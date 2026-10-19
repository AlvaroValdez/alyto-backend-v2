/**
 * AiContentReport.js — Denuncias de contenido generado por la IA de soporte.
 *
 * Existe por exigencia de la política de IA generativa de Google Play: una app
 * que genera contenido con IA debe ofrecer, DENTRO de la propia app, un modo de
 * denunciar contenido ofensivo, y debe atender esas denuncias. Sin esto no se
 * puede declarar a Aly en la ficha, y sin declararla no se puede encender.
 *
 * Guarda el texto denunciado tal cual se le mostró al usuario. Es la única copia:
 * la conversación de Aly vive solo en el cliente y no se persiste en ningún sitio,
 * así que si no se copia aquí, la denuncia llega sin el contenido que denuncia.
 */

import mongoose from 'mongoose'
import crypto   from 'crypto'

function shortId(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase()
}

/** Motivos ofrecidos al usuario. 'ofensivo' y 'peligroso' son los que le importan
 *  a Play; 'incorrecto' se incluye porque en un asistente de soporte es el caso
 *  más frecuente y, si no existe, se denuncia como "ofensivo" lo que solo estaba
 *  mal, y se pierde la señal que de verdad hay que vigilar. */
export const MOTIVOS = ['ofensivo', 'peligroso', 'incorrecto', 'otro']

const aiContentReportSchema = new mongoose.Schema({
  reportId: {
    type:    String,
    default: () => `AIR-${Date.now()}-${shortId(6)}`,
    unique:  true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  motivo: {
    type:     String,
    enum:     MOTIVOS,
    required: true,
  },
  /** La respuesta de Aly que se denuncia, recortada. */
  contenido: {
    type:     String,
    required: true,
    maxlength: 4000,
  },
  /** El mensaje del usuario que la provocó, si lo hubo. Sin esto, muchas respuestas
   *  son indescifrables fuera de contexto. */
  mensajeUsuario: {
    type:      String,
    default:   null,
    maxlength: 2000,
  },
  /** Comentario libre del usuario al denunciar. Opcional. */
  comentario: {
    type:      String,
    default:   null,
    maxlength: 1000,
  },
  estado: {
    type:    String,
    enum:    ['pendiente', 'revisado', 'accionado', 'descartado'],
    default: 'pendiente',
    index:   true,
  },
  revisadoPor: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },
  revisadoEn:  { type: Date,   default: null },
  resolucion:  { type: String, default: null, maxlength: 2000 },
}, {
  timestamps: true,
  collection: 'ai_content_reports',
})

// Para el panel de revisión: lo pendiente primero y lo más reciente arriba.
aiContentReportSchema.index({ estado: 1, createdAt: -1 })

export default mongoose.model('AiContentReport', aiContentReportSchema)
