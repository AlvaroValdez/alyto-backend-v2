/**
 * redenlaceQrService.js — Cobro por QR Simple de ATC S.A. (Red Enlace)
 *
 * Implementa IBankQrService sobre `/qr/simple/v2/*`. Sustituto de `becQrService`
 * para el payin en bolivianos.
 *
 * ── Tres diferencias con BANECO que cambian el comportamiento, no solo el código
 *
 * 1. **El webhook no devuelve nuestra referencia.** BANECO nos devolvía el
 *    `transactionId` que le mandamos; ATC solo devuelve su propio
 *    `numeroReferencia`. Por eso `qrId` = `numeroReferencia` **de ATC**: es el
 *    único valor que aparece en los tres lados (generación, consulta y webhook),
 *    y es el que `Transaction.bankQr.qrId` ya indexa. El mapeo queda resuelto
 *    por el campo que ya existía; lo que cambia es qué se guarda en él.
 *
 * 2. **El QR expira en segundos, no en días.** `vigencia` la fija ATC al
 *    generar y la aplica de su lado. `BANK_QR_DUE_DAYS` (que gobierna
 *    `paymentInstructionsExpiresAt`) no tiene efecto sobre ATC: si le decimos al
 *    usuario que tiene un día y el QR muere en diez minutos, el usuario paga un
 *    QR muerto. `generateQR` devuelve `expiresAt` con la fecha autoritativa que
 *    informa ATC — **falta cablearla** en quien crea la transacción.
 *
 * 3. **La imagen es PNG, no SVG.** BANECO devuelve un SVG en base64 y el
 *    frontend arma `data:image/svg+xml;base64,...`. ATC devuelve un PNG. Por eso
 *    `generateQR` devuelve además `qrImageMime`: renderizar un PNG declarándolo
 *    SVG da una imagen rota, no un error.
 *
 * ── Qué NO ofrece ATC en este producto
 *
 * - **No hay cancelación.** No existe endpoint para anular un QR emitido. No es
 *   un problema: la `vigencia` ya lo expiró del lado de ATC mucho antes de que
 *   el barrido de expiración lo mire. Ver `cancelQR`.
 * - **No hay listado de pagados por fecha.** El equivalente está en otro
 *   producto (`/cuentas-comercios/v1/cuentas/creditos`, filtrando
 *   `tipoOperacion = 'PAYIN QR'`), que todavía no está integrado. Ver
 *   `getPaidQRs`: la red de seguridad no queda desarmada, pero sí más lenta.
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import { apiFetch, isMockMode as clientIsMock, isAvailable as clientIsAvailable } from '../../bank/redenlaceClient.js';

// ── Config ───────────────────────────────────────────────────────────────────
// Regla 21: siempre dentro de funciones.
const cfg = {
  establishmentId:   () => process.env.REDENLACE_ESTABLISHMENT_ID,
  establishmentName: () => process.env.REDENLACE_ESTABLISHMENT_NAME ?? 'Alyto',
  webhookUrl:        () => process.env.REDENLACE_QR_WEBHOOK_URL,
  webhookKey:        () => process.env.REDENLACE_QR_WEBHOOK_KEY ?? 'x-api-key',
  webhookValue:      () => process.env.REDENLACE_QR_WEBHOOK_VALUE,
  vigenciaSeconds:   () => Number(process.env.REDENLACE_QR_VIGENCIA_SECONDS ?? 600),
};

/**
 * Vigencia del QR, en segundos.
 *
 * ⚠️ El máximo que acepta ATC **no está documentado**: el único ejemplo del
 * portal usa 45 segundos, que es inviable para un checkout. El default de 600
 * es una apuesta razonable, no un dato confirmado. Está en la lista de
 * preguntas abiertas a ATC; si rechazan el valor, `generateQR` va a fallar de
 * forma visible en certificación y no en producción.
 */
function vigencia() {
  const v = cfg.vigenciaSeconds();
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 600;
}

