/**
 * piiCrypto.js — Cifrado de campo (envelope) para PII en reposo
 *
 * Modelo de sobre (envelope encryption), con AWS KMS como raíz de confianza:
 *   1. Una DATA KEY (DEK, AES-256) se genera UNA vez y se guarda ENVUELTA por KMS
 *      en `PII_DATA_KEY_WRAPPED` (base64 del ciphertext KMS). Ver
 *      `scripts/provision-pii-dek.mjs`.
 *   2. Al arranque, la DEK se DESENVUELVE con KMS `Decrypt` (una llamada async) y
 *      queda en memoria del proceso. La master key nunca sale de KMS.
 *   3. Cada valor PII se cifra/descifra LOCALMENTE con AES-256-GCM usando esa DEK
 *      — de forma SÍNCRONA, sin round-trip a KMS por valor. Esto permite descifrar
 *      dentro de código síncrono (ej. `resolveClientDocument`) y sin latencia en
 *      cada screening/comprobante.
 *
 * Formato del ciphertext persistido:  "v1:" + base64( iv(12) | tag(16) | ct )
 *
 * AAD (Additional Authenticated Data): se ata el ciphertext a (userId, campo), de
 * modo que un ciphertext no pueda moverse entre usuarios/campos sin fallar la
 * verificación GCM. Mismo espíritu que el EncryptionContext de custodyService.
 *
 * Gating:
 *   - `PII_ENCRYPTION_ENABLED=true`  activa el cifrado en las ESCRITURAS. Con el
 *     flag OFF (default), las escrituras guardan el valor en claro (comportamiento
 *     legacy) y este módulo queda inerte → despliegue sin cambio de comportamiento.
 *   - Las LECTURAS descifran SIEMPRE que encuentren un ciphertext (independiente del
 *     flag), para que un valor ya cifrado siga siendo legible aunque se apague el flag.
 *
 * Fallback sin KMS (solo staging/testnet, opt-in):
 *   - `PII_KMS_FALLBACK=true` deriva la DEK de `PII_FALLBACK_KEY` (sha256) en vez de
 *     KMS. Hard-gated: PROHIBIDO en producción mainnet (lanza). Espejo del fallback
 *     de custodyService para entornos sin AWS.
 *
 * ⚠️ Ningún valor PII en claro se loguea nunca aquí.
 */

import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';
import crypto from 'node:crypto';

import { logger } from '../utils/logger.js';

const SCHEME           = 'v1';
const ENCRYPTED_MARKER = 'ENCRYPTED'; // marcador en el campo plano cuando el valor real vive cifrado
const KMS_ENC_CONTEXT  = { service: 'alyto-pii', purpose: 'field-encryption' };

let _dek = null; // Buffer(32) — DEK en claro cacheada en memoria

// ─── Lectura perezosa de env (regla 21: nada de env en ámbito de módulo) ──────

function kmsKeyId() {
  return process.env.PII_KMS_KEY_ID
    ?? process.env.USER_KEYPAIR_KMS_KEY_ID
    ?? process.env.AWS_SECRETS_KMS_KEY_ID
    ?? 'alias/aws/secretsmanager';
}
function awsRegion()  { return process.env.AWS_REGION ?? 'us-east-1'; }
function fallbackOn() { return process.env.PII_KMS_FALLBACK === 'true'; }

export function isPiiEncryptionEnabled() {
  return process.env.PII_ENCRYPTION_ENABLED === 'true';
}

// ─── DEK ──────────────────────────────────────────────────────────────────────

