/**
 * becQrService.js — Cliente HTTP para la API Banco Económico QR Connect
 *
 * Implementa IBankQrService:
 *   generateQR   — genera QR bancario interbancario (devuelve qrId + qrImage base64)
 *   cancelQR     — anula un QR no pagado
 *   getQRStatus  — consulta estado: 'pending' | 'paid' | 'cancelled'
 *   getPaidQRs   — lista QRs pagados en una fecha (para reconciliación diaria)
 *   isAvailable  — verifica que las vars de entorno estén configuradas
 *
 * Autenticación: Bearer JWT obtenido via POST /api/authentication/authenticate.
 * El token se cachea en memoria hasta ~30s antes de su expiración.
 *
 * Cifrado: AES-256-CBC, clave de 32 bytes (env BEC_AES_KEY), IV aleatorio
 * de 16 bytes prepended al ciphertext, output Base64. Usado para encriptar
 * BEC_PASSWORD (antes del login) y BEC_ACCOUNT_CREDIT (en generateQR).
 *
 * ⚠️  Validar el algoritmo durante el primer test de sandbox usando el endpoint
 * de descifrado del banco:
 *   GET {BEC_BASE_URL}/api/authentication/decrypt?text=<output>&aesKey=<BEC_AES_KEY>
 * debe devolver el texto original.
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import Sentry  from '../../sentry.js';

// ── Config helpers ────────────────────────────────────────────────────────────
const cfg = {
  baseUrl:       () => process.env.BEC_BASE_URL       ?? 'https://apimktdesa.baneco.com.bo/ApiGateway',
  username:      () => process.env.BEC_USERNAME,
  password:      () => process.env.BEC_PASSWORD,
  aesKey:        () => process.env.BEC_AES_KEY,
  accountCredit: () => process.env.BEC_ACCOUNT_CREDIT,
};

// ── Token cache ───────────────────────────────────────────────────────────────
let _cachedToken     = null;
let _tokenExpiresAt  = 0;
// Encrypted accountCredit never changes within a process; cache after first call.
let _encryptedAccount = null;

// ── AES-256-CBC encryption ────────────────────────────────────────────────────

/**
 * Cifra plaintext con AES-256-CBC.
 * IV aleatorio de 16 bytes prepended al ciphertext — output Base64.
 * El banco lo descifra extrayendo los primeros 16 bytes como IV.
 */
