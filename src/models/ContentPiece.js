// src/models/ContentPiece.js
//
// Pieza de contenido generada por el agente de marketing y educación financiera.
//
// NO es una colección financiera: no toca saldos, transacciones ni ledger. Vive
// aparte a propósito. Su razón de ser es dejar rastro auditable de qué se generó,
// cómo se clasificó el riesgo y quién autorizó su publicación.
//
// Doble verificación de riesgo (intencional, ver services/riskClassifier.js):
//   - `autoevaluacionRiesgo`  → lo que el MODELO dijo de su propia pieza.
//   - `clasificacionFinal`    → lo que decidió el CLASIFICADOR determinista.
// Manda siempre el clasificador. Guardamos ambos para poder auditar la brecha:
// si el modelo dice "bajo" y el código dice "alto", eso es evidencia de que el
// gate humano está haciendo falta y no puede quitarse.
//
// Estados:
//   pendiente_aprobacion — alto riesgo, esperando visto bueno humano
//   aprobado / rechazado — un humano decidió (queda `aprobadoPor` + `aprobadoEn`)
//   autopublicado        — bajo riesgo, habilitada sin gate humano
//   publicado            — efectivamente publicada en el canal
// ⚠️ En esta fase la publicación real a redes NO existe: `autopublicado` marca
// "apta para publicar sin gate", no "ya salió". `publicado` queda reservado para
// la fase siguiente.

import mongoose from 'mongoose';

const contentPieceSchema = new mongoose.Schema({
  titulo:           { type: String, required: true, trim: true, maxlength: 300 },
  cuerpo:           { type: String, required: true, trim: true, maxlength: 5000 },
  sugerenciaVisual: { type: String, trim: true, maxlength: 1000 },

  canal: {
    type: String,
    enum: ['facebook', 'x', 'tiktok'],
    required: true,
    index: true,
  },

  tipo: {
    type: String,
    enum: ['captacion', 'educacion'],
    required: true,
    index: true,
  },

  // Autoevaluación del modelo. Señal de entrada, NO decisión.
  autoevaluacionRiesgo: {
    type: String,
    enum: ['alto', 'bajo'],
    required: true,
  },

  // Justificación que dio el modelo para su autoevaluación (campo MOTIVO_RIESGO).
  // Se guarda para auditar la calidad del criterio del modelo con el tiempo.
  motivoRiesgoModelo: { type: String, trim: true, maxlength: 1000, default: null },

  // Decisión del clasificador determinista. Es la que manda.
  clasificacionFinal: {
    type: String,
    enum: ['alto', 'bajo'],
    required: true,
    index: true,
  },

  // Qué reglas del clasificador dispararon el alto riesgo. Vacío si fue bajo.
  motivosClasificador: { type: [String], default: [] },

  // Los fragmentos EXACTOS que dispararon cada señal ("2%", "asfi", "remesa").
  // Sin esto el revisor lee "Contiene cifras económicas" y tiene que buscar la
  // cifra a ojo; con esto la interfaz puede resaltarla. Un motivo que no se puede
  // verificar de un vistazo se termina aprobando sin leer.
  coincidenciasClasificador: { type: [String], default: [] },

  estado: {
    type: String,
    enum: ['pendiente_aprobacion', 'aprobado', 'rechazado', 'publicado', 'autopublicado'],
    required: true,
    index: true,
  },

  // Instrucción con la que se pidió la pieza. Permite reproducir y comparar.
  tarea: { type: String, trim: true, maxlength: 2000, default: null },

  creadoPor:  { type: String, default: 'marketing-agent', trim: true },

  // ── Publicación ────────────────────────────────────────────────────────────
  //
  // `postId` es la prueba de que la pieza salió: mientras esté vacío, la pieza
  // NO se publicó, pase lo que pase con el estado. Es el campo sobre el que se
  // apoya la idempotencia — publicar dos veces es tan grave como aprobar dos
  // veces, pero además es irreversible desde acá.
  publicacion: {
    postId:       { type: String, default: null },   // id del post en la red
    url:          { type: String, default: null },   // permalink, si la API lo devuelve
    publicadoEn:  { type: Date,   default: null },
    publicadoPor: { type: String, default: null },   // admin que apretó el botón
    intentos:     { type: Number, default: 0 },

    // Marca de intento en vuelo. La API de una red social no acepta claves de
    // idempotencia: si el proceso muere entre "llamé" y "guardé el resultado",
    // no hay forma de saber si el post salió. Reintentar a ciegas podría
    // duplicarlo, así que la pieza queda trabada acá y hay que destrabarla a
    // mano después de mirar la red. Preferimos un bloqueo visible a un post
    // duplicado silencioso.
    enCurso:      { type: Boolean, default: false },
    ultimoError:  { type: String,  default: null },
  },

  // Quién resolvió el gate humano (identificador del admin) y cuándo. Null
  // mientras nadie decidió. Evidencia de que hubo revisión humana.
  aprobadoPor: { type: String, default: null, trim: true },
  aprobadoEn:  { type: Date,   default: null },
}, { timestamps: true, collection: 'content_pieces' });

// Cola de aprobación: "las pendientes, más viejas primero".
contentPieceSchema.index({ estado: 1, createdAt: -1 });
// Historial paginado.
contentPieceSchema.index({ createdAt: -1 });

export default mongoose.model('ContentPiece', contentPieceSchema);