/** Deriva la DEK del secreto local (fallback testnet/staging, sin KMS). */
function fallbackDek() {
  const secret = process.env.PII_FALLBACK_KEY;
  if (!secret || secret.length < 16) {
    throw new Error('[pii] PII_FALLBACK_KEY no configurada o < 16 chars (requerida para el fallback sin KMS).');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest(); // 32 bytes
}

/**
 * Garantiza que la DEK esté cargada en memoria (idempotente). Async: desenvuelve
 * con KMS la primera vez. Llamar antes de cualquier encrypt/decrypt síncrono.
 * @returns {Promise<Buffer>}
 */
export async function ensureDek() {
  if (_dek) return _dek;

  if (fallbackOn()) {
    if (process.env.NODE_ENV === 'production' && process.env.STELLAR_NETWORK === 'mainnet') {
      throw new Error('[pii] PII_KMS_FALLBACK activo en producción mainnet — PROHIBIDO. Usar KMS.');
    }
    _dek = fallbackDek();
    logger.warn('[pii] DEK derivada del fallback local (sin KMS) — solo staging/testnet.');
    return _dek;
  }

  const wrapped = process.env.PII_DATA_KEY_WRAPPED;
  if (!wrapped) {
    throw new Error('[pii] PII_DATA_KEY_WRAPPED no configurada. Correr scripts/provision-pii-dek.mjs y cargar el valor en el secreto/entorno.');
  }

  const kms = new KMSClient({ region: awsRegion() });
  const res = await kms.send(new DecryptCommand({
    CiphertextBlob:    Buffer.from(wrapped, 'base64'),
    EncryptionContext: KMS_ENC_CONTEXT,
    ...(kmsKeyId() ? { KeyId: kmsKeyId() } : {}),
  }));
  const dek = Buffer.from(res.Plaintext);
  if (dek.length !== 32) throw new Error(`[pii] DEK longitud inesperada: ${dek.length} (esperado 32).`);
  _dek = dek;
  logger.info('[pii] DEK desenvuelta con KMS y cacheada en memoria.');
  return _dek;
}

/** Precalienta la DEK al arranque si el cifrado está activo. Best-effort: no lanza. */
export async function warmupPiiCrypto() {
  if (!isPiiEncryptionEnabled()) return false;
  try {
    await ensureDek();
    return true;
  } catch (err) {
    logger.error('[pii] No se pudo precalentar la DEK al arranque — el cifrado PII no operará hasta resolverlo.', { err: err.message });
    return false;
  }
}

function dekOrThrow() {
  if (!_dek) throw new Error('[pii] DEK no cargada — llamar `await ensureDek()` antes de cifrar/descifrar.');
  return _dek;
}

// ─── Primitivas de cifrado de campo (síncronas) ───────────────────────────────

/**
 * Cifra un valor con AES-256-GCM usando la DEK cacheada.
 * @param {string} plaintext
 * @param {string} [aad]  contexto autenticado (ej. `${userId}:campo`)
 * @returns {string} "v1:" + base64(iv|tag|ct)
 */
export function encryptField(plaintext, aad) {
  const key    = dekOrThrow();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SCHEME}:` + Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Descifra un valor "v1:...". Lanza si el AAD no coincide o el ciphertext fue alterado.
 * @param {string} stored
 * @param {string} [aad]
 * @returns {string} plaintext
 */
export function decryptField(stored, aad) {
  const key = dekOrThrow();
  if (!isEncrypted(stored)) throw new Error('[pii] Ciphertext con formato/esquema inválido.');
  const raw      = Buffer.from(stored.slice(SCHEME.length + 1), 'base64');
  const iv       = raw.subarray(0, 12);
  const tag      = raw.subarray(12, 28);
  const enc      = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** ¿El valor almacenado es un ciphertext de este esquema? */
export function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(`${SCHEME}:`);
}

/** AAD canónico para identityDocument.number (ata el ciphertext al usuario+campo). */
export function aadForDocumentNumber(userId) {
  return `${String(userId)}:identityDocument.number`;
}

/**
 * AAD canónico para el secreto TOTP del segundo factor. Ata el ciphertext al
 * usuario y al campo: un secreto copiado a otra cuenta con acceso directo a la
 * base falla la verificación GCM en vez de conceder acceso con privilegios.
 */
export function aadForTotpSecret(userId) {
  return `${String(userId)}:twoFactor.secret`;
}

export const PII_ENCRYPTED_MARKER = ENCRYPTED_MARKER;
export const PII_KMS_ENCRYPTION_CONTEXT = KMS_ENC_CONTEXT;
