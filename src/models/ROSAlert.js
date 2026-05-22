/**
 * ROSAlert.js — Alertas de Operaciones Sospechosas (ROS) UIF Bolivia
 *
 * Registra patrones heurísticos detectados automáticamente en transacciones SRL.
 * Exigencia ASFI: AV Finance SRL debe mantener un registro de operaciones
 * sospechosas y reportar a la UIF Bolivia dentro de los plazos legales.
 *
 * Flujo:
 *   rosMonitor.js detecta patrón → crea ROSAlert (status: 'open')
 *   Admin revisa → marca 'reviewed' o 'reported_uif'
 *   Si no requiere acción → 'dismissed' con nota obligatoria
 *
 * Compliance: Resolución ASFI RD 044/2021 — art. 28 obligación de reporte UIF.
 */

import mongoose from 'mongoose'
import crypto   from 'crypto'

const rosAlertSchema = new mongoose.Schema({
  alertId: {
    type:    String,
    default: () => `ROS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    unique:  true,
    index:   true,
  },

  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },

  /**
   * Regla heurística que disparó la alerta:
   *   single_tx_high      — una tx supera el umbral individual
   *   daily_cumulative    — suma diaria del usuario supera umbral
   *   high_frequency      — demasiadas txs en 24h
   *   new_account_volume  — cuenta nueva con volumen inusual
   *   velocity_spike      — volumen 3x el promedio de 30 días del usuario
   */
  rule: {
    type:     String,
    enum:     ['single_tx_high', 'daily_cumulative', 'high_frequency', 'new_account_volume', 'velocity_spike'],
    required: true,
    index:    true,
  },

  severity: {
    type:    String,
    enum:    ['low', 'medium', 'high'],
    default: 'medium',
  },

  /** IDs de transacciones que evidencian el patrón */
  transactionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'Transaction',
  }],

  /** Datos numéricos de evidencia (montos, conteos, etc.) */
  details: {
    type:    mongoose.Schema.Types.Mixed,
    default: {},
  },

  status: {
    type:    String,
    enum:    ['open', 'reviewed', 'dismissed', 'reported_uif'],
    default: 'open',
    index:   true,
  },

  /** Nota del admin al revisar o desestimar */
  reviewNote: {
    type:    String,
    default: null,
  },

  reviewedBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },

  reviewedAt: {
    type:    Date,
    default: null,
  },

  /** Fecha en que se reportó formalmente a la UIF (si aplica) */
  reportedToUifAt: {
    type:    Date,
    default: null,
  },

}, { timestamps: true, collection: 'ros_alerts' })

rosAlertSchema.index({ userId: 1, rule: 1, status: 1 })
rosAlertSchema.index({ status: 1, createdAt: -1 })

export default mongoose.model('ROSAlert', rosAlertSchema)