/**
 * `numeroReferencia` admite **solo dígitos**.
 *
 * No está en la documentación. Lo devolvió el sandbox el 2026-09-26:
 * `INVALID_FORMAT — El número de referencia debe contener solo dígitos numéricos`.
 * Nuestros identificadores (`ALY-C-...`, `WTX-...`) no califican, así que hay
 * que traducirlos a un alias numérico y guardar la equivalencia.
 *
 * Si el identificador ya es numérico se usa tal cual, sin tocar la base: eso
 * mantiene el modo mock y las pruebas unitarias sin dependencia de Mongo.
 *
 * @returns {Promise<string>} referencia de solo dígitos
 */
async function toNumericReference({ transactionId, targetModel, amount, currency }) {
  const raw = String(transactionId ?? '');
  if (/^\d{1,20}$/.test(raw)) return raw;

  const { issueReference } = await import('../../bank/providerReference.js');
  const doc = await issueReference({
    provider:    'redenlace',
    kind:        'payin',
    targetModel: targetModel ?? 'Transaction',
    targetId:    raw,
    amount,
    currency,
  });
  return doc.reference;
}

/** @returns {boolean} true si hay credenciales OAuth y alta de establecimiento */
export function isAvailable() {
  return clientIsAvailable() && !!cfg.establishmentId();
}

function isMockMode() {
  return clientIsMock() || !cfg.establishmentId();
}

// ── Mock ─────────────────────────────────────────────────────────────────────
// PNG 1x1 transparente. A diferencia del SVG de BANECO no dibuja nada: el mock
// sirve para ejercitar el flujo, no para mirarlo.
const MOCK_QR_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ── Generación ───────────────────────────────────────────────────────────────

/**
 * Genera un QR de cobro.
 *
 * @param {object} p
 * @param {string} p.transactionId — identificador propio; se traduce a un alias numérico
 * @param {number} p.amount        — importe en BOB
 * @param {string} [p.currency]    — ATC solo acepta 'BOB' en este producto
 * @param {string} [p.description] — glosa
 * @param {'Transaction'|'WalletTransaction'} [p.targetModel] — a qué apunta el alias
 * @returns {Promise<{qrId:string, qrImage:string, qrImageMime:string, expiresAt:Date|null, numeroReferencia:string}>}
 */
export async function generateQR({ transactionId, amount, currency = 'BOB', description, targetModel }) {
  if (currency !== 'BOB') {
    // Mejor fallar acá que mandar 'USD' y que ATC cobre en bolivianos igual.
    throw new Error(`Red Enlace QR Simple solo opera en BOB (recibido '${currency}')`);
  }

  if (isMockMode()) {
    const qrId = `mock-rl-${Date.now()}-${String(transactionId).slice(-8)}`;
    logger.warn('[RedEnlace] Mock mode activo — QR simulado', { qrId, amount, currency });
    return {
      qrId,
      qrImage:     MOCK_QR_PNG_B64,
      qrImageMime: 'image/png',
      expiresAt:   new Date(Date.now() + vigencia() * 1000),
      _mock:       true,
    };
  }

  if (!cfg.webhookUrl() || !cfg.webhookValue()) {
    // Sin webhook no hay confirmación automática y el cobro queda a merced del
    // barrido. ATC además declara los tres campos obligatorios.
    throw new Error('Red Enlace: falta REDENLACE_QR_WEBHOOK_URL o REDENLACE_QR_WEBHOOK_VALUE');
  }

  // ATC exige dígitos: `ALY-C-...` se rechaza con INVALID_FORMAT.
  const numeroReferencia = await toNumericReference({ transactionId, targetModel, amount, currency });

  const data = await apiFetch('/qr/simple/v2/generate', {
    method: 'POST',
    body:   JSON.stringify({
      glosa:                 (description ?? `Alyto ${transactionId}`).slice(0, 100),
      moneda:                'BOB',
      monto:                 Number(Number(amount).toFixed(2)),
      // ATC no devuelve esta referencia en el webhook, así que su valor es de
      // trazabilidad: aparece en los movimientos de la cuenta de comercio y
      // permite volver a la transacción vía ProviderReference.
      numeroReferencia,
      vigencia:              vigencia(),
      idEstablecimiento:     Number(cfg.establishmentId()),
      nombreEstablecimiento: cfg.establishmentName(),
      webhook: {
        url:   cfg.webhookUrl(),
        key:   cfg.webhookKey(),
        value: cfg.webhookValue(),
      },
    }),
  });

  if (data?.success !== true || !data?.data?.numeroReferencia) {
    throw new Error(`Red Enlace generateQR error: ${data?.message ?? 'respuesta inesperada'}`);
  }

  const expiresAt = data.data.fechaExpiracion ? new Date(data.data.fechaExpiracion) : null;

  return {
    qrId:        String(data.data.numeroReferencia),
    qrImage:     data.data.qr,
    qrImageMime: 'image/png',
    expiresAt:   expiresAt && !isNaN(expiresAt) ? expiresAt : null,
    numeroReferencia,   // el alias numérico que vio ATC
  };
}

