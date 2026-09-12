/**
 * LimitRejection.js — Asiento del rechazo de una operación por exceso de límite del
 * Protocolo de Pruebas (ASFI).
 *
 * Cierra un hueco de acreditación: el control de límites es una BARRERA PREVIA —
 * rechaza la operación ANTES de crearla (`ecpLimits.checkEcpLimits`) — pero hasta
 * ahora el rechazo sólo quedaba en los logs del servidor. La respuesta a ASFI declara
 * que el rechazo deja "registro... verificable en el sistema": este modelo lo hace
 * verdadero. Cada rechazo queda como un asiento consultable con el límite alcanzado,
 * el consumo previo y el remanente, exactamente como se declara.
 *
 * ⚠️ APPEND-ONLY: igual que AdminAuditLog, un asiento de rechazo no se edita ni se
 * borra. Los hooks de abajo bloquean update/delete a nivel de aplicación.
 *
 * No persiste datos personales del beneficiario ni del comprobante: sólo el hecho del
 * rechazo, su causa cuantificada y el contexto mínimo de auditoría.
 */

import mongoose from 'mongoose'

const limitRejectionSchema = new mongoose.Schema({
  // ── Causa cuantificada del rechazo (del `violation` de evaluateEcpLimits) ──────
  code:      { type: String, required: true, index: true },  // ej. 'ECP_DAILY_AMOUNT_LIMIT'
  scope:     { type: String, default: '' },                  // operación | diario | período | verificación
  unit:      { type: String, default: '' },                  // 'BOB' | 'operaciones' | null
  limit:     { type: Number, default: null },                // límite alcanzado
  used:      { type: Number, default: null },                // consumo previo
  requested: { type: Number, default: null },                // lo solicitado (monto o 1 operación)
  remaining: { type: Number, default: null },                // remanente disponible

  // ── Contexto de la operación rechazada ────────────────────────────────────────
  amountBOB:          { type: Number, default: null },  // monto de origen de la operación
  legalEntity:        { type: String, default: '' },    // 'SRL'
  corridorCode:       { type: String, default: '' },    // ej. 'bo-br'
  corridorId:         { type: mongoose.Schema.Types.ObjectId, ref: 'TransactionConfig' },
  destinationCountry: { type: String, default: '' },

  // ── Quién y desde dónde (auditoría) ───────────────────────────────────────────
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, { timestamps: true, collection: 'limit_rejections' })

// Índices para las consultas de supervisión (por fecha, por causa, por consumidor).
limitRejectionSchema.index({ createdAt: -1 })
limitRejectionSchema.index({ code: 1, createdAt: -1 })

// ── Append-only: bloquear cualquier update/delete a nivel de aplicación ──────────
const APPEND_ONLY = new Error('LimitRejection es append-only: un asiento de rechazo por límite no se puede modificar ni eliminar.')
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
                  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace']) {
  limitRejectionSchema.pre(op, function () { throw APPEND_ONLY })
}
// Bloquear save() sobre un documento ya existente (permite solo la creación inicial).
limitRejectionSchema.pre('save', function () {
  if (!this.isNew) throw APPEND_ONLY
})

export default mongoose.model('LimitRejection', limitRejectionSchema)
