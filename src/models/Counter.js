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
 *   BOL → Comprobante Oficial de Transacción retail (pdfGenerator / payoutController)
 *   SRV → Comprobante Oficial de Servicio B2B (businessInvoiceGenerator)
 */

import mongoose from 'mongoose'

const counterSchema = new mongoose.Schema({
  _id: { type: String },   // '{PREFIX}-{YYYYMM}'
  seq: { type: Number, default: 0 },
}, { collection: 'counters' })

export default mongoose.model('Counter', counterSchema)
