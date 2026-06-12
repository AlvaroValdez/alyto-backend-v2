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
 *   qrImage = imagen en Base64 lista para <img src="data:image/png;base64,...">
 */
export async function generateQR({ transactionId, amount, currency = 'BOB', description, dueDate }) {
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
  // API espera formato yyyyMMdd
  const pad    = (n) => String(n).padStart(2, '0');
  const dateStr = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;

  const data = await apiFetch(`/api/qrsimple/v2/paidQR/${dateStr}`);
  if (data.responseCode !== 0) throw new Error(`BEC paidQR error: ${data.message}`);
  return data.paymentList ?? [];
}

/** @returns {boolean} true si las vars mínimas están configuradas */
export function isAvailable() {
  return !!(cfg.username() && cfg.aesKey() && cfg.accountCredit() && cfg.password());
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
