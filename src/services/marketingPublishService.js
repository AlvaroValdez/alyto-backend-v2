// src/services/marketingPublishService.js
//
// Publicación de una pieza aprobada a su red social.
//
// Es el único punto del módulo donde una acción sale del sistema y no se puede
// deshacer desde acá. Por eso el orden de las verificaciones importa:
//
//   1. La pieza existe y está en un estado publicable.
//   2. Hay un publicador para su canal (TikTok no lo tiene, y no es un bug).
//   3. El publicador está configurado.
//   4. ⚠️ Se REVISAN las prohibiciones otra vez, contra el texto actual.
//   5. Recién ahí se reclama la pieza de forma atómica y se llama a la API.
//
// El paso 4 parece redundante — el clasificador ya corrió al generarla — y no lo
// es. Una pieza pudo aprobarse hace días, o entrar como 'autopublicado' sin que
// nadie la mirara, y las listas de compliance cambian. Este es el último momento
// en que revisar sale gratis. Después ya está publicado.
//
// Gating: MARKETING_PUBLISH_ENABLED, separado de MARKETING_AGENT_ENABLED. Así el
// código puede desplegarse y quedar inerte: generar y revisar sigue funcionando,
// publicar no, hasta que alguien lo decida explícitamente.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';
import ContentPiece from '../models/ContentPiece.js';
import { verificarProhibiciones } from './riskClassifier.js';
import { getPublisher, estadoPublicadores, verificarCanales } from './publishers/publisherRegistry.js';

/** Estados desde los que una pieza puede salir al aire. */
const PUBLICABLES = ['aprobado', 'autopublicado'];

export function isPublishEnabled() {
  return process.env.MARKETING_PUBLISH_ENABLED === 'true';
}

export function estadoCanales() {
  return estadoPublicadores();
}

/** Igual que estadoCanales() pero verificando la credencial contra la red. */
export function estadoCanalesVerificado() {
  return verificarCanales();
}

function error(codigo, mensaje, extra = {}) {
  const e = new Error(mensaje);
  e.code = codigo;
  Object.assign(e, extra);
  return e;
}

/** Texto publicable de una pieza — lo mismo que mira el clasificador. */
const textoDe = (p) => [p.titulo, p.cuerpo, p.sugerenciaVisual].filter(Boolean).join('\n');

/**
 * Publica una pieza en su canal.
 *
 * @param {string} id  ObjectId de la pieza
 * @param {{actor?: string}} opts
 * @returns {Promise<object>} la pieza actualizada
 * @throws error con `.code` describiendo qué impidió publicar
 */
