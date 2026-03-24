/**
 * paymentController.js — Controlador de Pagos Multi-Entidad
 *
 * Maneja los endpoints HTTP de pay-in. Toda la lógica de negocio
 * vive en los servicios — el controlador solo orquesta req → service → res.
 *
 * Validación Multi-Entidad:
 *   Cada función verifica que el legalEntity del usuario coincida con la
 *   jurisdicción requerida por el método de pago antes de proceder.
 *
 * COMPLIANCE: Terminología prohibida ausente.
 * Usar: crossBorderPayment, payin, payout, operationType.
 *
 * Endpoints:
 *   POST /payin/fintoc              — Inicia payin Chile (SpA)
 *   POST /webhooks/fintoc           — Webhook de confirmación Fintoc
 *   GET  /quote                     — Cotización en tiempo real
 *   GET  /:transactionId/status     — Consulta de estado (polling del frontend)
 */

import User              from '../models/User.js';
import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import Sentry            from '../services/sentry.js';
import {
  createWidgetLink,
  getPaymentIntent,
  verifyWebhookSignature,
} from '../services/fintocService.js';
import { dispatchPayout } from './ipnController.js';
import {
  getPrices,
  getWithdrawalRules as getVitaWithdrawalRules,
  createPayin,
}                              from '../services/vitaWalletService.js';
import { getAuditTrail }       from '../services/stellarService.js';
import { sendEmail, EMAILS }  from '../services/email.js';

// ─── POST /api/v1/payments/payin/fintoc ──────────────────────────────────────

/**
 * Inicia un payin vía Fintoc Open Banking (AV Finance SpA — Chile).
 *
 * Body esperado:
 * {
 *   "userId": "64abc...",
 *   "amount": 150000        ← CLP, entero, sin decimales
 * }
 *
 * Respuesta exitosa (201):
 * {
 *   "success": true,
 *   "transactionId": "ALY-B-...",
 *   "widgetUrl": "https://widget.fintoc.com/?token=...",
 *   "fintocPaymentIntentId": "pi_..."
 * }
 */
