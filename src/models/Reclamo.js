/**
 * Reclamo.js — Punto de Reclamo de Primera Instancia (PRILI)
 *
 * Exigencia ASFI para licencia ETF/PSAV de AV Finance SRL (Decreto 5384).
 * Aplica a todos los usuarios de la plataforma — no exclusivo de SRL.
 *
 * Plazos regulatorios:
 *   - Acuse de recibo: inmediato (automático al crear)
 *   - Respuesta primera instancia: 10 días hábiles (campo plazoVence)
 *   - Sin resolución → escala a ASFI (segunda instancia)
 */

import mongoose from 'mongoose'
import crypto   from 'crypto'

function shortId(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase()
}

const reclamoSchema = new mongoose.Schema({
  reclamoId: {
    type:    String,
    default: () => `REC-${Date.now()}-${shortId(6)}`,
    unique:  true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  transactionId: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'Transaction',
    default: null,
  },
  tipo: {
    type:     String,
    enum:     ['cobro_indebido', 'transferencia_no_recibida', 'demora', 'error_monto', 'cuenta_bloqueada', 'otro'],
    required: true,
  },
  descripcion: {
    type:      String,
    required:  true,
    maxlength: 1000,
  },
  montoReclamado: {
    type:    Number,
    default: null,
  },
  currency: {
    type:    String,
    default: null,
  },
  documentos: [{
    filename:   String,
    base64:     String,
    mimetype:   String,
    uploadedAt: { type: Date, default: Date.now },
  }],
  status: {
    type:    String,
    enum:    ['recibido', 'en_revision', 'resuelto', 'escalado_asfi', 'cerrado'],
    default: 'recibido',
    index:   true,
  },
  respuesta:     { type: String,  default: null },
  respondidoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  respondidoAt:  { type: Date,    default: null },
  escaladoAt:    { type: Date,    default: null },
  cerradoAt:     { type: Date,    default: null },
  satisfecho:    { type: Boolean, default: null },
  /** Plazo regulatorio ASFI: createdAt + 10 días hábiles. Se calcula en pre-save. */
  plazoVence:    { type: Date },
  /** Nota interna del admin — NO visible al usuario */
  internalNote:  { type: String,  default: null },
}, { timestamps: true })

// ─── Pre-save: calcular plazoVence (10 días hábiles) ─────────────────────────

reclamoSchema.pre('save', async function () {
  if (this.isNew) {
    const fecha = new Date()
    let diasHabiles = 0
    while (diasHabiles < 10) {
      fecha.setDate(fecha.getDate() + 1)
      const dow = fecha.getDay()
      if (dow !== 0 && dow !== 6) diasHabiles++ // excluir sábado (6) y domingo (0)
    }
    this.plazoVence = fecha
  }
})

// ─── Índices ──────────────────────────────────────────────────────────────────

reclamoSchema.index({ plazoVence: 1 })
reclamoSchema.index({ createdAt: -1 })
reclamoSchema.index({ userId: 1, status: 1 })

export default mongoose.model('Reclamo', reclamoSchema)
