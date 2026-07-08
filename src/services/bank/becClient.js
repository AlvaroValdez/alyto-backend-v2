/**
 * becClient.js — Cliente HTTP base compartido para las APIs de Banco Económico (BEC)
 *
 * Capa de bajo nivel reutilizable por los servicios BEC que NO son de QR:
 *   - becAccountService    (punto 8 — saldo y movimientos)
 *   - becDisbursementService (sección 9 — planillas de pago / dispersión)
 *
 * Replica la lógica probada en `bankQr/banks/becQrService.js` (auth JWT + AES-256-CBC
 * + token cache + mock mode), pero como módulo independiente para NO tocar el flujo
 * de cobros QR que ya está en producción. Cuando este cliente esté validado en
 * staging, becQrService puede migrar a usarlo y se elimina la duplicación.
 *
 * Autenticación: Bearer JWT obtenido vía POST /api/authentication/authenticate.
 *   El token se cachea en memoria hasta ~30s antes de expirar.
 *
 * Cifrado: AES-256-CBC, clave de 32 bytes (env BEC_AES_KEY), IV aleatorio de 16
 *   bytes prepended al ciphertext, output Base64. Igual que el banco descifra.
 *
 * Mock mode: activo cuando BEC_MOCK_ENABLED=true o cuando faltan credenciales.
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

// ── Config ──────────────────────────────────────────────────────────────────
// Nota: BEC_BASE_URL puede venir con o sin '/' final según cómo lo envíe el
// banco. Normalizamos aquí para no generar `//api/...` en los fetches.
const cfg = {
  baseUrl:  () => (process.env.BEC_BASE_URL ?? 'https://apimktdesa.baneco.com.bo/ApiGateway').replace(/\/+$/, ''),
  username: () => process.env.BEC_USERNAME,
  password: () => process.env.BEC_PASSWORD,
  aesKey:   () => process.env.BEC_AES_KEY,
};

// ── Token cache (módulo) ──────────────────────────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;

// ── AES-256-CBC ────────────────────────────────────────────────────────────────

/**
 * Cifra plaintext con AES-256-CBC. IV aleatorio de 16 bytes prepended al
 * ciphertext, output Base64. El banco descifra extrayendo los primeros 16 bytes.
 * @param {string} plaintext
 * @returns {string} base64
 */
export function encryptAes(plaintext) {
  const key = Buffer.from(cfg.aesKey(), 'utf8'); // 32 ASCII chars = 32 bytes = AES-256
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

// ── Auth ─────────────────────────────────────────────────────────────────────

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

  try {
    const payload = JSON.parse(
      Buffer.from(_cachedToken.split('.')[1], 'base64url').toString('utf8'),
    );
    _tokenExpiresAt = (payload.exp ?? 0) * 1000;
  } catch {
    _tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  }

  logger.info('[BEC] Token renovado (becClient)');
  return _cachedToken;
}

// ── HTTP genérico ──────────────────────────────────────────────────────────────

/**
 * Llama un endpoint de la API BEC con el JWT en el header. Lanza con el body en
 * el mensaje si la respuesta no es 2xx (para diagnóstico).
 * @param {string} path  — ej. '/api/accounts/queryMovements'
 * @param {RequestInit} [options]
 * @returns {Promise<any>} JSON parseado
 */
export async function apiFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${cfg.baseUrl()}${path}`, {
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

// ── Disponibilidad / mock ───────────────────────────────────────────────────────

/** @returns {boolean} true si las vars mínimas de auth están configuradas */
export function isAvailable() {
  return !!(cfg.username() && cfg.aesKey() && cfg.password());
}

/** @returns {boolean} true si debe operar en modo simulado */
export function isMockMode() {
  return process.env.BEC_MOCK_ENABLED === 'true' || !isAvailable();
}

/**
 * Verifica que nuestro cifrado AES sea compatible con el banco (test de integración).
 * Usa el endpoint de descifrado del banco: debe devolver el texto original.
 * @param {string} plaintext
 */
export async function verifyCipher(plaintext) {
  const encrypted = encryptAes(plaintext);
  const url = `${cfg.baseUrl()}/api/authentication/decrypt?text=${encodeURIComponent(encrypted)}&aesKey=${encodeURIComponent(cfg.aesKey())}`;
  const res  = await fetch(url);
  const text = await res.text();
  const match = text.trim() === plaintext;
  logger.info(`[BEC] verifyCipher (becClient): '${plaintext}' → match=${match}`);
  return { encrypted, decrypted: text.trim(), match };
}