function encryptAes(plaintext) {
  const key = Buffer.from(cfg.aesKey(), 'utf8'); // 32 ASCII chars = 32 bytes = AES-256
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

function getEncryptedAccount() {
  if (!_encryptedAccount) _encryptedAccount = encryptAes(cfg.accountCredit());
  return _encryptedAccount;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function authenticate() {
  const res = await fetch(`${cfg.baseUrl()}/api/authentication/authenticate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      userName: cfg.username(),
      password: encryptAes(cfg.password()),
    }),
  });

  if (!res.ok) throw new Error(`BEC auth HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseCode !== 0) throw new Error(`BEC auth error: ${data.message}`);
  return data.token;
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 30_000) return _cachedToken;

  _cachedToken = await authenticate();

  // Parse JWT exp claim to know when to refresh
  try {
    const payload = JSON.parse(
      Buffer.from(_cachedToken.split('.')[1], 'base64url').toString('utf8'),
    );
    _tokenExpiresAt = (payload.exp ?? 0) * 1000;
  } catch {
    // JWT parse failed — assume 55 min validity
    _tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  }

  logger.info('[BEC] Token renovado');
  return _cachedToken;
}

// ── Generic HTTP helper ───────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const token = await getToken();
  const url   = `${cfg.baseUrl()}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BEC API ${path} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Mock mode ─────────────────────────────────────────────────────────────────
// Activado cuando BEC_MOCK_ENABLED=true O cuando las credenciales no están
// configuradas. Permite testear el flujo completo admin sin credenciales reales.

/** @returns {boolean} true si las vars mínimas están configuradas */
export function isAvailable() {
  return !!(cfg.username() && cfg.aesKey() && cfg.accountCredit() && cfg.password());
}

function isMockMode() {
  return process.env.BEC_MOCK_ENABLED === 'true' || !isAvailable();
}

// SVG placeholder — se convierte a base64 para <img src="data:image/svg+xml;base64,...">
const MOCK_QR_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">',
  '<rect width="220" height="220" fill="#EFF6FF"/>',
  '<rect x="20" y="20" width="60" height="60" rx="4" fill="none" stroke="#1D4ED8" stroke-width="6"/>',
  '<rect x="35" y="35" width="30" height="30" rx="2" fill="#1D4ED8"/>',
  '<rect x="140" y="20" width="60" height="60" rx="4" fill="none" stroke="#1D4ED8" stroke-width="6"/>',
  '<rect x="155" y="35" width="30" height="30" rx="2" fill="#1D4ED8"/>',
  '<rect x="20" y="140" width="60" height="60" rx="4" fill="none" stroke="#1D4ED8" stroke-width="6"/>',
  '<rect x="35" y="155" width="30" height="30" rx="2" fill="#1D4ED8"/>',
  '<text x="110" y="108" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle" fill="#1D4ED8">QR SANDBOX</text>',
  '<text x="110" y="124" font-family="monospace" font-size="9" text-anchor="middle" fill="#3B82F6">BEC — Simulado</text>',
  '</svg>',
].join('');

const MOCK_QR_B64 = Buffer.from(MOCK_QR_SVG).toString('base64');

// ── Public API (IBankQrService) ───────────────────────────────────────────────

/**
 * Genera un QR de cobro bancario.
 *
 * @param {object} params
 * @param {string} params.transactionId  — alytoTransactionId (≤ 30 chars)
 * @param {number} params.amount         — monto en moneda de origen (BOB o USD)
 * @param {string} [params.currency]     — 'BOB' | 'USD'  (default: 'BOB')
 * @param {string} [params.description]  — glosa del cobro (≤ 100 chars)
 * @param {string} params.dueDate        — fecha de vencimiento 'yyyy-MM-dd'
 * @returns {Promise<{ qrId: string, qrImage: string }>}
 *   qrImage = imagen en Base64 lista para <img src="data:image/svg+xml;base64,...">
 */
export async function generateQR({ transactionId, amount, currency = 'BOB', description, dueDate }) {
  if (isMockMode()) {
    const qrId = `mock-bec-${Date.now()}-${transactionId.slice(-8)}`;
    logger.warn(`[BEC] Mock mode activo — QR simulado generado: ${qrId} | ${amount} ${currency}`);
    return { qrId, qrImage: MOCK_QR_B64, _mock: true };
  }

  const data = await apiFetch('/api/qrsimple/generateQR', {
    method: 'POST',
    body:   JSON.stringify({
      transactionId:  transactionId.slice(0, 30),        // API máx 30 chars
      accountCredit:  getEncryptedAccount(),
      currency,
      amount:         Number(amount.toFixed(2)),
      description:    (description ?? `Alyto ${transactionId}`).slice(0, 100),
      dueDate,
      singleUse:      true,   // un QR = un pago = una transacción
      modifyAmount:   false,  // monto fijo — rechaza pago con importe diferente
    }),
  });

  if (data.responseCode !== 0) throw new Error(`BEC generateQR error: ${data.message}`);

  return { qrId: data.qrId, qrImage: data.qrImage };
}

/**
 * Anula un QR no pagado.
 * Solo anula singleUse=true si no está pagado, o singleUse=false siempre.
 */
export async function cancelQR(qrId) {
  if (isMockMode()) { logger.warn(`[BEC] Mock cancelQR: ${qrId}`); return; }

  const data = await apiFetch('/api/qrsimple/cancelQR', {
    method: 'DELETE',
    body:   JSON.stringify({ qrId }),
  });
  if (data.responseCode !== 0) throw new Error(`BEC cancelQR error: ${data.message}`);
}

/**
 * Consulta el estado de un QR por su ID.
 *
 * @returns {{ status: 'pending'|'paid'|'cancelled', payment: object|null }}
 */
export async function getQRStatus(qrId) {
  if (isMockMode()) {
    logger.warn(`[BEC] Mock getQRStatus: ${qrId} → pending`);
    return { status: 'pending', payment: null };
  }

  const data = await apiFetch(`/api/qrsimple/v2/statusQR/${encodeURIComponent(qrId)}`);
  if (data.responseCode !== 0) throw new Error(`BEC statusQR error: ${data.message}`);

  // API: statusQRCode 0=activo pendiente, 1=pagado, 9=anulado
  const STATUS_MAP = { 0: 'pending', 1: 'paid', 9: 'cancelled' };
  return {
    status:  STATUS_MAP[data.statusQRCode] ?? 'unknown',
    payment: Array.isArray(data.payment) ? data.payment[0] ?? null : data.payment ?? null,
  };
}

/**
 * Lista todos los QRs pagados en una fecha — para reconciliación diaria.
 *
 * @param {Date} date
 * @returns {Promise<PaymentQR[]>}
 */
export async function getPaidQRs(date) {
  if (isMockMode()) { return []; }

  // API espera formato yyyyMMdd
  const pad    = (n) => String(n).padStart(2, '0');
  const dateStr = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;

  const data = await apiFetch(`/api/qrsimple/v2/paidQR/${dateStr}`);
  if (data.responseCode !== 0) throw new Error(`BEC paidQR error: ${data.message}`);
  return data.paymentList ?? [];
}

/**
 * Verifica la autenticidad de un IPN entrante de BEC ANTES de acreditar fondos.
 *
 * El endpoint /api/v1/ipn/bec es público (server-to-server, sin JWT), así que el
 * body por sí solo NO es confiable para mover dinero. Dos capas de defensa:
 *
 *   Capa 1 — Firma HMAC-SHA256 sobre el raw body (opcional, gated por BEC_IPN_SECRET).
 *     ⚠️ El esquema/header exacto del webhook BEC se confirma durante el onboarding
 *     de producción del webhook. Cuando se conozca, setear BEC_IPN_SECRET (y ajustar
 *     el header si BEC usa otro nombre). Mientras no esté configurado, esta capa se
 *     omite y la autenticidad recae 100% en la Capa 2.
 *
 *   Capa 2 — Reconfirmación autoritativa contra el banco (getQRStatus) por el canal
 *     SALIENTE autenticado con JWT. Nunca confiamos en el body: solo aceptamos si el
 *     banco mismo reporta el QR como 'paid'. Un IPN forjado es inútil porque el
 *     atacante no puede hacer que el banco diga 'paid' sin un pago real.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ ok: boolean, reason: string, payment?: object }>}
 */
export async function verifyIpn(req) {
  const qrId = req.body?.payment?.qrId;
  if (!qrId) return { ok: false, reason: 'no-qrId' };

  // Mock/staging: no hay banco real emitiendo IPN. El flujo de prueba usa el botón
  // admin "simular pago bancario", no este endpoint público. Aceptamos para no
  // romper pruebas manuales de flujo en staging.
  if (isMockMode()) return { ok: true, reason: 'mock' };

  // ── Capa 1: firma HMAC (si BEC_IPN_SECRET está configurado) ──
  const secret = process.env.BEC_IPN_SECRET;
  if (secret) {
    const provided = String(req.headers['x-bec-signature'] ?? req.headers['x-signature'] ?? '');
    const expected = crypto.createHmac('sha256', secret)
      .update(req.rawBody ?? '', 'utf8')
      .digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad-signature' };
    }
  }

  // ── Capa 2: reconfirmación autoritativa con el banco ──
  let statusInfo;
  try {
    statusInfo = await getQRStatus(qrId);
  } catch (err) {
    return { ok: false, reason: `bank-status-error:${err.message}` };
  }
  if (statusInfo.status !== 'paid') {
    return { ok: false, reason: `bank-status-${statusInfo.status}` };
  }

  return { ok: true, reason: secret ? 'hmac+bank' : 'bank-confirmed', payment: statusInfo.payment };
}

/** Para tests de integración: verifica que nuestro cifrado sea compatible con el banco */
export async function verifyCipher(plaintext) {
  const encrypted = encryptAes(plaintext);
  const url = `${cfg.baseUrl()}/api/authentication/decrypt?text=${encodeURIComponent(encrypted)}&aesKey=${encodeURIComponent(cfg.aesKey())}`;
  const res  = await fetch(url);
  const text = await res.text();
  const match = text.trim() === plaintext;
  logger.info(`[BEC] verifyCipher: '${plaintext}' → match=${match}`);
  return { encrypted, decrypted: text.trim(), match };
}
