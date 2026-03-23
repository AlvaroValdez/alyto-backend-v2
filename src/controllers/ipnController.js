/**
 * ipnController.js — Handlers de IPN (webhooks entrantes)
 *
 * Procesa notificaciones asíncronas de Vita Wallet y Fintoc para el motor
 * de pagos cross-border. El flujo automatizado completo es:
 *
 *   POST /crossborder → Transaction (payin_pending)
 *         ↓ usuario paga en widget de Vita / Fintoc
 *   POST /api/v1/ipn/vita  ← Vita confirma payin
 *         ↓
 *   dispatchPayout() → Vita withdrawal (o email admin si anchor manual)
 *         ↓
 *   POST /api/v1/ipn/vita  ← Vita confirma payout (segundo IPN)
 *         ↓
 *   Transaction.status = "completed" ✅
 *
 * Seguridad:
 *   - Vita IPN: validación HMAC-SHA256 (mismo algoritmo que outbound requests)
 *   - Fintoc IPN: validación por tipo de evento + lookup por payinReference
 *   - Ambos handlers responden HTTP 200 siempre para evitar reintentos innecesarios
 *     ante errores internos. Los errores se loguean para revisión manual.
 */

import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import User              from '../models/User.js';
import { generateVitaSignature, createPayout } from '../services/vitaWalletService.js';
import Sentry from '../services/sentry.js';
import { sendPushNotification, NOTIFICATIONS } from '../services/notifications.js';
import { sendEmail, EMAILS } from '../services/email.js';

// ─── Helpers Internos ─────────────────────────────────────────────────────────

/**
 * Valida la firma HMAC-SHA256 del IPN entrante de Vita.
 *
 * Vita firma el IPN con el mismo algoritmo que nosotros usamos para
 * autenticar nuestras peticiones salientes (V2-HMAC-SHA256):
 *   message = xLogin + xDate + sortedBody
 *   signature = HMAC-SHA256(VITA_SECRET, message)
 *
 * Verificamos re-computando la firma esperada con nuestro VITA_SECRET
 * y comparando con el header Authorization del IPN recibido.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function validateVitaIPNSignature(req) {
  const xDate = req.headers['x-date'];
  if (!xDate) {
    console.warn('[Alyto IPN/Vita] Header x-date ausente en el IPN.');
    return false;
  }

  // Verificar que el x-login del IPN corresponde a nuestra cuenta Vita
  const xLogin = req.headers['x-login'];
  if (xLogin && xLogin !== process.env.VITA_LOGIN) {
    console.warn('[Alyto IPN/Vita] x-login del IPN no coincide con VITA_LOGIN.', {
      received: xLogin,
    });
    return false;
  }

  // Extraer firma recibida del header Authorization
  // Formato: "V2-HMAC-SHA256, Signature: {hex}"
  const authHeader  = req.headers['authorization'] ?? '';
  const sigMatch    = authHeader.match(/Signature:\s*([a-f0-9]+)/i);
  if (!sigMatch) {
    console.warn('[Alyto IPN/Vita] Header Authorization sin firma parseable:', authHeader);
    return false;
  }
  const receivedSig = sigMatch[1].toLowerCase();

  // Recomputar la firma esperada con nuestro secreto compartido
  let expectedSig;
  try {
    expectedSig = generateVitaSignature(xDate, req.body);
  } catch (err) {
    console.error('[Alyto IPN/Vita] Error calculando firma esperada:', err.message);
    return false;
  }

  const isValid = receivedSig === expectedSig.toLowerCase();
  if (!isValid) {
    console.warn('[Alyto IPN/Vita] Firma inválida en IPN.', {
      received: receivedSig,
      expected: expectedSig,
    });
  }
  return isValid;
}

/**
 * Registra una entrada en el ipnLog de la transacción.
 * Operación no crítica — falla silenciosamente para no interrumpir el flujo.
 *
 * @param {object} transaction — Documento Mongoose (no .lean())
 * @param {string} eventType
 * @param {string} provider
 * @param {string} status
 * @param {*}      rawPayload
 */
