/**
 * clientIdentityIndex.js — Claves de búsqueda para reconocer a la MISMA persona
 * detrás de dos cuentas distintas.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * En `users` el único índice único es el correo. No hay unicidad por documento ni
 * por teléfono, y el registro no busca coincidencias, así que una persona puede
 * abrir cuentas nuevas indefinidamente y cada una levanta (y cobra) su propia
 * verificación de identidad en Stripe.
 *
 * El 2026-10-10 se encontró el caso en producción: la misma persona con dos
 * cuentas aprobadas (`gmamaniv@fcpn.edu.bo` del 03-oct y
 * `davidmamanivaleriano3@gmail.com` del 10-oct), dos sesiones de Stripe verificadas
 * al primer intento y dos cuentas custodiales con su propio par de claves. Mismo
 * teléfono, misma fecha de nacimiento, mismo nombre en el documento verificado.
 * Para el sistema eran dos clientes, y como tales cuentan contra el tope de
 * consumidores del Entorno Controlado de Pruebas.
 *
 * ── Por qué no se puede comparar el campo cifrado ───────────────────────────
 *
 * El CI real vive en `identityDocument.numberCiphertext`, cifrado con AES-256-GCM
 * con IV aleatorio y AAD atado al `userId` (ver [piiCrypto]). Esas dos propiedades
 * son deliberadas y correctas, pero implican que **dos cuentas con el mismo CI
 * tienen ciphertexts completamente distintos**: no hay forma de encontrar el
 * duplicado con una consulta. Descifrar la colección entera en cada registro
 * tampoco es una respuesta: es O(n) por alta y crece con el padrón.
 *
 * La salida estándar es un *índice ciego*: un HMAC determinista del valor
 * normalizado, con una clave derivada de la DEK, guardado junto al ciphertext e
 * indexado. Determinista para poder buscar; HMAC con clave (y no un hash pelado)
 * porque un CI boliviano tiene siete u ocho dígitos y un SHA-256 sin clave se
 * revierte por fuerza bruta en segundos. Quien obtenga la base sin la DEK no
 * puede ni leer el CI ni enumerar candidatos.
 *
 * El teléfono NO se trata así: ya se guarda en claro en `phone`, cifrarlo sería
 * teatro. Lo que falta ahí es normalización, porque `+591 69769901` y `69769901`
 * son el mismo número y ninguna consulta los iguala. Para eso está `phoneTail`.
 */

import crypto from 'node:crypto';

import { ensureDek, isEncrypted } from './piiCrypto.js';
import { logger } from '../utils/logger.js';

/**
 * Información de derivación del HMAC. Cambiarla invalida todas las huellas ya
 * guardadas (habría que recalcularlas con `scripts/duplicados-clientes.mjs
 * --backfill`), así que se versiona explícitamente.
 */
const FINGERPRINT_INFO = 'alyto-pii-fingerprint:v1:identityDocument.number';

/**
 * Longitud del tramo final del teléfono que se usa como clave de búsqueda.
 *
 * Ocho es el largo del móvil boliviano, que es la mayoría del padrón. Tomar el
 * final y no el número completo es lo que hace que `+59169769901` y `69769901`
 * caigan en la misma clave. El costo es que dos números de países distintos
 * podrían compartir los últimos ocho dígitos: eso produciría una coincidencia
 * falsa, y es tolerable porque esto **alimenta una alerta, no un bloqueo** — el
 * aviso muestra las dos cuentas y una persona decide.
 */
const PHONE_TAIL_LEN = 8;

/** Mínimo de dígitos para considerar que hay un teléfono utilizable. */
const PHONE_MIN_DIGITS = 7;

let _fpKey = null; // Buffer(32) — clave HMAC derivada de la DEK, cacheada

/**
 * Deja la clave de huella lista en memoria. Idempotente.
 *
 * Se deriva de la DEK con HKDF para no reusar la misma clave que cifra: si un día
 * se filtrara la clave de huella, no sirve para descifrar ningún valor.
 *
 * Devuelve `null` —sin lanzar— cuando no hay DEK disponible (desarrollo sin KMS,
 * suite de pruebas). Ese caso degrada a "no hay huella", no a un registro caído:
 * ver `documentFingerprint`.
 *
 * @returns {Promise<Buffer|null>}
 */
export async function ensureFingerprintKey() {
  if (_fpKey) return _fpKey;
  try {
    const dek = await ensureDek();
    _fpKey = Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), FINGERPRINT_INFO, 32));
    return _fpKey;
  } catch (err) {
    logger.warn('[identityIndex] Sin DEK: no se calcularán huellas de documento.', { err: err.message });
    return null;
  }
}

/** Olvida la clave cacheada. Solo para pruebas. */
export function _resetFingerprintKey() {
  _fpKey = null;
}

/**
 * Forma canónica de un número de documento, para que dos escrituras del mismo CI
 * con distinto formato produzcan la misma huella.
 *
 * Quita todo lo que no sea alfanumérico (espacios, puntos, guiones) y pasa a
 * mayúsculas: `1234567-1A`, `1.234.567 1a` y `12345671A` colapsan en uno.
 *
 * @param {*} raw
 * @returns {string|null} forma canónica, o null si no es un documento utilizable
 */
export function normalizeDocumentNumber(raw) {
  if (typeof raw !== 'string') return null;
  // Un valor cifrado o un marcador nunca es un documento: si llega hasta acá es
  // que el llamador leyó el campo equivocado, y calcular su huella produciría una
  // clave basura que además agruparía a todos los usuarios entre sí.
  if (isEncrypted(raw)) return null;
  const canon = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (canon.length < 4 || /^(PENDINGVERIFICATION|ENCRYPTED)$/.test(canon)) return null;
  return canon;
}

/**
 * Huella determinista del documento, para guardar e indexar junto al ciphertext.
 *
 * @param {*} raw número de documento EN CLARO
 * @returns {Promise<string|null>} hex de 64 caracteres, o null si no se pudo calcular
 */
export async function documentFingerprint(raw) {
  const canon = normalizeDocumentNumber(raw);
  if (!canon) return null;
  const key = await ensureFingerprintKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(canon, 'utf8').digest('hex');
}

/**
 * Clave de búsqueda del teléfono: los últimos dígitos, sin prefijo ni separadores.
 *
 * @param {*} raw
 * @returns {string|null}
 */
export function phoneTail(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS) return null;
  return digits.slice(-PHONE_TAIL_LEN);
}

export const PHONE_TAIL_LENGTH = PHONE_TAIL_LEN;

export default {
  ensureFingerprintKey,
  normalizeDocumentNumber,
  documentFingerprint,
  phoneTail,
};
