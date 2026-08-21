/**
 * JobRun.js — Registro de ejecución de los procesos automáticos.
 *
 * La conciliación con proveedores, la vigilancia de depósitos y el barrido de
 * operaciones huérfanas corrían sin dejar constancia en la base: su única huella
 * estaba en las bitácoras de infraestructura, que son externas a la aplicación,
 * rotan y no se pueden consultar desde el panel.
 *
 * Consecuencia práctica: no había forma de responder "¿corrió la conciliación
 * anoche?" sin salir del sistema. Y un proceso que deja de correr **no produce
 * ningún síntoma**: los descuadres simplemente dejan de detectarse, en silencio.
 * Ese es el modo de falla que este registro cubre.
 *
 * Fundamento: Art. 2° inc. d Sec. 4 (registros de actividades) y Art. 10° inc. e
 * (esta Autoridad puede verificar los recursos tecnológicos). Cierra la limitación
 * 6 del apartado 7.10 del informe técnico.
 *
 * Retención acotada por TTL: a diferencia de las bitácoras de auditoría, esto es
 * telemetría operativa, no evidencia regulatoria de una operación. Conservarla
 * indefinidamente haría crecer la colección sin aportar nada.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const TTL_DAYS = Number(process.env.JOB_RUN_TTL_DAYS) || 180;

const jobRunSchema = new Schema({
  /** Nombre del proceso, tal como lo registra `jobRegistry`. */
  name: { type: String, required: true, index: true },

  /** Quién lo disparó: el planificador externo, el temporizador interno, o un admin. */
  trigger: {
    type:    String,
    enum:    ['scheduler', 'interval', 'manual'],
    default: 'scheduler',
  },

  startedAt:  { type: Date, required: true },
  finishedAt: { type: Date, required: true },
  /** Duración en milisegundos. Redundante con las fechas, pero evita calcularla al consultar. */
  durationMs: { type: Number, required: true },

  ok: { type: Boolean, required: true, index: true },

  /**
   * Volumen procesado, cuando el proceso lo informa. Es lo que permite distinguir
   * "corrió y no había nada que hacer" de "corrió y no hizo lo que debía" — dos
   * situaciones que sin este dato se ven idénticas.
   */
  processed: { type: Number, default: null },

  /** Mensaje de error, si falló. */
  error: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
}, { collection: 'job_runs' });

jobRunSchema.index({ name: 1, startedAt: -1 });
jobRunSchema.index({ ok: 1, startedAt: -1 });
jobRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

export default mongoose.model('JobRun', jobRunSchema);