export async function initiateFintocPayin(req, res) {
  const { userId, amount } = req.body;

  // ── 1. Validación de entrada ──────────────────────────────────────────────
  if (!userId || !amount) {
    return res.status(400).json({
      success: false,
      error:   'Los campos userId y amount son requeridos.',
    });
  }

  if (!Number.isInteger(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({
      success: false,
      error:   'El campo amount debe ser un entero positivo en CLP.',
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

  // ── 3. VALIDACIÓN MULTI-ENTIDAD ───────────────────────────────────────────
  // Fintoc Opera exclusivamente bajo AV Finance SpA (jurisdicción Chile).
  // Usuarios registrados bajo LLC o SRL no pueden usar este método de pago.
  if (user.legalEntity !== 'SpA') {
    return res.status(403).json({
      success:       false,
      error:         'El método Fintoc solo está disponible para cuentas de la jurisdicción SpA (Chile).',
      userEntity:    user.legalEntity,
      requiredEntity: 'SpA',
    });
  }

  // ── 4. Verificar KYC aprobado ─────────────────────────────────────────────
  if (user.kycStatus !== 'approved') {
    return res.status(403).json({
      success:   false,
      error:     'El usuario no tiene KYC aprobado. Operación no permitida.',
      kycStatus: user.kycStatus,
    });
  }

  // ── 5. Buscar corredor activo para SpA (origen CL) ────────────────────────
  const { destinationCountry } = req.body;
  const corridorQuery = { originCountry: 'CL', isActive: true };
  if (destinationCountry) corridorQuery.destinationCountry = destinationCountry.toUpperCase();

  let corridor;
  try {
    corridor = await TransactionConfig.findOne(corridorQuery).lean();
  } catch {
    // No fatal — corridorId quedará undefined; dispatchPayout lo manejará
  }

  // ── 6. Crear PaymentIntent en Fintoc ──────────────────────────────────────
  let fintocResult;
  try {
    fintocResult = await createWidgetLink({
      amount:         Number(amount),
      currency:       'CLP',
      customer_email: user.email,
      metadata: {
        userId:       user._id.toString(),
        legalEntity:  'SpA',
      },
      success_url: `${process.env.APP_URL}/success`,
      cancel_url:  `${process.env.APP_URL}/send`,
    });
  } catch (error) {
    console.error('[Alyto Controller] Error creando PaymentIntent Fintoc:', {
      userId,
      error: error.message,
    });
    Sentry.captureException(error, {
      tags:  { component: 'initPayin' },
      extra: { corridorId: corridor?._id?.toString(), originAmount: Number(amount) },
    });
    return res.status(502).json({
      success: false,
      error:   'No se pudo crear el intento de pago con Fintoc. Intenta nuevamente.',
    });
  }

  // ── 6. Registrar la transacción en BD (estado: payin_pending) ────────────
  let transaction;
  try {
    // Generamos un ID provisional — el orquestador asignará el ID definitivo
    // cuando la transacción avance al tránsito Stellar
    const alytoTransactionId = `ALY-B-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    transaction = await Transaction.create({
      userId:       user._id,
      legalEntity:  'SpA',                      // Jurisdicción de esta operación
      operationType: 'payin',
      routingScenario: 'B',                     // Escenario B: origen Chile

      ...(corridor ? { corridorId: corridor._id } : {}),

      originalAmount:  Number(amount),
      originCurrency:  'CLP',
      originCountry:   'CL',
      ...(corridor?.destinationCountry ? { destinationCountry: corridor.destinationCountry } : {}),
      ...(corridor?.destinationCurrency ? { destinationCurrency: corridor.destinationCurrency } : {}),

      providersUsed:  ['payin:fintoc'],
      paymentLegs: [{
        stage:      'payin',
        provider:   'fintoc',
        status:     'pending',
        externalId: fintocResult.id,
      }],

      status:              'payin_pending',
      alytoTransactionId,
    });
  } catch (error) {
    // El Checkout Session ya fue creado en Fintoc — loguear para reconciliación manual
    console.error('[Alyto Controller] Error persistiendo transacción Fintoc en BD:', {
      userId,
      fintocCheckoutSessionId: fintocResult.id,
      error: error.message,
    });
    // No interrumpir — el webhook actualizará el estado cuando llegue la confirmación
  }

  // ── 7. Respuesta al cliente ───────────────────────────────────────────────
  return res.status(201).json({
    success:                  true,
    alytoTransactionId:       transaction?.alytoTransactionId,
    fintocCheckoutSessionId:  fintocResult.id,
    payinUrl:                 fintocResult.url,
    amount:                   fintocResult.amount,
    currency:                 fintocResult.currency,
    status:                   'payin_pending',
  });
}

// ─── POST /api/v1/payments/webhooks/fintoc ────────────────────────────────────

/**
 * Webhook de confirmación asíncrona de Fintoc.
 *
 * Fintoc llama a este endpoint cuando el usuario completa o falla el pago
 * en su banco. Actualiza la transacción en BD según el resultado.
 *
 * Seguridad: verifica la firma HMAC-SHA256 del header 'fintoc-signature'
 * antes de procesar cualquier dato del payload.
 *
 * Body de Fintoc (ejemplo):
 * {
 *   "type": "payment_intent.succeeded",
 *   "data": {
 *     "id": "pi_abc123",
 *     "status": "succeeded",
 *     "amount": 150000,
 *     "currency": "CLP"
 *   }
 * }
 */
export async function fintocWebhook(req, res) {
  // Log inmediato — ANTES de cualquier validación para confirmar que el handler es alcanzado
  console.log('[Fintoc IPN] ⚡ Webhook recibido');
  console.log('[Fintoc IPN] Headers:', JSON.stringify({
    'content-type':     req.headers['content-type'],
    'fintoc-signature': req.headers['fintoc-signature'],
    'user-agent':       req.headers['user-agent'],
  }));
  console.log('[Fintoc IPN] Body:', JSON.stringify(req.body));

  // ── 1. Verificar firma del webhook ────────────────────────────────────────
  // express.json() ya parseó el body — usamos req.body directamente.
  // Para la verificación HMAC reconstruimos el string desde req.body
  // (req.rawBody estará disponible solo si captureRawBody corrió antes).
  const signature = req.headers['fintoc-signature'];
  const rawBody   = req.rawBody ?? JSON.stringify(req.body);

  if (!signature) {
    console.warn('[Alyto Webhook] Fintoc: petición sin firma. Rechazando.');
    return res.status(400).json({ error: 'Firma requerida.' });
  }

  const isValid = verifyWebhookSignature(rawBody, signature);
  if (!isValid) {
    console.warn('[Alyto Webhook] Fintoc: firma inválida. Posible petición no autorizada.');
    return res.status(401).json({ error: 'Firma inválida.' });
  }

  // ── 2. Parsear evento ─────────────────────────────────────────────────────
  const { type, data } = req.body;

  console.info('[Alyto Webhook] Fintoc evento recibido:', {
    type,
    paymentIntentId: data?.id,
    status:          data?.status,
  });

  // ── 3. Procesar según tipo de evento ─────────────────────────────────────
  try {
    switch (type) {

      case 'payment_intent.succeeded': {
        // ── a) Buscar transacción por metadata.transactionId ─────────────────
        const transactionId = data?.metadata?.transactionId;

        if (!transactionId) {
          console.error('[Fintoc IPN] No transactionId en metadata:', JSON.stringify(data?.metadata));
          return res.status(200).json({ ok: true, message: 'Missing transactionId, ignoring' });
        }

        const transaction = await Transaction.findOne({ alytoTransactionId: transactionId });

        if (!transaction) {
          console.warn('[Fintoc IPN] Transacción no encontrada:', transactionId);
          return res.status(200).json({ ok: true, message: 'Transaction not found, ignoring' });
        }

        console.log('[Fintoc IPN] ✅ Transacción encontrada:', transactionId, '| status:', transaction.status);

        // ── b) Confirmar payin y disparar payout ─────────────────────────────
        if (transaction.status === 'payin_pending') {
          transaction.status         = 'payin_confirmed';
          transaction.payinReference = data?.id ?? transaction.payinReference;
          transaction.ipnLog.push({
            provider:   'fintoc',
            eventType:  'fintoc_payin_confirmed',
            status:     'payin_confirmed',
            rawPayload: data,
            receivedAt: new Date(),
          });
          await transaction.save();

          console.info('[Fintoc IPN] Payin confirmado — disparando payout.', {
            alytoTransactionId: transactionId,
            checkoutSessionId:  data?.id,
          });

          // dispatchPayout es async — await para capturar errores en el catch
          await dispatchPayout(transaction);
        } else {
          console.info('[Fintoc IPN] Transacción no en payin_pending — ignorando.', {
            alytoTransactionId: transactionId,
            currentStatus:      transaction.status,
          });
        }

        break;
      }

      case 'payment_intent.failed': {
        const transactionId = data?.metadata?.transactionId;
        if (transactionId) {
          await Transaction.findOneAndUpdate(
            { alytoTransactionId: transactionId },
            { $set: { status: 'failed', failureReason: data.error?.message ?? 'Pago rechazado por Fintoc.' } },
          );
        }
        console.info('[Fintoc IPN] Payin fallido.', { checkoutSessionId: data?.id, transactionId });
        break;
      }

      default:
        // Eventos informativos (ej. payment_intent.created) — no requieren acción
        console.info(`[Alyto Webhook] Fintoc: evento no procesado: ${type}`);
    }
  } catch (error) {
    console.error('[Alyto Webhook] Fintoc: error procesando evento:', {
      type,
      paymentIntentId: data?.id,
      error:           error.message,
    });
    // Responder 500 para que Fintoc reintente el webhook
    return res.status(500).json({ error: 'Error procesando el evento.' });
  }

  // Fintoc espera un 200 rápido para confirmar recepción
  return res.status(200).json({ received: true });
}

// ─── GET /api/v1/payments/withdrawal-rules/:countryCode ──────────────────────

/** In-memory cache: countryCode → { rules, cachedAt } — TTL 1 hora */
const withdrawalRulesCache = new Map();
const RULES_CACHE_TTL_MS   = 60 * 60 * 1000;  // 1 hour

/**
 * Reglas de retiro hardcodeadas para CO y PE.
 * Se usan cuando Vita no responde o no devuelve campos para ese país.
 * Los keys siguen la nomenclatura exacta que espera el endpoint de withdrawal de Vita.
 */
const FALLBACK_WITHDRAWAL_RULES = {
  CO: [
    { key: 'beneficiary_first_name',    label: 'Nombres',              type: 'text',   required: true,  min: 2,    max: 50,  options: [], placeholder: 'Ej. Juan Carlos',           when: null },
    { key: 'beneficiary_last_name',     label: 'Apellidos',            type: 'text',   required: true,  min: 2,    max: 50,  options: [], placeholder: 'Ej. García López',          when: null },
    { key: 'beneficiary_email',         label: 'Correo electrónico',   type: 'email',  required: true,  min: null, max: 80,  options: [], placeholder: 'Ej. juan@correo.com',        when: null },
    { key: 'beneficiary_address',       label: 'Dirección',            type: 'text',   required: true,  min: 3,    max: 200, options: [], placeholder: 'Ej. Calle 10 #20-30, Bogotá', when: null },
    { key: 'beneficiary_document_type', label: 'Tipo de documento',    type: 'select', required: true,  min: null, max: null, options: [
      { value: 'CC',  label: 'Cédula de ciudadanía' },
      { value: 'CE',  label: 'Cédula de extranjería' },
      { value: 'NIT', label: 'NIT' },
    ], placeholder: '', when: null },
    { key: 'beneficiary_document_number', label: 'Número de documento', type: 'text', required: true, min: 5, max: 20, options: [], placeholder: 'Ej. 1090123456', when: null },
    { key: 'transfer_type',             label: 'Tipo de transferencia', type: 'select', required: true, min: null, max: null, options: [
      { value: 'Transferencia bancaria', label: 'Transferencia bancaria' },
    ], placeholder: '', when: null },
    { key: 'bank_code',                 label: 'Banco',                type: 'select', required: true,  min: null, max: null, options: [
      { value: '0001', label: 'Bancolombia' },
      { value: '0013', label: 'Banco Bogotá' },
      { value: '0051', label: 'Davivienda' },
      { value: '0009', label: 'BBVA Colombia' },
      { value: '0023', label: 'Banco de Occidente' },
    ], placeholder: '', when: { key: 'transfer_type', value: 'Transferencia bancaria' } },
    { key: 'account_bank',              label: 'Número de cuenta',     type: 'text',   required: true,  min: 5,    max: 20,  options: [], placeholder: 'Ej. 1234567890', when: { key: 'transfer_type', value: 'Transferencia bancaria' } },
    { key: 'account_type_bank',         label: 'Tipo de cuenta',       type: 'select', required: true,  min: null, max: null, options: [
      { value: 'Cuenta de Ahorros',  label: 'Cuenta de Ahorros' },
      { value: 'Cuenta Corriente',   label: 'Cuenta Corriente' },
    ], placeholder: '', when: { key: 'transfer_type', value: 'Transferencia bancaria' } },
  ],
  PE: [
    { key: 'beneficiary_first_name',    label: 'Nombres',              type: 'text',   required: true,  min: 2,    max: 50,  options: [], placeholder: 'Ej. María',                  when: null },
    { key: 'beneficiary_last_name',     label: 'Apellidos',            type: 'text',   required: true,  min: 2,    max: 50,  options: [], placeholder: 'Ej. Quispe Torres',          when: null },
    { key: 'beneficiary_email',         label: 'Correo electrónico',   type: 'email',  required: true,  min: null, max: 80,  options: [], placeholder: 'Ej. maria@correo.pe',         when: null },
    { key: 'beneficiary_address',       label: 'Dirección',            type: 'text',   required: true,  min: 3,    max: 200, options: [], placeholder: 'Ej. Av. Arequipa 1234, Lima',  when: null },
    { key: 'beneficiary_document_type', label: 'Tipo de documento',    type: 'select', required: true,  min: null, max: null, options: [
      { value: 'DNI', label: 'DNI' },
      { value: 'CE',  label: 'Carné de extranjería' },
    ], placeholder: '', when: null },
    { key: 'beneficiary_document_number', label: 'Número de documento', type: 'text', required: true, min: 8, max: 12, options: [], placeholder: 'Ej. 12345678', when: null },
    { key: 'bank_code',                 label: 'Banco',                type: 'select', required: true,  min: null, max: null, options: [
      { value: 'BCP',       label: 'BCP (Banco de Crédito)' },
      { value: 'INTERBANK', label: 'Interbank' },
      { value: 'BBVA',      label: 'BBVA Perú' },
      { value: 'SCOTIABANK',label: 'Scotiabank Perú' },
      { value: 'BANBIF',    label: 'BanBif' },
    ], placeholder: '', when: null },
    { key: 'account_bank',              label: 'Número de cuenta o CCI', type: 'text', required: true, min: 10, max: 22, options: [], placeholder: 'Ej. 00219100123456789012', when: null },
    { key: 'account_type_bank',         label: 'Tipo de cuenta',       type: 'select', required: true,  min: null, max: null, options: [
      { value: 'Cuenta de Ahorros', label: 'Cuenta de Ahorros' },
      { value: 'Cuenta Corriente',  label: 'Cuenta Corriente' },
    ], placeholder: '', when: null },
  ],
};

/** Normaliza un campo de la respuesta de Vita al formato canónico del frontend */
function transformVitaField(f) {
  if (!f?.key) return null;
  let type = (f.type ?? 'text').toLowerCase();
  if (!['text', 'select', 'email', 'phone'].includes(type)) type = 'text';
  const placeholder = (f.min && f.max) ? `${f.min}–${f.max} caracteres` : (f.max ? `Máx. ${f.max} caracteres` : '');
  return {
    key:         f.key,
    label:       f.name ?? f.key,
    type,
    required:    true,
    options:     Array.isArray(f.options) ? f.options : [],
    min:         f.min  ?? null,
    max:         f.max  ?? null,
    placeholder: f.placeholder ?? placeholder,
    when:        f.when ?? null,
  };
}

/**
 * GET /api/v1/payments/withdrawal-rules/:countryCode
 *
 * Devuelve los campos requeridos para crear un withdrawal en Vita hacia el
 * país indicado. La respuesta está normalizada al formato { key, label, type,
 * required, options, min, max, placeholder, when } para renderizado dinámico
 * en el formulario de beneficiario del frontend.
 *
 * Caching: resultados en memoria por 1 hora para no saturar a Vita.
 * Fallback: si Vita no responde, devuelve reglas hardcodeadas para CO/PE.
 *
 * Auth: Bearer JWT (protect middleware)
 * Params: countryCode — ISO alpha-2 mayúsculas (ej. CO, PE, AR)
 */
export async function getWithdrawalRulesController(req, res) {
  const countryCode = (req.params.countryCode ?? '').toUpperCase();

  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    return res.status(400).json({ error: 'countryCode inválido. Usar ISO alpha-2 (ej. CO, PE).' });
  }

  // ── 1. Revisar caché ──────────────────────────────────────────────────────
  const cached = withdrawalRulesCache.get(countryCode);
  if (cached && (Date.now() - cached.cachedAt) < RULES_CACHE_TTL_MS) {
    return res.status(200).json(cached.rules);
  }

  // ── 2. Obtener desde Vita ──────────────────────────────────────────────────
  let rules;
  try {
    const vitaResponse = await getVitaWithdrawalRules();
    const country      = countryCode.toLowerCase();
    const fields       = vitaResponse?.rules?.[country]?.fields ?? [];

    if (fields.length === 0) {
      throw new Error(`Vita no devuelve campos para ${countryCode}`);
    }

    rules = fields.map(transformVitaField).filter(Boolean);
    withdrawalRulesCache.set(countryCode, { rules, cachedAt: Date.now() });

    console.info(`[Alyto WithdrawalRules] Reglas cargadas desde Vita para ${countryCode}: ${rules.length} campos.`);
  } catch (err) {
    // ── 3. Fallback a reglas hardcodeadas ─────────────────────────────────────
    console.warn(`[Alyto WithdrawalRules] Vita no disponible para ${countryCode} — usando fallback.`, err.message);

    Sentry.captureMessage(`WithdrawalRules fallback activado para ${countryCode}`, {
      level: 'warning',
      extra: { error: err.message, countryCode },
    });

    rules = FALLBACK_WITHDRAWAL_RULES[countryCode] ?? null;

    if (!rules) {
      return res.status(404).json({
        error: `No hay reglas de retiro disponibles para ${countryCode} en este momento.`,
      });
    }

    // Cachear fallback con TTL reducido (10 min) para reintentar Vita pronto
    withdrawalRulesCache.set(countryCode, { rules, cachedAt: Date.now() - (RULES_CACHE_TTL_MS - 10 * 60 * 1000) });
  }

  return res.status(200).json(rules);
}

// ─── POST /api/v1/payments/crossborder ───────────────────────────────────────

/**
 * Inicia un pago cross-border vía Vita Wallet.
 *
 * Crea una payment_order en Vita, registra la transacción en BD con los datos
 * del beneficiario, y devuelve la URL de pago para el widget del frontend.
 *
 * Body esperado:
 * {
 *   "corridorId":     "CL-CO-001",         ← corridorId del TransactionConfig
 *   "originAmount":   150000,               ← CLP (entero)
 *   "payinMethod":    "vitaWallet",         ← siempre "vitaWallet" para este flujo
 *   "beneficiaryData": { ...vitaFields },   ← formato dinámico (llaves de Vita)
 *   "beneficiary":    { ...legacyFields }   ← formato legado (compatibilidad)
 * }
 *
 * Respuesta exitosa (201):
 * {
 *   "transactionId":  "ALY-D-...",
 *   "payinUrl":       "https://vitawallet.io/...",
 *   "status":         "payin_pending"
 * }
 *
 * Auth: Bearer JWT (protect middleware)
 */
export async function initCrossBorderPayment(req, res) {
  const {
    corridorId,
    originAmount,
    beneficiaryData,
    beneficiary: legacyBeneficiary,
    // Datos de la cotización previa (opcionales — si el frontend los pasa se guardan)
    destinationAmount: quotedDestAmount,
    exchangeRate:      quotedExchangeRate,
  } = req.body;
  const userId = req.user?._id;

  // ── 1. Validación de entrada ──────────────────────────────────────────────
  if (!corridorId || !originAmount) {
    return res.status(400).json({ error: 'Los campos corridorId y originAmount son requeridos.' });
  }
  const amount = Number(originAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'originAmount debe ser un número positivo.' });
  }
  if (!beneficiaryData && !legacyBeneficiary) {
    return res.status(400).json({ error: 'Se requiere beneficiaryData o beneficiary.' });
  }

  // ── 2. Buscar corredor activo ─────────────────────────────────────────────
  let corridor;
  try {
    corridor = await TransactionConfig.findOne({ corridorId, isActive: true }).lean();
  } catch (err) {
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
  if (!corridor) {
    return res.status(404).json({ error: `Corredor '${corridorId}' no encontrado o inactivo.` });
  }

  // Validar que el corredor corresponde a la moneda origen del usuario
  const ENTITY_CURRENCY_MAP_CBP = { SpA: 'CLP', SRL: 'BOB', LLC: 'USD' };
  const userOriginCurrency = ENTITY_CURRENCY_MAP_CBP[req.user?.legalEntity] ?? 'USD';
  if (corridor.originCurrency !== userOriginCurrency) {
    return res.status(403).json({
      error: 'Este corredor no está disponible para tu cuenta.',
      expected: userOriginCurrency,
      corridorCurrency: corridor.originCurrency,
    });
  }

  // ── 3. Calcular fees desde TransactionConfig (configurable por corredor) ─────
  const payinFee        = Math.round(amount * (corridor.payinFeePercent / 100));
  const alytoCSpread    = Math.round(amount * (corridor.alytoCSpread / 100));
  const fixedFee        = corridor.fixedFee ?? 0;
  const profitRetention = Math.round(amount * (corridor.profitRetentionPercent / 100));
  const payoutFee       = corridor.payoutFeeFixed ?? 0;

  console.log('[CrossBorder] Fees desde TransactionConfig:');
  console.log('  corridorId:', corridorId);
  console.log('  alytoCSpread%:', corridor.alytoCSpread);
  console.log('  fixedFee:', corridor.fixedFee);
  console.log('  payinFeePercent:', corridor.payinFeePercent);
  console.log('  profitRetentionPercent:', corridor.profitRetentionPercent);
  console.log('  Fees calculados:', { payinFee, alytoCSpread, fixedFee, profitRetention, payoutFee });

  // ── 4. Crear payin según el método del corredor ───────────────────────────
  //
  //   fintoc    → Checkout Session en Fintoc. Fondos llegan a cuenta SpA en Chile.
  //               El payout a Vita se dispara solo tras IPN de confirmación.
  //   vitaWallet → payment_order en Vita (ej. AR, BR donde el usuario paga en su país).
  //

  // Generar alytoTransactionId ANTES del call a Fintoc para incluirlo en el metadata.
  // El IPN de confirmación usará este ID para encontrar la transacción en BD.
  const alytoTransactionId = `ALY-${corridor.routingScenario ?? 'D'}-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  let payinProviderRef         = null;  // ID externo para lookup en IPN
  let payinUrl                 = null;  // Token/URL que abre el widget de pago
  let payinProvider            = 'unknown';
  let manualPaymentInstructions = null; // Solo para payinMethod === 'manual'

  if (corridor.payinMethod === 'fintoc') {
    // ── Payin Fintoc (Chile — AV Finance SpA) ─────────────────────────────
    const user = await User.findById(userId).select('email firstName lastName').lean();

    let fintocResult;
    try {
      fintocResult = await createWidgetLink({
        amount:         Math.round(amount),
        currency:       'CLP',
        metadata: {
          transactionId: alytoTransactionId,
          corridorId:    corridor.corridorId,
        },
        success_url:    `${process.env.APP_URL}/success`,
        cancel_url:     `${process.env.APP_URL}/cancel`,
        customer_email: user?.email,
      });
    } catch (err) {
      console.error('[Alyto CrossBorder] Error creando Checkout Session en Fintoc:', {
        corridorId, amount, error: err.message,
      });
      Sentry.captureException(err, {
        tags:  { component: 'initCrossBorderPayment', payinMethod: 'fintoc' },
        extra: { corridorId, amount },
      });
      return res.status(502).json({ error: 'No se pudo crear la orden de pago. Intenta nuevamente.' });
    }

    payinProviderRef = fintocResult.id;
    payinUrl         = fintocResult.url;
    payinProvider    = 'fintoc';

    console.log('[CrossBorder] Fintoc Checkout Session creado:', {
      checkoutSessionId: fintocResult.id,
      payinUrl:          payinUrl ? '[PRESENTE]' : '[AUSENTE]',
    });

  } else if (corridor.payinMethod === 'manual') {
    // ── Payin Manual (Bolivia — AV Finance SRL) ───────────────────────────
    // No se llama a ningún proveedor externo. El usuario transfiere a la
    // cuenta bancaria de SRL y el admin confirma manualmente desde el ledger.
    payinProvider    = 'manual';
    payinProviderRef = null;
    payinUrl         = null;

    manualPaymentInstructions = {
      bankName:      process.env.SRL_BANK_NAME      ?? 'Banco Bisa',
      accountHolder: process.env.SRL_ACCOUNT_HOLDER ?? 'AV Finance SRL',
      accountNumber: process.env.SRL_ACCOUNT_NUMBER ?? '',
      accountType:   'Cuenta Corriente',
      currency:      corridor.originCurrency,
      amount,
      reference:     alytoTransactionId,
      instructions:  'Realizar transferencia bancaria indicando el número de referencia en el concepto del pago. El pago será verificado manualmente en un plazo de 2-4 horas hábiles.',
    };

    console.log('[CrossBorder] Payin manual SRL — instrucciones generadas para:', alytoTransactionId);

  } else {
    // ── Payin Vita (países donde el usuario paga localmente via Vita) ──────
    let vitaPayinResult;
    try {
      vitaPayinResult = await createPayin({
        amount:               amount,
        country_iso_code:     corridor.originCountry ?? 'CL',
        issue:                `Pago Alyto — ${corridor.corridorId}`,
        success_redirect_url: `${process.env.APP_URL ?? 'https://app.alyto.com'}/success`,
      });
    } catch (err) {
      console.error('[Alyto CrossBorder] Error creando payment_order en Vita:', {
        corridorId, amount, error: err.message,
      });
      Sentry.captureException(err, {
        tags:  { component: 'initCrossBorderPayment', payinMethod: 'vita' },
        extra: { corridorId, amount },
      });
      return res.status(502).json({ error: 'No se pudo crear la orden de pago. Intenta nuevamente.' });
    }

    payinProviderRef =
      vitaPayinResult?.data?.id ??
      vitaPayinResult?.id ??
      vitaPayinResult?.payment_order?.id ??
      null;
    payinUrl =
      vitaPayinResult?.data?.attributes?.url ??
      vitaPayinResult?.url ??
      vitaPayinResult?.payment_order?.url ??
      null;
    payinProvider = 'vitaWallet';

    console.log('[CrossBorder] Vita payinUrl extraída:', payinUrl, '| vitaPayinId:', payinProviderRef);
  }

  // ── 5. Construir sub-documento de beneficiario ────────────────────────────
  // beneficiaryData (nuevo formato dinámico): almacenar en dynamicFields
  // beneficiary (legado): mapear a los campos nombrados del schema
  let beneficiaryDoc = {};
  if (beneficiaryData && typeof beneficiaryData === 'object') {
    // Separar campos fc_* (internos de Vita, no son datos del beneficiario)
    const vitaFields = Object.fromEntries(
      Object.entries(beneficiaryData).filter(([k]) => !k.startsWith('fc_')),
    );
    beneficiaryDoc = { dynamicFields: vitaFields };
  } else if (legacyBeneficiary) {
    const b = legacyBeneficiary;
    beneficiaryDoc = {
      firstName:      b.firstName  ?? b.fullName?.split(' ')[0] ?? '',
      lastName:       b.lastName   ?? b.fullName?.split(' ').slice(1).join(' ') ?? '',
      email:          b.email      ?? '',
      phone:          b.phone      ?? '',
      documentType:   b.documentType  ?? b.document_type  ?? '',
      documentNumber: b.documentNumber ?? b.document_id   ?? '',
      bankCode:       b.bankName   ?? b.bank_code        ?? '',
      accountBank:    b.accountNumber ?? b.account_bank  ?? '',
      accountType:    b.accountType ?? b.account_type    ?? '',
      address:        b.address    ?? '',
    };
  }

  // ── 6. Crear transacción en BD ────────────────────────────────────────────
  // alytoTransactionId ya fue generado antes del call a Fintoc (Fix: metadata del IPN)

  let transaction;
  try {
    transaction = await Transaction.create({
      userId,
      legalEntity:     corridor.legalEntity  ?? 'LLC',
      operationType:   'crossBorderPayment',
      routingScenario: corridor.routingScenario ?? 'D',
      corridorId:      corridor._id,

      originalAmount:      amount,
      originCurrency:      corridor.originCurrency,
      originCountry:       corridor.originCountry,
      destinationCountry:  corridor.destinationCountry,
      destinationCurrency: corridor.destinationCurrency,
      // Activo de tránsito en Stellar (USDC para corredores SRL Bolivia)
      // El monto exacto de USDC se calcula y guarda en dispatchPayout al confirmar payin.
      ...(corridor.legalEntity === 'SRL' ? { digitalAsset: 'USDC' } : {}),
      // Montos y tasa de la cotización previa (desnormalizados para historial)
      ...(quotedDestAmount    != null ? { destinationAmount: quotedDestAmount }       : {}),
      ...(quotedExchangeRate  != null ? { exchangeRate: quotedExchangeRate, exchangeRateLockedAt: new Date() } : {}),

      fees: {
        payinFee,
        alytoCSpread,
        fixedFee,
        payoutFee,
        profitRetention,
        totalDeducted: payinFee + alytoCSpread + fixedFee + payoutFee,
      },

      beneficiary: beneficiaryDoc,

      providersUsed: [`payin:${payinProvider}`],
      paymentLegs: [{
        stage:      'payin',
        provider:   payinProvider,
        status:     'pending',
        externalId: payinProviderRef ? String(payinProviderRef) : undefined,
      }],

      payinReference:      payinProviderRef ? String(payinProviderRef) : undefined,
      paymentInstructions: manualPaymentInstructions ?? undefined,
      status:              corridor.payinMethod === 'manual' ? 'pending' : 'payin_pending',
      alytoTransactionId,
    });
  } catch (err) {
    console.error('[Alyto CrossBorder] Error persistiendo transacción en BD:', {
      corridorId, error: err.message,
    });
  }

  // ── 7. Emails para payin manual ───────────────────────────────────────────
  if (corridor.payinMethod === 'manual' && transaction) {
    const user = await User.findById(userId).select('email firstName').lean();
    if (user) {
      // Email al usuario con instrucciones de transferencia
      sendEmail(...EMAILS.manualPayinInstructions(user, transaction, manualPaymentInstructions))
        .catch(err => console.error('[CrossBorder] Error email instrucciones:', err.message));
    }
    // Email al admin notificando payin pendiente
    sendEmail(...EMAILS.adminManualPayinAlert(transaction, manualPaymentInstructions))
      .catch(err => console.error('[CrossBorder] Error email admin payin manual:', err.message));
  }

  // ── 8. Respuesta al cliente ───────────────────────────────────────────────
  if (corridor.payinMethod === 'manual') {
    return res.status(201).json({
      transactionId:       alytoTransactionId,
      status:              'pending',
      payinMethod:         'manual',
      paymentInstructions: manualPaymentInstructions,
    });
  }

  return res.status(201).json({
    transactionId: alytoTransactionId,
    payinUrl:      payinUrl ?? null,
    payinMethod:   payinProvider,
    status:        'payin_pending',
  });
}

// ─── GET /api/v1/payments/quote ───────────────────────────────────────────────

/**
 * Extrae la tasa de cambio y el costo fijo de la respuesta de Vita GET /prices.
 *
 * Estructura real de la respuesta (documentada por Vita):
 * {
 *   withdrawal: {
 *     prices: {
 *       attributes: {
 *         "clp_sell": { "co": 0.0045, "pe": 0.29, "ar": ..., "bo": ..., "mx": ..., "br": ... },
 *         "usd_sell": { "co": 4200,   "pe": 3.8,  ... }
 *       }
 *     },
 *     "co": { fixed_cost: 200,  ... },
 *     "pe": { fixed_cost: 0.5,  ... },
 *     ...
 *   },
 *   vita_sent: { ... },
 *   valid_until: "2026-03-20T15:00:00Z"
 * }
 *
 * Lógica de lookup:
 * Estructura real de la respuesta de Vita /prices (solo existe clp_sell):
 *   withdrawal.prices.attributes.clp_sell[countryKey]          → tasa CLP→destino
 *   withdrawal.prices.attributes.fixed_cost[countryKey]        → costo fijo en moneda destino
 *   withdrawal.prices.attributes.valid_until                   → expiración ISO8601
 *
 * Para originCurrency USD/USDC: Vita NO tiene usd_sell. Se deriva via cross-rate:
 *   usd_to_dest = clp_sell[dest] / clp_sell["us"]
 *   Ejemplo: clp_sell.co=4.343071 / clp_sell.us=0.001035 ≈ 4196 COP/USD
 *
 * @param {object} vitaPricesResponse  — Respuesta cruda de getPrices()
 * @param {string} originCurrency      — 'CLP' | 'USD' | 'USDC'
 * @param {string} destinationCountry  — ISO alpha-2 mayúsculas (ej. 'CO', 'CL')
 * @returns {{ rate: number, fixedCost: number, validUntil: string|null } | null}
 */
function extractVitaPricing(vitaPricesResponse, originCurrency, destinationCountry) {
  const attrs = vitaPricesResponse?.withdrawal?.prices?.attributes;
  if (!attrs) return null;

  const countryKey = destinationCountry.toLowerCase();
  const origin     = originCurrency.toUpperCase();
  let rate;

  if (origin === 'CLP') {
    // Tasa directa de Vita: 1 CLP → N unidades de moneda destino
    const raw = attrs.clp_sell?.[countryKey];
    if (raw == null) return null;
    rate = Number(raw);
  } else if (origin === 'USD' || origin === 'USDC') {
    // Vita solo provee clp_sell. Derivamos la tasa USD via cross-rate CLP:
    //   1 USD = (clp_sell[dest] / clp_sell["us"]) unidades de moneda destino
    // Ejemplo BO→CO: 4.343071 / 0.001035 ≈ 4196 COP/USD
    // Ejemplo BO→CL: 1.0      / 0.001035 ≈ 966  CLP/USD
    // Ejemplo BO→US: 0.001035 / 0.001035 = 1.0  USD/USD ✓
    const clpToDest = Number(attrs.clp_sell?.[countryKey] ?? NaN);
    const clpToUsd  = Number(attrs.clp_sell?.['us']       ?? NaN);
    if (!isFinite(clpToDest) || !isFinite(clpToUsd) || clpToUsd <= 0) return null;
    rate = clpToDest / clpToUsd;
  } else {
    return null;  // moneda origen no soportada
  }

  if (!isFinite(rate) || rate <= 0) return null;

  // fixed_cost está en attributes.fixed_cost[countryKey] (en moneda destino)
  const fixedCost  = Number(attrs.fixed_cost?.[countryKey] ?? 0);
  const validUntil = attrs.valid_until ?? null;

  return { rate, fixedCost, validUntil };
}

/**
 * GET /api/v1/payments/quote
 *
 * Cotización en tiempo real para un crossBorderPayment.
 * Devuelve el desglose completo de fees y el monto que recibirá el beneficiario.
 * La cotización expira en 3 minutos — el cliente debe usarla para iniciar la
 * transacción antes de que venza (el motor rehará el cálculo con tasa fresca).
 *
 * Query params:
 *   originCountry      — ISO alpha-2 (ej. "CL")
 *   destinationCountry — ISO alpha-2 (ej. "CO")
 *   originAmount       — Monto positivo en la moneda de origen del corredor
 *
 * Auth: Bearer JWT (protect middleware)
 */
export async function getQuote(req, res) {
  let { originCountry, destinationCountry, originAmount } = req.query;
  const userId = req.user?._id?.toString();

  // ── 1. Validar query params — originCountry con fallback por legalEntity ────
  if (!originCountry && req.user?.legalEntity) {
    const entityCountryMap = { SpA: 'CL', SRL: 'BO', LLC: 'US' };
    originCountry = entityCountryMap[req.user.legalEntity] ?? null;
    if (originCountry) {
      console.info(`[Alyto Quote] originCountry inferido de legalEntity ${req.user.legalEntity} → ${originCountry} | userId: ${userId}`);
    }
  }

  if (!originCountry || !destinationCountry || !originAmount) {
    return res.status(400).json({
      error: 'Parámetros requeridos: originCountry, destinationCountry, originAmount.',
    });
  }

  const amount = Number(originAmount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'originAmount debe ser un número positivo.',
    });
  }

  const origin = originCountry.toUpperCase();
  const dest   = destinationCountry.toUpperCase();

  // Determinar moneda origen según entidad del usuario autenticado
  const ENTITY_CURRENCY_MAP = { SpA: 'CLP', SRL: 'BOB', LLC: 'USD' };
  const userOriginCurrency  = ENTITY_CURRENCY_MAP[req.user?.legalEntity] ?? 'USD';

  // ── 2. Buscar corredor activo en TransactionConfig ─────────────────────────
  let corridor;
  try {
    corridor = await TransactionConfig.findOne({
      originCountry:      origin,
      destinationCountry: dest,
      originCurrency:     userOriginCurrency,
      isActive:           true,
    }).lean();
  } catch (err) {
    console.error('[Alyto Quote] Error buscando corredor en BD:', {
      originCountry: origin,
      destinationCountry: dest,
      originCurrency: userOriginCurrency,
      userId,
      error: err.message,
    });
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!corridor) {
    console.warn('[Alyto Quote] Corredor no encontrado:', {
      originCountry: origin,
      destinationCountry: dest,
      originCurrency: userOriginCurrency,
      userId,
      legalEntity: req.user?.legalEntity,
    });
    return res.status(404).json({
      error: `Corredor no disponible para tu país de origen (${origin} → ${dest}).`,
    });
  }

  // Validar monto mínimo del corredor
  if (amount < corridor.minAmountOrigin) {
    return res.status(400).json({
      error:  `El monto mínimo para este corredor es ${corridor.minAmountOrigin} ${corridor.originCurrency}.`,
      min:    corridor.minAmountOrigin,
      currency: corridor.originCurrency,
    });
  }

  if (corridor.maxAmountOrigin !== null && amount > corridor.maxAmountOrigin) {
    return res.status(400).json({
      error:  `El monto máximo para este corredor es ${corridor.maxAmountOrigin} ${corridor.originCurrency}.`,
      max:    corridor.maxAmountOrigin,
      currency: corridor.originCurrency,
    });
  }

  // ── 3. Obtener precios en tiempo real desde Vita ──────────────────────────
  // Para corredores manuales (BOB): primero convertir BOB→USD (tasa ASFI del corredor),
  // luego consultar Vita por la tasa USD→destino. Vita no tiene precios para BOB.
  // Para corredores estándar: consultar Vita directamente con la moneda de origen.

  const round2 = n => Math.round(n * 100) / 100;

  const payinFee        = amount * (corridor.payinFeePercent / 100);
  const alytoCSpread    = amount * (corridor.alytoCSpread / 100);
  const fixedFee        = corridor.fixedFee;
  const profitRetention = amount * (corridor.profitRetentionPercent / 100);
  const amountAfterFees = amount - payinFee - alytoCSpread - fixedFee - profitRetention;

  if (amountAfterFees <= 0) {
    return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
  }

  let vitaResponse;
  try {
    vitaResponse = await getPrices();
  } catch (err) {
    console.error('[Alyto Quote] Vita /prices no disponible:', {
      corridorId: corridor.corridorId, userId, error: err.message,
    });
    return res.status(503).json({
      error: 'Servicio de tasas no disponible. Intenta nuevamente en unos momentos.',
    });
  }

  // ── 3a. Corredores manuales (SRL Bolivia): BOB → USDC → destino ────────────
  //
  // Ruta de conversión: BOB → USDC (tasa configurada por admin en corredor)
  //                     USDC → destino (tasa USD en tiempo real de Vita)
  //
  // La tasa admin (manualExchangeRate) debe haberse fijado previamente vía:
  //   PATCH /admin/corridors/:corridorId/rate
  //
  // Sin tasa configurada (manualExchangeRate === 0): la cotización no puede procesarse.
  if (corridor.payinMethod === 'manual') {
    const bobPerUsdc = corridor.manualExchangeRate;

    if (!bobPerUsdc || bobPerUsdc <= 0) {
      console.error('[Alyto Quote] Corredor manual sin tasa configurada:', {
        corridorId: corridor.corridorId, userId,
      });
      return res.status(503).json({
        error:   'La tasa de cambio de este corredor aún no ha sido configurada por el operador.',
        code:    'RATE_NOT_CONFIGURED',
        action:  'El administrador debe fijar la tasa BOB/USDC desde el panel de configuración.',
      });
    }

    // ── Paso 1: BOB → USDC (tasa fijada por admin, refleja tasa ASFI) ────────
    // amountAfterFees ya descuenta: alytoCSpread + fixedFee + profitRetention
    const usdcTransitAmount = round2(amountAfterFees / bobPerUsdc);

    if (usdcTransitAmount <= 0) {
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    // ── Paso 2: USDC → destino (tasa USD en tiempo real de Vita) ─────────────
    // USDC ≈ 1:1 USD, por lo que usamos las tasas USD de Vita directamente.
    const vitaPricingUSD = extractVitaPricing(vitaResponse, 'USD', dest);

    if (!vitaPricingUSD) {
      console.error('[Alyto Quote] Vita no tiene tasa USD→' + dest + ' para corredor manual.', {
        corridorId: corridor.corridorId, userId,
      });
      return res.status(503).json({
        error: 'Tasa de cambio no disponible para este corredor. Intenta nuevamente.',
      });
    }

    const { rate: usdcToDestRate, fixedCost: vitaFixedCost, validUntil } = vitaPricingUSD;

    // payoutFee: costo fijo de Vita para este destino (en moneda destino)
    const payoutFee       = vitaFixedCost > 0 ? vitaFixedCost : corridor.payoutFeeFixed;
    const destinationAmount = round2((usdcTransitAmount * usdcToDestRate) - payoutFee);

    if (destinationAmount <= 0) {
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    // ── Tasa efectiva compuesta: BOB → dest ───────────────────────────────────
    // effectiveRate = destAmount / originAmount = cuántas unidades dest recibe por 1 BOB
    const effectiveExchangeRate = round2(destinationAmount / amount);

    // ── Ganancia de Alyto en USDC ─────────────────────────────────────────────
    // La ganancia es la diferencia entre el BOB bruto y el neto, convertida a USDC.
    const alytoProfitBOB  = payinFee + alytoCSpread + fixedFee + profitRetention;
    const alytoProfitUSDC = round2(alytoProfitBOB / bobPerUsdc);

    const localExpiry    = new Date(Date.now() + 3 * 60 * 1000);
    const vitaExpiry     = validUntil ? new Date(validUntil) : null;
    const quoteExpiresAt = (vitaExpiry && vitaExpiry < localExpiry) ? vitaExpiry : localExpiry;

    console.info('[Alyto Quote] Cotización manual BOB→USDC→' + dest + ':', {
      corridorId:       corridor.corridorId,
      userId,
      originAmount:     amount,
      bobPerUsdc,
      usdcTransitAmount,
      usdcToDestRate,
      destinationAmount,
      alytoProfitUSDC,
    });

    return res.status(200).json({
      corridorId:           corridor.corridorId,
      originAmount:         amount,
      originCurrency:       corridor.originCurrency,
      destinationAmount,
      destinationCurrency:  corridor.destinationCurrency,
      exchangeRate:         effectiveExchangeRate,
      // ── Ruta de conversión ───────────────────────────────────────────────
      isManualCorridor:     true,
      conversionPath:       `${corridor.originCurrency} → USDC → ${corridor.destinationCurrency}`,
      stellarAsset:         'USDC',
      usdcTransitAmount,     // USDC que viajan por Stellar como highway
      bobPerUsdc,            // Tasa admin: 1 USDC = N BOB
      usdcToDestRate,        // Tasa Vita: 1 USDC → N dest
      // ── Fees desglosados ─────────────────────────────────────────────────
      fees: {
        payinFee:        round2(payinFee),
        alytoCSpread:    round2(alytoCSpread),
        fixedFee:        round2(fixedFee),
        payoutFee:       round2(payoutFee),
        profitRetention: round2(profitRetention),
        total:           round2(payinFee + alytoCSpread + fixedFee + profitRetention),
        alytoProfitUSDC,  // Ganancia total Alyto expresada en USDC
      },
      quoteExpiresAt,
      payinMethod:  corridor.payinMethod,
      payoutMethod: corridor.payoutMethod,
      legalEntity:  corridor.legalEntity,
    });
  }

  // ── 3b. Corredores estándar: tasa directa desde Vita ──────────────────────
  const vitaPricing = extractVitaPricing(
    vitaResponse,
    corridor.originCurrency,
    dest,
  );

  if (!vitaPricing) {
    console.error('[Alyto Quote] Tasa de cambio no encontrada en respuesta Vita:', {
      corridorId:          corridor.corridorId,
      originCurrency:      corridor.originCurrency,
      destinationCountry:  dest,
      userId,
    });
    return res.status(503).json({
      error: 'Tasa de cambio no disponible para este corredor. Intenta nuevamente.',
    });
  }

  const { rate: exchangeRate, fixedCost: vitaFixedCost, validUntil } = vitaPricing;

  // ── 4. Calcular desglose de fees (corredores estándar) ────────────────────
  // payoutFee: usar fixed_cost de Vita si está disponible; si no, el valor
  // estático del TransactionConfig actúa como fallback (ej. en mantenimiento de Vita)
  const payoutFee = vitaFixedCost > 0 ? vitaFixedCost : corridor.payoutFeeFixed;

  const destinationAmount = round2((amountAfterFees * exchangeRate) - payoutFee);

  if (destinationAmount <= 0) {
    return res.status(400).json({
      error: 'Monto insuficiente para cubrir los fees del corredor.',
    });
  }

  // ── 5. Construir y devolver cotización ────────────────────────────────────
  // quoteExpiresAt: el menor entre "ahora + 3 min" y el valid_until de Vita
  const localExpiry = new Date(Date.now() + 3 * 60 * 1000);
  const vitaExpiry  = validUntil ? new Date(validUntil) : null;
  const quoteExpiresAt = (vitaExpiry && vitaExpiry < localExpiry) ? vitaExpiry : localExpiry;

  return res.status(200).json({
    corridorId:          corridor.corridorId,
    originAmount:        amount,
    originCurrency:      corridor.originCurrency,
    destinationAmount,
    destinationCurrency: corridor.destinationCurrency,
    exchangeRate,
    fees: {
      payinFee:        round2(payinFee),
      alytoCSpread:    round2(alytoCSpread),
      fixedFee:        round2(fixedFee),
      payoutFee:       round2(payoutFee),
      profitRetention: round2(profitRetention),
      totalDeducted:   round2(payinFee + alytoCSpread + fixedFee + payoutFee),
    },
    payinMethod:  corridor.payinMethod,
    payoutMethod: corridor.payoutMethod,
    entity:       corridor.legalEntity,
    quoteExpiresAt,
  });
}

// ─── GET /api/v1/payments/transactions ───────────────────────────────────────

/**
 * Historial de transacciones del usuario autenticado.
 * El usuario solo ve sus propias transacciones (filtrado por userId del JWT).
 *
 * Query params:
 *   status {String}  — filtrar por un status específico (opcional)
 *   page   {Number}  — número de página, default 1
 *   limit  {Number}  — ítems por página, default 10 (máx. 50)
 *
 * Auth: Bearer JWT (protect middleware)
 */
export async function getTransactionHistory(req, res) {
  const userId = req.user._id;

  // ── 1. Parsear y validar parámetros ───────────────────────────────────────
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const skip  = (page - 1) * limit;

  const VALID_STATUSES = [
    'initiated', 'payin_pending', 'payin_confirmed', 'payin_completed',
    'processing', 'in_transit', 'payout_pending', 'payout_sent',
    'completed', 'failed', 'refunded',
  ];

  const filter = { userId };
  if (req.query.status) {
    if (!VALID_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ error: `Status inválido: ${req.query.status}` });
    }
    filter.status = req.query.status;
  }

  // ── 2. Consultar BD ────────────────────────────────────────────────────────
  let transactions, total;
  try {
    [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('corridorId', 'corridorId payinMethod')
        .lean(),
      Transaction.countDocuments(filter),
    ]);
  } catch (err) {
    console.error('[Alyto Transactions] Error consultando historial:', err.message);
    Sentry.captureException(err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  // ── 3. Formatear respuesta ─────────────────────────────────────────────────
  const formatted = transactions.map((tx) => {
    const ben        = tx.beneficiary ?? {};
    const rawAccount = ben.accountBank ?? '';
    const maskedAccount = rawAccount.length >= 4
      ? `****${rawAccount.slice(-4)}`
      : rawAccount ? '****' : null;

    const corridor = tx.corridorId ?? {};

    return {
      transactionId:       tx.alytoTransactionId || String(tx._id),
      status:              tx.status,
      originAmount:        tx.originalAmount,
      originCurrency:      tx.originCurrency,
      destinationAmount:   tx.destinationAmount   ?? null,
      destinationCurrency: tx.destinationCurrency ?? null,
      beneficiary: {
        fullName:               [ben.firstName, ben.lastName].filter(Boolean).join(' ') || null,
        beneficiary_first_name: ben.firstName ?? null,
        beneficiary_last_name:  ben.lastName  ?? null,
        bankName:               ben.bankCode  ?? null,
        accountNumber:          maskedAccount,
      },
      payinMethod:       corridor.payinMethod ?? (tx.paymentLegs?.[0]?.provider ?? null),
      corridorId:        corridor.corridorId  ?? null,
      estimatedDelivery: '1 día hábil',
      createdAt:         tx.createdAt,
      updatedAt:         tx.updatedAt,
    };
  });

  // ── 4. Respuesta ──────────────────────────────────────────────────────────
  return res.status(200).json({
    transactions: formatted,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
}

// ─── GET /api/v1/payments/:transactionId/status ───────────────────────────────

/**
 * Consulta el estado de una transacción propia del usuario autenticado.
 * Usado por el frontend en polling cada ~5 segundos durante el Step 5
 * (widget de pago activo).
 *
 * Seguridad:
 *   - Requiere JWT válido (protect middleware).
 *   - La búsqueda incluye userId del token → un usuario no puede ver
 *     transacciones ajenas aunque conozca el transactionId.
 *   - El ipnLog y datos internos nunca se exponen al frontend.
 *   - accountNumber se enmascara: muestra solo los últimos 4 dígitos.
 *
 * Mapeo de fees (feeBreakdown del modelo → campos del response):
 *   payinFee      ← feeBreakdown.providerFee  (fee del proveedor de pay-in)
 *   alytyCSpread  ← feeBreakdown.alytoFee     (spread de Alyto)
 *   fixedFee      ← 0                          (no almacenado por separado)
 *   payoutFee     ← feeBreakdown.networkFee   (fee de tránsito/red)
 *   totalDeducted ← feeBreakdown.totalFee
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export async function getTransactionStatus(req, res) {
  const { transactionId } = req.params;
  const userId = req.user._id;

  console.log('[Status] buscando alytoTransactionId:', transactionId, '| userId:', userId.toString());

  // ── 1. Buscar transacción del usuario ─────────────────────────────────────
  let transaction;
  try {
    transaction = await Transaction
      .findOne({ alytoTransactionId: transactionId, userId })
      .populate('corridorId', 'payinMethod')
      .lean();
  } catch (err) {
    console.error('[Alyto Status] Error buscando transacción:', {
      transactionId,
      userId: userId.toString(),
      error:  err.message,
    });
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!transaction) {
    // Segundo intento sin filtro de userId — para detectar si el problema es el userId
    const exists = await Transaction.exists({ alytoTransactionId: transactionId }).lean();
    console.warn('[Alyto Status] Transacción no encontrada.', {
      transactionId,
      userId:        userId.toString(),
      existsWithoutUserFilter: !!exists,
    });
    return res.status(404).json({
      error:         'Transacción no encontrada.',
      transactionId,
    });
  }

  // ── 2. Enmascarar número de cuenta del beneficiario ───────────────────────
  const rawAccount    = transaction.beneficiary?.accountBank ?? '';
  const maskedAccount = rawAccount.length >= 4
    ? `****${rawAccount.slice(-4)}`
    : '****';

  // ── 3. Mapear fees desde feeBreakdown ────────────────────────────────────
  const fb = transaction.feeBreakdown ?? {};

  // ── 4. Construir respuesta (sin ipnLog ni campos internos) ────────────────
  return res.status(200).json({
    transactionId:       transaction.alytoTransactionId,
    status:              transaction.status,
    originAmount:        transaction.originalAmount,
    originCurrency:      transaction.originCurrency,
    destinationAmount:   transaction.destinationAmount   ?? 0,
    destinationCurrency: transaction.destinationCurrency ?? '',
    exchangeRate:        transaction.exchangeRate        ?? 0,
    fees: {
      payinFee:      fb.providerFee ?? 0,
      alytyCSpread:  fb.alytoFee    ?? 0,
      fixedFee:      0,
      payoutFee:     fb.networkFee  ?? 0,
      totalDeducted: fb.totalFee    ?? 0,
    },
    beneficiary: {
      fullName:      `${transaction.beneficiary?.firstName ?? ''} ${transaction.beneficiary?.lastName ?? ''}`.trim(),
      bankName:      transaction.beneficiary?.bankCode ?? '',
      accountNumber: maskedAccount,
    },
    payinMethod:       transaction.corridorId?.payinMethod ?? null,
    estimatedDelivery: '1 día hábil',
    createdAt:         transaction.createdAt,
    updatedAt:         transaction.updatedAt,
  });
}

// ─── GET /api/v1/payments/:transactionId/audit ────────────────────────────────

/**
 * Verifica el audit trail blockchain de una transacción completada.
 *
 * Solo el usuario dueño de la transacción puede consultar su audit trail.
 * La transacción debe estar en status "completed" y tener un stellarTxId.
 *
 * Auth: Bearer JWT (protect middleware)
 * Params: transactionId — alytoTransactionId (ej. "ALY-B-1710000000000-XYZ123")
 *
 * Respuestas:
 *   200 { audited: false }  — completada pero aún sin registro blockchain
 *   200 { audited: true, stellarTxId, network, explorerUrl, registeredAt, memo }
 *   400 — transacción no completada
 *   404 — no encontrada o no pertenece al usuario
 *   500 — error interno
 */
export async function getTransactionAudit(req, res) {
  const { transactionId } = req.params;
  const userId = req.user._id;

  // ── 1. Buscar transacción ─────────────────────────────────────────────────
  let transaction;
  try {
    transaction = await Transaction
      .findOne({ alytoTransactionId: transactionId, userId })
      .lean();
  } catch (err) {
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transacción no encontrada.' });
  }

  // ── 2. Solo transacciones completadas tienen audit trail ──────────────────
  if (transaction.status !== 'completed') {
    return res.status(400).json({
      error:  'El audit trail solo está disponible para transacciones completadas.',
      status: transaction.status,
    });
  }

  // ── 3. Sin stellarTxId — en proceso ──────────────────────────────────────
  if (!transaction.stellarTxId) {
    return res.status(200).json({
      audited:  false,
      message:  'Transacción aún no registrada en blockchain.',
      network:  process.env.STELLAR_NETWORK ?? 'testnet',
    });
  }

  // ── 4. Consultar Horizon para detalles del audit trail ────────────────────
  const auditData = await getAuditTrail(transaction.stellarTxId);

  const network = process.env.STELLAR_NETWORK ?? 'testnet';
  const explorerUrl = `https://stellar.expert/explorer/${
    network === 'mainnet' ? 'public' : 'testnet'
  }/tx/${transaction.stellarTxId}`;

  return res.status(200).json({
    audited:      true,
    stellarTxId:  transaction.stellarTxId,
    network,
    explorerUrl,
    registeredAt: auditData?.createdAt ?? null,
    memo:         auditData?.memo       ?? null,
    ledger:       auditData?.ledger     ?? null,
  });
}

// ─── GET /api/v1/payments/corridors ─────────────────────────────────────────

/**
 * Retorna los corredores disponibles para el usuario autenticado,
 * filtrados por su entidad legal (SpA→CLP, SRL→BOB, LLC→USD).
 *
 * Auth: Bearer JWT
 *
 * Respuesta:
 * {
 *   originCurrency: "CLP",
 *   originCountry: "CL",
 *   corridors: [{ corridorId, destinationCountry, destinationCurrency,
 *                 destinationCountryName, destinationFlag }]
 * }
 */

const COUNTRY_META = {
  CO: { name: 'Colombia',       flag: '🇨🇴' },
  PE: { name: 'Perú',           flag: '🇵🇪' },
  AR: { name: 'Argentina',      flag: '🇦🇷' },
  MX: { name: 'México',         flag: '🇲🇽' },
  BR: { name: 'Brasil',         flag: '🇧🇷' },
  EC: { name: 'Ecuador',        flag: '🇪🇨' },
  UY: { name: 'Uruguay',        flag: '🇺🇾' },
  PY: { name: 'Paraguay',       flag: '🇵🇾' },
  US: { name: 'Estados Unidos', flag: '🇺🇸' },
  BO: { name: 'Bolivia',        flag: '🇧🇴' },
  CL: { name: 'Chile',          flag: '🇨🇱' },
  VE: { name: 'Venezuela',      flag: '🇻🇪' },
};

export async function getAvailableCorridors(req, res) {
  const ENTITY_CURRENCY_MAP = { SpA: 'CLP', SRL: 'BOB', LLC: 'USD' };
  const ENTITY_COUNTRY_MAP  = { SpA: 'CL',  SRL: 'BO',  LLC: 'US'  };

  const legalEntity        = req.user?.legalEntity ?? 'LLC';
  const userOriginCurrency = ENTITY_CURRENCY_MAP[legalEntity] ?? 'USD';
  const userOriginCountry  = ENTITY_COUNTRY_MAP[legalEntity]  ?? 'US';

  let corridors;
  try {
    corridors = await TransactionConfig.find({
      originCurrency: userOriginCurrency,
      isActive:       true,
      originCountry:  { $ne: 'ANY' },           // excluir corredores comodín
      destinationCountry: { $ne: 'CRYPTO' },    // excluir wallets crypto
    })
      .select('corridorId destinationCountry destinationCurrency')
      .lean();
  } catch (err) {
    console.error('[Alyto Corridors] Error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  const result = corridors.map((c) => {
    const meta = COUNTRY_META[c.destinationCountry] ?? {};
    return {
      corridorId:              c.corridorId,
      destinationCountry:      c.destinationCountry,
      destinationCurrency:     c.destinationCurrency,
      destinationCountryName:  meta.name ?? c.destinationCountry,
      destinationFlag:         meta.flag ?? '',
    };
  });

  return res.json({
    originCurrency: userOriginCurrency,
    originCountry:  userOriginCountry,
    corridors:      result,
  });
}
