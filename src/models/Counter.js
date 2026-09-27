/**
 * Counter.js — Secuencia atómica para numeración de comprobantes
 *
 * Cada documento representa una serie mensual por prefijo.
 * _id = '{PREFIX}-{YYYYMM}'  (ej: 'BOL-202605')
 * seq = último número emitido en esa serie
 *
 * El incremento se hace con findOneAndUpdate + $inc, que MongoDB garantiza
 * atómico incluso bajo carga concurrente y en clusters multi-instancia.
 *
 * Series definidas:
 *   BOL  → Comprobante Oficial de Transacción retail (pdfGenerator / payoutController)
 *   SRV  → Comprobante Oficial de Servicio B2B (businessInvoiceGenerator)
 *   PREF → Alias hacia un proveedor externo (providerReference). Usa `base`.
 */

import mongoose from 'mongoose'

const counterSchema = new mongoose.Schema({
  _id: { type: String },   // '{PREFIX}-{YYYYMM}'
  seq: { type: Number, default: 0 },

  /**
   * Desplazamiento que se SUMA a `seq` al formar el identificador visible, sin
   * alterar `seq`. Lo usa `providerReference`: un alias que arranca en 1 le
   * informa al proveedor cuántas operaciones llevamos.
   *
   * Se escribe una sola vez con `$setOnInsert` y no se vuelve a tocar. Cambiarlo
   * después haría que la serie se solape con identificadores ya emitidos.
   *
   * Las series de comprobantes (BOL, SRV) no lo usan: ahí el correlativo debe
   * ser un correlativo de verdad por período fiscal.
   */
  base: { type: Number },
}, { collection: 'counters' })

export default mongoose.model('Counter', counterSchema)
