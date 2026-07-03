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
 */

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
    && !PLACEHOLDER_RE.test(value.trim());
}

/**
 * Resuelve el documento del cliente para el comprobante.
 * @param {{ taxId?: string, identityDocument?: { number?: string } }} user
 * @returns {{ nitOci: string, tipoDocumento: 'NIT'|'CI', ciPending: boolean }}
 */
export function resolveClientDocument(user) {
  // NIT empresarial tiene prioridad (cuentas business).
  if (typeof user?.taxId === 'string' && user.taxId.trim()) {
    return { nitOci: user.taxId.trim(), tipoDocumento: 'NIT', ciPending: false };
  }

  const num = user?.identityDocument?.number;
  if (isRealDocumentNumber(num)) {
    return { nitOci: num.trim(), tipoDocumento: 'CI', ciPending: false };
  }

  // CI aún no disponible → se emite el comprobante con estado explícito.
  return { nitOci: CI_PENDING_LABEL, tipoDocumento: 'CI', ciPending: true };
}