/**
 * ATC no expone cancelación de QR Simple.
 *
 * No lanzamos: el barrido de expiración llama a esto antes de marcar la
 * transacción como fallida, y un throw ensuciaría cada corrida con un error que
 * no es un error. La carrera que la cancelación cierra en BANECO ("marco fallida
 * y el usuario paga después") no existe acá: para cuando el barrido actúa, la
 * `vigencia` ya venció el QR del lado de ATC.
 */
export async function cancelQR(qrId) {
  logger.info('[RedEnlace] cancelQR no aplica — el QR expira por vigencia en ATC', { qrId });
}

// ── Consulta de estado ───────────────────────────────────────────────────────

/** ATC → vocabulario interno del registry. */
const STATUS_MAP = {
  PENDIENTE: 'pending',
  PAGADO:    'paid',
  CANCELADO: 'cancelled',
  EXPIRADO:  'cancelled',   // para el barrido, expirado y anulado se tratan igual
  ERROR:     'unknown',
};

/**
 * Normaliza la respuesta de ATC a la forma que consumen el IPN y el job.
 * `qrId` y `amount` son los dos campos que el resto del sistema exige.
 */
function normalizePayment(qrId, src = {}) {
  const fecha = src.fechaHoraTransaccion ?? src.bancoOrigen?.fechaTransaccion ?? '';
  const [paymentDate, paymentTime] = String(fecha).split('T');

  return {
    qrId:           String(qrId),
    amount:         Number(src.importe ?? src.monto),
    currency:       src.moneda ?? 'BOB',
    senderName:     src.clienteOrigen?.nombreCliente ?? '',
    senderDocument: src.clienteOrigen?.ciCliente ?? src.clienteOrigen?.ciNitCliente ?? '',
    senderAccount:  src.clienteOrigen?.numeroCuenta ?? '',
    bankCode:       src.bancoOrigen?.codigoBanco ?? '',
    bankName:       src.bancoOrigen?.nombreBanco ?? '',
    achNumber:      src.bancoOrigen?.numeroOrdenAch ?? '',
    paymentDate:    paymentDate || '',
    paymentTime:    paymentTime || '',
    raw:            src,
  };
}

/**
 * Consulta el estado de un QR por el `numeroReferencia` de ATC.
 * @returns {Promise<{status:'pending'|'paid'|'cancelled'|'unknown', payment:object|null}>}
 */
