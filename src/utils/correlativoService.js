/**
 * correlativoService.js — Generador de números correlativos para comprobantes Alyto
 *
 * Centraliza la generación de correlativos para:
 *   - 'BOL' → Comprobante Oficial de Transacción (retail Bolivia)
 *   - 'SRV' → Comprobante Oficial de Servicio (B2B)
 *
 * Implementación: contador atómico en MongoDB (findOneAndUpdate + $inc + upsert).
 * Seguro para multi-instancia y concurrencia alta — MongoDB garantiza
 * que dos llamadas simultáneas nunca reciben el mismo número.
 *
 * Formato de salida: '{PREFIX}-{YYYYMM}-{SEQ_6}' → ej: 'BOL-202605-000042'
 * La secuencia reinicia cada mes para mantener correlativos cortos y auditables
 * por período fiscal (exigencia ASFI / contabilidad AV Finance SRL).
 *
 * @param {'BOL'|'SRV'} prefix
 * @returns {Promise<string>}  ej: 'BOL-202605-000042'
 */

import Counter from '../models/Counter.js'

export async function generarNumeroCorrelativo(prefix) {
  const now    = new Date()
  const year   = now.getFullYear()
  const month  = String(now.getMonth() + 1).padStart(2, '0')
  const period = `${year}${month}`          // ej: '202605'
  const key    = `${prefix}-${period}`      // ej: 'BOL-202605'

  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  )

  const seq = String(doc.seq).padStart(6, '0')  // ej: '000042'
  return `${prefix}-${period}-${seq}`            // ej: 'BOL-202605-000042'
}
