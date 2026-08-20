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

// ─── Slide de carrusel ───────────────────────────────────────────────────────
//
// Un slide es texto, no imagen. La imagen se renderiza a partir de él (SVG →
// PNG) y ese render es reproducible: la pieza guardada es el texto.
//
// Esto NO es un detalle de implementación, es lo que mantiene vivo el control
// regulatorio. Si el slide fuera un PNG subido, su contenido sería opaco para
// `riskClassifier` y el 90% del mensaje de un carrusel —que vive en las
// imágenes, no en el pie— se publicaría sin pasar por el gate.
//
// Los `maxlength` son topes de sanidad, NO validación de que el texto entre en
// el lienzo. Cuánto entra depende del ancho real de cada glifo (Inter es de
// ancho variable), así que lo mide el renderer y falla ruidosamente si desborda.
// Un slide que no se generó es mejor que uno con el titular cortado.
const slideSchema = new mongoose.Schema({
  orden:  { type: Number, required: true, min: 1, max: 10 },
  rol:    { type: String, enum: ['portada', 'desarrollo', 'cierre'], required: true },
  titulo: { type: String, trim: true, maxlength: 200, default: '' },
  texto:  { type: String, trim: true, maxlength: 600, default: '' },
}, { _id: false });

const contentPieceSchema = new mongoose.Schema({
  titulo:           { type: String, required: true, trim: true, maxlength: 300 },
  cuerpo:           { type: String, required: true, trim: true, maxlength: 5000 },
  sugerenciaVisual: { type: String, trim: true, maxlength: 1000 },

  // Un carrusel no es "un post con más campos": se publica por otra vía (subir
  // cada imagen sin publicar, juntar los media_fbid, recién ahí el post), así
  // que el publicador necesita saberlo antes de elegir el camino.
  formato: {
    type: String,
    enum: ['post', 'carrusel'],
    default: 'post',
    required: true,
  },

  // Vacío en un post. En un carrusel, 2–10 slides con `orden` contiguo desde 1.
  slides: { type: [slideSchema], default: [] },

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

// ─── Invariantes de carrusel ─────────────────────────────────────────────────
//
// Se validan en el modelo y no en el servicio a propósito: son condiciones sin
// las cuales la pieza no se puede renderizar ni publicar, así que no debería
// existir en la base. Que el parseo de la respuesta del modelo falle a medias
// es un modo de fallo real, no hipotético.
//
// Importa además por compliance: si un carrusel persistiera con `slides` vacío,
// el clasificador solo vería título y cuerpo, no encontraría nada objetable y
// lo marcaría BAJO → autopublicado. Fallar acá es lo que evita que un carrusel
// sin texto legible se cuele como "apto para publicar".
// Va en un hook `pre('validate')` y no en un validador de path porque el
// mensaje necesita mirar `formato` para explicar QUÉ está mal, y en la función
// de mensaje de un validador de Mongoose `this` no es el documento.
// Hook sin `next`: declarado sin argumentos, Mongoose lo trata como síncrono y
// lo da por terminado cuando retorna.
contentPieceSchema.pre('validate', function () {
  const slides = this.slides ?? [];
  const n = slides.length;

  if (this.formato !== 'carrusel') {
    if (n > 0) {
      this.invalidate('slides', `Una pieza de formato "${this.formato}" no lleva slides (recibidos: ${n}).`);
    }
    return;
  }

  if (n < 2 || n > 10) {
    this.invalidate('slides', `Un carrusel lleva entre 2 y 10 slides (recibidos: ${n}).`);
    return;
  }

  // `orden` tiene que ser exactamente 1..n. Sin esto, un slide que no parsea
  // deja la secuencia en [1,2,4,5] y el carrusel se publica con un hueco —
  // pierde un paso del argumento sin que nadie se entere.
  const ordenes = slides.map(s => s.orden).sort((a, b) => a - b);
  if (!ordenes.every((o, i) => o === i + 1)) {
    this.invalidate(
      'slides',
      `Los slides deben numerarse de 1 a ${n} sin huecos ni repetidos (recibidos: ${ordenes.join(', ')}).`,
    );
  }
});

// Cola de aprobación: "las pendientes, más viejas primero".
contentPieceSchema.index({ estado: 1, createdAt: -1 });
// Historial paginado.
contentPieceSchema.index({ createdAt: -1 });

export default mongoose.model('ContentPiece', contentPieceSchema);
