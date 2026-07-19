/**
 * AdminAuditLog.js — Registro de auditoría de acciones sensibles del admin.
 *
 * Requisito transversal del AnchorAdmin (spec §5): toda acción sensible ejecutada
 * desde el panel debe quedar registrada — quién, qué, cuándo, valor anterior y nuevo.
 * El propio panel es auditable a través de este registro.
 *
 * Es la capa base de todo lo que MUTA estado (congelamiento 4.7, fees/límites 4.12):
 * esos módulos llaman a recordAdminAction() al ejecutar la acción.
 *
 * ⚠️ APPEND-ONLY: los registros de auditoría no se editan ni se borran. Los hooks de
 * abajo bloquean update/delete a nivel de aplicación; la inmutabilidad fuerte
 * (retención regulatoria) se refuerza a nivel de infraestructura si se requiere.
 *
 * ⚠️ NUNCA persiste secretos: before/after/metadata se pasan por redactSensitive()
 * en adminAuditService antes de crear el documento.
 */

import mongoose from 'mongoose'

const adminAuditLogSchema = new mongoose.Schema({
  // ── Quién ────────────────────────────────────────────────────────────────────
  actorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  actorEmail: { type: String, default: '' },   // snapshot al momento de la acción
  actorRole:  { type: String, default: '' },   // snapshot (admin/operador)

  // ── Qué ──────────────────────────────────────────────────────────────────────
  action:     { type: String, required: true, index: true },  // ej. 'wallet.freeze', 'fee.update'
  targetType: { type: String, default: '' },                  // ej. 'WalletUSDC', 'WalletFeeConfig'
  targetId:   { type: String, default: '' },                  // ObjectId o clave de config

  // ── Valor anterior y nuevo (ya redactados) ────────────────────────────────────
  before:     { type: mongoose.Schema.Types.Mixed, default: null },
  after:      { type: mongoose.Schema.Types.Mixed, default: null },

  // ── Contexto ──────────────────────────────────────────────────────────────────
  reason:     { type: String, default: '' },   // motivo / referencia de oficio regulatorio
  metadata:   { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:         { type: String, default: '' },
  userAgent:  { type: String, default: '' },

  // ── Resultado ──────────────────────────────────────────────────────────────────
  result:       { type: String, enum: ['success', 'failure'], default: 'success', index: true },
  errorMessage: { type: String, default: '' },
}, { timestamps: true, collection: 'admin_audit_logs' })

// Índices para las consultas del panel (por actor, por acción, por objeto, por fecha).
adminAuditLogSchema.index({ createdAt: -1 })
adminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 })
adminAuditLogSchema.index({ actorId: 1, createdAt: -1 })

// ── Append-only: bloquear cualquier update/delete a nivel de aplicación ──────────
const APPEND_ONLY = new Error('AdminAuditLog es append-only: no se puede modificar ni eliminar un registro de auditoría.')
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
                  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace']) {
  adminAuditLogSchema.pre(op, function () { throw APPEND_ONLY })
}
// Bloquear save() sobre un documento ya existente (permite solo la creación inicial).
adminAuditLogSchema.pre('save', function () {
  if (!this.isNew) throw APPEND_ONLY
})

export default mongoose.model('AdminAuditLog', adminAuditLogSchema)