export async function publicarPieza(id, opts = {}) {
  if (!isPublishEnabled()) {
    throw error('PUBLICACION_DESHABILITADA',
      'La publicación a redes está deshabilitada (MARKETING_PUBLISH_ENABLED).');
  }

  const actor = opts.actor || 'admin';
  const pieza = await ContentPiece.findById(id).lean();

  if (!pieza) throw error('NO_ENCONTRADA', 'Pieza no encontrada.');

  // Ya salió: no se reintenta. `postId` es la prueba, no el estado.
  if (pieza.publicacion?.postId) {
    throw error('YA_PUBLICADA',
      'Esta pieza ya se publicó.',
      { postId: pieza.publicacion.postId, url: pieza.publicacion.url });
  }

  // Trabada por un intento anterior que no cerró. Reintentar podría duplicar el
  // post, así que se exige mirar la red y destrabar a mano.
  if (pieza.publicacion?.enCurso) {
    throw error('INTENTO_EN_CURSO',
      'Hay un intento de publicación sin resolver. Verificá en la red si el post salió ' +
      'antes de reintentar: publicar de nuevo podría duplicarlo.');
  }

  if (!PUBLICABLES.includes(pieza.estado)) {
    throw error('ESTADO_NO_PUBLICABLE',
      `Una pieza en estado "${pieza.estado}" no se puede publicar. ` +
      'Solo salen al aire las aprobadas o las de bajo riesgo.',
      { estado: pieza.estado });
  }

  const publicador = getPublisher(pieza.canal);
  if (!publicador) {
    throw error('CANAL_SIN_PUBLICADOR',
      `No hay publicación automática para ${pieza.canal}. ` +
      'Su API no acepta publicaciones de solo texto: requiere video o imágenes.',
      { canal: pieza.canal });
  }

  if (!publicador.disponible()) {
    throw error('PUBLICADOR_NO_CONFIGURADO',
      `${publicador.nombre} no está configurado. Falta: ${publicador.faltaConfigurar().join(', ')}.`,
      { canal: pieza.canal, falta: publicador.faltaConfigurar() });
  }

  // ⚠️ Último control antes de que sea irreversible.
  const veto = verificarProhibiciones(textoDe(pieza));
  if (!veto.ok) {
    logger.error('[marketing-publish] publicación bloqueada por prohibición absoluta', {
      piezaId: id, actor, motivo: veto.motivo, coincidencia: veto.coincidencia,
    });
    throw error('CONTENIDO_PROHIBIDO',
      `Esta pieza no puede publicarse: ${veto.motivo.toLowerCase()} ("${veto.coincidencia}").`,
      { motivo: veto.motivo, coincidencia: veto.coincidencia });
  }

  // Reclamo atómico: solo una llamada puede quedarse con la pieza. La condición
  // repite postId:null y enCurso:false para cerrar la ventana entre la lectura
  // de arriba y este update — dos admins apretando a la vez no duplican el post.
  const reclamada = await ContentPiece.findOneAndUpdate(
    {
      _id: id,
      estado: { $in: PUBLICABLES },
      $or: [{ 'publicacion.postId': null }, { 'publicacion.postId': { $exists: false } }],
      'publicacion.enCurso': { $ne: true },
    },
    { $set: { 'publicacion.enCurso': true }, $inc: { 'publicacion.intentos': 1 } },
    { returnDocument: 'after' },
  );

  if (!reclamada) {
    throw error('INTENTO_EN_CURSO',
      'Otro intento de publicación tomó esta pieza primero.');
  }

  try {
    const { postId, url } = await publicador.publicar({
      titulo: reclamada.titulo,
      cuerpo: reclamada.cuerpo,
    });

    const publicada = await ContentPiece.findByIdAndUpdate(id, {
      $set: {
        estado: 'publicado',
        'publicacion.postId':       postId,
        'publicacion.url':          url,
        'publicacion.publicadoEn':  new Date(),
        'publicacion.publicadoPor': actor,
        'publicacion.enCurso':      false,
        'publicacion.ultimoError':  null,
      },
    }, { returnDocument: 'after' });

    logger.info('[marketing-publish] pieza publicada', {
      piezaId: id, canal: reclamada.canal, postId, actor,
      intentos: reclamada.publicacion?.intentos,
    });

    return publicada;
  } catch (err) {
    // Distinción crítica: si el publicador nunca llegó a Meta (fallo de red),
    // no sabemos si el post salió → la pieza queda TRABADA para que un humano
    // mire antes de reintentar. Si Meta rechazó explícitamente, no hay post y se
    // puede desbloquear sin riesgo.
    const meLlegoRespuesta = err.code === 'PUBLICADOR_RECHAZO';

    await ContentPiece.findByIdAndUpdate(id, {
      $set: {
        'publicacion.enCurso':     !meLlegoRespuesta,
        'publicacion.ultimoError': err.message?.slice(0, 500) ?? String(err),
      },
    });

    logger.error('[marketing-publish] falló la publicación', {
      piezaId: id, canal: reclamada.canal, code: err.code,
      quedaTrabada: !meLlegoRespuesta, error: err.message,
    });
    Sentry.captureException(err, { tags: { service: 'marketingPublishService', canal: reclamada.canal } });

    throw err;
  }
}

/**
 * Destraba una pieza que quedó con un intento sin resolver.
 *
 * Es deliberadamente una acción humana y explícita: el operador tiene que haber
 * mirado la red social y confirmado que el post NO salió. Si salió, lo correcto
 * es registrar el postId a mano, no volver a publicar.
 */
export async function destrabarPieza(id, opts = {}) {
  const pieza = await ContentPiece.findById(id).lean();
  if (!pieza) throw error('NO_ENCONTRADA', 'Pieza no encontrada.');
  if (pieza.publicacion?.postId) {
    throw error('YA_PUBLICADA', 'La pieza ya tiene un post asociado; no hay nada que destrabar.');
  }
  if (!pieza.publicacion?.enCurso) {
    throw error('NO_TRABADA', 'La pieza no está trabada.');
  }

  logger.warn('[marketing-publish] pieza destrabada manualmente', {
    piezaId: id, actor: opts.actor, intentosPrevios: pieza.publicacion?.intentos,
  });

  return ContentPiece.findByIdAndUpdate(id, {
    $set: { 'publicacion.enCurso': false },
  }, { returnDocument: 'after' });
}

export default { isPublishEnabled, estadoCanales, estadoCanalesVerificado, publicarPieza, destrabarPieza };