async function appendIpnLog(transaction, eventType, provider, status, rawPayload) {
  try {
    transaction.ipnLog.push({ provider, eventType, status, rawPayload, receivedAt: new Date() });
    await transaction.save();
  } catch (err) {
    console.error('[Alyto IPN] Error guardando ipnLog:', {
      transactionId: transaction.alytoTransactionId,
      eventType,
      error: err.message,
    });
  }
}

/**
 * Notifica al admin que hay un payout manual pendiente (Escenario C — Bolivia).
 * Delega al servicio de email con Dynamic Template de SendGrid.
 *
 * @param {object} transaction — Documento Mongoose con beneficiary y montos
 */
async function notifyAdminManualPayout(transaction) {
  await sendEmail(...EMAILS.adminBoliviaAlert(transaction));
}

/**
 * Calcula el monto neto a enviar a Vita para el withdrawal.
 * Es el originalAmount menos todos los fees que Alyto retiene.
 *
 * Usa feeBreakdown.totalFee si está almacenado; en caso contrario
 * usa 0 (seguro: Vita calculará la conversión sin deducción extra).
 *
 * TODO (Fase 18B): almacenar netAmountToSend explícitamente al crear la
 * transacción en POST /crossborder para evitar esta reconstrucción.
 *
 * @param {object} transaction
 * @returns {number}
 */
/**
 * Calcula el monto neto a enviar a Vita descontando los fees de Alyto.
 *
 * Fees descontados aquí (retenidos por Alyto antes de enviar):
 *   payinFee       — costo del método de pago local (ej. Fintoc)
 *   alytoCSpread   — spread cambiario de Alyto
 *   fixedFee       — fee fijo por operación
 *   profitRetention — margen de ganancia de Alyto
 *
 * El payoutFee (costo de dispersión en destino) lo descuenta Vita
 * directamente sobre el monto que recibe — NO se descuenta aquí.
 *
 * @param {object} transaction — Documento Mongoose
 * @returns {number} Monto neto en CLP a enviar a Vita
 * @throws {Error} Si el monto neto es <= 0
 */
function resolveNetAmountForPayout(transaction) {
  const fees = transaction.fees || {};

  const montoNeto = Math.round(
    (transaction.originalAmount ?? 0)
    - (fees.payinFee        || 0)
    - (fees.alytoCSpread    || 0)
    - (fees.fixedFee        || 0)
    - (fees.profitRetention || 0),
  );

  console.log('[dispatchPayout] Desglose fees:');
  console.log('  originAmount:', transaction.originalAmount);
  console.log('  - payinFee:', fees.payinFee || 0);
  console.log('  - alytoCSpread:', fees.alytoCSpread || 0, '(configurable desde admin por corredor)');
  console.log('  - fixedFee:', fees.fixedFee || 0, '(configurable desde admin por corredor)');
  console.log('  - profitRetention:', fees.profitRetention || 0, '(configurable desde admin por corredor)');
  console.log('  = montoNeto enviado a Vita:', montoNeto);

  if (montoNeto <= 0) {
    throw new Error(
      `Monto neto inválido: ${montoNeto} — revisar config de fees en corredor ${transaction.corridorId}`,
    );
  }

  return montoNeto;
}

// ─── dispatchPayout ───────────────────────────────────────────────────────────

/**
 * Dispara el payout al beneficiario después de que el payin fue confirmado.
 * Se invoca desde ambos handlers (vita y fintoc) cuando el payin queda confirmado.
 *
 * El payoutMethod del corredor determina qué proveedor ejecuta el payout:
 *   vitaWallet   → POST /transactions (withdrawal) a Vita API
 *   anchorBolivia → Notificación email al admin + status "processing"
 *   rampNetwork  → TODO Fase 18B
 *   stellar      → TODO Fase 18B
 *
 * Errores: capturados internamente — nunca lanzan excepción al caller.
 * Los fallos quedan registrados en ipnLog y el status pasa a "failed".
 *
 * @param {object} transaction — Documento Mongoose con .save() disponible
 */
