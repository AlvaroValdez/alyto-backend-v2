/**
 * clientDocument.js — Resolución del documento fiscal/identidad del cliente
 * para el Comprobante Oficial de Transacción (SRL Bolivia).
 *
 * Fuente única de verdad usada por AMBOS generadores de comprobante
 * (payoutController y ipnController) para evitar divergencias:
 *   - Cuentas business con NIT  → tipoDocumento 'NIT'
 *   - Personas naturales con CI real capturado → tipoDocumento 'CI'
 *   - CI aún no capturado (placeholder de registro o Stripe no lo devolvió)
 *     → estado 'En verificación' (decisión ECP/ASFI: se emite el comprobante,
 *       nunca con "NO REGISTRADO"; el pendiente queda marcado con ciPending).
 *
 * Contexto: en el registro `identityDocument.number` se fija a
 * 'PENDING_VERIFICATION' y solo se sobrescribe cuando el usuario declara su CI
 * (flujo KYC) o cuando Stripe Identity devuelve `id_number` (no garantizado).
 *
 * Cifrado en reposo (PII): el CI real se persiste CIFRADO en
 * `identityDocument.numberCiphertext` (AES-256-GCM sobre DEK envuelta por KMS,
 * ver `services/piiCrypto.js`) y `identityDocument.number` queda con el marcador
 * `ENCRYPTED`. `readDocumentNumber()` es el ÚNICO punto que descifra para lectura;
 * `resolveDocumentNumberStorage()` es el ÚNICO punto que cifra para escritura. Las
 * consultas deben incluir `+identityDocument.numberCiphertext` (es select:false).
 *
 * Índice ciego para duplicados: como el ciphertext lleva IV aleatorio y AAD atado al
 * usuario, dos cuentas con el mismo CI se ven distintas en la base y no hay consulta
 * que las empareje. Por eso cada escritura deja también
 * `identityDocument.numberFingerprint`, un HMAC determinista del valor normalizado
 * (ver [clientIdentityIndex]). Que los dos puntos de escritura ya fueran únicos es
 * lo que permite añadirlo acá y que lo hereden los cuatro llamadores (registro,
 * perfil de cumplimiento, webhook de Stripe y SEP-12) sin tocar ninguno.
 */

import {
  decryptField,
  encryptField,
  ensureDek,
  aadForDocumentNumber,
  isPiiEncryptionEnabled,
  PII_ENCRYPTED_MARKER,
} from '../services/piiCrypto.js';
import { documentFingerprint } from '../services/clientIdentityIndex.js';

const PLACEHOLDER_RE = /pending|verification/i;

/** Etiqueta impresa cuando el CI todavía no fue capturado. */
export const CI_PENDING_LABEL = 'En verificación';

/**
 * ¿El valor es un número de documento real (no vacío, no placeholder)?
 * @param {*} value
 * @returns {boolean}
 */
export function isRealDocumentNumber(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.trim() !== PII_ENCRYPTED_MARKER
    && !PLACEHOLDER_RE.test(value.trim());
}

/**
 * Devuelve el CI real EN CLARO del usuario, descifrando si está cifrado.
 * - Si hay `numberCiphertext` → descifra (requiere DEK cargada; el llamador async
 *   debe `await ensureDek()` antes, o el arranque haberla precalentado).
 * - Si `number` es el marcador `ENCRYPTED` pero NO se seleccionó el ciphertext →
 *   devuelve null (NO expone el marcador) para degradar seguro a "En verificación".
 * - Si no, devuelve `number` tal cual (sentinel o valor legacy en claro).
 * @param {{ _id?: any, identityDocument?: { number?: string, numberCiphertext?: string } }} user
 * @returns {string|null}
 */
export function readDocumentNumber(user) {
  const idoc = user?.identityDocument;
  if (!idoc) return null;
  if (idoc.numberCiphertext) {
    return decryptField(idoc.numberCiphertext, aadForDocumentNumber(user._id));
  }
  if (idoc.number === PII_ENCRYPTED_MARKER) return null; // ciphertext ausente/no seleccionado
  return idoc.number ?? null;
}

