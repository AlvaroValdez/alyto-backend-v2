/**
 * Incident.js — Registro estructurado de incidentes.
 *
 * Antes de este modelo, un incidente sólo existía como el estado de la operación
 * afectada: si tres operaciones fallaban por la misma causa, había tres registros de
 * fallo y ningún registro del hecho que los produjo. Un incidente que no afecta a
 * ninguna operación —una indisponibilidad detectada y contenida a tiempo, un
 * descuadre de conciliación resuelto— no dejaba rastro en ninguna parte.
 *
 * Fundamento normativo: Art. 3° inc. a.5 Sec. 5 (tratamiento de daños), Art. 13°
 * inc. e (los daños al consumidor son causal de rechazo) y Art. 10° (seguimiento).
 * Implementa los apartados 10.3 a 10.7 del informe técnico.
 *
 * ── Dos decisiones que conviene no revertir ─────────────────────────────────────
 *
 * 1. INCIDENTE ≠ DAÑO. Todo daño proviene de un incidente; no todo incidente produce
 *    daño. `determination.isDamage` es el campo que los separa, y se completa en la
 *    etapa de determinación, no al abrir. Abrir un incidente NO afirma que hubo
 *    perjuicio.
 *
 * 2. LA SUCESIÓN DE ESTADOS SE CONSERVA. `statusHistory` es aditivo y no se puede
 *    reescribir. Es la corrección expresa del defecto que tiene ROSAlert, donde el
 *    estado se sobrescribe y la secuencia de decisiones se pierde: si un caso se
 *    revisa y luego se descarta, hoy no queda constancia de que hubo una revisión
 *    previa. Ante la UIF eso es indefendible.
 */

import mongoose from 'mongoose';
import Counter   from './Counter.js';

const { Schema } = mongoose;

/** Tipología del apartado 10.4 del informe técnico. */
export const INCIDENT_TYPES = [
  'pago_no_ejecutado',        // 1 — cobro percibido, pago no ejecutado
  'monto_inferior',           // 2 — acreditación por monto inferior al informado
  'demora',                   // 3 — demora superior al plazo informado
  'deposito_no_acreditado',   // 4 — depósito no acreditado en la billetera
  'restriccion_indebida',     // 5 — falso positivo de un control de prevención
  'datos_personales',         // 6 — incidente de seguridad de la información
  'indisponibilidad',         // 7 — falla de infraestructura
  'descuadre',                // conciliación: diferencia detectada
  'otro',
];

/** Los cuatro primeros admiten resarcimiento patrimonial directo (apdo. 10.8.1). */
export const PATRIMONIAL_TYPES = [
  'pago_no_ejecutado', 'monto_inferior', 'demora', 'deposito_no_acreditado',
];

export const INCIDENT_STATUSES = [
  'abierto',        // detectado, sin contener
  'contenido',      // exposición detenida (apdo. 10.6 paso 2)
  'en_analisis',    // determinando alcance y causa
  'determinado',    // se estableció si hubo daño
  'resarcido',      // restitución ejecutada
  'cerrado',
  'descartado',     // no constituyó incidente
];