export async function dispatchPayout(transaction) {
  // ── Obtener configuración del corredor ────────────────────────────────────
  let corridor;
  try {
    corridor = await TransactionConfig.findById(transaction.corridorId).lean();
  } catch (err) {
    console.error('[Alyto Payout] Error obteniendo TransactionConfig:', {
      corridorId:    transaction.corridorId?.toString(),
      transactionId: transaction.alytoTransactionId,
      error:         err.message,
    });
  }

  if (!corridor) {
    // Error de configuración del sistema, no del pago — el payin fue confirmado.
    // No marcar como 'failed' para no confundir al usuario; dejar en payin_confirmed
    // para intervención manual por el equipo de operaciones.
    console.error('[Alyto Payout] Corredor no encontrado — payout pendiente de intervención manual.', {
      corridorId:    transaction.corridorId?.toString(),
      transactionId: transaction.alytoTransactionId,
    });
    transaction.ipnLog.push({
      provider:   'manual',
      eventType:  'payout.corridor_missing',
      status:     'pending',
      rawPayload: {
        note:       'Corredor no encontrado al intentar ejecutar el payout.',
        corridorId: transaction.corridorId?.toString(),
      },
    });
    await transaction.save().catch(() => {});
    return;
  }

  const payoutMethod = corridor.payoutMethod;
  console.info('[Alyto Payout] Despachando payout.', {
    transactionId: transaction.alytoTransactionId,
    payoutMethod,
    destinationCountry: transaction.destinationCountry,
  });

  // ── vitaWallet: withdrawal bancario vía Vita API ──────────────────────────
  if (payoutMethod === 'vitaWallet') {
    const ben    = transaction.beneficiary ?? {};
    const amount = resolveNetAmountForPayout(transaction);

    // Extraer dynamicFields (Map → objeto plano)
    const dynamicFields = {};
    if (ben.dynamicFields instanceof Map) {
      for (const [k, v] of ben.dynamicFields.entries()) {
        dynamicFields[k] = v;
      }
    } else if (ben.dynamicFields && typeof ben.dynamicFields === 'object') {
      Object.assign(dynamicFields, ben.dynamicFields);
    }

    // ── Detección de formato ────────────────────────────────────────────────
    // Si dynamicFields contiene keys de Vita (beneficiary_first_name, bank_code, etc.),
    // usarlos directamente (formato dinámico del formulario de withdrawal_rules).
    // Si no, construir el payload desde los campos nombrados del schema (formato legado).
    const isDynamicFormat = Boolean(
      dynamicFields.beneficiary_first_name ??
      dynamicFields.beneficiary_email      ??
      dynamicFields.bank_code,
    );

    let vitaPayload;
    if (isDynamicFormat) {
      // ── Formato dinámico: spread directo de los campos de Vita ─────────────
      const firstName = dynamicFields.beneficiary_first_name ?? '';
      const lastName  = dynamicFields.beneficiary_last_name  ?? '';
      vitaPayload = {
        country:          transaction.destinationCountry,
        currency:         (transaction.originCurrency ?? 'clp').toLowerCase(),
        amount,
        order:            transaction.alytoTransactionId,
        purpose:          'ISSAVG',
        ...dynamicFields,                      // todos los campos del formulario dinámico
        // fc_* obligatorios de Vita — siempre se sobreescriben
        fc_customer_type: 'natural',
        fc_legal_name:    `${firstName} ${lastName}`.trim() || 'Beneficiario Alyto',
        fc_document_type: dynamicFields.beneficiary_document_type ?? 'dni',
      };
    } else {
      // ── Formato legado: mapeo desde campos del schema ─────────────────────
      vitaPayload = {
        country:                     transaction.destinationCountry,
        currency:                    (transaction.originCurrency ?? 'clp').toLowerCase(),
        amount,
        order:                       transaction.alytoTransactionId,
        beneficiary_first_name:      ben.firstName  ?? '',
        beneficiary_last_name:       ben.lastName   ?? '',
        beneficiary_email:           ben.email      ?? '',
        beneficiary_address:         ben.address    ?? '',
        beneficiary_document_type:   ben.documentType   ?? 'dni',
        beneficiary_document_number: ben.documentNumber ?? '',
        purpose:                     'ISSAVG',
        ...(ben.bankCode    ? { bank_code:         ben.bankCode    } : {}),
        ...(ben.accountBank ? { account_bank:       ben.accountBank } : {}),
        ...(ben.accountType ? { account_type_bank:  ben.accountType } : {}),
        fc_customer_type: 'natural',
        fc_legal_name:    `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim(),
        fc_document_type: ben.documentType ?? 'dni',
        ...dynamicFields,
      };
    }

    let vitaResponse;
    try {
      vitaResponse = await createPayout(vitaPayload);
    } catch (err) {
      console.error('[Alyto Payout] Error en createPayout (Vita):', {
        transactionId: transaction.alytoTransactionId,
        error:         err.message,
        vitaCode:      err.vitaCode,
        detail:        err.data,
      });
      Sentry.captureException(err, {
        tags:  { component: 'dispatchPayout', corridorId: transaction.corridorId?.toString() },
        extra: { transactionId: transaction.alytoTransactionId, beneficiary: transaction.beneficiary },
      });
      transaction.status        = 'failed';
      transaction.failureReason = `Vita withdrawal falló: ${err.message}`;
      await appendIpnLog(transaction, 'payout_dispatch_failed', 'vitaWallet', 'failed', {
        error:    err.message,
        vitaCode: err.vitaCode ?? null,
        detail:   err.data    ?? null,
      });
      return;
    }

    // Payout creado exitosamente en Vita
    transaction.payoutReference = vitaResponse?.id ?? vitaResponse?.transaction?.id ?? null;
    transaction.status          = 'payout_sent';
    transaction.providersUsed   = [...(transaction.providersUsed ?? []), 'payout:vitaWallet'];

    await appendIpnLog(transaction, 'payout_dispatched', 'vitaWallet', 'payout_sent', {
      vitaTransactionId: transaction.payoutReference,
      amount,
      country: transaction.destinationCountry,
    });

    console.info('[Alyto Payout] Vita withdrawal creado.', {
      transactionId:     transaction.alytoTransactionId,
      vitaTransactionId: transaction.payoutReference,
      amount,
    });

    // Notificación push: pago enviado al banco
    try {
      await sendPushNotification(
        transaction.userId,
        NOTIFICATIONS.payoutSent(transaction.destinationCountry),
      );
    } catch (notifErr) {
      console.error('[Alyto Payout] Error enviando push payout_sent:', notifErr.message);
    }

    return;
  }

  // ── anchorBolivia: payout manual (Escenario C — Bolivia) ─────────────────
  if (payoutMethod === 'anchorBolivia') {
    transaction.status = 'processing';
    await appendIpnLog(transaction, 'anchor_manual_required', 'anchorBolivia', 'processing', {
      note: 'Payout manual Bolivia — se notificó al admin.',
    });

    await notifyAdminManualPayout(transaction);
    console.info('[Alyto Payout] Payout manual Bolivia — admin notificado.', {
      transactionId: transaction.alytoTransactionId,
    });
    return;
  }

  // ── rampNetwork / stellar / otros — placeholder Fase 18B ────────────────
  console.warn('[Alyto Payout] payoutMethod no implementado — marcando como processing.', {
    payoutMethod,
    transactionId: transaction.alytoTransactionId,
  });
  transaction.status = 'processing';
  await appendIpnLog(transaction, 'payout_method_unimplemented', payoutMethod, 'processing', {
    payoutMethod,
    note: 'Implementación pendiente Fase 18B.',
  });
}

// ─── POST /api/v1/ipn/vita ────────────────────────────────────────────────────

/**
 * Recibe y procesa los IPN de Vita Wallet.
 *
 * Vita reintenta este endpoint cada 10 minutos por 30 días hasta recibir HTTP 200.
 * Por eso siempre respondemos 200, incluso si hay errores internos — el error
 * queda registrado en ipnLog y en los logs del servidor.
 *
 * Este handler procesa DOS tipos de IPN:
 *   1. Confirmación de payin (pay-in completado por el usuario)
 *      → transaction.status === "payin_pending" → dispatchPayout()
 *
 *   2. Confirmación de payout (withdrawal bancario completado por Vita)
 *      → transaction.status === "payout_sent" → status = "completed"
 *
 * Body esperado de Vita:
 * {
 *   "status": "completed" | "denied",
 *   "order":  "{alytoTransactionId}",
 *   "wallet": { "token": "...", "uuid": "..." }
 * }
 */
export async function handleVitaIPN(req, res) {
  // ── 1. Validar firma HMAC-SHA256 ──────────────────────────────────────────
  if (!validateVitaIPNSignature(req)) {
    console.warn('[Alyto IPN/Vita] Firma inválida — rechazando petición.', {
      ip:   req.ip,
      body: JSON.stringify(req.body)?.slice(0, 200),
    });
    Sentry.captureMessage('IPN firma inválida recibida', {
      level: 'warning',
      extra: { body: req.body, ip: req.ip },
    });
    // 401 aquí: firma inválida no necesita un 200 — Vita no reintentará si enviamos 401
    return res.status(401).json({ error: 'Firma inválida.' });
  }

  const { status: vitaStatus, order: vitaOrder, wallet } = req.body;

  console.info('[Alyto IPN/Vita] IPN recibido.', {
    vitaStatus,
    order: vitaOrder,
    walletUuid: wallet?.uuid,
  });

  // ── 2. Buscar transacción por alytoTransactionId ──────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: vitaOrder });
  } catch (err) {
    console.error('[Alyto IPN/Vita] Error buscando transacción en BD:', {
      order: vitaOrder,
      error: err.message,
    });
    // 200: error interno, Vita no debe reintentar este IPN (el problema es nuestro)
    return res.status(200).json({ received: true });
  }

  if (!transaction) {
    console.warn('[Alyto IPN/Vita] Transacción no encontrada para order:', vitaOrder);
    // 200: evitar reintentos de Vita ante un order que no existe en nuestro sistema
    return res.status(200).json({ received: true });
  }

  // ── 3. Registrar IPN en el log de la transacción ──────────────────────────
  // Nota: appendIpnLog llama a transaction.save() — no llamar save() adicionales
  // antes de esta línea si ya se modificó el documento.
  await appendIpnLog(transaction, 'vita_ipn_received', 'vitaWallet', vitaStatus, req.body);

  // ── 4. Procesar según el estado actual de la transacción ─────────────────
  const currentStatus = transaction.status;

  try {

    // ── Caso A: confirmación de payin ─────────────────────────────────────
    if (['payin_pending', 'initiated', 'pending'].includes(currentStatus)) {

      if (vitaStatus === 'completed') {
        transaction.status        = 'payin_confirmed';
        transaction.payinReference = wallet?.uuid ?? transaction.payinReference;
        await transaction.save();

        console.info('[Alyto IPN/Vita] Payin confirmado — disparando payout.', {
          transactionId: transaction.alytoTransactionId,
          walletUuid:    wallet?.uuid,
        });

        // Notificación push: payin confirmado
        try {
          await sendPushNotification(
            transaction.userId,
            NOTIFICATIONS.payinConfirmed(transaction.originalAmount, transaction.originCurrency),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payin_confirmed:', notifErr.message);
        }

        // Email transaccional: pago iniciado
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentInitiated(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentInitiated:', emailErr.message);
        }

        // Fire-and-forget: no awaitar para responder 200 rápido a Vita
        dispatchPayout(transaction).catch(err => {
          console.error('[Alyto IPN/Vita] dispatchPayout fire-and-forget falló:', {
            transactionId: transaction.alytoTransactionId,
            error:         err.message,
          });
        });

      } else if (vitaStatus === 'denied') {
        transaction.status        = 'failed';
        transaction.failureReason = 'Payin denegado por Vita Wallet.';
        await transaction.save();

        console.info('[Alyto IPN/Vita] Payin denegado por Vita.', {
          transactionId: transaction.alytoTransactionId,
        });

        // Notificación push: pago fallido
        try {
          await sendPushNotification(
            transaction.userId,
            NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payment_failed (payin denied):', notifErr.message);
        }

        // Email transaccional: pago fallido
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentFailed(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentFailed (payin denied):', emailErr.message);
        }
      }
      // Otros estados de Vita (ej. 'pending') → no hacer nada, esperar siguiente IPN
      return res.status(200).json({ received: true });
    }

    // ── Caso B: ya procesado previamente — idempotencia ──────────────────
    if (currentStatus === 'payin_confirmed' && vitaStatus === 'completed') {
      console.info('[Alyto IPN/Vita] IPN duplicado de payin — ya procesado. Ignorando.', {
        transactionId: transaction.alytoTransactionId,
      });
      return res.status(200).json({ received: true });
    }

    // ── Caso C: confirmación de payout (segundo IPN de Vita) ─────────────
    if (currentStatus === 'payout_sent') {

      if (vitaStatus === 'completed') {
        transaction.status      = 'completed';
        transaction.completedAt = new Date();
        await transaction.save();

        await appendIpnLog(transaction, 'payout_completed', 'vitaWallet', 'completed', req.body);

        console.info('[Alyto IPN/Vita] Payout completado — transacción finalizada. ✅', {
          transactionId: transaction.alytoTransactionId,
        });
        // TODO Fase 18B: registrar TXID en Stellar como capa de auditoría

        // Notificación push: transferencia completada
        try {
          await sendPushNotification(
            transaction.userId,
            NOTIFICATIONS.paymentCompleted(
              transaction.originalAmount,
              transaction.originCurrency,
              transaction.destinationAmount,
              transaction.destinationCurrency,
            ),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payment_completed:', notifErr.message);
        }

        // Email transaccional: pago completado
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentCompleted(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentCompleted:', emailErr.message);
        }

      } else if (vitaStatus === 'denied') {
        transaction.status        = 'failed';
        transaction.failureReason = 'Payout (withdrawal bancario) denegado por Vita Wallet.';
        await transaction.save();

        await appendIpnLog(transaction, 'payout_denied', 'vitaWallet', 'failed', req.body);

        console.error('[Alyto IPN/Vita] Payout denegado por Vita — requiere revisión manual.', {
          transactionId: transaction.alytoTransactionId,
        });

        // Notificar al admin que el payout falló y requiere intervención
        notifyAdminManualPayout(transaction).catch(() => {});

        // Notificación push: transferencia fallida
        try {
          await sendPushNotification(
            transaction.userId,
            NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payment_failed (payout denied):', notifErr.message);
        }

        // Email transaccional: pago fallido
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentFailed(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentFailed (payout denied):', emailErr.message);
        }
      }
      return res.status(200).json({ received: true });
    }

    // ── Caso D: estado no esperado — loguear y responder 200 ─────────────
    console.warn('[Alyto IPN/Vita] IPN recibido en estado inesperado — ignorando.', {
      transactionId: transaction.alytoTransactionId,
      currentStatus,
      vitaStatus,
    });

  } catch (err) {
    // Error interno no manejado — loguear sin reventar el proceso
    console.error('[Alyto IPN/Vita] Error procesando IPN:', {
      transactionId: transaction?.alytoTransactionId,
      currentStatus,
      vitaStatus,
      error:         err.message,
    });
  }

  return res.status(200).json({ received: true });
}

// ─── POST /api/v1/ipn/fintoc ──────────────────────────────────────────────────

/**
 * Recibe y procesa los IPN / webhooks de Fintoc para el flujo cross-border.
 *
 * ⚠️  Este handler es para el flujo cross-border (payin → dispatchPayout).
 *     El webhook de Fintoc para el flujo SpA legacy está en
 *     POST /api/v1/payments/webhooks/fintoc (paymentController.js).
 *
 * Fintoc envía un event body con:
 * {
 *   "type": "payment_intent.succeeded",
 *   "data": { "id": "pi_...", "status": "succeeded", ... }
 * }
 *
 * La transacción se busca por payinReference === data.id.
 * Si no existe por payinReference, busca por paymentLegs.externalId (legacy).
 */
export async function handleFintocIPN(req, res) {
  // Log inmediato — ANTES de cualquier validación para confirmar que el handler es alcanzado
  console.log('[Fintoc IPN] ⚡ Webhook recibido en /api/v1/ipn/fintoc');
  console.log('[Fintoc IPN] Headers:', JSON.stringify({
    'content-type':     req.headers['content-type'],
    'fintoc-signature': req.headers['fintoc-signature'],
    'user-agent':       req.headers['user-agent'],
  }));
  console.log('[Fintoc IPN] Body:', JSON.stringify(req.body));

  const { type, data } = req.body;

  console.info('[Alyto IPN/Fintoc] Evento recibido.', {
    type,
    paymentIntentId: data?.id,
  });

  // ── 1. Filtrar eventos irrelevantes ───────────────────────────────────────
  // Solo procesar confirmaciones de pago exitoso
  if (type !== 'payment_intent.succeeded') {
    console.info('[Alyto IPN/Fintoc] Evento ignorado (no es succeeded):', type);
    return res.status(200).json({ received: true });
  }

  const paymentIntentId = data?.id;
  if (!paymentIntentId) {
    console.warn('[Alyto IPN/Fintoc] Event sin data.id — ignorando.');
    return res.status(200).json({ received: true });
  }

  // ── 2. Buscar transacción cross-border por payinReference ─────────────────
  let transaction;
  try {
    transaction = await Transaction.findOne({ payinReference: paymentIntentId });

    // Fallback: buscar por paymentLegs.externalId (transacciones SpA legacy
    // que también podrían pasar por este endpoint)
    if (!transaction) {
      transaction = await Transaction.findOne({
        'paymentLegs.externalId': paymentIntentId,
        'paymentLegs.provider':   'fintoc',
      });
    }
  } catch (err) {
    console.error('[Alyto IPN/Fintoc] Error buscando transacción:', {
      paymentIntentId,
      error: err.message,
    });
    return res.status(200).json({ received: true });
  }

  if (!transaction) {
    console.warn('[Alyto IPN/Fintoc] Transacción no encontrada para payment_intent:', paymentIntentId);
    return res.status(200).json({ received: true });
  }

  // ── 3. Registrar IPN en log ───────────────────────────────────────────────
  await appendIpnLog(transaction, 'fintoc_ipn_received', 'fintoc', data?.status ?? 'succeeded', req.body);

  // ── 4. Procesar si el payin está pendiente ────────────────────────────────
  try {
    if (transaction.status === 'payin_pending') {
      transaction.status = 'payin_confirmed';
      await transaction.save();

      console.info('[Alyto IPN/Fintoc] Payin confirmado — disparando payout.', {
        transactionId:   transaction.alytoTransactionId,
        paymentIntentId,
      });

      // Fire-and-forget: Fintoc también necesita respuesta rápida
      dispatchPayout(transaction).catch(err => {
        console.error('[Alyto IPN/Fintoc] dispatchPayout fire-and-forget falló:', {
          transactionId: transaction.alytoTransactionId,
          error:         err.message,
        });
      });

    } else {
      console.info('[Alyto IPN/Fintoc] Transacción no en payin_pending — ignorando.', {
        transactionId: transaction.alytoTransactionId,
        currentStatus: transaction.status,
      });
    }
  } catch (err) {
    console.error('[Alyto IPN/Fintoc] Error procesando confirmación:', {
      transactionId: transaction?.alytoTransactionId,
      error:         err.message,
    });
  }

  return res.status(200).json({ received: true });
}
