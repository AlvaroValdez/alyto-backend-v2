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
import { ENTITY_CURRENCY_MAP, ENTITY_COUNTRY_MAP } from '../utils/entityMaps.js';
import {
  createWidgetLink,
  getPaymentIntent,
  verifyWebhookSignature,
} from '../services/fintocService.js';
import { dispatchPayout }   from './ipnController.js';
import { generatePaymentQR } from '../services/qrService.js';
import SRLConfig            from '../models/SRLConfig.js';
import multer               from 'multer';
import { calculateQuote }   from '../services/quoteCalculator.js';

// ─── Multer: almacenamiento en memoria para comprobantes ─────────────────────
export const uploadComprobante = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos JPG, PNG o PDF.'));
    }
  },
});
import {
  getPrices,
  getWithdrawalRules as getVitaWithdrawalRules,
  createPayin,
  VITA_SENT_ONLY_COUNTRIES,
}                              from '../services/vitaWalletService.js';
import {
  getHarborQuote,
  getHarborTransferRequirements,
  getCustomerUuid,
}                              from '../services/owlPayService.js';
import { getAuditTrail }       from '../services/stellarService.js';
import { sendEmail, EMAILS }  from '../services/email.js';
import { getBOBRate }          from '../services/exchangeRateService.js';
import { calculateFintocFee } from '../utils/fintocFees.js';
import { notify, notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { broadcastToAdmins } from '../routes/adminSSE.js';

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
/** Transforma un field del JSON Schema de Harbor al formato canónico del frontend */
function transformHarborField(key, spec, requiredSet) {
  if (!key || !spec) return null;

  let type = 'text';
  if (spec.enum && Array.isArray(spec.enum)) type = 'select';
  else if (spec.format === 'email') type = 'email';
  else if (spec.type === 'number' || spec.type === 'integer') type = 'text';

  const options = Array.isArray(spec.enum)
    ? spec.enum.map(v => ({ value: v, label: String(v) }))
    : [];

  return {
    key,
    label:       spec.title ?? spec.description ?? key,
    type,
    required:    requiredSet.has(key),
    options,
    min:         spec.minLength ?? spec.minimum ?? null,
    max:         spec.maxLength ?? spec.maximum ?? null,
    placeholder: spec.example ?? spec.pattern ?? '',
    format:      spec.format   ?? null,
    hint:        spec.description ?? null,
    when:        null,
  };
}

/** Aplana un JSON Schema anidado (payout_instrument, beneficiary_info) a un array de fields */
function flattenHarborSchema(schema) {
  if (!schema || typeof schema !== 'object') return [];

  const fields = [];
  const topRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  const props = schema.properties ?? {};

  for (const [key, spec] of Object.entries(props)) {
    if (spec?.type === 'object' && spec.properties) {
      const nestedRequired = new Set(Array.isArray(spec.required) ? spec.required : []);
      for (const [nkey, nspec] of Object.entries(spec.properties)) {
        const field = transformHarborField(nkey, nspec, nestedRequired);
        if (field) fields.push(field);
      }
    } else {
      const field = transformHarborField(key, spec, topRequired);
      if (field) fields.push(field);
    }
  }

  return fields;
}

export async function getWithdrawalRulesController(req, res) {
  const countryCode = (req.params.countryCode ?? '').toUpperCase();

  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    return res.status(400).json({ error: 'countryCode inválido. Usar ISO alpha-2 (ej. CO, PE).' });
  }

  // ── 1. Resolver corredor activo para (destCountry, legalEntity) ────────────
  const legalEntity = req.user?.legalEntity ?? null;
  let corridor = null;
  try {
    const query = { destinationCountry: countryCode, isActive: true };
    if (legalEntity) query.legalEntity = legalEntity;
    corridor = await TransactionConfig.findOne(query).lean();
    if (!corridor && legalEntity) {
      corridor = await TransactionConfig.findOne({ destinationCountry: countryCode, isActive: true }).lean();
    }
  } catch (err) {
    console.warn('[Alyto WithdrawalRules] Error resolviendo corredor:', err.message);
  }

  const payoutMethod = corridor?.payoutMethod ?? 'vitaWallet';
  const cacheKey     = `${countryCode}:${payoutMethod}`;

  // ── 2. Revisar caché ───────────────────────────────────────────────────────
  const cached = withdrawalRulesCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < RULES_CACHE_TTL_MS) {
    return res.status(200).json(cached.payload);
  }

  // ── 3a. Harbor (OwlPay) — requirements dinámicos ───────────────────────────
  if (payoutMethod === 'owlPay') {
    try {
      const customerUuid = getCustomerUuid(legalEntity ?? 'SRL');
      const quote = await getHarborQuote({
        sourceAmount:      100,
        sourceCurrency:    'USDC',
        sourceChain:       process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
        destCountry:       countryCode,
        destCurrency:      corridor?.destinationCurrency ?? 'USD',
        customerUuid,
        commissionPercent: corridor?.alytoCSpread ?? 0.5,
      });

      const requirements = await getHarborTransferRequirements({
        quoteId:     quote.quoteId,
        destCountry: countryCode,
      });

      const fields = flattenHarborSchema(requirements.schema);
      const payload = { destCountry: countryCode, payoutMethod: 'owlPay', fields };
      withdrawalRulesCache.set(cacheKey, { payload, cachedAt: Date.now() });

      console.info(`[Alyto WithdrawalRules] Harbor requirements para ${countryCode}: ${fields.length} campos.`);
      return res.status(200).json(payload);
    } catch (err) {
      console.warn(`[Alyto WithdrawalRules] Harbor no disponible para ${countryCode} — fallback a reglas locales.`, err.message);
      Sentry.captureMessage(`WithdrawalRules Harbor fallback ${countryCode}`, {
        level: 'warning', extra: { error: err.message, countryCode },
      });
      // Cae al flujo Vita/fallback de abajo
    }
  }

  // ── 3b. Vita Wallet — flujo existente ──────────────────────────────────────
  let fields;
  try {
    const vitaResponse = await getVitaWithdrawalRules();
    const country      = countryCode.toLowerCase();
    const vitaFields   = vitaResponse?.rules?.[country]?.fields ?? [];

    if (vitaFields.length === 0) {
      throw new Error(`Vita no devuelve campos para ${countryCode}`);
    }

    fields = vitaFields.map(transformVitaField).filter(Boolean);
    console.info(`[Alyto WithdrawalRules] Reglas cargadas desde Vita para ${countryCode}: ${fields.length} campos.`);
  } catch (err) {
    console.warn(`[Alyto WithdrawalRules] Vita no disponible para ${countryCode} — usando fallback.`, err.message);
    Sentry.captureMessage(`WithdrawalRules fallback activado para ${countryCode}`, {
      level: 'warning', extra: { error: err.message, countryCode },
    });

    fields = FALLBACK_WITHDRAWAL_RULES[countryCode] ?? null;
    if (!fields) {
      return res.status(404).json({
        error: `No hay reglas de retiro disponibles para ${countryCode} en este momento.`,
      });
    }
  }

  const payload = { destCountry: countryCode, payoutMethod: 'vitaWallet', fields };
  withdrawalRulesCache.set(cacheKey, { payload, cachedAt: Date.now() });
  return res.status(200).json(payload);
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
    destinationAmount:   quotedDestAmount,
    exchangeRate:        quotedExchangeRate,
    usdcTransitAmount:   quotedUsdcTransitAmount,
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

  // Validar que el usuario tiene acceso al país de origen del corredor
  const ENTITY_COUNTRY_MAP_CBP = { SpA: 'CL', SRL: 'BO', LLC: 'US' };
  const userOriginCountryCBP   = ENTITY_COUNTRY_MAP_CBP[req.user?.legalEntity] ?? req.user?.residenceCountry ?? 'CL';
  if (corridor.originCountry !== userOriginCountryCBP) {
    return res.status(403).json({
      error: 'No tienes acceso a este corredor.',
      userOriginCountry:     userOriginCountryCBP,
      corridorOriginCountry: corridor.originCountry,
    });
  }

  // ── Validar monto mínimo y máximo del corredor ────────────────────────────
  if (corridor.minAmountOrigin && amount < corridor.minAmountOrigin) {
    return res.status(400).json({
      error:    `El monto mínimo para este corredor es ${corridor.minAmountOrigin} ${corridor.originCurrency}.`,
      code:     'BELOW_MINIMUM',
      min:      corridor.minAmountOrigin,
      currency: corridor.originCurrency,
    });
  }
  if (corridor.maxAmountOrigin && amount > corridor.maxAmountOrigin) {
    return res.status(400).json({
      error:    `El monto máximo para este corredor es ${corridor.maxAmountOrigin} ${corridor.originCurrency}.`,
      code:     'ABOVE_MAXIMUM',
      max:      corridor.maxAmountOrigin,
      currency: corridor.originCurrency,
    });
  }

  // ── Límite regulatorio BOB (RND 102400000021 — Bancarización Bolivia) ──────
  // Aplica a todos los usuarios SRL cuyo origen es BOB.
  // Umbral legal: Bs 50.000. Se opera hasta Bs 49.999 para no requerir
  // documento bancario ASFI mientras se tramita la licencia ETF/PSAV.
  if (req.user?.legalEntity === 'SRL' && corridor.originCurrency === 'BOB' && amount > 49_999) {
    return res.status(400).json({
      error:    'El monto supera el límite regulatorio por transacción en Bolivia.',
      detail:   'Conforme a la RND 102400000021 (Bancarización Bolivia), operamos hasta Bs 49.999 por transacción mientras tramitamos la licencia ETF/PSAV ante ASFI.',
      code:     'BOB_SINGLE_TX_LIMIT_EXCEEDED',
      limit:    49_999,
      currency: 'BOB',
    });
  }

  // ── Payin manual SRL: el comprobante se sube DESPUÉS (spec §2.3) ───────────
  // La tx se crea sin comprobante en status 'payin_pending'. El usuario navega
  // a Step 3 (/send/payment/:txId) donde sube el comprobante vía
  // POST /payments/:transactionId/comprobante. Ese endpoint es el único punto
  // que persiste Transaction.paymentProof y dispara broadcastToAdmins.

  // ── 3a. Corredor cl-bo: CLP → BOB (anchorBolivia) ────────────────────────
  if (
    corridor.destinationCurrency === 'BOB' &&
    corridor.payoutMethod        === 'anchorBolivia'
  ) {
    const SpAConfig = (await import('../models/SpAConfig.js')).default;
    const spaCfg = await SpAConfig.findOne({ isActive: true }).lean();

    if (!spaCfg?.clpPerBob || !spaCfg?.accountNumber) {
      return res.status(503).json({
        error: 'El corredor CLP → BOB no esta disponible en este momento.',
        code:  'SPA_CONFIG_MISSING',
      });
    }

    const { clpPerBob } = spaCfg;
    const round2 = (n) => Math.round(n * 100) / 100;

    // payinFee: incluir fee de Fintoc si aplica, o porcentual del corredor
    let payinFeeVal;
    if (corridor.payinMethod === 'fintoc' && corridor.fintocConfig?.ufValue) {
      const fintocResult = calculateFintocFee(amount, corridor.fintocConfig);
      payinFeeVal = fintocResult.fixedFee;
    } else {
      payinFeeVal = round2(amount * (corridor.payinFeePercent / 100));
    }
    const spreadFee         = round2(amount * (corridor.alytoCSpread / 100));
    const fixedFeeVal       = corridor.fixedFee ?? 0;
    const profitFee         = round2(amount * (corridor.profitRetentionPercent / 100));
    const totalDeductedReal = round2(payinFeeVal + spreadFee + fixedFeeVal + profitFee);
    const netCLP            = round2(amount - totalDeductedReal);
    const destinationBOB    = round2(netCLP / clpPerBob);

    if (destinationBOB <= 0 || netCLP <= 0) {
      return res.status(400).json({ error: 'El monto ingresado no cubre los fees minimos.' });
    }

    const alytoTransactionId = `ALY-${corridor.routingScenario ?? 'B'}-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const paymentRef = req.body.paymentRef ?? `ALY-${Date.now().toString(36).toUpperCase()}`;

    // Construir beneficiario
    const ben = beneficiaryData ?? legacyBeneficiary ?? {};
    const beneficiaryDoc = {
      firstName:      ben.firstName  ?? '',
      lastName:       ben.lastName   ?? '',
      accountType:    ben.accountType ?? '',
      accountBank:    ben.accountNumber ?? '',
      bankCode:       ben.bankName   ?? '',
      dynamicFields:  ben,
    };
    // Si es QR, guardar la imagen en dynamicFields
    if (ben.type === 'qr_image' && ben.qrImageBase64) {
      beneficiaryDoc.dynamicFields = {
        ...ben,
        qrImageBase64:   ben.qrImageBase64,
        qrImageMimetype: ben.qrImageMimetype ?? 'image/png',
      };
    }

    let transaction;
    try {
      transaction = await Transaction.create({
        userId,
        legalEntity:         corridor.legalEntity ?? 'SpA',
        operationType:       'crossBorderPayment',
        routingScenario:     corridor.routingScenario ?? 'B',
        corridorId:          corridor._id,

        originalAmount:      amount,
        originCurrency:      'CLP',
        originCountry:       'CL',
        destinationCountry:  'BO',
        destinationCurrency: 'BOB',
        destinationAmount:   destinationBOB,
        exchangeRate:        clpPerBob,
        exchangeRateLockedAt: new Date(),

        fees: {
          payinFee:          payinFeeVal,
          alytoCSpread:      spreadFee,
          fixedFee:          fixedFeeVal,
          profitRetention:   profitFee,
          totalDeducted:     round2(payinFeeVal + spreadFee + fixedFeeVal),
          totalDeductedReal,
          feeCurrency:       'CLP',
        },

        beneficiary:    beneficiaryDoc,

        providersUsed:  ['payin:manual'],
        paymentLegs:    [{ stage: 'payin', provider: 'manual', status: 'pending' }],

        paymentInstructions: {
          bankName:      spaCfg.bankName,
          accountType:   spaCfg.accountType,
          accountNumber: spaCfg.accountNumber,
          rut:           spaCfg.rut,
          accountHolder: spaCfg.accountHolder,
          bankEmail:     spaCfg.bankEmail,
          currency:      'CLP',
          amount,
          reference:     paymentRef,
        },

        status:             'payin_pending',
        alytoTransactionId,
      });
    } catch (err) {
      console.error('[CrossBorder CL-BO] Error creando transaccion:', {
        corridorId: corridor.corridorId, error: err.message,
      });
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Error interno al crear la transaccion.' });
    }

    // Emails en paralelo (fire-and-forget)
    const user = await User.findById(userId).select('email firstName lastName').lean();
    if (user?.email) {
      const clpBobTemplateId = process.env.SENDGRID_TEMPLATE_CLP_BOB_INSTRUCTIONS
        ?? process.env.SENDGRID_TEMPLATE_MANUAL_PAYIN
        ?? process.env.SENDGRID_TEMPLATE_INITIATED;
      if (!clpBobTemplateId) {
        console.error('[Email] ⚠️ Falta SENDGRID_TEMPLATE_CLP_BOB_INSTRUCTIONS — email de instrucciones NO enviado.');
      } else {
        // Beneficiario Bolivia — incluir en el email para confirmación visual
        const beneName = `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim() || '—';
        const beneBank = ben.bankName ?? ben.bankCode ?? '—';
        const beneAcctRaw = ben.accountNumber ?? ben.accountBank ?? '';
        const beneAcct = beneAcctRaw ? `****${String(beneAcctRaw).slice(-4)}` : '—';

        console.log('[Payment] Sending CLP-BOB instructions to:', user.email, 'tx:', alytoTransactionId);
        sendEmail(
          user.email,
          clpBobTemplateId,
          {
            userName:       user.firstName ?? 'Usuario',
            amount:         amount.toLocaleString('es-CL'),
            paymentRef,
            bankName:       spaCfg.bankName,
            accountType:    spaCfg.accountType,
            accountNumber:  spaCfg.accountNumber,
            rut:            spaCfg.rut,
            accountHolder:  spaCfg.accountHolder,
            bankEmail:      spaCfg.bankEmail,
            totalDeducted:  totalDeductedReal.toLocaleString('es-CL'),
            destinationBOB: destinationBOB.toFixed(2),
            clpPerBob:      clpPerBob.toFixed(2),
            // Beneficiario — confirmación visual antes de transferir
            beneficiaryName:    beneName,
            beneficiaryBank:    beneBank,
            beneficiaryAccount: beneAcct,
            destinationCountry: 'BO',
          },
        )
          .then(() => console.log('[Payment] CLP-BOB instructions email sent OK:', user.email))
          .catch(err => console.error('[Payment] CLP-BOB instructions email FAILED:', {
            error: err.message, body: err.response?.body, to: user.email, templateId: clpBobTemplateId,
          }));
      }
    } else {
      console.error('[Payment] ⚠️ No user/email para CLP-BOB instrucciones, userId:', userId);
    }
    // Alerta admin
    const adminClpBobTemplate = process.env.SENDGRID_TEMPLATE_ADMIN_CLP_BOB
      ?? process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA;
    const adminEmail = process.env.ADMIN_EMAIL ?? process.env.SENDGRID_ADMIN_EMAIL;
    if (adminClpBobTemplate && adminEmail) {
      sendEmail(
        adminEmail,
        adminClpBobTemplate,
        {
          transactionId:  alytoTransactionId,
          userName:       `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim(),
          userEmail:      user?.email ?? '',
          amount:         amount.toLocaleString('es-CL'),
          paymentRef,
          beneficiaryType: ben.type ?? 'bank_data',
          beneficiaryName: `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim(),
          bankName:        ben.bankName ?? '',
          accountNumber:   ben.accountNumber ?? '',
          hasProof:        'No',
          ledgerUrl:       `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/admin/ledger?tx=${alytoTransactionId}`,
        },
      ).catch(err => console.error('[Email] Error admin CLP-BOB alert:', {
        error: err.message, to: adminEmail, templateId: adminClpBobTemplate,
      }));
    } else {
      console.error('[Email] ⚠️ Falta SENDGRID_TEMPLATE_ADMIN_CLP_BOB o ADMIN_EMAIL — alerta admin NO enviada.');
    }

    console.info('[CrossBorder CL-BO] Transaccion creada:', {
      alytoTransactionId,
      amount,
      destinationBOB,
      clpPerBob,
      totalDeductedReal,
      beneficiaryType: ben.type ?? 'bank_data',
    });

    // Notificar a admins — push + in-app
    notifyAdmins(NOTIFICATIONS.adminNewTransaction(alytoTransactionId, amount, 'CLP', 'CLP→BOB')).catch(() => {});

    // Notificar al usuario — campana in-app + push (BUG 7)
    notify(userId, NOTIFICATIONS.transferInitiated(amount, 'CLP', 'BO', alytoTransactionId)).catch(() => {});

    return res.status(201).json({
      alytoTransactionId,
      status:              'payin_pending',
      message:             'Transaccion creada. Realiza la transferencia y recibiras confirmacion.',
      paymentRef,
      payinInstructions: {
        bankName:      spaCfg.bankName,
        accountType:   spaCfg.accountType,
        accountNumber: spaCfg.accountNumber,
        rut:           spaCfg.rut,
        accountHolder: spaCfg.accountHolder,
        bankEmail:     spaCfg.bankEmail,
        amount,
        reference:     paymentRef,
        currency:      'CLP',
      },
      destinationAmount:   destinationBOB,
      destinationCurrency: 'BOB',
    });
  }

  // ── 3b. Calcular fees desde TransactionConfig (configurable por corredor) ────
  // Fintoc cobra fee fijo en UF — usar cálculo dinámico si fintocConfig está presente.
  // Corredores no-Fintoc (SRL, LLC) usan payinFeePercent como siempre.
  // round2: misma precisión que en la cotización (quoteSocket + calculateBOBQuote).
  const round2 = n => Math.round(n * 100) / 100;
  let payinFee;
  if (corridor.payinMethod === 'fintoc' && corridor.fintocConfig?.ufValue) {
    const fintocResult = calculateFintocFee(amount, corridor.fintocConfig);
    payinFee = fintocResult.fixedFee;
    console.log('[CrossBorder] Fintoc UF fee:', {
      ufValue: fintocResult.ufValue, tier: fintocResult.tier,
      fixedFee: fintocResult.fixedFee, effectivePercent: fintocResult.percentage.toFixed(3) + '%',
    });
  } else {
    payinFee = round2(amount * (corridor.payinFeePercent / 100));
  }
  const alytoCSpread    = round2(amount * (corridor.alytoCSpread / 100));
  const fixedFee        = corridor.fixedFee ?? 0;
  const profitRetention = round2(amount * (corridor.profitRetentionPercent / 100));
  const payoutFee       = corridor.payoutFeeFixed ?? 0;

  console.log('[CrossBorder] Fees desde TransactionConfig:');
  console.log('  corridorId:', corridorId);
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

    // Leer datos bancarios desde DB (admin los configura); fallback a env vars
    let dbBankData = {};
    try {
      const srlCfg = await SRLConfig.findOne({ key: 'srl_bolivia' }).select('bankData').lean();
      dbBankData = srlCfg?.bankData ?? {};
    } catch (cfgErr) {
      console.warn('[CrossBorder] No se pudo leer bankData de SRLConfig, usando env vars:', cfgErr.message);
    }

    manualPaymentInstructions = {
      bankName:      dbBankData.bankName      || process.env.SRL_BANK_NAME      || 'Banco Bisa',
      accountHolder: dbBankData.accountHolder || process.env.SRL_ACCOUNT_HOLDER || 'AV Finance SRL',
      accountNumber: dbBankData.accountNumber || process.env.SRL_ACCOUNT_NUMBER || '',
      accountType:   dbBankData.accountType   || process.env.SRL_ACCOUNT_TYPE   || 'Cuenta Corriente',
      currency:      corridor.originCurrency,
      amount,
      reference:     alytoTransactionId,
      concept:       `Alyto - ${alytoTransactionId}`,
      instructions:  'Escanea el QR desde tu app bancaria o realiza una transferencia indicando el número de referencia en el concepto del pago. El pago será verificado en un plazo de 2-4 horas hábiles.',
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
    // Separar campos fc_* (internos de Vita) y *_label (display-only del frontend)
    const vitaFields = Object.fromEntries(
      Object.entries(beneficiaryData).filter(([k]) => !k.startsWith('fc_') && !k.endsWith('_label')),
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
  //
  // El comprobante NO se adjunta aquí (spec §2.3). La tx se crea sin
  // paymentProof y queda en 'payin_pending'; el usuario navega a Step 3
  // y sube el comprobante vía POST /payments/:transactionId/comprobante
  // (uploadPaymentProof). Ese endpoint persiste Transaction.paymentProof,
  // registra ipnLog y dispara broadcastToAdmins → tab Accionables.

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
      ...(corridor.legalEntity === 'SRL' ? { digitalAsset: 'USDC' } : {}),
      // usdcTransitAmount cotizado: almacenado en digitalAssetAmount para que dispatchPayout
      // use exactamente el mismo monto USDC que se le mostró al usuario, sin recalcular.
      ...(quotedUsdcTransitAmount != null && corridor.legalEntity === 'SRL'
        ? { digitalAssetAmount: Number(quotedUsdcTransitAmount) }
        : {}),
      // Montos y tasa de la cotización previa (desnormalizados para historial)
      ...(quotedDestAmount    != null ? { destinationAmount: quotedDestAmount }       : {}),
      ...(quotedExchangeRate  != null ? { exchangeRate: quotedExchangeRate, exchangeRateLockedAt: new Date() } : {}),

      fees: {
        payinFee,
        alytoCSpread,
        fixedFee,
        payoutFee,
        profitRetention,
        vitaRateMarkup:    0,   // spec v1.0 §3.5, §6.9 — always zero for new tx
        totalDeducted:     round2(payinFee + alytoCSpread + fixedFee + payoutFee),
        totalDeductedReal: round2(payinFee + alytoCSpread + fixedFee + payoutFee + profitRetention),
        feeCurrency:       corridor.originCurrency ?? 'USD',
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
      status:              'payin_pending',
      alytoTransactionId,
    });
  } catch (err) {
    console.error('[Alyto CrossBorder] Error persistiendo transacción en BD:', {
      corridorId, error: err.message,
    });
  }

  // ── 7. QR + Emails para payin manual ─────────────────────────────────────
  let paymentQR      = null;
  let paymentQRStatic = [];   // QR estáticos subidos por el admin (Tigo Money, Banco, etc.)

  if (corridor.payinMethod === 'manual' && transaction) {
    // Generar QR dinámico (codifica datos bancarios para lectura por app bancaria)
    try {
      const { qrBase64 } = await generatePaymentQR(transaction);
      paymentQR = qrBase64;
      transaction.paymentQR = qrBase64;
      await transaction.save();
      console.log('[CrossBorder] QR generado para:', alytoTransactionId);
    } catch (qrErr) {
      console.error('[CrossBorder] Error generando QR:', qrErr.message);
    }

    // Obtener QR estáticos configurados por el admin (Tigo Money, Banco Bisa, etc.)
    try {
      const srlConfig = await SRLConfig.getActive();
      paymentQRStatic = (srlConfig.qrImages ?? []).map(q => ({
        label:       q.label,
        imageBase64: q.imageBase64,
      }));
    } catch (srlErr) {
      console.error('[CrossBorder] Error obteniendo QR estáticos SRL:', srlErr.message);
    }

    const user = await User.findById(userId).select('email firstName').lean();
    if (user?.email) {
      console.log('[Payment] Sending manual payin instructions to:', user.email, 'tx:', alytoTransactionId);
      sendEmail(...EMAILS.manualPayinInstructions(user, transaction, manualPaymentInstructions))
        .then(() => console.log('[Payment] Manual payin instructions email sent OK:', user.email))
        .catch(err => console.error('[Payment] Manual payin instructions email FAILED:', {
          error: err.message, body: err.response?.body, to: user.email, txId: alytoTransactionId,
        }));
    } else {
      console.error('[Payment] ⚠️ Usuario no encontrado/sin email para instrucciones, userId:', userId);
    }
  }

  // Notificar a admins — push + in-app
  const corridorLabel = `${transaction.originCurrency}→${transaction.destinationCurrency}`;
  notifyAdmins(
    NOTIFICATIONS.adminNewTransaction(alytoTransactionId, transaction.originalAmount, transaction.originCurrency, corridorLabel),
    corridor.payinMethod === 'manual' ? { email: EMAILS.adminBoliviaAlert(transaction) } : {},
  ).catch(() => {});

  // Notificar al usuario — campana in-app + push (BUG 7)
  notify(
    transaction.userId,
    NOTIFICATIONS.transferInitiated(
      transaction.originalAmount,
      transaction.originCurrency,
      transaction.destinationCountry,
      alytoTransactionId,
    ),
  ).catch(() => {});

  // ── 8. Respuesta al cliente ───────────────────────────────────────────────
  if (corridor.payinMethod === 'manual') {
    return res.status(201).json({
      transactionId:       alytoTransactionId,
      status:              'payin_pending',
      payinMethod:         'manual',
      paymentInstructions: manualPaymentInstructions,
      destinationAmount:   transaction.destinationAmount   ?? quotedDestAmount   ?? null,
      destinationCurrency: transaction.destinationCurrency ?? null,
      exchangeRate:        transaction.exchangeRate        ?? quotedExchangeRate ?? null,
      // QR dinámico: codifica datos bancarios para apps de homebanking
      paymentQR,
      // QR estáticos: imágenes subidas por el admin (Tigo Money, Banco Bisa, etc.)
      // Array de { label, imageBase64 } — mostrar cada uno con su etiqueta
      paymentQRStatic,
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
async function extractVitaPricing(vitaPricesResponse, originCurrency, destinationCountry) {
  // GT, SV, ES, PL only exist in vita_sent table — fall back to it for pricing.
  // All other countries use withdrawal table (original behavior).
  const destUpper  = destinationCountry.toUpperCase();
  const attrsSource = VITA_SENT_ONLY_COUNTRIES.has(destUpper)
    ? vitaPricesResponse?.vita_sent?.prices?.attributes
    : vitaPricesResponse?.withdrawal?.prices?.attributes;

  const attrs = attrsSource ?? vitaPricesResponse?.withdrawal?.prices?.attributes;
  if (!attrs) return null;

  const countryKey = destinationCountry.toLowerCase();
  const origin     = originCurrency.toUpperCase();
  let rate;

  // ── Destino Bolivia (BO): Vita no tiene clp_sell['bo'] — derivar via BOB_USD_RATE ──
  // AV Finance SRL es el anchor manual: paga en BOB directamente.
  // No se llama a Vita para el payout BOB — la tasa se construye desde la tasa admin.
  if (countryKey === 'bo') {
    const clpToUsd = Number(attrs.clp_sell?.['us'] ?? NaN);
    if (!isFinite(clpToUsd) || clpToUsd <= 0) return null;
    const BOB_USD_RATE = await getBOBRate();
    if (origin === 'CLP') {
      // 1 CLP = clpToUsd USD; 1 USD = BOB_USD_RATE BOB → 1 CLP = clpToUsd * BOB_USD_RATE BOB
      rate = clpToUsd * BOB_USD_RATE;
    } else if (origin === 'USD' || origin === 'USDC') {
      // 1 USD = BOB_USD_RATE BOB (tasa admin o MongoDB)
      rate = BOB_USD_RATE;
    } else {
      return null;
    }
    // fixedCost para BO no existe en Vita — anchor manual no cobra fee adicional
    const validUntil = attrs.valid_until ?? null;
    console.info('[Alyto Quote] Cotización ' + origin + '→BOB via BOB_USD_RATE:', {
      BOB_USD_RATE, clpToUsd, rate,
    });
    return { rate, fixedCost: 0, validUntil };
  }

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
  } else if (origin === 'BOB') {
    // Bolivia: Vita no tiene bob_sell. Dos pasos:
    //   PASO 1 — tasa USD→destino via cross-rate CLP
    //   PASO 2 — dividir por BOB_USD_RATE (desde MongoDB o .env)
    const BOB_USD_RATE = await getBOBRate();
    const clpToDest    = Number(attrs.clp_sell?.[countryKey] ?? NaN);
    const clpToUsd     = Number(attrs.clp_sell?.['us']       ?? NaN);
    if (!isFinite(clpToDest) || !isFinite(clpToUsd) || clpToUsd <= 0) return null;
    const usdToDestRate = clpToDest / clpToUsd;
    rate = usdToDestRate / BOB_USD_RATE;
    console.info('[Alyto Quote] Cotización BOB→' + destinationCountry + ' via cross-rate:', {
      clpToDest, clpToUsd, usdToDestRate, BOB_USD_RATE, bobToDestRate: rate,
    });
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
 * calculateBOBQuote — Cotización para corredores manuales SRL Bolivia.
 *
 * Ruta de conversión: BOB → USDC (tasa admin o BOB_USD_RATE env) → destino (Vita cross-rate CLP).
 * Vita no tiene tasas BOB nativas. Se deriva: usd_to_dest = clp_sell[dest] / clp_sell["us"]
 *
 * @param {object} req
 * @param {object} res
 * @param {object} corridor  — TransactionConfig activo
 * @param {number} amount    — originAmount en BOB
 * @param {string} dest      — destinationCountry ISO alpha-2 mayúsculas
 */
async function calculateBOBQuote(req, res, corridor, amount, dest) {
  const round2      = n => Math.round(n * 100) / 100;
  const userId      = req.user?._id?.toString();

  // ── 1. Tasa BOB/USDC ───────────────────────────────────────────────────────
  // Prioridad: manualExchangeRate del corredor → MongoDB (ExchangeRate) → .env
  const BOB_USD_RATE = await getBOBRate();
  const bobPerUsdc   = (corridor.manualExchangeRate > 0)
    ? corridor.manualExchangeRate
    : BOB_USD_RATE;

  const rateSource = corridor.manualExchangeRate > 0 ? 'corridor_manualRate' : 'exchangeRate_db_or_env';
  console.log('[Quote BOB] BOB_USD_RATE:', bobPerUsdc, '| source:', rateSource);

  // ── 2. Obtener precios Vita (USD→dest via cross-rate CLP) ─────────────────
  let vitaResponse;
  try {
    vitaResponse = await getPrices();
  } catch (err) {
    console.error('[Quote BOB] Vita /prices no disponible:', err.message);
    return res.status(503).json({
      error: 'Servicio de tasas no disponible. Intenta nuevamente en unos momentos.',
    });
  }

  const vitaPricingUSD = await extractVitaPricing(vitaResponse, 'USD', dest);
  if (!vitaPricingUSD) {
    console.error('[Quote BOB] No hay tasa USD→' + dest + ' en Vita para corredor:', corridor.corridorId);
    return res.status(503).json({
      error: `No hay tasa USD→${dest} disponible. Intenta nuevamente.`,
    });
  }

  const { rate: usdToDestRate, validUntil } = vitaPricingUSD;

  // ── 3. Quote unificado — delegate to canonical calculator (spec §3.2) ─────
  let quote;
  try {
    quote = calculateQuote({
      amount,
      corridor,
      bobPerUsdc,
      vitaRate: usdToDestRate,
    });
  } catch (err) {
    console.error('[Quote BOB] calculateQuote rejected inputs:', err.message);
    return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
  }

  if (quote.destinationAmount <= 0) {
    return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
  }

  const alytoProfitUSDC = round2(
    (quote.fees.payinFee + quote.fees.alytoCSpread + quote.fees.fixedFee + quote.fees.profitRetention)
    / bobPerUsdc,
  );

  console.log('[Quote BOB] rate USD→' + dest + ':', usdToDestRate);
  console.log('[Quote BOB] effectiveRate BOB→' + dest + ':', quote.effectiveRate);
  console.log('[Quote BOB] netBOB:', amount - quote.totalDeductedReal, '| usdcTransit:', quote.digitalAssetAmount, '| dest:', quote.destinationAmount);

  const localExpiry    = new Date(Date.now() + 3 * 60 * 1000);
  const vitaExpiry     = validUntil ? new Date(validUntil) : null;
  const quoteExpiresAt = (vitaExpiry && vitaExpiry < localExpiry) ? vitaExpiry : localExpiry;

  return res.status(200).json({
    corridorId:          corridor.corridorId,
    originAmount:        quote.originAmount,
    originCurrency:      'BOB',
    destinationAmount:   quote.destinationAmount,
    destinationCurrency: corridor.destinationCurrency,
    exchangeRate:        quote.effectiveRate,
    conversionPath:      `BOB → USDC → ${corridor.destinationCurrency}`,
    isManualCorridor:    corridor.payoutMethod === 'anchorBolivia',
    stellarAsset:        'USDC',
    usdcTransitAmount:   quote.digitalAssetAmount,
    bobPerUsdc,
    usdcToDestRate:      usdToDestRate,
    fees: {
      ...quote.fees,
      alytoProfitUSDC,
    },
    payinMethod:   corridor.payinMethod,
    payoutMethod:  corridor.payoutMethod,
    entity:        'SRL',
    quoteExpiresAt,
  });
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
  let { originCountry, destinationCountry, originAmount, corridorId } = req.query;
  const userId = req.user?._id?.toString();

  // ── 1. Validar query params — originCountry con fallback por legalEntity ────
  if (!originCountry && req.user?.legalEntity) {
    const entityCountryMap = { SpA: 'CL', SRL: 'BO', LLC: 'US' };
    originCountry = entityCountryMap[req.user.legalEntity] ?? null;
    if (originCountry) {
      console.info(`[Alyto Quote] originCountry inferido de legalEntity ${req.user.legalEntity} → ${originCountry} | userId: ${userId}`);
    }
  }

  if (!originAmount || (!corridorId && (!originCountry || !destinationCountry))) {
    return res.status(400).json({
      error: 'Parámetros requeridos: originAmount + (corridorId | originCountry + destinationCountry).',
    });
  }

  const amount = Number(originAmount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'originAmount debe ser un número positivo.',
    });
  }

  // ── 2. Buscar corredor activo en TransactionConfig ─────────────────────────
  // Buscar por países de origen/destino sin filtrar por legalEntity del usuario.
  // El corredor cl-bo es SpA pero cualquier usuario con acceso a CL puede usarlo.
  let corridor;
  try {
    if (corridorId) {
      corridor = await TransactionConfig.findOne({
        corridorId: corridorId.toLowerCase(),
        isActive:   true,
      }).lean();
    } else {
      const origin = originCountry.toUpperCase();
      const dest   = destinationCountry.toUpperCase();
      corridor = await TransactionConfig.findOne({
        originCountry:      origin,
        destinationCountry: dest,
        isActive:           true,
      }).lean();
    }
  } catch (err) {
    console.error('[Alyto Quote] Error buscando corredor en BD:', {
      corridorId: corridorId ?? null,
      originCountry: originCountry?.toUpperCase(),
      destinationCountry: destinationCountry?.toUpperCase(),
      userId,
      error: err.message,
    });
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  // Derivar origin/dest del corredor cuando se buscó por corridorId
  const origin = corridor?.originCountry      ?? originCountry?.toUpperCase();
  const dest   = corridor?.destinationCountry ?? destinationCountry?.toUpperCase();

  if (!corridor) {
    console.warn('[Alyto Quote] Corredor no encontrado:', {
      corridorId: corridorId ?? null,
      originCountry: origin,
      destinationCountry: dest,
      userId,
      legalEntity: req.user?.legalEntity,
    });
    return res.status(404).json({
      error: `Corredor no disponible para tu país de origen (${origin} → ${dest}).`,
    });
  }

  // Verificar que el usuario tiene acceso al país de origen del corredor
  const ENTITY_COUNTRY_MAP = { SpA: 'CL', SRL: 'BO', LLC: 'US' };
  const userOriginCountry  = ENTITY_COUNTRY_MAP[req.user?.legalEntity] ?? req.user?.residenceCountry ?? 'CL';
  if (corridor.originCountry !== userOriginCountry) {
    return res.status(403).json({
      error: 'No tienes acceso a este corredor.',
      userOriginCountry,
      corridorOriginCountry: corridor.originCountry,
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

  // ── 3a. Corredor cl-bo: CLP → BOB (anchorBolivia) ────────────────────────
  // Payout anchorBolivia. Tasa desde SpAConfig (CLP por 1 BOB). No usa Vita.
  if (
    corridor.destinationCurrency === 'BOB' &&
    corridor.payoutMethod        === 'anchorBolivia'
  ) {
    const SpAConfig = (await import('../models/SpAConfig.js')).default;
    const spaCfg = await SpAConfig.findOne({ isActive: true }).lean();

    if (!spaCfg?.clpPerBob || !spaCfg?.accountNumber) {
      return res.status(503).json({
        error: 'El corredor CLP → BOB no esta disponible en este momento.',
        code:  'SPA_CONFIG_MISSING',
      });
    }

    const { clpPerBob, minAmountCLP, maxAmountCLP } = spaCfg;

    // Validar limites desde SpAConfig (mas especificos que TransactionConfig)
    if (amount < (minAmountCLP ?? 10000)) {
      return res.status(400).json({
        error: `Monto minimo: ${(minAmountCLP ?? 10000).toLocaleString('es-CL')} CLP`,
      });
    }
    if (amount > (maxAmountCLP ?? 5000000)) {
      return res.status(400).json({
        error: `Monto maximo: ${(maxAmountCLP ?? 5000000).toLocaleString('es-CL')} CLP`,
      });
    }

    // ── CALCULO EXACTO — Regla de Oro ─────────────────────────────────────
    const round2 = (n) => Math.round(n * 100) / 100;

    // payinFee: incluir fee de Fintoc si aplica, o porcentual del corredor
    let payinFee;
    if (corridor.payinMethod === 'fintoc' && corridor.fintocConfig?.ufValue) {
      const fintocResult = calculateFintocFee(amount, corridor.fintocConfig);
      payinFee = fintocResult.fixedFee;
    } else {
      payinFee = round2(amount * (corridor.payinFeePercent / 100));
    }
    const spreadFee         = round2(amount * (corridor.alytoCSpread / 100));
    const fixedFee          = corridor.fixedFee ?? 0;
    const profitFee         = round2(amount * (corridor.profitRetentionPercent / 100));
    const totalDeductedReal = round2(payinFee + spreadFee + fixedFee + profitFee);
    const netCLP            = round2(amount - totalDeductedReal);
    const destinationBOB    = round2(netCLP / clpPerBob);

    // Verificacion de integridad en runtime
    if (destinationBOB <= 0 || netCLP <= 0) {
      console.error('[Quote CL-BO] Calculo invalido:', {
        amount, payinFee, spreadFee, fixedFee, profitFee, netCLP, destinationBOB,
      });
      return res.status(400).json({ error: 'El monto ingresado no cubre los fees minimos.' });
    }

    const paymentRef = `ALY-${Date.now().toString(36).toUpperCase()}`;

    return res.status(200).json({
      corridorId:             corridor.corridorId,
      originCountry:          'CL',
      destinationCountry:     'BO',
      originCurrency:         'CLP',
      destinationCurrency:    'BOB',
      originAmount:           amount,
      destinationAmount:      destinationBOB,
      exchangeRate:           clpPerBob,
      exchangeRateDisplay:    `1 BOB = ${clpPerBob.toFixed(2)} CLP`,
      payinMethod:            'manual',
      payoutMethod:           'anchorBolivia',
      isManualCorridor:       true,
      paymentRef,

      fees: {
        // Visible al usuario (total sin profitRetention — regla CLAUDE.md)
        payinFee:          round2(payinFee),
        alytoCSpread:      round2(spreadFee),
        fixedFee:          round2(fixedFee),
        payoutFee:         0,
        totalDeducted:     round2(payinFee + spreadFee + fixedFee),
        feeCurrency:       'CLP',
        // BD interna — auditoría (NO visible al usuario)
        profitRetention:   profitFee,
        totalDeductedReal,
      },

      payinInstructions: {
        bankName:      spaCfg.bankName,
        accountType:   spaCfg.accountType,
        accountNumber: spaCfg.accountNumber,
        rut:           spaCfg.rut,
        accountHolder: spaCfg.accountHolder,
        bankEmail:     spaCfg.bankEmail,
        amount,
        reference:     paymentRef,
        currency:      'CLP',
      },
    });
  }

  // ── 3b. Cotización BOB: early exit antes de llamar a Vita ─────────────────
  // Para corredores manuales Bolivia, entramos al flujo BOB inmediatamente.
  // Vita se llama dentro de calculateBOBQuote (siempre necesitamos USD→dest).
  if (corridor.originCurrency === 'BOB') {
    console.log('[Quote BOB] Activando flujo Bolivia para:', corridor.corridorId);
    return await calculateBOBQuote(req, res, corridor, amount, dest);
  }

  // ── 4. Obtener precios en tiempo real desde Vita (corredores no-BOB) ─────
  const round2 = n => Math.round(n * 100) / 100;

  // Fintoc cobra fee fijo en UF — usar cálculo dinámico si fintocConfig está presente.
  let payinFee;
  if (corridor.payinMethod === 'fintoc' && corridor.fintocConfig?.ufValue) {
    const fintocResult = calculateFintocFee(amount, corridor.fintocConfig);
    payinFee = fintocResult.fixedFee;
  } else {
    payinFee = amount * (corridor.payinFeePercent / 100);
  }
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
    // bobPerUsdc: admin-configured rate or DB/env fallback.
    const BOB_USD_RATE = await getBOBRate();
    const bobPerUsdc   = (corridor.manualExchangeRate && corridor.manualExchangeRate > 0)
      ? corridor.manualExchangeRate
      : BOB_USD_RATE;

    const vitaPricingUSD = await extractVitaPricing(vitaResponse, 'USD', dest);
    if (!vitaPricingUSD) {
      console.error('[Alyto Quote] Vita no tiene tasa USD→' + dest + ' para corredor manual.', {
        corridorId: corridor.corridorId, userId,
      });
      return res.status(503).json({
        error: 'Tasa de cambio no disponible para este corredor. Intenta nuevamente.',
      });
    }

    const { rate: usdcToDestRate, validUntil } = vitaPricingUSD;

    // ── Quote unificado — canonical formula (spec v1.0 §3.2) ─────────────────
    let quote;
    try {
      quote = calculateQuote({
        amount,
        corridor,
        bobPerUsdc,
        vitaRate: usdcToDestRate,
      });
    } catch (err) {
      console.error('[Alyto Quote] calculateQuote rejected inputs:', err.message);
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    if (quote.destinationAmount <= 0) {
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    const alytoProfitUSDC = round2(
      (quote.fees.payinFee + quote.fees.alytoCSpread + quote.fees.fixedFee + quote.fees.profitRetention)
      / bobPerUsdc,
    );

    const localExpiry    = new Date(Date.now() + 3 * 60 * 1000);
    const vitaExpiry     = validUntil ? new Date(validUntil) : null;
    const quoteExpiresAt = (vitaExpiry && vitaExpiry < localExpiry) ? vitaExpiry : localExpiry;

    console.info('[Alyto Quote] Cotización manual BOB→USDC→' + dest + ':', {
      corridorId:        corridor.corridorId,
      userId,
      originAmount:      amount,
      bobPerUsdc,
      usdcTransitAmount: quote.digitalAssetAmount,
      usdcToDestRate,
      destinationAmount: quote.destinationAmount,
      alytoProfitUSDC,
    });

    return res.status(200).json({
      corridorId:           corridor.corridorId,
      originAmount:         quote.originAmount,
      originCurrency:       corridor.originCurrency,
      destinationAmount:    quote.destinationAmount,
      destinationCurrency:  corridor.destinationCurrency,
      exchangeRate:         quote.effectiveRate,
      isManualCorridor:     corridor.payoutMethod === 'anchorBolivia',
      conversionPath:       `${corridor.originCurrency} → USDC → ${corridor.destinationCurrency}`,
      stellarAsset:         'USDC',
      usdcTransitAmount:    quote.digitalAssetAmount,
      bobPerUsdc,
      usdcToDestRate,
      fees: {
        ...quote.fees,
        alytoProfitUSDC,
      },
      quoteExpiresAt,
      payinMethod:  corridor.payinMethod,
      payoutMethod: corridor.payoutMethod,
      legalEntity:  corridor.legalEntity,
    });
  }

  // ── 3b. Corredores estándar: tasa directa desde Vita ──────────────────────
  const vitaPricing = await extractVitaPricing(
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

  // Raw Vita rate — spec v1.0 §1.2, §6.1 forbid markup in any quote calculation
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
      payinFee:          round2(payinFee),
      alytoCSpread:      round2(alytoCSpread),
      fixedFee:          round2(fixedFee),
      payoutFee:         0,           // vita fixedCost ya descontado de destinationAmount (en moneda destino)
      profitRetention:   round2(profitRetention),
      totalDeducted:     round2(payinFee + alytoCSpread + fixedFee),
      totalDeductedReal: round2(payinFee + alytoCSpread + fixedFee + profitRetention),
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
      estimatedDelivery: corridor.payinMethod === 'manual' ? 'pocas horas' : '1-2 días hábiles',
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

  // ── 2. Extraer datos del beneficiario (schema fields + dynamicFields) ─────
  const ben      = transaction.beneficiary ?? {};
  // Con .lean(), dynamicFields es un plain object (no un Map), así que lo usamos directamente
  const dynFields = (ben.dynamicFields && typeof ben.dynamicFields === 'object')
    ? ben.dynamicFields
    : {};

  // Nombre: campo schema o dynamicFields
  const firstName = ben.firstName ?? dynFields.beneficiary_first_name ?? '';
  const lastName  = ben.lastName  ?? dynFields.beneficiary_last_name  ?? '';
  const fullName  = `${firstName} ${lastName}`.trim();

  // Banco: bankCode schema o dynamic
  const bankName = ben.bankCode
    ?? dynFields.bank_name ?? dynFields.bank_code
    ?? '';

  // Cuenta: accountBank schema o dynamic — enmascarar solo últimos 4
  const rawAccount = ben.accountBank
    ?? dynFields.account_number ?? dynFields.account_bank
    ?? '';
  const maskedAccount = rawAccount.length >= 4
    ? `****${rawAccount.slice(-4)}`
    : (rawAccount || '****');

  // Tipo de cuenta
  const accountType = ben.accountType ?? dynFields.account_type ?? '';

  // Documento
  const documentType   = ben.documentType
    ?? dynFields.document_type ?? dynFields.beneficiary_document_type ?? '';
  const documentNumber = ben.documentNumber
    ?? dynFields.document_number ?? dynFields.beneficiary_document_number ?? '';

  // País destino
  const destinationCountry = transaction.destinationCountry ?? null;

  // Concepto / referencia
  const concept = transaction.concept ?? transaction.reference
    ?? dynFields.concept ?? dynFields.reference ?? '';

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
    destinationCountry,
    exchangeRate:        transaction.exchangeRate        ?? 0,
    fees: {
      payinFee:      fb.providerFee ?? 0,
      alytyCSpread:  fb.alytoFee    ?? 0,
      fixedFee:      0,
      payoutFee:     fb.networkFee  ?? 0,
      totalDeducted: fb.totalFee    ?? 0,
    },
    beneficiary: {
      fullName,
      bankName,
      accountNumber: maskedAccount,
      accountType,
      documentType,
      documentNumber,
    },
    concept,
    payinMethod:       transaction.corridorId?.payinMethod ?? null,
    estimatedDelivery: transaction.corridorId?.payinMethod === 'manual' ? 'pocas horas' : '1-2 días hábiles',
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

// ─── GET /api/v1/payments/:transactionId/qr ──────────────────────────────────

/**
 * Retorna el código QR de pago de una transacción manual (Bolivia).
 * Si el QR no existe en BD (transacciones antiguas), lo genera y lo persiste.
 *
 * Auth: Bearer JWT — el usuario solo puede ver sus propias transacciones.
 */
export async function getTransactionQR(req, res) {
  const { transactionId } = req.params;
  const userId = req.user._id;

  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: transactionId, userId });
  } catch (err) {
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transacción no encontrada.' });
  }

  if (transaction.paymentInstructions == null) {
    return res.status(404).json({ error: 'Esta transacción no requiere pago manual.' });
  }

  // Si no hay QR guardado (tx antigua), generarlo y persistirlo
  if (!transaction.paymentQR) {
    try {
      const { qrBase64 } = await generatePaymentQR(transaction);
      transaction.paymentQR = qrBase64;
      await transaction.save();
    } catch (err) {
      console.error('[QR] Error generando QR para tx antigua:', err.message);
      return res.status(500).json({ error: 'Error generando código QR.' });
    }
  }

  // Incluir QR estáticos del admin (Tigo Money, Banco Bisa, etc.)
  let paymentQRStatic = [];
  try {
    const srlConfig = await SRLConfig.getActive();
    paymentQRStatic = (srlConfig.qrImages ?? []).map(q => ({
      label:       q.label,
      imageBase64: q.imageBase64,
    }));
  } catch (srlErr) {
    console.error('[QR] Error obteniendo QR estáticos SRL:', srlErr.message);
  }

  return res.status(200).json({
    transactionId:       transaction.alytoTransactionId,
    qrBase64:            transaction.paymentQR,
    paymentQRStatic,
    paymentInstructions: transaction.paymentInstructions,
    amount:              transaction.originalAmount,
    currency:            transaction.originCurrency,
    status:              transaction.status,
  });
}

// ─── GET /api/v1/payments/srl-payin-instructions ─────────────────────────────

/**
 * Retorna los datos bancarios y los QR estáticos de AV Finance SRL para que el
 * frontend muestre las instrucciones de transferencia antes de crear la
 * transacción (el comprobante se exige en initCrossBorderPayment).
 *
 * Auth: Bearer JWT — disponible para usuarios SRL.
 */
export async function getSRLPayinInstructions(req, res) {
  if (req.user?.legalEntity !== 'SRL') {
    return res.status(403).json({ error: 'Este endpoint es exclusivo para usuarios SRL.' });
  }

  let bankData = {};
  let qrImages = [];
  try {
    const srlCfg = await SRLConfig.findOne({ key: 'srl_bolivia' })
      .select('bankData qrImages')
      .lean();
    bankData = srlCfg?.bankData ?? {};
    qrImages = (srlCfg?.qrImages ?? []).map(q => ({
      label:       q.label,
      imageBase64: q.imageBase64,
    }));
  } catch (err) {
    console.warn('[SRLPayinInstructions] Fallback a env vars:', err.message);
  }

  return res.status(200).json({
    bankName:      bankData.bankName      || process.env.SRL_BANK_NAME      || 'Banco Bisa',
    accountHolder: bankData.accountHolder || process.env.SRL_ACCOUNT_HOLDER || 'AV Finance SRL',
    accountNumber: bankData.accountNumber || process.env.SRL_ACCOUNT_NUMBER || '',
    accountType:   bankData.accountType   || process.env.SRL_ACCOUNT_TYPE   || 'Cuenta Corriente',
    currency:      'BOB',
    qrImages,
  });
}

// ─── POST /api/v1/payments/:transactionId/comprobante ────────────────────────

/**
 * El usuario sube su comprobante de transferencia bancaria (JPG, PNG o PDF).
 * Se persiste en base64 en Transaction.paymentProof y se notifica al admin.
 *
 * Auth: Bearer JWT
 * Content-Type: multipart/form-data  (campo: 'comprobante')
 */
export async function uploadPaymentProof(req, res) {
  const { transactionId } = req.params;
  const userId = req.user._id;

  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  }

  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: transactionId, userId });
  } catch {
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transacción no encontrada.' });
  }

  if (transaction.paymentInstructions == null) {
    return res.status(400).json({ error: 'Esta transacción no requiere comprobante.' });
  }

  const file = req.file;

  transaction.paymentProof = {
    data:       file.buffer.toString('base64'),
    mimetype:   file.mimetype,
    filename:   file.originalname,
    size:       file.size,
    uploadedAt: new Date(),
  };

  transaction.ipnLog.push({
    provider:   'manual',
    eventType:  'payment_proof_uploaded',
    status:     transaction.status,
    rawPayload: {
      filename: file.originalname,
      size:     file.size,
      mimetype: file.mimetype,
    },
    receivedAt: new Date(),
  });

  try {
    await transaction.save();
  } catch (err) {
    console.error('[Comprobante] Error guardando en BD:', err.message);
    return res.status(500).json({ error: 'Error guardando el comprobante.' });
  }

  // Broadcast SSE: nueva tx accionable (tab "Accionables" del admin Ledger)
  broadcastToAdmins('tx_actionable', {
    transactionId:     transaction.alytoTransactionId,
    userId:            String(userId),
    amount:            transaction.originalAmount,
    currency:          transaction.originCurrency,
    destinationCountry: transaction.destinationCountry,
    timestamp:         new Date().toISOString(),
  });

  // Notificar a admins — push + in-app + email
  const user = await User.findById(userId).select('firstName lastName').lean();
  const userName = user ? `${user.firstName} ${user.lastName}`.trim() : 'Usuario';
  notifyAdmins(
    NOTIFICATIONS.adminPaymentProof(transaction.alytoTransactionId, userName),
  ).catch(() => {});

  return res.status(200).json({
    message:       'Comprobante recibido correctamente.',
    transactionId: transaction.alytoTransactionId,
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
  // LatAm
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
  GT: { name: 'Guatemala',      flag: '🇬🇹' },
  SV: { name: 'El Salvador',    flag: '🇸🇻' },
  CR: { name: 'Costa Rica',     flag: '🇨🇷' },
  DO: { name: 'Rep. Dominicana',flag: '🇩🇴' },
  HT: { name: 'Haití',          flag: '🇭🇹' },
  PA: { name: 'Panamá',         flag: '🇵🇦' },
  // Europa / global
  EU: { name: 'Europa',         flag: '🇪🇺' },
  GB: { name: 'Reino Unido',    flag: '🇬🇧' },
  CN: { name: 'China',          flag: '🇨🇳' },
  AE: { name: 'Emiratos Árabes',flag: '🇦🇪' },
  AU: { name: 'Australia',      flag: '🇦🇺' },
  ES: { name: 'España',         flag: '🇪🇸' },
  PL: { name: 'Polonia',        flag: '🇵🇱' },
  CA: { name: 'Canadá',         flag: '🇨🇦' },
  HK: { name: 'Hong Kong',      flag: '🇭🇰' },
  JP: { name: 'Japón',          flag: '🇯🇵' },
  SG: { name: 'Singapur',       flag: '🇸🇬' },
  ZA: { name: 'Sudáfrica',      flag: '🇿🇦' },
  NG: { name: 'Nigeria',        flag: '🇳🇬' },
};

/** Labels legibles para métodos de payin */
const PAYIN_METHOD_LABELS = {
  fintoc:      'Transferencia Open Banking (Fintoc)',
  manual:      'Transferencia bancaria manual',
  stripe:      'Tarjeta de crédito/débito',
  vitaWallet:  'Vita Wallet',
  owlPay:      'OwlPay Harbor',
  rampNetwork: 'Ramp Network',
};

export async function getAvailableCorridors(req, res) {
  const legalEntity        = req.user?.legalEntity ?? 'SpA';
  const userOriginCurrency = ENTITY_CURRENCY_MAP[legalEntity] ?? 'USD';
  const userOriginCountry  = ENTITY_COUNTRY_MAP[legalEntity]  ?? 'US';

  // Filtrar por legalEntity directamente para que LLC vea todos sus corredores
  // (el filtro anterior por originCurrency excluía corredores bo-* de LLC)
  const baseFilter = {
    isActive:           true,
    destinationCountry: { $ne: 'CRYPTO' },   // excluir wallets crypto
    originCountry:      { $ne: 'ANY' },       // excluir corredores comodín
  };

  let corridorFilter;
  if (legalEntity === 'SpA') {
    // SpA: corredores propios + legacy sin legalEntity
    corridorFilter = { ...baseFilter, $or: [{ legalEntity: 'SpA' }, { legalEntity: { $exists: false } }] };
  } else {
    corridorFilter = { ...baseFilter, legalEntity };
  }

  let corridors;
  try {
    corridors = await TransactionConfig.find(corridorFilter)
      .select('corridorId destinationCountry destinationCurrency payinMethod payoutMethod alytoCSpread fixedFee payinFeePercent fintocConfig minAmountOrigin maxAmountOrigin')
      .lean();
  } catch (err) {
    console.error('[Alyto Corridors] Error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  // Formato plano compatible con el frontend actual (corridorsToCountries usa
  // c.destinationCountry y c.destinationCurrency a nivel raíz).
  // Incluimos payinMethod y payinMethodLabel como campos extra sin romper nada.
  const result = corridors.map((c) => {
    const meta = COUNTRY_META[c.destinationCountry] ?? {};
    return {
      corridorId:              c.corridorId,
      destinationCountry:      c.destinationCountry,
      destinationCurrency:     c.destinationCurrency,
      destinationCountryName:  meta.name ?? c.destinationCountry,
      destinationFlag:         meta.flag ?? '',
      payinMethod:             c.payinMethod,
      payinMethodLabel:        PAYIN_METHOD_LABELS[c.payinMethod] ?? c.payinMethod,
      minAmountOrigin:         c.minAmountOrigin ?? 0,
    };
  });

  return res.json({
    originCurrency: userOriginCurrency,
    originCountry:  userOriginCountry,
    corridors:      result,
  });
}

// ─── GET /api/v1/payments/methods ───────────────────────────────────────────

/**
 * Métodos de pago disponibles para una ruta específica, con tasa en tiempo real.
 *
 * Query params:
 *   destinationCountry — ISO alpha-2 (ej. "BO", "CO")
 *
 * Retorna los corredores activos para el usuario agrupados por método de payin,
 * cada uno con la tasa actual y un monto estimado de referencia.
 *
 * Auth: Bearer JWT
 */
export async function getPayinMethods(req, res) {
  const { destinationCountry } = req.query;

  if (!destinationCountry) {
    return res.status(400).json({ error: 'Parámetro requerido: destinationCountry.' });
  }

  const legalEntity        = req.user?.legalEntity ?? 'SpA';
  const userOriginCurrency = ENTITY_CURRENCY_MAP[legalEntity] ?? 'USD';
  const userOriginCountry  = ENTITY_COUNTRY_MAP[legalEntity]  ?? 'US';
  const dest               = destinationCountry.toUpperCase();

  let corridors;
  try {
    corridors = await TransactionConfig.find({
      isActive:           true,
      originCountry:      userOriginCountry,
      destinationCountry: dest,
      originCurrency:     userOriginCurrency,
    })
      .select('corridorId payinMethod payoutMethod alytoCSpread fixedFee payinFeePercent fintocConfig payoutFeeFixed originCurrency destinationCurrency manualExchangeRate profitRetentionPercent')
      .lean();
  } catch (err) {
    console.error('[Alyto PayinMethods] Error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!corridors.length) {
    return res.status(404).json({
      error: `No hay métodos de pago disponibles para ${userOriginCountry} → ${dest}.`,
    });
  }

  // Obtener tasas en tiempo real de Vita (una sola llamada para todos los corredores)
  let vitaPrices = null;
  try {
    vitaPrices = await getPrices();
  } catch (err) {
    console.warn('[Alyto PayinMethods] Vita /prices no disponible:', err.message);
  }

  const REFERENCE_AMOUNT = 100000; // monto de referencia para estimar

  const methods = await Promise.all(corridors.map(async (c) => {
    // Calcular tasa efectiva para el monto de referencia
    let effectiveRate = null;
    let estimatedDestinationAmount = null;

    if (vitaPrices) {
      const pricing = await extractVitaPricing(vitaPrices, c.originCurrency, dest);
      if (pricing) {
        effectiveRate = pricing.rate;

        // Simular fees para el monto de referencia
        let payinFee;
        if (c.payinMethod === 'fintoc' && c.fintocConfig?.ufValue) {
          payinFee = calculateFintocFee(REFERENCE_AMOUNT, c.fintocConfig).fixedFee;
        } else if (c.payinMethod === 'manual') {
          payinFee = 0;
        } else {
          payinFee = REFERENCE_AMOUNT * ((c.payinFeePercent ?? 0) / 100);
        }
        const spread    = REFERENCE_AMOUNT * ((c.alytoCSpread ?? 0) / 100);
        const fixed     = c.fixedFee ?? 0;
        const retention = REFERENCE_AMOUNT * ((c.profitRetentionPercent ?? 0) / 100);
        const netAmount = REFERENCE_AMOUNT - payinFee - spread - fixed - retention;
        const payoutFee = pricing.fixedCost > 0 ? pricing.fixedCost : (c.payoutFeeFixed ?? 0);

        estimatedDestinationAmount = Math.round(((netAmount * effectiveRate) - payoutFee) * 100) / 100;
      }
    }

    return {
      corridorId:       c.corridorId,
      payinMethod:      c.payinMethod,
      payinMethodLabel: PAYIN_METHOD_LABELS[c.payinMethod] ?? c.payinMethod,
      payoutMethod:     c.payoutMethod,
      originCurrency:   c.originCurrency,
      destinationCurrency: c.destinationCurrency,
      // Tasa y estimación en tiempo real
      effectiveRate,
      referenceAmount:  REFERENCE_AMOUNT,
      estimatedDestinationAmount,
      // Fees visibles
      fees: {
        alytoCSpread:   c.alytoCSpread,
        fixedFee:       c.fixedFee,
        payinFeePercent: c.payinFeePercent,
        payinMethod:    c.payinMethod,
        isFintocUF:     !!(c.payinMethod === 'fintoc' && c.fintocConfig?.ufValue),
      },
    };
  }));

  return res.json({
    originCountry:      userOriginCountry,
    originCurrency:     userOriginCurrency,
    destinationCountry: dest,
    destinationCountryName: COUNTRY_META[dest]?.name ?? dest,
    destinationFlag:        COUNTRY_META[dest]?.flag ?? '',
    referenceAmount:    REFERENCE_AMOUNT,
    methods,
  });
}