/** Entrada de la sucesión de estados. Aditiva: se agrega, nunca se modifica. */
const statusChangeSchema = new Schema({
  from:      { type: String },
  to:        { type: String, required: true },
  at:        { type: Date,   default: Date.now },
  actorId:   { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actorEmail:{ type: String, default: '' },
  reason:    { type: String, default: '' },
}, { _id: false });

const incidentSchema = new Schema({
  /** Correlativo INC-YYYYMM-NNNN. */
  incidentId: { type: String, unique: true, index: true },

  type:     { type: String, enum: INCIDENT_TYPES, required: true, index: true },
  severity: { type: String, enum: ['baja', 'media', 'alta', 'critica'], default: 'media', index: true },

  /**
   * Cómo se detectó. `deteccion_propia` es el caso que el apdo. 10.5 destaca: la
   * entidad inicia el procedimiento de oficio, sin esperar reclamo.
   */
  source: { type: String, enum: ['deteccion_propia', 'reclamo', 'proveedor', 'auditoria'],
            required: true, index: true },

  detectedAt:  { type: Date, default: Date.now, index: true },
  detectedBy:  { type: String, default: 'system' },
  description: { type: String, required: true, maxlength: 2000 },

  /** Alcance. Un incidente puede no afectar a ninguna operación ni consumidor. */
  affectedUsers:        [{ type: Schema.Types.ObjectId, ref: 'User' }],
  affectedTransactions: [{ type: String }],   // alytoTransactionId
  affectedReclamos:     [{ type: String }],   // reclamoId
  failureCategory:      { type: String, default: null, index: true },  // ver failureTaxonomy

  /** Contención — apdo. 10.6 paso 2. Precede a la determinación, a propósito. */
  containment: {
    at:     { type: Date,   default: null },
    action: { type: String, default: '' },
  },

  /** Determinación — apdo. 10.6 paso 4. Es donde incidente se separa de daño. */
  determination: {
    at:         { type: Date,    default: null },
    isDamage:   { type: Boolean, default: null },   // null = aún no determinado
    cause:      { type: String,  default: '' },
    causeKnown: { type: Boolean, default: null },
  },

  /** Resarcimiento — apdo. 10.8. */
  compensation: {
    modality:   { type: String, enum: ['devolucion_integra', 'complemento', 'acreditacion',
                                       'liberacion', 'no_corresponde', null], default: null },
    amount:     { type: Number, default: null },
    currency:   { type: String, default: null },
    dueAt:      { type: Date,   default: null },   // plazo comprometido en el 10.8.1
    executedAt: { type: Date,   default: null },
  },

  /** Comunicación a esta Autoridad — apdo. 10.11. */
  asfiReport: {
    required:   { type: Boolean, default: false },
    dueAt:      { type: Date,    default: null },
    reportedAt: { type: Date,    default: null },
    reference:  { type: String,  default: '' },
  },

  status:        { type: String, enum: INCIDENT_STATUSES, default: 'abierto', index: true },
  statusHistory: { type: [statusChangeSchema], default: [] },
}, { timestamps: true, collection: 'incidents' });

incidentSchema.index({ status: 1, detectedAt: -1 });
incidentSchema.index({ type: 1, detectedAt: -1 });
incidentSchema.index({ 'compensation.dueAt': 1 });
incidentSchema.index({ 'asfiReport.dueAt': 1 });

/**
 * Correlativo + primer asiento de la sucesión de estados.
 *
 * El asiento inicial se escribe acá y no en el servicio para que ningún incidente
 * pueda existir sin su historia: si se creara por otra vía, la sucesión arrancaría
 * vacía y no habría forma de saber cuándo se abrió.
 */
incidentSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  try {
    if (!this.incidentId) {
      const now = this.detectedAt ?? new Date();
      const serie = `INC-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const doc = await Counter.findOneAndUpdate(
        { _id: serie },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
      );
      this.incidentId = `${serie}-${String(doc.seq).padStart(4, '0')}`;
    }
    if (this.statusHistory.length === 0) {
      this.statusHistory.push({ from: null, to: this.status, at: this.detectedAt ?? new Date(),
                                reason: 'Apertura del incidente' });
    }
    next();
  } catch (err) { next(err); }
});

/**
 * La sucesión de estados no se reescribe. Se bloquea cualquier actualización que
 * intente tocar `statusHistory` por fuera del servicio, que sólo agrega.
 */
const HISTORY_APPEND_ONLY = new Error(
  'Incident.statusHistory es aditivo: no se puede modificar ni eliminar una entrada de la sucesión de estados.',
);
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne']) {
  incidentSchema.pre(op, function () {
    const u = this.getUpdate() ?? {};
    const tocaHistoria = (o) => o && Object.keys(o).some(k => k.startsWith('statusHistory'));
    if (tocaHistoria(u.$set) || tocaHistoria(u.$unset) || tocaHistoria(u)
        || u.$pull?.statusHistory || u.$pop?.statusHistory) {
      throw HISTORY_APPEND_ONLY;
    }
  });
}

export default mongoose.model('Incident', incidentSchema);
