/**
 * institutionalController.js — Controlador del Corredor Institucional
 *
 * Gestiona los endpoints del Escenario A: clientes corporativos y origen EE.UU.
 * bajo AV Finance LLC (Delaware).
 *
 * VALIDACIÓN MULTI-ENTIDAD CRÍTICA:
 *   Todo endpoint de este controlador verifica que el usuario tenga
 *   legalEntity === 'LLC' antes de proceder. Usuarios registrados bajo
 *   SpA o SRL son rechazados con un 403 explícito.
 *
 * Flujo completo del Escenario A:
 *   Stripe pay-in → OwlPay on-ramp → Stellar Network → [Destino]
 *
 * COMPLIANCE: Terminología prohibida ausente.
 */

import User        from '../models/User.js';
import Transaction from '../models/Transaction.js';
import {
  createOnRampOrder,
  verifyOwlPayWebhookSignature,
} from '../services/owlPayService.js';

// ─── POST /api/v1/institutional/onramp/owlpay ────────────────────────────────

/**
 * Inicia un on-ramp institucional fiat → USDC vía OwlPay (AV Finance LLC).
 *
 * Body esperado:
 * {
 *   "userId":             "64abc...",
 *   "amount":             5000,           ← USD
 *   "destinationWallet":  "G...",         ← Stellar public key del cliente destino
 *   "memo":               "OP-20250316"   ← Opcional, para trazabilidad
 * }
 *
 * Respuesta exitosa (201):
 * {
 *   "success":            true,
 *   "alytoTransactionId": "ALY-A-...",
 *   "owlPayOrderId":      "ord_...",
 *   "paymentUrl":         "https://harbor...",
 *   "estimatedUSDC":      4985.25,
 *   "status":             "initiated"
 * }
 */
