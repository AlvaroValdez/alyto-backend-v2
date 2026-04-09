/**
 * correlativoService.js — Generador de números correlativos para comprobantes Alyto
 *
 * Centraliza la generación de correlativos para:
 *   - 'BOL' → Comprobante Oficial de Transacción (retail Bolivia)
 *   - 'SRV' → Comprobante Oficial de Servicio (B2B)
 *
 * TODO producción: reemplazar por contador atómico en BD para evitar duplicados
 * en entornos multi-instancia.
 *
 * @param {'BOL'|'SRV'} prefix
 * @param {import('mongoose').Document} transaction
 * @returns {string} Ej: 'SRV-202604-A1B2C3'
 */
export function generarNumeroCorrelativo(prefix, transaction) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const seq   = transaction._id.toString().slice(-6).toUpperCase();
  return `${prefix}-${year}${month}-${seq}`;
}