export async function getQRStatus(qrId) {
  if (isMockMode()) {
    logger.warn('[RedEnlace] Mock getQRStatus → pending', { qrId });
    return { status: 'pending', payment: null };
  }

  const data = await apiFetch(`/qr/simple/v2/verify/${encodeURIComponent(qrId)}`);

  if (data?.success !== true) {
    throw new Error(`Red Enlace verify error: ${data?.errors?.[0]?.message ?? data?.message ?? 'desconocido'}`);
  }

  const estado = String(data?.data?.estado ?? '').toUpperCase();
  const status = STATUS_MAP[estado] ?? 'unknown';

  return {
    status,
    payment: status === 'paid' ? normalizePayment(qrId, data.data) : null,
  };
}

/**
 * ATC no expone "pagados por fecha" en QR Simple.
 *
 * Esto desactiva la FASE A de `reconcileBankQrPayments` (confirmar un pago cuyo
 * webhook se perdió, el mismo día). **No** desactiva la red de seguridad: la
 * FASE B hace un `getQRStatus` final sobre cada QR vencido y confirma si ATC
 * dice `PAGADO`. El costo es latencia, no pérdida: un pago con webhook perdido
 * se confirma al vencer el QR más la hora de gracia, en vez de en la corrida
 * siguiente.
 *
 * Para recuperar la FASE A hay que integrar `/cuentas-comercios/v1/cuentas/creditos`
 * y filtrar `tipoOperacion = 'PAYIN QR'`. Requiere el NIT habilitado y el número
 * de cuenta de comercio, que ATC todavía no entregó.
 */
export async function getPaidQRs(_date) {
  logger.warn('[RedEnlace] getPaidQRs no disponible en QR Simple — la confirmación tardía la cubre el barrido (FASE B)');
  return [];
}

// ── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Traduce el webhook de ATC a la forma `{ payment: {...} }` que espera
 * `handleBankQrIPN`. ATC manda un objeto plano; BANECO manda uno anidado.
 *
 * @param {import('express').Request} req
 * @returns {object|null}
 */
export function normalizeIpn(req) {
  const b = req.body ?? {};
  if (!b.numeroReferencia) return null;
  return normalizePayment(b.numeroReferencia, b);
}

/**
 * Compara dos cadenas en tiempo constante, tolerando longitudes distintas.
 */
function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Autentica un webhook entrante ANTES de acreditar.
 *
 * Capa 1 — la cabecera que nosotros mismos declaramos al generar el QR
 *   (`webhook.key` / `webhook.value`). A diferencia de BANECO, acá el secreto lo
 *   elegimos nosotros, así que no hay excusa para no tenerlo.
 *
 * Capa 2 — reconfirmación contra ATC por el canal saliente autenticado. Un
 *   webhook falsificado es inútil si ATC no dice `PAGADO`.
 *
 * En producción, sin `REDENLACE_QR_WEBHOOK_VALUE` se rechaza (fail-closed).
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, reason:string, payment?:object}>}
 */
export async function verifyIpn(req) {
  const qrId = req.body?.numeroReferencia ?? req.body?.payment?.qrId;
  if (!qrId) return { ok: false, reason: 'no-numeroReferencia' };

  if (isMockMode()) {
    // Un REDENLACE_MOCK_ENABLED olvidado en producción convertiría este endpoint
    // público en acreditación sin verificar. Mismo endurecimiento que en BANECO.
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'mock-mode-forbidden-in-prod' };
    }
    return { ok: true, reason: 'mock' };
  }

  const expected = cfg.webhookValue();
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'no-webhook-auth-configured' };
    }
  } else {
    const headerName = String(cfg.webhookKey()).toLowerCase();
    const provided   = req.headers?.[headerName];
    if (!provided || !safeEquals(provided, expected)) {
      return { ok: false, reason: 'bad-webhook-key' };
    }
  }

  let statusInfo;
  try {
    statusInfo = await getQRStatus(qrId);
  } catch (err) {
    return { ok: false, reason: `bank-status-error:${err.message}` };
  }
  if (statusInfo.status !== 'paid') {
    return { ok: false, reason: `bank-status-${statusInfo.status}` };
  }

  return { ok: true, reason: 'webhook-key+bank', payment: statusInfo.payment };
}