export async function initiateCorporateOnRamp(req, res) {
  const { userId, amount, destinationWallet, memo } = req.body;

  // ── 1. Validación de entrada ──────────────────────────────────────────────
  if (!userId || !amount || !destinationWallet) {
    return res.status(400).json({
      success: false,
      error:   'Los campos userId, amount y destinationWallet son requeridos.',
    });
  }

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      success: false,
      error:   'El campo amount debe ser un número positivo en USD.',
    });
  }

  if (!/^G[A-Z2-7]{55}$/.test(destinationWallet)) {
    return res.status(400).json({
      success: false,
      error:   'destinationWallet debe ser una Stellar public key válida (comienza con G, 56 caracteres).',
    });
  }

  // ── 2. Buscar usuario en BD ───────────────────────────────────────────────
  let user;
  try {
    user = await User.findById(userId).lean();
  } catch {
    return res.status(400).json({
      success: false,
      error:   'userId inválido o con formato incorrecto.',
    });
  }

  if (!user) {
    return res.status(404).json({
      success: false,
      error:   'Usuario no encontrado.',
    });
  }

  // ── 3. VALIDACIÓN MULTI-ENTIDAD CRÍTICA ───────────────────────────────────
  //
  // El on-ramp vía OwlPay opera EXCLUSIVAMENTE bajo AV Finance LLC (Delaware).
  // Razón: OwlPay Harbor es la infraestructura de liquidez institucional B2B
  // contratada por la entidad LLC. Las entidades SpA y SRL tienen sus propios
  // motores de recaudación (Fintoc para SpA, Anchor Manual para SRL).
  //
  // Ningún usuario con legalEntity SpA o SRL puede acceder a este corredor.
  if (user.legalEntity !== 'LLC') {
    return res.status(403).json({
      success:        false,
      error:          'El enrutamiento vía OwlPay es exclusivo para clientes corporativos bajo la jurisdicción LLC (EE.UU.).',
      userEntity:     user.legalEntity,
      requiredEntity: 'LLC',
      hint:           user.legalEntity === 'SpA'
                        ? 'Para usuarios SpA (Chile) usar el endpoint /payin/fintoc.'
                        : 'Para usuarios SRL (Bolivia) usar el endpoint /payouts/bolivia/manual.',
    });
  }

  // ── 4. Verificar KYB aprobado (clientes institucionales requieren KYB) ────
  if (user.kycStatus !== 'approved') {
    return res.status(403).json({
      success:   false,
      error:     'La verificación KYB del cliente no está aprobada. Operación institucional no permitida.',
      kycStatus: user.kycStatus,
    });
  }

  // ── 5. Crear registro previo de transacción en BD (estado: initiated) ────
  const alytoTransactionId = `ALY-A-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  let transaction;
  try {
    transaction = await Transaction.create({
      userId:          user._id,
      legalEntity:     'LLC',
      operationType:   'crossBorderPayment',
      routingScenario: 'A',

      originalAmount:  amount,
      originCurrency:  'USD',

      digitalAsset:    'USDC',
      stellarDestAddress: destinationWallet,

      providersUsed: [],
      paymentLegs:   [],

      status:              'initiated',
      alytoTransactionId,
      ...(memo ? { internalNotes: memo } : {}),
    });
  } catch (error) {
    console.error('[Alyto Institutional] Error creando registro de transacción:', {
      userId,
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error interno al registrar la operación. Intenta nuevamente.',
    });
  }

  // ── 6. Crear la orden de on-ramp en OwlPay/Harbor ────────────────────────
  let owlPayResult;
  try {
    owlPayResult = await createOnRampOrder({
      amount,
      currency:          'USD',
      destinationWallet,
      userId:            user._id.toString(),
      alytoTransactionId,
      memo,
      customerUuid:      user.harborCustomerUuid ?? user._id.toString(),
    });
  } catch (error) {
    // Marcar la transacción como fallida antes de responder
    await Transaction.findByIdAndUpdate(transaction._id, {
      status:        'failed',
      failureReason: `OwlPay rechazó la orden: ${error.message}`,
    }).catch(() => {}); // Silenciar error secundario de BD

    console.error('[Alyto Institutional] Error creando orden OwlPay:', {
      alytoTransactionId,
      userId,
      error: error.message,
    });
    return res.status(502).json({
      success: false,
      error:   'No se pudo crear la orden de on-ramp con OwlPay. Intenta nuevamente.',
    });
  }

  // ── 7. Actualizar la transacción con el ID de OwlPay ─────────────────────
  try {
    await Transaction.findByIdAndUpdate(transaction._id, {
      $set:  { status: 'payin_pending' },
      $push: {
        providersUsed: 'payin:owlPay',
        paymentLegs: {
          stage:      'payin',
          provider:   'owlPay',
          status:     'pending',
          externalId: owlPayResult.orderId,
        },
      },
    });
  } catch (error) {
    // No crítico — el webhook de OwlPay actualizará el estado al confirmar
    console.warn('[Alyto Institutional] Advertencia: orden OwlPay creada pero no vinculada en BD:', {
      alytoTransactionId,
      owlPayOrderId: owlPayResult.orderId,
      error:         error.message,
    });
  }

  // ── 8. Respuesta al cliente ───────────────────────────────────────────────
  return res.status(201).json({
    success:              true,
    alytoTransactionId:   transaction.alytoTransactionId,
    owlPayOrderId:        owlPayResult.orderId,
    transferInstructions: owlPayResult.transferInstructions,
    estimatedUSDC:        owlPayResult.estimatedUSDC,
    amount:               owlPayResult.amount,
    currency:             owlPayResult.currency,
    status:               'initiated',
  });
}

// ─── POST /api/v1/institutional/webhooks/owlpay ──────────────────────────────

/**
 * Webhook de confirmación de OwlPay/Harbor.
 *
 * OwlPay llama a este endpoint cuando la liquidación institucional se completa
 * en la red Stellar. Actualiza la transacción con el stellarTxId y el nuevo estado.
 *
 * Seguridad: verifica la firma HMAC-SHA256 del header 'x-owlpay-signature'
 * antes de procesar cualquier dato del payload.
 *
 * Payload de OwlPay (ejemplo de evento completado):
 * {
 *   "event":  "order.completed",
 *   "data": {
 *     "id":                 "ord_abc123",
 *     "status":             "completed",
 *     "source_amount":      5000,
 *     "destination_amount": 4985.25,
 *     "stellar_tx_hash":    "a3f7c...",
 *     "stellar_ledger":     50123456,
 *     "metadata": { "alyto_transaction_id": "ALY-A-..." }
 *   }
 * }
 */
export async function owlPayWebhook(req, res) {
  // ── 1. Verificar firma del webhook ────────────────────────────────────────
  const signature = req.headers['harbor-signature'];
  const rawBody   = req.rawBody;

  if (!signature || !rawBody) {
    console.warn('[Alyto Webhook] OwlPay: petición sin firma o sin body. Rechazando.');
    return res.status(400).json({ error: 'Firma requerida.' });
  }

  const isValid = verifyOwlPayWebhookSignature(rawBody, signature);
  if (!isValid) {
    console.warn('[Alyto Webhook] OwlPay: firma inválida. Posible petición no autorizada.');
    return res.status(401).json({ error: 'Firma inválida.' });
  }

  // ── 2. Responder 200 a OwlPay INMEDIATAMENTE antes de procesar ───────────
  // Harbor/OwlPay requiere una respuesta rápida para no reintentar el webhook.
  // El procesamiento real ocurre después de enviar el 200.
  res.status(200).json({ received: true });

  // ── 3. Parsear evento y procesar en background ───────────────────────────
  const { event, data } = req.body;

  console.info('[Alyto Webhook] OwlPay evento recibido:', {
    event,
    orderId: data?.id,
    status:  data?.status,
  });

  try {
    switch (event) {

      // ── Liquidación completada: fondos enviados a Stellar ────────────────
      case 'order.completed': {
        const stellarTxId = data.stellar_tx_hash ?? data.txid ?? null;
        const stellarLedger = data.stellar_ledger ?? null;
        const usdcAmount    = data.destination_amount ?? null;

        const updated = await Transaction.findOneAndUpdate(
          {
            'paymentLegs.externalId': data.id,
            'paymentLegs.provider':   'owlPay',
          },
          {
            $set: {
              // Actualiza a in_transit: el USDC ya está en la wallet Stellar del cliente
              status:              'in_transit',
              stellarTxId:         stellarTxId,
              stellarLedger:       stellarLedger,
              digitalAssetAmount:  usdcAmount,
              'paymentLegs.$.status':      'completed',
              'paymentLegs.$.completedAt': new Date(),
            },
            $push: {
              providersUsed: 'transit:stellar',
              paymentLegs: {
                stage:       'transit',
                provider:    'stellar',
                status:      'completed',
                externalId:  stellarTxId,
                completedAt: new Date(),
              },
            },
          },
          { new: true },
        );

        if (!updated) {
          console.warn('[Alyto Webhook] OwlPay: transacción no encontrada para orden:', data.id);
        } else {
          console.info('[Alyto Webhook] OwlPay: on-ramp completado, fondos en Stellar.', {
            alytoTransactionId: updated.alytoTransactionId,
            stellarTxId,
            usdcAmount,
          });
        }
        break;
      }

      // ── Pago fiat confirmado, en proceso de conversión ───────────────────
      case 'order.payment_received': {
        await Transaction.findOneAndUpdate(
          {
            'paymentLegs.externalId': data.id,
            'paymentLegs.provider':   'owlPay',
          },
          {
            $set: {
              status:                      'payin_completed',
              'paymentLegs.$.status':      'completed',
              'paymentLegs.$.completedAt': new Date(),
            },
          },
        );
        console.info('[Alyto Webhook] OwlPay: pago fiat recibido, conversión en proceso.', {
          orderId: data.id,
        });
        break;
      }

      // ── Orden fallida ────────────────────────────────────────────────────
      case 'order.failed': {
        await Transaction.findOneAndUpdate(
          {
            'paymentLegs.externalId': data.id,
            'paymentLegs.provider':   'owlPay',
          },
          {
            $set: {
              status:                       'failed',
              failureReason:                data.failure_reason ?? 'Orden OwlPay rechazada.',
              'paymentLegs.$.status':       'failed',
              'paymentLegs.$.errorMessage': data.failure_reason ?? 'Fallo en on-ramp institucional.',
            },
          },
        );
        console.warn('[Alyto Webhook] OwlPay: orden fallida.', {
          orderId:       data.id,
          failureReason: data.failure_reason,
        });
        break;
      }

      default:
        console.info(`[Alyto Webhook] OwlPay: evento informativo no procesado: ${event}`);
    }
  } catch (error) {
    // El 200 ya fue enviado — loguear para revisión manual sin afectar al cliente
    console.error('[Alyto Webhook] OwlPay: error procesando evento:', {
      event,
      orderId: data?.id,
      error:   error.message,
    });
  }
}
