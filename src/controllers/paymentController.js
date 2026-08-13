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

import { logger }        from '../utils/logger.js';
import User              from '../models/User.js';
import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import BusinessProfile   from '../models/BusinessProfile.js';
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
import { calculateQuote, toPublicFees, getEffectiveSpreadPct, round6 } from '../services/quoteCalculator.js';
import { getDisplayRate } from '../utils/rateDisplay.js';

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
  getVitaCountryKey,
  getVitaSentCountry,
}                              from '../services/vitaWalletService.js';
import {
  getHarborQuote,
  getHarborTransferRequirements,
  getHarborMethodsWithSchemas,
  getCustomerUuid,
  resolveHarborCountry,
}                              from '../services/owlPayService.js';
import { getAuditTrail }       from '../services/stellarService.js';
import { resolveComprobanteUrl } from '../services/storageService.js';
import { parseComprobante, isBedrockEnabled } from '../services/bedrockService.js';
import { sendEmail, EMAILS }  from '../services/email.js';
import { getBOBRate, resolveMinAmountOrigin, resolveQuoteRate } from '../services/exchangeRateService.js';
import { resolveEffectiveMinimum } from '../services/corridorMinimums.js';
import { calculateFintocFee } from '../utils/fintocFees.js';
import { pickSupportedQuote, HARBOR_FORM_FIELDS } from '../utils/harborMethodSupport.js';
import { notify, notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { broadcastToAdmins } from '../routes/adminSSE.js';
import { resolveEuCorridor, isEuSepaDestination } from '../routing/euAmountRouter.js';

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
  // userId SIEMPRE del JWT — el body permitía crear payins atribuidos a
  // usuarios arbitrarios (IDOR, audit 2026-06-11).
  const userId = req.user?._id;
  // contactId (beneficiario de la agenda) es opcional y proviene del body.
  // Fix: antes NO se destructuraba → al construir la Transaction se lanzaba
  // ReferenceError y el catch la tragaba (la tx nunca se persistía).
  const { amount, contactId } = req.body;

  // ── 1. Validación de entrada ──────────────────────────────────────────────
  if (!userId || !amount) {
    return res.status(400).json({
      success: false,
      error:   'El campo amount es requerido.',
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
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url:  `${process.env.FRONTEND_URL}/send`,
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

      ...(corridor ? { corridorId: corridor._id, corridorCode: corridor.corridorId } : {}),
      ...(contactId ? { contactId } : {}),

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

// Nota: VITA_COUNTRY_KEY_MAP y getVitaCountryKey importados desde vitaWalletService.js

/**
 * Resuelve un código de banco Vita a nombre legible.
 * 1. Busca en el cache en memoria (populado cuando alguien abre el formulario).
 * 2. Si el cache está frío (nuevo deploy), consulta Vita directamente y popula.
 * 3. Fallback: devuelve el código crudo.
 */
async function lookupBankName(country, bankCode) {
  if (!bankCode || !country) return bankCode ?? '';

  const findInFields = (fields) => {
    const bankField = fields?.find(f => f.key === 'bank_code');
    return bankField?.options?.find(o => String(o.value) === String(bankCode))?.label ?? null;
  };

  // 1. Cache en memoria
  for (const [cacheKey, cached] of withdrawalRulesCache.entries()) {
    if (!cacheKey.startsWith(country + ':')) continue;
    const label = findInFields(cached?.payload?.fields);
    if (label) return label;
  }

  // 2. Cache frío → consultar Vita y calentar
  try {
    const vitaResponse = await getVitaWithdrawalRules();
    const vitaKey      = getVitaCountryKey(country);
    const vitaFields   = vitaResponse?.rules?.[vitaKey]?.fields ?? [];
    if (vitaFields.length > 0) {
      const fields = vitaFields.map(transformVitaField).filter(Boolean);
      withdrawalRulesCache.set(`${country}:vitaWallet`, { payload: { fields }, cachedAt: Date.now() });
      const label = findInFields(fields);
      if (label) return label;
    }
  } catch { /* best-effort */ }

  return bankCode;
}

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
      { value: '891', label: 'Bancolombia' },
      { value: '909', label: 'Banco de Bogotá' },
      { value: '908', label: 'Davivienda' },
      { value: '913', label: 'BBVA Colombia' },
      { value: '878', label: 'Banco de Occidente' },
      { value: '904', label: 'Nequi' },
      { value: '900', label: 'Daviplata' },
      { value: '907', label: 'Scotiabank Colpatria' },
      { value: '905', label: 'Banco Av Villas' },
      { value: '886', label: 'Banco Santander' },
      { value: '884', label: 'Banco Popular' },
      { value: '906', label: 'Banco Caja Social' },
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
      { value: '259', label: 'BCP (Banco de Crédito del Perú)' },
      { value: '260', label: 'Interbank' },
      { value: '263', label: 'BBVA Continental' },
      { value: '262', label: 'Scotiabank Perú' },
      { value: '267', label: 'BanBif' },
      { value: '269', label: 'Mi Banco' },
      { value: '271', label: 'Banco Falabella' },
      { value: '272', label: 'Banco Santander' },
    ], placeholder: '', when: null },
    { key: 'account_bank',              label: 'Número de cuenta o CCI', type: 'text', required: true, min: 10, max: 22, options: [], placeholder: 'Ej. 00219100123456789012', when: null },
    { key: 'account_type_bank',         label: 'Tipo de cuenta',       type: 'select', required: true,  min: null, max: null, options: [
      { value: 'Cuenta de Ahorros', label: 'Cuenta de Ahorros' },
      { value: 'Cuenta Corriente',  label: 'Cuenta Corriente' },
    ], placeholder: '', when: null },
  ],
  CL: [
    { key: 'beneficiary_first_name',    label: 'Nombres',              type: 'text',   required: true,  min: 2,    max: 50,  options: [], placeholder: 'Ej. Valentina',              when: null },
    { key: 'beneficiary_last_name',     label: 'Apellidos',            type: 'text',   required: true,  min: 2,    max: 50,  options: [], placeholder: 'Ej. Rojas Muñoz',           when: null },
    { key: 'beneficiary_email',         label: 'Correo electrónico',   type: 'email',  required: true,  min: null, max: 80,  options: [], placeholder: 'Ej. valentina@correo.cl',   when: null },
    { key: 'beneficiary_document_type', label: 'Tipo de documento',    type: 'select', required: true,  min: null, max: null, options: [
      { value: 'RUT', label: 'RUT' },
      { value: 'CE',  label: 'Cédula de extranjería' },
    ], placeholder: '', when: null },
    { key: 'beneficiary_document_number', label: 'RUT / Documento',   type: 'text',   required: true,  min: 7,    max: 12,  options: [], placeholder: 'Ej. 12345678-9', when: null },
    { key: 'bank_code',                 label: 'Banco',                type: 'select', required: true,  min: null, max: null, options: [
      { value: '10',   label: 'BancoEstado' },
      { value: '7',    label: 'Banco Santander' },
      { value: '11',   label: 'Banco de Chile' },
      { value: '3',    label: 'BCI' },
      { value: '2',    label: 'Scotiabank Chile' },
      { value: '8',    label: 'Banco Itaú' },
      { value: '16',   label: 'Banco Falabella' },
      { value: '5',    label: 'Banco BICE' },
      { value: '17',   label: 'Banco Security' },
      { value: '15',   label: 'Banco Ripley' },
      { value: '14',   label: 'Banco Consorcio' },
      { value: '12',   label: 'Coopeuch' },
      { value: '989',  label: 'Mercado Pago' },
      { value: '1006', label: 'Mach' },
      { value: '997',  label: 'Tenpo Prepago' },
    ], placeholder: '', when: null },
    { key: 'account_bank',              label: 'Número de cuenta',     type: 'text',   required: true,  min: 5,    max: 20,  options: [], placeholder: 'Ej. 00123456789', when: null },
    { key: 'account_type_bank',         label: 'Tipo de cuenta',       type: 'select', required: true,  min: null, max: null, options: [
      { value: 'Cuenta de Ahorros', label: 'Cuenta de Ahorros' },
      { value: 'Cuenta Corriente',  label: 'Cuenta Corriente' },
      { value: 'Cuenta Vista',      label: 'Cuenta Vista / RUT' },
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
  // corridorId query param permite desambiguar cuando hay múltiples corredores
  // activos para el mismo país (ej. bo-cn CNY Harbor vs bo-cn-usd USD Vita).
  const corridorIdParam = req.query.corridorId ?? null;
  const legalEntity     = req.user?.legalEntity ?? null;
  let corridor = null;
  try {
    if (corridorIdParam) {
      corridor = await TransactionConfig.findOne({ corridorId: corridorIdParam, isActive: true }).lean();
    }
    // Destinos multi-corredor (EU: bo-eu-srl owlPay + bo-es vitaWallet): sin
    // corridorId el findOne era no determinista. Orden de preferencia:
    //   - EU/SEPA → vitaWallet (regla fija "EU siempre Vita", euAmountRouter.js):
    //     el formulario correcto es el IBAN de Vita, no el SWIFT/WIRE de Harbor.
    //   - resto → payoutMethod asc ('owlPay' < 'vitaWallet'), Harbor primario.
    const preferVita = isEuSepaDestination(countryCode);
    const sortSpec   = preferVita ? { payoutMethod: -1 } : { payoutMethod: 1 };
    if (!corridor) {
      const query = { destinationCountry: countryCode, isActive: true };
      if (legalEntity) query.legalEntity = legalEntity;
      corridor = await TransactionConfig.findOne(query).sort(sortSpec).lean();
    }
    if (!corridor && legalEntity) {
      corridor = await TransactionConfig.findOne({ destinationCountry: countryCode, isActive: true })
        .sort(sortSpec).lean();
    }
  } catch (err) {
    console.warn('[Alyto WithdrawalRules] Error resolviendo corredor:', err.message);
  }

  const payoutMethod = corridor?.payoutMethod ?? 'vitaWallet';
  const cacheKey     = corridorIdParam
    ? `${corridorIdParam}:${payoutMethod}`
    : `${countryCode}:${payoutMethod}`;

  // ── 2. Revisar caché ───────────────────────────────────────────────────────
  const cached = withdrawalRulesCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < RULES_CACHE_TTL_MS) {
    return res.status(200).json(cached.payload);
  }

  // ── 3a. Harbor (OwlPay) — campos definidos por HARBOR_FORM_FIELDS ───────────
  // La fuente de verdad es harborMethodSupport.HARBOR_FORM_FIELDS, derivada de
  // buildPayoutInstrument(). Cubre todos los países Harbor activos (bo-us, bo-eu,
  // bo-gb, bo-br, bo-mx, bo-cn, bo-hk, bo-in, bo-ae, bo-sg, bo-jp, bo-ng).
  // Harbor solo se llama en tryOwlPayV2() cuando se ejecuta el payout real.
  if (payoutMethod === 'owlPay') {
    // EU: el corredor bo-eu-srl tiene destinationCountry='EU'. Países individuales
    // de la eurozona (DE, FR, IT…) usan los mismos campos WIRE.
    const euCountries = new Set(['DE','FR','IT','NL','BE','PT','AT','PL','SE','CH','NO','DK','FI','IE']);
    const harborKey = euCountries.has(countryCode) ? 'EU' : countryCode;
    const harborFields = HARBOR_FORM_FIELDS[harborKey] ?? null;

    if (!harborFields) {
      console.warn(`[WithdrawalRules] No hay HARBOR_FORM_FIELDS para país: ${countryCode} (clave: ${harborKey})`);
      return res.status(404).json({
        error: `No hay definición de formulario Harbor para ${countryCode}. Contactar soporte.`,
      });
    }

    const payload = { destCountry: countryCode, payoutMethod: 'owlPay', fields: harborFields };
    withdrawalRulesCache.set(cacheKey, { payload, cachedAt: Date.now() });
    return res.status(200).json(payload);
  }

  // ── 3b. Vita Wallet — flujo existente ──────────────────────────────────────
  let fields;
  try {
    const vitaResponse = await getVitaWithdrawalRules();
    const vitaKey      = getVitaCountryKey(countryCode, corridor?.destinationCurrency);
    const vitaFields   = vitaResponse?.rules?.[vitaKey]?.fields ?? [];

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
    contactId,
    // Datos de la cotización previa (opcionales — si el frontend los pasa se guardan)
    destinationAmount:   quotedDestAmount,
    exchangeRate:        quotedExchangeRate,
    usdcTransitAmount:   quotedUsdcTransitAmount,
    // Selección de método Harbor por parte del usuario (corredores multi-método).
    owlPayMethod,
    // Provider quote metadata (heredado del response de GET /quote).
    // providerQuoteId NO se reusa en dispatchPayout (los quotes Harbor expiran
    // ~60 s y el payin manual tarda horas) — se persiste solo para auditoría.
    providerQuoteId,
    rateSource,
    rateExpiresAt,
    rateConfidence,
    // Legacy alias (backward compat con frontend viejo que mandaba harborQuoteId).
    harborQuoteId,
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
  // Debe estar alineado con harborMethodSupport.js (single source of truth de métodos Harbor).
  const VALID_OWLPAY_METHODS = new Set([
    'CIPS', 'WIRE',                              // China / multi
    'PIX',                                       // Brasil
    'SPEI',                                      // México
    'SEPA',                                      // Europa
    'ACH', 'ACH_PUSH', 'FEDWIRE', 'DOMESTIC_WIRE', // EEUU
    'NEQUI', 'BANK_TRANSFER', 'BANK-TRANSFER',   // Colombia / UAE
    'AANI', 'FTS',                               // UAE
    'IMPS', 'NEFT', 'RTGS',                      // India
    'CHATS', 'FPS',                              // Hong Kong / GB
  ]);
  // Normalizar: si el método no es válido, descartarlo (null) — el create NO debe
  // recibir un valor fuera del enum (rompía Transaction.create → 500). Harbor elige
  // el mejor método disponible cuando no se pasa uno.
  let normalizedOwlPayMethod = owlPayMethod;
  if (owlPayMethod && !VALID_OWLPAY_METHODS.has(owlPayMethod)) {
    console.warn('[crossborder] owlPayMethod desconocido recibido, se descarta:', owlPayMethod);
    normalizedOwlPayMethod = null;
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
  // Mínimo EFECTIVO (incluye el guard de piso del proveedor) — misma fuente que
  // el quote, así no se puede crear una transacción que el payout va a rechazar.
  const { min: minAmount } = await resolveEffectiveMinimum(corridor, req.user?.accountType);
  if (minAmount > 0 && amount < minAmount) {
    return res.status(400).json({
      error:    `El monto mínimo para este corredor es ${minAmount} ${corridor.originCurrency}.`,
      code:     'BELOW_MINIMUM',
      min:      minAmount,
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

  // ── Límite operativo Business (KYB aprobado) ──────────────────────────────
  // Solo aplica cuando el límite y la moneda de origen coinciden.
  if (req.user?.accountType === 'business') {
    try {
      const bizProfile = await BusinessProfile.findOne({ userId: req.user._id })
        .select('transactionLimits')
        .lean();
      if (bizProfile?.transactionLimits?.currency === corridor.originCurrency) {
        const { maxSingleTransaction } = bizProfile.transactionLimits;
        if (maxSingleTransaction > 0 && amount > maxSingleTransaction) {
          return res.status(400).json({
            error:    `El monto supera el límite por transacción de tu cuenta Business.`,
            code:     'BUSINESS_TX_LIMIT_EXCEEDED',
            limit:    maxSingleTransaction,
            currency: corridor.originCurrency,
          });
        }
      }
    } catch (bizErr) {
      console.error('[CrossBorder] Error verificando límites Business:', bizErr.message);
    }
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
    const spreadFee         = round2(amount * (getEffectiveSpreadPct(corridor, req.user) / 100));
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
      firstName:   ben.beneficiary_first_name ?? ben.firstName  ?? '',
      lastName:    ben.beneficiary_last_name  ?? ben.lastName   ?? '',
      accountType: ben.accountType ?? '',
      accountBank: ben.beneficiary_account ?? ben.accountNumber ?? '',
      bankCode:    ben.beneficiary_bank    ?? ben.bankName      ?? '',
      dynamicFields: ben,
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
        corridorCode:        corridor.corridorId,
        ...(contactId ? { contactId } : {}),

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

        isPrioritySupport:  req.user?.accountType === 'business',
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
        // Beneficiario Bolivia — los campos vienen en snake_case (beneficiary_first_name)
        // cuando el frontend usa el formato dinámico de Vita. Fallback a camelCase (legado).
        const beneName = (
          `${ben.beneficiary_first_name ?? ben.firstName ?? ''} ${ben.beneficiary_last_name ?? ben.lastName ?? ''}`.trim()
        ) || '—';
        const beneBank    = ben.beneficiary_bank    ?? ben.bankName    ?? ben.bankCode ?? '—';
        const beneAcctRaw = ben.beneficiary_account ?? ben.accountNumber ?? ben.accountBank ?? '';
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
          beneficiaryName: `${ben.beneficiary_first_name ?? ben.firstName ?? ''} ${ben.beneficiary_last_name ?? ben.lastName ?? ''}`.trim(),
          bankName:        ben.beneficiary_bank    ?? ben.bankName    ?? '',
          accountNumber:   ben.beneficiary_account ?? ben.accountNumber ?? '',
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
  const alytoCSpread    = round2(amount * (getEffectiveSpreadPct(corridor, req.user) / 100));
  const _isBusiness     = req.user?.accountType === 'business';
  const fixedFee        = (_isBusiness && corridor.businessFixedFee != null)
    ? corridor.businessFixedFee
    : (corridor.fixedFee ?? 0);
  const profitRetention = round2(amount * (corridor.profitRetentionPercent / 100));
  const payoutFee       = corridor.payoutFeeFixed ?? 0;

  console.log('[CrossBorder] Fees desde TransactionConfig:');
  console.log('  corridorId:', corridorId);
  console.log('  Fees calculados:', { payinFee, alytoCSpread, fixedFee, profitRetention, payoutFee });

  // ── 3c. USDC de tránsito: SIEMPRE recalculado server-side (corredores SRL/BOB) ──
  // transaction.digitalAssetAmount es el monto que dispatchPayout envía a Vita/Harbor.
  // El valor del body (quotedUsdcTransitAmount) solo se acepta si coincide con el
  // cálculo del servidor dentro de una tolerancia estrecha (drift de tasa entre el
  // quote y este create). Fuera de tolerancia → se usa el valor del servidor y se
  // reporta a Sentry como posible manipulación.
  const USDC_TRANSIT_TOLERANCE = 0.015; // 1.5% — cubre drift quote→create con tasa de mercado+buffer
  let serverUsdcTransit = null;
  if (corridor.legalEntity === 'SRL' && corridor.originCurrency === 'BOB') {
    try {
      const { bobPerUsdc } = await resolveQuoteRate(corridor);
      const netBOB = round2(amount - (payinFee + alytoCSpread + fixedFee + profitRetention));
      if (bobPerUsdc > 0 && netBOB > 0) serverUsdcTransit = round2(netBOB / bobPerUsdc);
    } catch (rateErr) {
      // Sin tasa ahora mismo: dejamos digitalAssetAmount sin setear — dispatchPayout
      // recalcula server-side (convertBobToUsdc) al despachar. NUNCA el valor del cliente.
      console.warn('[CrossBorder] resolveQuoteRate falló — usdcTransit se recalculará al despachar:', rateErr.message);
    }
  }
  let digitalAssetAmountFinal = null;
  if (serverUsdcTransit > 0) {
    const quotedUsdc = Number(quotedUsdcTransitAmount);
    if (
      Number.isFinite(quotedUsdc) && quotedUsdc > 0 &&
      Math.abs(quotedUsdc - serverUsdcTransit) / serverUsdcTransit <= USDC_TRANSIT_TOLERANCE
    ) {
      // Coincide con lo cotizado al usuario — honrar el monto mostrado.
      digitalAssetAmountFinal = quotedUsdc;
    } else {
      digitalAssetAmountFinal = serverUsdcTransit;
      if (quotedUsdcTransitAmount != null) {
        console.warn('[CrossBorder] ⚠️ usdcTransitAmount del cliente fuera de tolerancia — usando cálculo server-side:', {
          quoted: quotedUsdcTransitAmount, server: serverUsdcTransit, userId: String(userId),
        });
        Sentry.captureMessage('usdcTransitAmount del cliente fuera de tolerancia (posible manipulación)', {
          level: 'warning',
          extra: { quoted: quotedUsdcTransitAmount, server: serverUsdcTransit, corridorId, userId: String(userId) },
        });
      }
    }
  }

  // ── 4. Crear payin según el método del corredor ───────────────────────────
  //
  //   fintoc    → Checkout Session en Fintoc. Fondos llegan a cuenta SpA en Chile.
  //               El payout a Vita se dispara solo tras IPN de confirmación.
  //   vitaWallet → payment_order en Vita (ej. AR, BR donde el usuario paga en su país).
  //

  // Generar alytoTransactionId ANTES del call a Fintoc para incluirlo en el metadata.
  // El IPN de confirmación usará este ID para encontrar la transacción en BD.
  const alytoTransactionId = `ALY-${corridor.routingScenario ?? 'D'}-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  let payinProviderRef          = null;  // ID externo para lookup en IPN
  let payinUrl                  = null;  // Token/URL que abre el widget de pago
  let payinProvider             = 'unknown';
  let manualPaymentInstructions = null;  // Solo para payinMethod === 'manual'
  let bankQrMeta                = null;  // Solo para payinMethod === 'bankQr'

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
        success_url:    `${process.env.FRONTEND_URL}/success`,
        cancel_url:     `${process.env.FRONTEND_URL}/cancel`,
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

  } else if (corridor.payinMethod === 'bankQr') {
    // ── Payin QR Bancario (Bolivia — Banco Económico u otro banco registrado) ─
    // El banco genera un QR real que el usuario escanea con su app bancaria.
    // La confirmación es automática via webhook (POST /api/v1/ipn/{bankId}).
    // No requiere subida de comprobante ni confirmación manual del admin.
    const bankId = corridor.bankQrConfig?.bankId ?? 'bec';

    // Vencimiento del QR. dueDate='hoy' expiraba a medianoche → un usuario que
    // genera el QR a las 23:30 tenía 30 min para pagar. BANK_QR_DUE_DAYS (default 1)
    // extiende la validez. dueDate en scope externo para acceso fuera del try.
    const BANK_QR_DUE_DAYS = Math.max(0, Number(process.env.BANK_QR_DUE_DAYS ?? 1));
    const dueDateObj = new Date();
    dueDateObj.setDate(dueDateObj.getDate() + BANK_QR_DUE_DAYS);
    const dueDate = [
      dueDateObj.getFullYear(),
      String(dueDateObj.getMonth() + 1).padStart(2, '0'),
      String(dueDateObj.getDate()).padStart(2, '0'),
    ].join('-');
    // Fin del día de vencimiento (23:59:59 local) — sincroniza el TTL de la tx
    // con la vida real del QR en el banco, para cleanup/reconciliación.
    const dueExpiresAt = new Date(dueDateObj);
    dueExpiresAt.setHours(23, 59, 59, 999);

    let becResult;
    try {
      const { getBankQrService } = await import('../services/bankQr/bankQrRegistry.js');
      const svc = getBankQrService(bankId);

      becResult = await svc.generateQR({
        transactionId: alytoTransactionId,           // 26 chars, bajo el límite de 30
        amount:        amount,
        currency:      corridor.originCurrency ?? 'BOB',
        description:   `Alyto ${alytoTransactionId}`.slice(0, 100),
        dueDate,
      });
    } catch (err) {
      logger.error('[CrossBorder] Error generando QR bancario:', {
        bankId, corridorId, error: err.message,
      });
      Sentry.captureException(err, {
        tags:  { component: 'initCrossBorderPayment', payinMethod: 'bankQr' },
        extra: { corridorId, bankId, amount },
      });
      return res.status(502).json({ error: 'No se pudo generar el código QR. Intenta nuevamente.' });
    }

    payinProvider    = 'bankQr';   // bankId específico en bankQr.bankId
    payinProviderRef = becResult.qrId;
    payinUrl         = null;

    // La imagen base64 se guarda en paymentQR (mismo campo que el QR manual estático)
    // y los metadatos del banco en bankQr para la reconciliación.
    bankQrMeta = {
      bankId,
      qrId:    becResult.qrId,
      dueDate,                       // string 'yyyy-MM-dd' — mismo valor enviado al banco
      expiresAt: dueExpiresAt,       // Date — fin del día de vencimiento (TTL de la tx)
      qrImage: becResult.qrImage,    // almacenado temporalmente para pasarlo a la response
    };

    logger.info('[CrossBorder] QR bancario generado', {
      bankId,
      qrId:               becResult.qrId,
      alytoTransactionId,
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
      bankName:      dbBankData.bankName      || process.env.SRL_BANK_NAME      || 'Banco Económico',
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
        success_redirect_url: `${process.env.FRONTEND_URL ?? 'https://alyto.app'}/success`,
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
      corridorCode:    corridor.corridorId,
      ...(contactId ? { contactId } : {}),

      originalAmount:      amount,
      originCurrency:      corridor.originCurrency,
      originCountry:       corridor.originCountry,
      destinationCountry:  corridor.destinationCountry,
      destinationCurrency: corridor.destinationCurrency,
      // Activo de tránsito en Stellar (USDC para corredores SRL Bolivia)
      ...(corridor.legalEntity === 'SRL' ? { digitalAsset: 'USDC' } : {}),
      // usdcTransitAmount: calculado server-side (sección 3c). El valor del body
      // solo se usa si coincide con el cálculo del servidor dentro de tolerancia.
      ...(digitalAssetAmountFinal != null && corridor.legalEntity === 'SRL'
        ? { digitalAssetAmount: digitalAssetAmountFinal }
        : {}),
      // destinationAmount estimado del WS/getQuote. tryOwlPayV2 lo sobreescribirá
      // con el monto real de Harbor al crear el transfer (rateConfidence='exact').
      ...(quotedDestAmount   != null ? { destinationAmount: quotedDestAmount }         : {}),
      ...(quotedExchangeRate != null ? { exchangeRate: quotedExchangeRate, exchangeRateLockedAt: new Date() } : {}),

      fees: {
        payinFee,
        alytoCSpread,
        fixedFee,
        payoutFee,
        profitRetention,
        vitaRateMarkup:    0,   // spec v1.0 §3.5, §6.9 — always zero for new tx
        totalDeducted:     round2(payinFee + alytoCSpread + fixedFee),
        totalDeductedReal: round2(payinFee + alytoCSpread + fixedFee + profitRetention),
        feeCurrency:       corridor.originCurrency ?? 'USD',
      },

      beneficiary: beneficiaryDoc,

      // transferPurpose: read from beneficiaryData for OwlPay corridors (Harbor requirement)
      ...((beneficiaryData ?? legacyBeneficiary)?.transfer_purpose
        ? { transferPurpose: String((beneficiaryData ?? legacyBeneficiary).transfer_purpose) }
        : {}),

      ...(normalizedOwlPayMethod ? { owlPayMethod: normalizedOwlPayMethod } : {}),

      // Provider quote metadata del GET /quote previo (solo para auditoría).
      // owlPay: forzar 'estimated' — el rate real se fija en tryOwlPayV2 al despachar.
      ...((providerQuoteId ?? harborQuoteId) ? { providerQuoteId: providerQuoteId ?? harborQuoteId } : {}),
      ...(rateSource    && corridor.payoutMethod !== 'owlPay' ? { rateSource }                       : {}),
      ...(rateExpiresAt && corridor.payoutMethod !== 'owlPay' ? { rateExpiresAt: new Date(rateExpiresAt) } : {}),
      rateConfidence: (() => {
        // owlPay: siempre 'estimated' hasta que tryOwlPayV2 fije el rate real con Harbor.
        if (corridor.payoutMethod === 'owlPay') return 'estimated';
        // Cualquier otro corredor: usar lo que envió el frontend; si falta, default 'estimated'.
        // El WS emite rateConfidence:'estimated' en las 3 ramas — debería llegar siempre.
        // El fallback evita null en clientes con bundle cacheado antes del fix de Step4Confirm.
        if (!rateConfidence) {
          console.warn('[CrossBorder] rateConfidence ausente en body — usando default "estimated"', {
            alytoTransactionId,
            corridorId: corridor.corridorId,
            payoutMethod: corridor.payoutMethod,
            bodyHasField: 'rateConfidence' in req.body,
          });
        }
        return rateConfidence ?? 'estimated';
      })(),

      providersUsed: [`payin:${payinProvider}`],
      paymentLegs: [{
        stage:      'payin',
        provider:   payinProvider,
        status:     'pending',
        externalId: payinProviderRef ? String(payinProviderRef) : undefined,
      }],

      payinReference:      payinProviderRef ? String(payinProviderRef) : undefined,
      paymentInstructions: manualPaymentInstructions ?? undefined,
      // bankQr: solo los metadatos de reconciliación (qrImage va en paymentQR)
      ...(bankQrMeta ? { bankQr: { bankId: bankQrMeta.bankId, qrId: bankQrMeta.qrId, dueDate: bankQrMeta.dueDate } } : {}),
      // bankQr: TTL de la tx = fin del día de vencimiento del QR (no el default +24h),
      // para que el barrido de expiración reconcilie/cancele en el momento correcto.
      ...(bankQrMeta?.expiresAt ? { paymentInstructionsExpiresAt: bankQrMeta.expiresAt } : {}),
      isPrioritySupport:   req.user?.accountType === 'business',
      // bankQr y manual comienzan en 'payin_pending' (no requieren comprobante manual).
      // Manual: admin confirma desde el ledger. bankQr: banco notifica via webhook.
      status: payinProvider === 'manual' ? 'pending_comprobante' : 'payin_pending',
      alytoTransactionId,
    });
  } catch (err) {
    console.error('[Alyto CrossBorder] Error persistiendo transacción en BD:', {
      corridorId, error: err.message,
    });
    // No continuar con transaction=undefined (causaba un 500 confuso aguas abajo
    // al acceder a transaction.originCurrency). Devolver el motivo real de inmediato.
    return res.status(500).json({
      error:  'No se pudo crear la transacción.',
      detail: err.message,
    });
  }

  // ── 7. QR + Emails post-creación de transacción ──────────────────────────
  let paymentQR      = null;
  let paymentQRStatic = [];   // QR estáticos subidos por el admin (Tigo Money, Banco, etc.)

  // bankQr: el QR ya fue generado por el banco — solo persistirlo en paymentQR
  if (corridor.payinMethod === 'bankQr' && bankQrMeta && transaction) {
    try {
      transaction.paymentQR = bankQrMeta.qrImage;
      await transaction.save();
      paymentQR = bankQrMeta.qrImage;
    } catch (saveErr) {
      logger.error('[CrossBorder] Error guardando qrImage del banco:', saveErr.message);
    }
  }

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

    // Obtener QR estáticos configurados por el admin (Tigo Money, Banco Económico, etc.)
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
      // Rate user-facing dest/origin desde amounts — independiente de la
      // semántica inconsistente de Transaction.exchangeRate (deprecated).
      exchangeRate:        getDisplayRate(transaction) || quotedExchangeRate || null,
      // QR dinámico: codifica datos bancarios para apps de homebanking
      paymentQR,
      // QR estáticos: imágenes subidas por el admin (Tigo Money, Banco Económico, etc.)
      // Array de { label, imageBase64 } — mostrar cada uno con su etiqueta
      paymentQRStatic,
    });
  }

  // bankQr: incluir QR image + metadatos necesarios para el frontend
  if (corridor.payinMethod === 'bankQr') {
    return res.status(201).json({
      transactionId:       alytoTransactionId,
      payinMethod:         payinProvider,
      status:              'payin_pending',
      destinationAmount:   transaction.destinationAmount   ?? quotedDestAmount   ?? null,
      destinationCurrency: transaction.destinationCurrency ?? null,
      exchangeRate:        getDisplayRate(transaction) || quotedExchangeRate || null,
      paymentQR,                              // base64 del QR bancario real
      bankQrId:            bankQrMeta?.qrId, // para polling de estado si lo necesita el FE
      dueDate:             bankQrMeta?.dueDate,
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
 *   withdrawal.prices.attributes.clp_sell[countryKey]          → tasa CLP→destino
 *   usd.withdrawal.prices.attributes.usd_sell[countryKey]      → tasa USD→destino (39 países, directa)
 *   withdrawal.prices.attributes.fixed_cost[countryKey]        → costo fijo en moneda destino
 *   withdrawal.prices.attributes.valid_until                   → expiración ISO8601
 *
 * Para originCurrency USD/USDC: se usa prices.usd.withdrawal.usd_sell (tasa exacta de Vita).
 *   Fall back a cross-rate CLP si la sección USD no está disponible:
 *   usd_to_dest = clp_sell[dest] / clp_sell["us"]
 *   Ejemplo: clp_sell.co=4.343071 / clp_sell.us=0.001035 ≈ 4196 COP/USD
 *
 * @param {object} vitaPricesResponse  — Respuesta cruda de getPrices()
 * @param {string} originCurrency      — 'CLP' | 'USD' | 'USDC'
 * @param {string} destinationCountry  — ISO alpha-2 mayúsculas (ej. 'CO', 'CL')
 * @returns {{ rate: number, fixedCost: number, validUntil: string|null } | null}
 */
async function extractVitaPricing(vitaPricesResponse, originCurrency, destinationCountry) {
  const destUpper  = destinationCountry.toUpperCase();
  const isVitaSent = VITA_SENT_ONLY_COUNTRIES.has(destUpper);

  // vita_sent (ES/PL/GT/SV/EU): claves ISO directas en la tabla, con EU→'es'
  // (getVitaSentCountry — la eurozona entra por España, el IBAN fija el país).
  // withdrawal (todos los demás): CA→'causd', HK→'hkusd', etc.
  const countryKey = isVitaSent
    ? getVitaSentCountry(destUpper).toLowerCase()
    : getVitaCountryKey(destinationCountry);
  const origin     = originCurrency.toUpperCase();
  let rate;

  // ── Países vita_sent con origen USD/USDC/BOB: tasa desde usd.vita_sent ──────
  // Es el MISMO rail que ejecuta el dispatch (createVitaSentPayout) y es
  // autosuficiente: NO depende de la sección CLP, por eso va ANTES del gate de
  // attrs (que apunta a la sección CLP y no aplica aquí).
  if (isVitaSent && (origin === 'USD' || origin === 'USDC' || origin === 'BOB')) {
    const sentAttrs = vitaPricesResponse?.usd?.vita_sent?.prices?.attributes;
    const sentRate  = Number(sentAttrs?.usd_sell?.[countryKey] ?? NaN);
    if (isFinite(sentRate) && sentRate > 0) {
      const fixedCost  = Number(sentAttrs?.fixed_cost?.[countryKey] ?? 0);
      const validUntil = sentAttrs?.valid_until ?? null;
      if (origin === 'BOB') {
        const BOB_USD_RATE = await getBOBRate();
        return { rate: sentRate / BOB_USD_RATE, fixedCost, validUntil };
      }
      return { rate: sentRate, fixedCost, validUntil };
    }
  }

  // ── Sección CLP (tasas cross-rate / origen CLP) ──────────────────────────────
  // La API de Vita anida las tablas por moneda de origen (clp.withdrawal,
  // clp.vita_sent, usd.withdrawal, ...). Se conservan las rutas top-level como
  // primer intento por compatibilidad con la forma antigua de la respuesta.
  const attrsSource = isVitaSent
    ? (vitaPricesResponse?.vita_sent?.prices?.attributes
        ?? vitaPricesResponse?.clp?.vita_sent?.prices?.attributes)
    : (vitaPricesResponse?.withdrawal?.prices?.attributes
        ?? vitaPricesResponse?.clp?.withdrawal?.prices?.attributes);

  const attrs = attrsSource
    ?? vitaPricesResponse?.withdrawal?.prices?.attributes
    ?? vitaPricesResponse?.clp?.withdrawal?.prices?.attributes;
  if (!attrs) return null;

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
    // Preferir tasa directa desde prices.usd.withdrawal (exactamente lo que Vita aplica).
    // Fall back a cross-rate CLP si la sección USD no está disponible en la cuenta.
    const usdAttrs   = vitaPricesResponse?.usd?.withdrawal?.prices?.attributes;
    const directRate = Number(usdAttrs?.usd_sell?.[countryKey] ?? NaN);
    if (isFinite(directRate) && directRate > 0) {
      return {
        rate:       directRate,
        fixedCost:  Number(usdAttrs?.fixed_cost?.[countryKey] ?? 0),
        validUntil: usdAttrs?.valid_until ?? null,
      };
    }
    const clpToDest = Number(attrs.clp_sell?.[countryKey] ?? NaN);
    const clpToUsd  = Number(attrs.clp_sell?.['us']       ?? NaN);
    if (!isFinite(clpToDest) || !isFinite(clpToUsd) || clpToUsd <= 0) return null;
    rate = clpToDest / clpToUsd;
  } else if (origin === 'BOB') {
    // Bolivia: Vita no tiene bob_sell. Dos pasos:
    //   PASO 1 — tasa USD→destino (USD directo o cross-rate CLP; vita_sent ya
    //            se resolvió arriba antes del gate)
    //   PASO 2 — dividir por BOB_USD_RATE (desde MongoDB o .env)
    const BOB_USD_RATE  = await getBOBRate();
    const usdAttrs      = vitaPricesResponse?.usd?.withdrawal?.prices?.attributes;
    const directUSD     = Number(usdAttrs?.usd_sell?.[countryKey] ?? NaN);
    let usdToDestRate;
    if (isFinite(directUSD) && directUSD > 0) {
      usdToDestRate = directUSD;
    } else {
      const clpToDest = Number(attrs.clp_sell?.[countryKey] ?? NaN);
      const clpToUsd  = Number(attrs.clp_sell?.['us']       ?? NaN);
      if (!isFinite(clpToDest) || !isFinite(clpToUsd) || clpToUsd <= 0) return null;
      usdToDestRate = clpToDest / clpToUsd;
    }
    rate = usdToDestRate / BOB_USD_RATE;
    console.info('[Alyto Quote] Cotización BOB→' + destinationCountry + ':', {
      usdToDestRate, BOB_USD_RATE, bobToDestRate: rate,
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
 * Ruta de conversión: BOB → USDC (tasa admin o BOB_USD_RATE env) → destino (tasa USD directa Vita).
 * Vita no tiene tasas BOB nativas. Se usa prices.usd.withdrawal con fallback a cross-rate CLP.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} corridor  — TransactionConfig activo
 * @param {number} amount    — originAmount en BOB
 * @param {string} dest      — destinationCountry ISO alpha-2 mayúsculas
 */
/**
 * resolveProviderQuote — Para corredores con payoutMethod=owlPay, llama a Harbor
 * con el monto USDC real (quote.digitalAssetAmount) y override quote.destinationAmount
 * + quote.effectiveRate con los valores que Harbor entregará realmente.
 *
 * Para corredores Vita o anchorBolivia, no toca el quote — devuelve la metadata
 * con rateSource='vita' / rateConfidence='estimated'.
 *
 * Si Harbor falla (timeout, 5xx, etc.), no rompe la cotización: deja el quote
 * con la extrapolación Vita pero marca rateSource='vita_fallback' para que el
 * frontend muestre disclaimer de "tasa referencial".
 *
 * Mutates `quote.destinationAmount` y `quote.effectiveRate` cuando aplica override.
 *
 * @returns {{providerQuoteId, rateSource, rateExpiresAt, rateConfidence}}
 */
async function resolveProviderQuote({ quote, corridor, requestedMethod }) {
  const meta = {
    providerQuoteId: null,
    rateSource:      'vita',
    rateExpiresAt:   null,
    rateConfidence:  'estimated',
  };

  if (corridor.payoutMethod !== 'owlPay') return meta;

  try {
    const legalEntity       = (corridor.legalEntity ?? 'SRL').toUpperCase();
    const customerUuidEnvKey = `OWLPAY_CUSTOMER_UUID_${legalEntity}`;
    const customerUuid       = getCustomerUuid(corridor.legalEntity);

    if (!customerUuid) {
      console.warn('[Quote] Customer UUID no configurado para Harbor quote:', {
        corridorId:     corridor.corridorId,
        legalEntity,
        expectedEnvVar: customerUuidEnvKey,
      });
    }
    const harborQuotes = await getHarborQuote({
      sourceAmount:   quote.digitalAssetAmount,
      sourceCurrency: 'USDC',
      sourceChain:    process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      destCountry:    resolveHarborCountry(corridor.destinationCountry),
      destCurrency:   corridor.destinationCurrency,
      customerUuid,
      returnAll:      true,
    });

    // Filtra a métodos soportados (ver utils/harborMethodSupport.js).
    // Evita cotizar con SEPA si el sistema no puede ejecutar SEPA.
    const selected = pickSupportedQuote(harborQuotes, corridor.destinationCountry, requestedMethod);

    if (!selected) throw new Error('Harbor devolvió 0 quotes');

    quote.destinationAmount = selected.destinationAmount;
    quote.effectiveRate     = round6(selected.destinationAmount / quote.originAmount);

    meta.providerQuoteId = selected.quoteId;
    meta.rateSource      = `harbor:${selected.paymentMethod}`;
    meta.rateExpiresAt   = selected.quoteExpiresAt ? new Date(selected.quoteExpiresAt) : null;
    meta.rateConfidence  = 'exact';

    console.info('[Quote] Harbor real cotization aplicada:', {
      method:            selected.paymentMethod,
      sourceAmount:      quote.digitalAssetAmount,
      destinationAmount: selected.destinationAmount,
      effectiveRate:     quote.effectiveRate,
      expiresAt:         meta.rateExpiresAt,
    });
  } catch (err) {
    console.warn('[Quote] Harbor cotization falló — fallback Vita extrapolado:', err.message);
    meta.rateSource     = 'vita_fallback';
    meta.rateConfidence = 'estimated';
  }

  return meta;
}

async function calculateBOBQuote(req, res, corridor, amount, dest) {
  const round2      = n => Math.round(n * 100) / 100;
  const userId      = req.user?._id?.toString();

  // ── 1. Tasa BOB/USDC (con colchón cambiario si aplica) ──────────────────────
  // Fuente única: resolveQuoteRate. manualExchangeRate del admin gana sin colchón;
  // si no, tasa de mercado × (1 + fxBufferPct) para proteger el margen ante el
  // gap quote→fondeo manual (ver services/exchangeRateService.js).
  const { bobPerUsdc, marketRate, bufferPct, source: rateSource } = await resolveQuoteRate(corridor);
  console.log('[Quote BOB] bobPerUsdc:', bobPerUsdc, '| market:', marketRate, '| buffer%:', bufferPct, '| source:', rateSource);

  // ── 2 + 3. Quote por proveedor ────────────────────────────────────────────
  // Harbor (owlPay): una sola llamada con el USDC exacto — sin Vita.
  // Vita / anchorBolivia: flujo existente.

  if (corridor.payoutMethod === 'owlPay') {
    // Paso A: calcular USDC transit desde fees (no requiere tasa de cambio)
    const isBiz        = req.user?.accountType === 'business';
    const _payinFee    = amount * ((corridor.payinFeePercent ?? 0) / 100);
    const _spread      = amount * (getEffectiveSpreadPct(corridor, req.user) / 100);
    const _fixed       = (isBiz && corridor.businessFixedFee != null) ? corridor.businessFixedFee : (corridor.fixedFee ?? 0);
    const _profit      = amount * ((corridor.profitRetentionPercent ?? 0) / 100);
    const _netBOB      = amount - round2(_payinFee + _spread + _fixed + _profit);
    const usdcTransit  = round2(_netBOB / bobPerUsdc);

    if (usdcTransit <= 0) {
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    // Paso B: UNA llamada a Harbor con el monto USDC exacto
    const customerUuid = getCustomerUuid(corridor.legalEntity ?? 'SRL');
    let harborQuotes;
    try {
      harborQuotes = await getHarborQuote({
        sourceAmount:   usdcTransit,
        sourceCurrency: 'USDC',
        sourceChain:    process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
        destCountry:    resolveHarborCountry(corridor.destinationCountry),
        destCurrency:   corridor.destinationCurrency,
        customerUuid,
        returnAll:      true,
      });
    } catch (err) {
      console.error('[Quote BOB Harbor] getHarborQuote falló:', err.message);
      return res.status(503).json({ error: 'Servicio Harbor no disponible. Intenta nuevamente.' });
    }

    const requestedMethod = req.query.method ?? null;
    // Filtra a métodos soportados (utils/harborMethodSupport.js) — evita SEPA EU bug.
    const quotesArr = Array.isArray(harborQuotes) ? harborQuotes : [harborQuotes];
    const selected = pickSupportedQuote(quotesArr, corridor.destinationCountry, requestedMethod) ?? quotesArr[0];

    if (!selected?.exchangeRate) {
      return res.status(503).json({ error: 'Harbor no devolvió tasa válida.' });
    }

    // Paso C: calculateQuote con rate real de Harbor → fee breakdown correcto
    let quote;
    try {
      quote = calculateQuote({
        amount, corridor, bobPerUsdc,
        providerRate: selected.exchangeRate,
        accountType:  req.user?.accountType,
      });
    } catch (err) {
      console.error('[Quote BOB Harbor] calculateQuote rejected:', err.message);
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    // Harbor entrega el destinationAmount exacto — usarlo directamente
    if (selected.destinationAmount > 0) {
      quote.destinationAmount = selected.destinationAmount;
      quote.effectiveRate     = round6(selected.destinationAmount / amount);
    }

    if (quote.destinationAmount <= 0) {
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    const alytoProfitUSDC = round2(
      // Ganancia = solo fees de Alyto (spread + fijo + retención). payinFee es
      // pass-through del proveedor de payin → NO es ganancia.
      (quote.fees.alytoCSpread + quote.fees.fixedFee + quote.fees.profitRetention)
      / bobPerUsdc,
    );
    const quoteExpiresAt = selected.quoteExpiresAt
      ? new Date(Math.min(new Date(selected.quoteExpiresAt).getTime(), Date.now() + 3 * 60 * 1000))
      : new Date(Date.now() + 3 * 60 * 1000);

    console.log('[Quote BOB Harbor] rate USDC→' + dest + ':', selected.exchangeRate, '| method:', selected.paymentMethod);
    console.log('[Quote BOB Harbor] usdcTransit:', quote.digitalAssetAmount, '| dest:', quote.destinationAmount);

    return res.status(200).json({
      corridorId:          corridor.corridorId,
      originAmount:        quote.originAmount,
      originCurrency:      'BOB',
      destinationAmount:   quote.destinationAmount,
      destinationCurrency: corridor.destinationCurrency,
      exchangeRate:        quote.effectiveRate,
      conversionPath:      `BOB → USDC → ${corridor.destinationCurrency}`,
      isManualCorridor:    false,
      stellarAsset:        'USDC',
      usdcTransitAmount:   quote.digitalAssetAmount,
      bobPerUsdc,
      usdcToDestRate:      selected.exchangeRate,
      harborPaymentMethod: selected.paymentMethod,
      // alytoProfitUSDC (margen de Alyto) se re-agregaba DESPUÉS de toPublicFees,
      // anulando el filtro. Va solo al console.info de arriba.
      fees: toPublicFees(quote.fees, {
        originCurrency:      corridor.originCurrency,
        destinationCurrency: corridor.destinationCurrency,
      }),
      payinMethod:     corridor.payinMethod,
      payoutMethod:    corridor.payoutMethod,
      entity:          'SRL',
      quoteExpiresAt,
      providerQuoteId: selected.quoteId,
      rateSource:      `harbor:${selected.paymentMethod}`,
      rateExpiresAt:   selected.quoteExpiresAt ? new Date(selected.quoteExpiresAt) : null,
      rateConfidence:  'exact',
    });
  }

  // ── Vita / anchorBolivia ──────────────────────────────────────────────────
  let usdToDestRate, vitaFixedCost = 0, validUntil, providerMeta;

  {
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

    usdToDestRate = vitaPricingUSD.rate;
    vitaFixedCost = vitaPricingUSD.fixedCost;
    validUntil    = vitaPricingUSD.validUntil;
    providerMeta  = { providerQuoteId: null, rateSource: 'vita', rateExpiresAt: null, rateConfidence: 'estimated' };
  }

  let quote;
  try {
    quote = calculateQuote({
      amount, corridor, bobPerUsdc,
      providerRate:     usdToDestRate,
      // Fija REAL de Vita (fixed_cost live, moneda destino): sin descontarla el
      // quote prometía más de lo que Vita entrega (ej. withdrawal[eu]: 5 EUR).
      providerFixedFee: vitaFixedCost,
      accountType:      req.user?.accountType,
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

  console.log('[Quote BOB] rate USD→' + dest + ':', usdToDestRate, '| fixedCost:', vitaFixedCost, '| provider:', providerMeta.rateSource);
  console.log('[Quote BOB] effectiveRate BOB→' + dest + ':', quote.effectiveRate);
  console.log('[Quote BOB] netBOB:', amount - quote.totalDeductedReal, '| usdcTransit:', quote.digitalAssetAmount, '| dest:', quote.destinationAmount);

  const localExpiry    = new Date(Date.now() + 3 * 60 * 1000);
  const vitaExpiry     = validUntil ? new Date(validUntil) : null;
  const harborExpiry   = providerMeta.rateExpiresAt;
  // El más restrictivo: local 3min vs Vita validUntil vs Harbor expiry
  const candidates     = [localExpiry, vitaExpiry, harborExpiry].filter(Boolean);
  const quoteExpiresAt = candidates.reduce((a, b) => (a < b ? a : b));

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
    harborPaymentMethod: providerMeta.rateSource?.startsWith('harbor:')
      ? providerMeta.rateSource.replace('harbor:', '')
      : null,
    // alytoProfitUSDC y profitRetention NO viajan al usuario (regla 11 CLAUDE.md):
    // esta ruta hacía `...quote.fees` y los exponía junto con la fija en moneda
    // destino. toPublicFees es lista blanca — ver quoteCalculator.js.
    fees: toPublicFees(quote.fees, {
      originCurrency:      corridor.originCurrency,
      destinationCurrency: corridor.destinationCurrency,
    }),
    payinMethod:   corridor.payinMethod,
    payoutMethod:  corridor.payoutMethod,
    entity:        'SRL',
    quoteExpiresAt,
    // Provider quote metadata (commit 4 — response shape)
    providerQuoteId: providerMeta.providerQuoteId,
    rateSource:      providerMeta.rateSource,
    rateExpiresAt:   providerMeta.rateExpiresAt,
    rateConfidence:  providerMeta.rateConfidence,
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
      // EU/SEPA → SIEMPRE Vita (regla fija en código, ver euAmountRouter.js).
      // Si no hay corredor Vita para ese origen, cae al lookup normal.
      corridor = await resolveEuCorridor(origin, dest);
      if (!corridor) {
        corridor = await TransactionConfig.findOne({
          originCountry:      origin,
          destinationCountry: dest,
          isActive:           true,
        }).lean();
      }
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

  // Precios de Vita: se piden UNA sola vez por cotización y se reusan tanto para
  // el piso del mínimo como para la tasa más abajo (getPrices cachea, pero pedirlo
  // dos veces en el mismo request es ruido innecesario).
  let vitaResponse = null;
  if (corridor.payoutMethod === 'vitaWallet') {
    vitaResponse = await getPrices().catch(() => null);   // el 503 se decide más abajo
  }

  // Validar monto mínimo del corredor — mínimo EFECTIVO: el configurado, elevado
  // si hiciera falta para que el NETO (post-fees) alcance el piso del proveedor.
  // Sin esto el usuario cotizaba y pagaba, y el payout moría después en Vita/Harbor
  // (ver corridorMinimums.js).
  const { min: minAmountOrigin, raisedBy, floorUSD } =
    await resolveEffectiveMinimum(corridor, req.user?.accountType, vitaResponse);
  if (amount < minAmountOrigin) {
    if (raisedBy) {
      console.info('[Alyto Quote] mínimo elevado por piso del proveedor', {
        corridorId: corridor.corridorId, minAmountOrigin, floorUSD,
      });
    }
    return res.status(400).json({
      error:  `El monto mínimo para este corredor es ${minAmountOrigin} ${corridor.originCurrency}.`,
      min:    minAmountOrigin,
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
    const spreadFee         = round2(amount * (getEffectiveSpreadPct(corridor, req.user) / 100));
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
      exchangeRateDisplay:    (() => {
        // Fix: esto es una COTIZACIÓN — no existe `transaction` en este scope
        // (antes referenciaba una variable no declarada → ReferenceError → 500).
        // Se calcula la tasa efectiva (incluye fees) con los montos ya resueltos.
        const r = getDisplayRate({ originalAmount: amount, destinationAmount: destinationBOB });
        return r > 0 ? `1 BOB = ${(1 / r).toFixed(2)} CLP` : '—';
      })(),
      payinMethod:            'manual',
      payoutMethod:           'anchorBolivia',
      isManualCorridor:       true,
      paymentRef,

      // El comentario decía "NO visible al usuario" pero profitRetention y
      // totalDeductedReal iban en el body de la respuesta igual. Fuera.
      fees: {
        payinFee:      round2(payinFee),
        alytoCSpread:  round2(spreadFee),
        fixedFee:      round2(fixedFee),
        payoutFee:     0,
        totalDeducted: round2(payinFee + spreadFee + fixedFee),
        feeCurrency:   'CLP',
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
  const alytoCSpread    = amount * (getEffectiveSpreadPct(corridor, req.user) / 100);
  const fixedFee        = corridor.fixedFee;
  const profitRetention = amount * (corridor.profitRetentionPercent / 100);
  const amountAfterFees = amount - payinFee - alytoCSpread - fixedFee - profitRetention;

  if (amountAfterFees <= 0) {
    return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
  }

  // Si ya se obtuvieron arriba (corredor Vita) se reusan; si no, o si aquel intento
  // falló, se piden aquí — este es el punto donde la falta de tasas SÍ es un 503.
  if (!vitaResponse) {
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
    // bobPerUsdc: tasa admin sin colchón, o mercado × (1 + colchón) — fuente única.
    const { bobPerUsdc, marketRate, bufferPct, source: rateSource } = await resolveQuoteRate(corridor);
    console.log('[Alyto Quote] bobPerUsdc:', bobPerUsdc, '| market:', marketRate, '| buffer%:', bufferPct, '| source:', rateSource);

    const vitaPricingUSD = await extractVitaPricing(vitaResponse, 'USD', dest);
    if (!vitaPricingUSD) {
      console.error('[Alyto Quote] Vita no tiene tasa USD→' + dest + ' para corredor manual.', {
        corridorId: corridor.corridorId, userId,
      });
      return res.status(503).json({
        error: 'Tasa de cambio no disponible para este corredor. Intenta nuevamente.',
      });
    }

    const { rate: usdcToDestRate, fixedCost: vitaFixedCost, validUntil } = vitaPricingUSD;

    // ── Quote unificado — canonical formula (spec v1.0 §3.2) ─────────────────
    let quote;
    try {
      quote = calculateQuote({
        amount,
        corridor,
        bobPerUsdc,
        providerRate:     usdcToDestRate,
        // Fija REAL de Vita (fixed_cost live) — sin ella el quote promete de más.
        providerFixedFee: vitaFixedCost,
        accountType:      req.user?.accountType,
      });
    } catch (err) {
      console.error('[Alyto Quote] calculateQuote rejected inputs:', err.message);
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    if (quote.destinationAmount <= 0) {
      return res.status(400).json({ error: 'Monto insuficiente para cubrir los fees del corredor.' });
    }

    // Provider-aware override (mismo helper que calculateBOBQuote).
    const providerMeta = await resolveProviderQuote({
      quote,
      corridor,
      requestedMethod: req.query.method ?? null,
    });

    const alytoProfitUSDC = round2(
      // Ganancia = solo fees de Alyto (spread + fijo + retención). payinFee es
      // pass-through del proveedor de payin → NO es ganancia.
      (quote.fees.alytoCSpread + quote.fees.fixedFee + quote.fees.profitRetention)
      / bobPerUsdc,
    );

    const localExpiry    = new Date(Date.now() + 3 * 60 * 1000);
    const vitaExpiry     = validUntil ? new Date(validUntil) : null;
    const harborExpiry   = providerMeta.rateExpiresAt;
    const candidates     = [localExpiry, vitaExpiry, harborExpiry].filter(Boolean);
    const quoteExpiresAt = candidates.reduce((a, b) => (a < b ? a : b));

    console.info('[Alyto Quote] Cotización manual ' + corridor.originCurrency + '→USDC→' + dest + ':', {
      corridorId:        corridor.corridorId,
      userId,
      originAmount:      amount,
      bobPerUsdc,
      usdcTransitAmount: quote.digitalAssetAmount,
      usdcToDestRate,
      destinationAmount: quote.destinationAmount,
      alytoProfitUSDC,
      rateSource:        providerMeta.rateSource,
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
      // alytoProfitUSDC (margen de Alyto) se re-agregaba DESPUÉS de toPublicFees,
      // anulando el filtro. Va solo al console.info de arriba.
      fees: toPublicFees(quote.fees, {
        originCurrency:      corridor.originCurrency,
        destinationCurrency: corridor.destinationCurrency,
      }),
      quoteExpiresAt,
      payinMethod:  corridor.payinMethod,
      payoutMethod: corridor.payoutMethod,
      legalEntity:  corridor.legalEntity,
      // Provider quote metadata (commit 4 — response shape)
      providerQuoteId: providerMeta.providerQuoteId,
      rateSource:      providerMeta.rateSource,
      rateExpiresAt:   providerMeta.rateExpiresAt,
      rateConfidence:  providerMeta.rateConfidence,
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
      payinFee:      round2(payinFee),
      alytoCSpread:  round2(alytoCSpread),
      fixedFee:      round2(fixedFee),
      payoutFee:     0,   // fija del proveedor: ya descontada del destino, en otra moneda
      totalDeducted: round2(payinFee + alytoCSpread + fixedFee),
      feeCurrency:   corridor.originCurrency,
      // profitRetention / totalDeductedReal quedan fuera: son internos (regla 11).
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
    const df         = (ben.dynamicFields && typeof ben.dynamicFields === 'object') ? ben.dynamicFields : {};
    const rawAccount = ben.accountBank ?? df.account_number ?? df.account_bank ?? '';
    const maskedAccount = rawAccount.length >= 4
      ? `****${rawAccount.slice(-4)}`
      : rawAccount ? '****' : null;

    const corridor = tx.corridorId ?? {};
    const splitName = [ben.firstName ?? df.beneficiary_first_name, ben.lastName ?? df.beneficiary_last_name].filter(Boolean).join(' ');
    const harborName = df.beneficiary_name ?? df.account_holder_name ?? null;
    const resolvedFullName = ben.fullName ?? (splitName || harborName);

    return {
      transactionId:       tx.alytoTransactionId || String(tx._id),
      status:              tx.status,
      originAmount:        tx.originalAmount,
      originCurrency:      tx.originCurrency,
      destinationAmount:   tx.destinationAmount   ?? null,
      destinationCurrency: tx.destinationCurrency ?? null,
      beneficiary: {
        fullName:               resolvedFullName,
        beneficiary_first_name: ben.firstName ?? df.beneficiary_first_name ?? null,
        beneficiary_last_name:  ben.lastName  ?? df.beneficiary_last_name  ?? null,
        bankName:               ben.bankCode  ?? df.bank_name ?? df.bank_code ?? null,
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
 * Mapeo de fees: lee del schema actual `fees` (Transaction.feesSchema).
 * Para transacciones legacy sin `fees.totalDeducted`, cae al
 * `feeBreakdown` antiguo (alytoFee/providerFee/networkFee/totalFee).
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

  // Nombre: schema fields → dynamicFields split → Harbor whole-name formats
  const firstName = ben.firstName ?? dynFields.beneficiary_first_name ?? '';
  const lastName  = ben.lastName  ?? dynFields.beneficiary_last_name  ?? '';
  const fullName  = ben.fullName
    ?? (firstName || lastName ? `${firstName} ${lastName}`.trim() : null)
    ?? dynFields.beneficiary_name
    ?? dynFields.account_holder_name
    ?? '';

  // Banco: resolver código → nombre legible (cache Vita) o bank_name si ya es texto
  const rawBankCode = ben.bankCode ?? dynFields.bank_code ?? '';
  const storedBankName = dynFields.bank_name ?? '';
  const bankName = storedBankName
    || await lookupBankName(transaction.destinationCountry, rawBankCode)
    || rawBankCode;

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

  // ── 3. Mapear fees desde el schema actual; fallback a feeBreakdown legacy ─
  const useFees = transaction.fees && (transaction.fees.totalDeducted ?? 0) > 0;
  const f       = useFees ? transaction.fees : null;
  const fb      = useFees ? null : (transaction.feeBreakdown ?? {});

  // ── 4. Construir respuesta (sin ipnLog ni campos internos) ────────────────
  return res.status(200).json({
    transactionId:       transaction.alytoTransactionId,
    status:              transaction.status,
    originAmount:        transaction.originalAmount,
    originCurrency:      transaction.originCurrency,
    destinationAmount:   transaction.destinationAmount   ?? 0,
    destinationCurrency: transaction.destinationCurrency ?? '',
    destinationCountry,
    // Rate dest/origin desde amounts — fuente única (ver utils/rateDisplay.js).
    exchangeRate:        getDisplayRate(transaction),
    fees: f
      ? {
          alytoCSpread:    f.alytoCSpread    ?? 0,
          fixedFee:        f.fixedFee        ?? 0,
          payinFee:        f.payinFee        ?? 0,
          payoutFee:       f.payoutFee       ?? 0,
          profitRetention: f.profitRetention ?? 0,
          totalDeducted:   f.totalDeducted   ?? 0,
          feeCurrency:     f.feeCurrency     ?? transaction.originCurrency ?? 'USD',
        }
      : {
          alytoCSpread:  fb.alytoFee    ?? 0,
          fixedFee:      0,
          payinFee:      fb.providerFee ?? 0,
          payoutFee:     fb.networkFee  ?? 0,
          totalDeducted: fb.totalFee    ?? 0,
          feeCurrency:   fb.feeCurrency ?? transaction.originCurrency ?? 'USD',
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
    // ── SEP-24 / SEP-31 — depósito/retiro de activo digital (NO cross-border) ──
    // El FE usa estos campos para distinguir un depósito (USD→USDC a la propia
    // wallet) de un envío a beneficiario, y renderizar el comprobante correcto.
    operationType:      transaction.operationType    ?? null,
    sep24Type:          transaction.sep24Type         ?? null,
    digitalAsset:       transaction.digitalAsset       ?? null,
    digitalAssetAmount: transaction.digitalAssetAmount ?? null,
    instructionAddress: transaction.instructionAddress ?? null,
    instructionMemo:    transaction.instructionMemo    ?? null,
    expiresAt:          transaction.expiresAt          ?? null,
    createdAt:         transaction.createdAt,
    updatedAt:         transaction.updatedAt,
    // Trazabilidad blockchain — el FE muestra "Verificado en blockchain" si hay
    // stellarTxId. La red es autoritativa del backend (prod=public/mainnet,
    // staging=testnet) para que el link a Stellar Expert no dependa de VITE.
    stellarTxId:       transaction.stellarTxId ?? null,
    stellarNetwork:    process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet',
    // Comprobante Oficial SRL Bolivia — URL pre-firmada fresca (s3key:// → presigned 1h)
    boliviaCompliance: transaction.boliviaCompliance
      ? {
          comprobanteUrl:         await resolveComprobanteUrl(
            transaction.boliviaCompliance.comprobanteUrl
            ?? transaction.boliviaCompliance.comprobantePdfUrl,
          ),
          numeroComprobante:      transaction.boliviaCompliance.numeroComprobante     ?? null,
          comprobanteGeneratedAt: transaction.boliviaCompliance.comprobanteGeneratedAt ?? null,
        }
      : null,
    // Confianza en la tasa y historial de ajustes (MSA Section 4.2 — UI Liability)
    rateConfidence:    transaction.rateConfidence ?? null,
    rateHistory:       (transaction.rateHistory ?? []).map(h => ({
      at:             h.at,
      previousAmount: h.previousAmount,
      newAmount:      h.newAmount,
      difference:     h.difference,
      diffPercent:    h.diffPercent,
      reason:         h.reason,
    })),
    // ── Detalle de fallo user-facing (NO exponer failureReason técnico) ─────
    failure: transaction.status === 'failed' ? {
      reason:    transaction.userFailureReason ?? null,
      action:    transaction.userFailureAction ?? null,
      category:  transaction.failureCategory   ?? null,
      retryable: transaction.failureRetryable  ?? false,
    } : null,
  });
}

// ─── GET /api/v1/payments/:transactionId/status/stream (SSE) ──────────────────

/**
 * Server-Sent Events del estado de una transacción. Reemplaza el polling HTTP
 * cada 5s del frontend: una sola conexión larga; el servidor vigila el estado
 * (chequeo liviano a Mongo cada 4s) y empuja `event: status` SOLO cuando cambia.
 * Cierra al llegar a un estado terminal. Auth por query token (EventSource no
 * puede mandar header Authorization) — resuelto por el middleware de la ruta.
 */
export async function streamTransactionStatus(req, res) {
  const { transactionId } = req.params;
  const userId = req.user._id;

  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no', // evita buffering en nginx/proxy
  });
  res.write('event: connected\ndata: {}\n\n');

  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);
  const POLL_MS  = 4000;
  let lastStatus = null;
  let closed     = false;

  const end = () => { closed = true; clearInterval(timer); try { res.end(); } catch { /* noop */ } };

  const tick = async () => {
    if (closed) return;
    try {
      const tx = await Transaction.findOne(
        { alytoTransactionId: transactionId, userId },
      ).select('status updatedAt').lean();

      if (!tx) { res.write(`event: error\ndata: ${JSON.stringify({ error: 'not_found' })}\n\n`); return end(); }

      if (tx.status !== lastStatus) {
        lastStatus = tx.status;
        res.write(`event: status\ndata: ${JSON.stringify({ status: tx.status, updatedAt: tx.updatedAt })}\n\n`);
        if (TERMINAL.has(tx.status)) return end();
      } else {
        res.write(': ping\n\n'); // comentario SSE = keepalive
      }
    } catch (err) {
      console.warn('[SSE status] error:', err.message);
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'server' })}\n\n`);
    }
  };

  const timer = setInterval(tick, POLL_MS);
  req.on('close', () => { closed = true; clearInterval(timer); });
  tick();
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

  // Incluir QR estáticos del admin (Tigo Money, Banco Económico, etc.)
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
    bankName:      bankData.bankName      || process.env.SRL_BANK_NAME      || 'Banco Económico',
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

  // Avanzar desde pending_comprobante → payin_pending ahora que el comprobante fue recibido
  if (transaction.status === 'pending_comprobante') {
    transaction.status = 'payin_pending';
  }

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

  // AWS-4 — Parser IA del comprobante (fire-and-forget, no bloquea la respuesta).
  // Pre-rellena datos para el admin; no autoritativo. No-op si BEDROCK_ENABLED!=true.
  if (isBedrockEnabled()) {
    parseComprobante(file.buffer.toString('base64'), file.mimetype)
      .then(async (parsed) => {
        if (!parsed) return;
        await Transaction.updateOne(
          { _id: transaction._id },
          { $set: { comprobanteParsedData: { ...parsed, parsedAt: new Date(), model: 'bedrock' } } },
        );
        broadcastToAdmins('tx_comprobante_parsed', {
          transactionId: transaction.alytoTransactionId,
          amount:        parsed.amount,
          reference:     parsed.reference,
          confidence:    parsed.confidence,
        });
      })
      .catch(() => {});
  }

  // Broadcast SSE: nueva tx accionable (tab "Accionables" del admin Ledger)
  broadcastToAdmins('tx_actionable', {
    transactionId:      transaction.alytoTransactionId,
    userId:             String(userId),
    amount:             transaction.originalAmount,
    currency:           transaction.originCurrency,
    destinationCountry: transaction.destinationCountry,
    isPriority:         transaction.isPrioritySupport ?? false,
    timestamp:          new Date().toISOString(),
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
      .select('corridorId destinationCountry destinationCurrency payinMethod payoutMethod alytoCSpread businessAlytoCSpread fixedFee payinFeePercent fintocConfig minAmountOrigin minAmountUSD minAmountUSDBusiness maxAmountOrigin')
      .lean();
  } catch (err) {
    console.error('[Alyto Corridors] Error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  // Mínimo EFECTIVO por corredor — el mismo que valida el quote (incluye el guard
  // de piso del proveedor). Se calcula acá para que lo que el usuario VE en el
  // selector coincida con lo que el backend EXIGE: antes el listado mostraba el
  // mínimo configurado y el quote rechazaba con otro número (o peor, aceptaba y
  // el payout moría en el proveedor). Las tasas y /prices están cacheadas.
  const vitaPricesForMins = corridors.some(c => c.payoutMethod === 'vitaWallet')
    ? await getPrices().catch(() => null)
    : null;
  const effMins = new Map();
  await Promise.all(corridors.map(async (c) => {
    try {
      effMins.set(c.corridorId, await resolveEffectiveMinimum(
        { ...c, originCurrency: userOriginCurrency }, req.user?.accountType, vitaPricesForMins,
        { forDisplay: true },   // muestra con colchón; el quote exige el piso exacto
      ));
    } catch { /* fail-open: se usa el configurado */ }
  }));

  // Agrupar por (destinationCountry + destinationCurrency). Cuando un destino EU/SEPA
  // tiene MÚLTIPLES proveedores (Harbor + Vita, ej. bo-eu-srl + bo-es) se expone solo
  // el de Vita (regla "EU siempre Vita", euAmountRouter.js). Casos como bo-cn (CNY) vs
  // bo-cn-usd (USD) NO se colapsan (distinta moneda → entradas separadas).
  const mapCorridor = (c, extra = {}) => {
    const eff = effMins.get(c.corridorId);
    const meta = COUNTRY_META[c.destinationCountry] ?? {};
    return {
      corridorId:              c.corridorId,
      destinationCountry:      c.destinationCountry,
      destinationCurrency:     c.destinationCurrency,
      destinationCountryName:  meta.name ?? c.destinationCountry,
      destinationFlag:         meta.flag ?? '',
      payinMethod:             c.payinMethod,
      payinMethodLabel:        PAYIN_METHOD_LABELS[c.payinMethod] ?? c.payinMethod,
      payoutMethod:            c.payoutMethod,
      // Mínimo efectivo (ya incluye el piso del proveedor). Fallback al configurado
      // si el cálculo falló — nunca dejamos el campo vacío.
      minAmountOrigin:         eff?.min    ?? c.minAmountOrigin ?? 0,
      minAmountUSD:            eff?.minUSD ?? c.minAmountUSD    ?? null,
      minAmountUSDBusiness:    c.minAmountUSDBusiness    ?? null,
      // Señal de por qué el mínimo es más alto que el configurado (diagnóstico/UI).
      minRaisedBy:             eff?.raisedBy ?? null,
      providerFloorUSD:        eff?.floorUSD ?? null,
      autoRouted:              false,
      ...extra,
    };
  };

  const groups = new Map();
  for (const c of corridors) {
    const key = `${c.destinationCountry}|${c.destinationCurrency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(mapCorridor(group[0]));
      continue;
    }
    // Múltiples corredores mismo país+moneda.
    if (isEuSepaDestination(group[0].destinationCountry)) {
      // EU/SEPA → SIEMPRE Vita (regla fija, ver euAmountRouter.js). Se expone UNA
      // entrada: el corredor Vita real, con su corridorId y sus propios mínimos
      // (nada de 'auto'/autoRouted — el frontend envía el corridorId y Step3
      // resuelve el formulario por payoutMethod, camino estándar).
      // Si el grupo no tuviera Vita (config anómala) se mantienen explícitos.
      const vita = group.find(c => c.payoutMethod === 'vitaWallet');
      if (vita) {
        result.push(mapCorridor(vita));
      } else {
        for (const c of group) result.push(mapCorridor(c));
      }
    } else {
      // Multi-proveedor sin auto-router → no colapsar (mantener explícitos para no
      // romper la resolución por corridorId). Defensivo: hoy no ocurre fuera de EU.
      for (const c of group) result.push(mapCorridor(c));
    }
  }

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
      .select('corridorId payinMethod payoutMethod alytoCSpread businessAlytoCSpread fixedFee payinFeePercent fintocConfig payoutFeeFixed originCurrency destinationCurrency manualExchangeRate profitRetentionPercent')
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

// ─── GET /api/v1/payments/harbor/requirements ────────────────────────────────

/**
 * Devuelve los métodos de pago Harbor disponibles para un corredor (destCountry
 * + destCurrency) junto con el JSON Schema de cada método. El frontend usa esto
 * para renderizar formularios dinámicos de beneficiario sin hardcodear campos.
 *
 * Resuelve el customerUuid del legalEntity del usuario cuando está configurado
 * para que las tasas reflejen su tier real; si no, hace el quote anónimo.
 *
 * Query: destCountry (ISO-2), destCurrency (ISO-3), amountUSDC (opcional)
 */
export async function getHarborMethodsRequirements(req, res) {
  const { destCountry, destCurrency, amountUSDC } = req.query;
  if (!destCountry || !destCurrency) {
    return res.status(400).json({ error: 'destCountry y destCurrency son requeridos' });
  }

  let customerUuid = null;
  try {
    const legalEntity = req.user?.legalEntity;
    if (legalEntity) customerUuid = getCustomerUuid(legalEntity);
  } catch {
    customerUuid = null;
  }

  try {
    const resolvedDestCountry = resolveHarborCountry(destCountry);
    const methods = await getHarborMethodsWithSchemas({
      destCountry: resolvedDestCountry,
      destCurrency,
      amountUSDC: amountUSDC ?? '100',
      customerUuid,
    });
    return res.json({
      destCountry:  resolvedDestCountry.toUpperCase(),
      destCurrency: destCurrency.toUpperCase(),
      methods,
    });
  } catch (err) {
    console.error('[Harbor Requirements]', err.message);
    return res.status(502).json({ error: 'No se pudo obtener métodos Harbor', detail: err.message });
  }
}