/**
 * ¿El usuario tiene un CI real capturado? (presencia, sin descifrar el valor).
 * @param {{ identityDocument?: { number?: string, numberCiphertext?: string } }} user
 * @returns {boolean}
 */
export function hasRealDocumentNumber(user) {
  const idoc = user?.identityDocument;
  if (idoc?.numberCiphertext) return true;
  return isRealDocumentNumber(idoc?.number);
}

/**
 * Construye los campos a persistir para un número de documento entrante, cifrando
 * los valores REALES cuando el cifrado está activo. Único punto de escritura.
 *
 * Devuelve `{ number, numberCiphertext, numberFingerprint }`:
 *   - valor real + flag ON  → `{ number: 'ENCRYPTED', numberCiphertext: 'v1:...' }`
 *   - valor real + flag OFF → `{ number: <valor>, numberCiphertext: null }` (legacy)
 *   - sentinel/vacío        → `{ number: 'PENDING_VERIFICATION', numberCiphertext: null }`
 *
 * La huella se calcula para todo valor real, **con el cifrado encendido o apagado**:
 * no tiene que ver con cómo se guarda el número sino con poder encontrar duplicados.
 * Queda en `null` si no hay DEK de la que derivar la clave, y en ese caso la
 * detección de duplicados por documento simplemente no opera (ver [clientIdentityIndex]).
 *
 * Async: hace `ensureDek()` cuando corresponde cifrar o calcular la huella.
 * @param {any} userId
 * @param {string} rawValue
 * @returns {Promise<{ number: string, numberCiphertext: string|null, numberFingerprint: string|null }>}
 */
export async function resolveDocumentNumberStorage(userId, rawValue) {
  const v = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!(v && isRealDocumentNumber(v))) {
    return { number: v || 'PENDING_VERIFICATION', numberCiphertext: null, numberFingerprint: null };
  }
  const numberFingerprint = await documentFingerprint(v);
  if (!isPiiEncryptionEnabled()) {
    return { number: v, numberCiphertext: null, numberFingerprint };
  }
  await ensureDek();
  return {
    number:           PII_ENCRYPTED_MARKER,
    numberCiphertext: encryptField(v, aadForDocumentNumber(userId)),
    numberFingerprint,
  };
}

/**
 * Aplica `resolveDocumentNumberStorage` sobre un objeto `$set` (rutas con findByIdAndUpdate).
 * Muta y devuelve el mismo `$set`.
 * @param {Record<string, any>} $set
 * @param {any} userId
 * @param {string} rawValue
 * @returns {Promise<Record<string, any>>}
 */
export async function applyDocumentNumberToSet($set, userId, rawValue) {
  const { number, numberCiphertext, numberFingerprint } =
    await resolveDocumentNumberStorage(userId, rawValue);
  $set['identityDocument.number'] = number;
  $set['identityDocument.numberCiphertext'] = numberCiphertext;
  $set['identityDocument.numberFingerprint'] = numberFingerprint;
  return $set;
}

/**
 * Resuelve el documento del cliente para el comprobante.
 * @param {{ taxId?: string, _id?: any, identityDocument?: { number?: string, numberCiphertext?: string } }} user
 * @returns {{ nitOci: string, tipoDocumento: 'NIT'|'CI', ciPending: boolean }}
 */
export function resolveClientDocument(user) {
  // NIT empresarial tiene prioridad (cuentas business).
  if (typeof user?.taxId === 'string' && user.taxId.trim()) {
    return { nitOci: user.taxId.trim(), tipoDocumento: 'NIT', ciPending: false };
  }

  const num = readDocumentNumber(user);
  if (isRealDocumentNumber(num)) {
    return { nitOci: num.trim(), tipoDocumento: 'CI', ciPending: false };
  }

  // CI aún no disponible → se emite el comprobante con estado explícito.
  return { nitOci: CI_PENDING_LABEL, tipoDocumento: 'CI', ciPending: true };
}
