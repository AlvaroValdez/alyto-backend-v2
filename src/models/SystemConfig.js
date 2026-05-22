/**
 * SystemConfig.js — Configuración de sistema (key-value persistente)
 *
 * Almacena configuraciones operativas que deben sobrevivir reinicios:
 *   - stellar:srl:cursor  — último pagingToken Horizon procesado (Fase 36)
 *   - (extensible para feature flags, parámetros operativos, etc.)
 *
 * Uso:
 *   await SystemConfig.setValue('stellar:srl:cursor', '123456789')
 *   await SystemConfig.getValue('stellar:srl:cursor')        → '123456789'
 *   await SystemConfig.getValue('no-existe', 'default')      → 'default'
 */

import mongoose from 'mongoose'

const systemConfigSchema = new mongoose.Schema({
  _id:   { type: String },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
}, {
  timestamps: true,
  collection: 'system_configs',
})

// ─── Métodos estáticos ────────────────────────────────────────────────────────

systemConfigSchema.statics.getValue = async function (key, defaultValue = null) {
  const doc = await this.findById(key).lean()
  return doc ? doc.value : defaultValue
}

systemConfigSchema.statics.setValue = async function (key, value) {
  await this.findOneAndUpdate(
    { _id: key },
    { value },
    { upsert: true, new: true },
  )
}

export default mongoose.model('SystemConfig', systemConfigSchema)
