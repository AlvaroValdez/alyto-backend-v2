/**
 * marketingAgentController.js — Panel admin del agente de marketing.
 *
 * Controladores delgados: la lógica vive en marketingAgentService y riskClassifier.
 * Prefijo: /api/v1/admin/marketing  (protect + checkAdmin + feature flag en las rutas).
 *
 * ⚠️ Aprobar y rechazar son mutaciones sensibles: quedan registradas en
 * AdminAuditLog vía recordAdminAction. El campo `aprobadoPor` de la pieza dice
 * QUIÉN aprobó; el audit log dice además desde qué IP, con qué user-agent y con
 * qué estado previo. Ante ASFI, el gate humano vale lo que valga su evidencia.
 *
 * Concurrencia: la transición de estado es un findOneAndUpdate condicionado al
 * estado de origen. Dos admins apretando "aprobar" a la vez no se pisan — el
 * segundo recibe 409 con el estado real, en vez de sobrescribir quién aprobó.
 */

import mongoose from 'mongoose';
import * as Sentry from '@sentry/node';
import ContentPiece from '../models/ContentPiece.js';
import { procesarPieza, isMarketingAgentEnabled } from '../services/marketingAgentService.js';
import { verificarProhibiciones, textoPublicable } from '../services/riskClassifier.js';
import {
  publicarPieza, destrabarPieza, isPublishEnabled, estadoCanalesVerificado,
} from '../services/marketingPublishService.js';
import { canalesSoportados } from '../services/publishers/publisherRegistry.js';
import { recordAdminAction } from '../services/adminAuditService.js';
import { logger } from '../utils/logger.js';

// Errores del servicio que son culpa del modelo, no del servidor: se responden
// 502 (upstream) con el código, para que el panel muestre algo accionable en vez
// de un "error interno" genérico.
const ERRORES_UPSTREAM = {
  RESPUESTA_NO_PARSEABLE: 'El modelo no devolvió la estructura esperada. Reintentá o ajustá la tarea.',
  CANAL_INVALIDO:         'El modelo eligió un canal no soportado. Indicá el canal en la tarea (facebook, x o tiktok).',
  TIPO_INVALIDO:          'El modelo eligió un tipo no soportado. Indicá si es de captación o educación.',
};

const PAGE_LIMIT_MAX = 100;

// Errores de publicación → HTTP. Cada uno pide una acción distinta del admin,
// así que colapsarlos en un 500 le quitaría la única pista que tiene.
const HTTP_PUBLICACION = {
  NO_ENCONTRADA:            404,
  YA_PUBLICADA:             409,  // idempotencia: no se reintenta
  INTENTO_EN_CURSO:         409,  // hay que mirar la red antes de tocar nada
  ESTADO_NO_PUBLICABLE:     409,
  CONTENIDO_PROHIBIDO:      422,  // nunca publicable
  CANAL_SIN_PUBLICADOR:     501,  // la red no acepta este tipo de contenido
  PUBLICADOR_NO_CONFIGURADO:503,  // falta configuración del despliegue
  PUBLICACION_DESHABILITADA:503,
  PUBLICADOR_RECHAZO:       502,  // la red dijo que no
  PUBLICADOR_SIN_RESPUESTA: 504,  // no sabemos si salió
  PUBLICADOR_RESPUESTA_RARA:502,
  NO_TRABADA:               409,
};

/** Paginación saneada desde query params. */
function paginacion(query) {
  const page  = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, Number(query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function fail(res, err, fn, mensaje) {
  logger.error(`[marketingAgent] ${fn} falló`, { error: err.message });
  Sentry.captureException(err, { tags: { controller: 'marketingAgentController', fn } });
  return res.status(500).json({ error: mensaje });
}

// ─── POST /api/v1/admin/marketing/generar ────────────────────────────────────

/** Genera una pieza, la clasifica y la persiste. Body: { tarea }. */
export async function generar(req, res) {
  const { tarea } = req.body || {};

  if (!tarea || typeof tarea !== 'string' || !tarea.trim()) {
    return res.status(400).json({ error: 'Falta `tarea`: describí qué pieza querés generar.' });
  }

  try {
    // El servicio devuelve null solo si el flag está apagado. Con el montaje
    // condicionado al flag esto casi no puede pasar, pero si pasa es 503 (el
    // servicio existe y está deshabilitado), no 500.
    const pieza = await procesarPieza(tarea, { creadoPor: req.user?.email || 'admin' });

    if (!pieza) {
      return res.status(503).json({
        error: 'El agente de marketing está deshabilitado (MARKETING_AGENT_ENABLED).',
      });
    }

    return res.status(201).json({ pieza });
  } catch (err) {
    if (err.code === 'TAREA_VACIA') return res.status(400).json({ error: err.message });

    // El prompt vive fuera del repo: si falta, es un problema de configuración
    // del despliegue, no del modelo ni del pedido. 503 con el nombre exacto de
    // la variable que hay que setear.
    if (err.code === 'PROMPT_NO_CONFIGURADO') {
      logger.error('[marketingAgent] system prompt no configurado', { error: err.message });
      return res.status(503).json({ error: err.message, code: err.code });
    }

    if (ERRORES_UPSTREAM[err.code]) {
      logger.warn('[marketingAgent] generación rechazada', { code: err.code, error: err.message });
      return res.status(502).json({ error: ERRORES_UPSTREAM[err.code], code: err.code });
    }

    return fail(res, err, 'generar', 'No se pudo generar la pieza de contenido.');
  }
}

// ─── GET /api/v1/admin/marketing/pendientes ──────────────────────────────────

/** Cola de aprobación: piezas de alto riesgo esperando decisión humana. */
export async function listarPendientes(req, res) {
  try {
    const { page, limit, skip } = paginacion(req.query);

    const [piezas, total] = await Promise.all([
      // Más viejas primero: lo que lleva más tiempo esperando se atiende antes.
      ContentPiece.find({ estado: 'pendiente_aprobacion' }).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
      ContentPiece.countDocuments({ estado: 'pendiente_aprobacion' }),
    ]);

    // Se marca cuáles no son aprobables para que el panel deshabilite el botón,
    // en vez de dejar que el admin haga clic y reciba un 422. Un gate que rebota
    // sin explicar de antemano entrena a ignorar los errores.
    const conVeto = piezas.map(p => {
      const veto = verificarProhibiciones(textoPublicable(p));
      return veto.ok ? { ...p, prohibida: false }
                     : { ...p, prohibida: true, motivoProhibicion: veto.motivo, coincidencia: veto.coincidencia };
    });

    return res.status(200).json({
      piezas: conVeto,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return fail(res, err, 'listarPendientes', 'No se pudo obtener la cola de aprobación.');
  }
}

// ─── GET /api/v1/admin/marketing/publicables ─────────────────────────────────

/**
 * Lo que está listo para salir al aire: aprobadas o de bajo riesgo, todavía sin
 * publicar. Espejo de /pendientes — juntas cubren las dos colas de trabajo del
 * admin (revisar y publicar).
 */
export async function listarPublicables(req, res) {
  try {
    const { page, limit, skip } = paginacion(req.query);

    const filtro = {
      estado: { $in: ['aprobado', 'autopublicado'] },
      'publicacion.postId': null,
    };

    const [piezas, total] = await Promise.all([
      ContentPiece.find(filtro).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
      ContentPiece.countDocuments(filtro),
    ]);

    // Se marca por qué una pieza no se puede publicar, para que el panel lo
    // muestre en vez de ofrecer un botón que va a rebotar.
    const canalesConPublicador = new Set(canalesSoportados());
    const conEstado = piezas.map(p => ({
      ...p,
      publicable: canalesConPublicador.has(p.canal) && !p.publicacion?.enCurso,
      motivoNoPublicable: !canalesConPublicador.has(p.canal)
        ? `${p.canal} no acepta publicaciones de solo texto por API`
        : p.publicacion?.enCurso
          ? 'Hay un intento de publicación sin resolver'
          : null,
    }));

    return res.status(200).json({
      piezas: conEstado,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return fail(res, err, 'listarPublicables', 'No se pudo obtener la lista de publicables.');
  }
}

// ─── GET /api/v1/admin/marketing/historial ───────────────────────────────────

/** Historial completo, paginado. Filtros opcionales: estado, canal, tipo. */
export async function listarHistorial(req, res) {
  try {
    const { page, limit, skip } = paginacion(req.query);

    const filtro = {};
    for (const campo of ['estado', 'canal', 'tipo', 'clasificacionFinal']) {
      if (req.query[campo]) filtro[campo] = req.query[campo];
    }

    const [piezas, total] = await Promise.all([
      ContentPiece.find(filtro).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ContentPiece.countDocuments(filtro),
    ]);

    return res.status(200).json({
      piezas,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return fail(res, err, 'listarHistorial', 'No se pudo obtener el historial.');
  }
}

// ─── POST /api/v1/admin/marketing/:id/{aprobar,rechazar} ─────────────────────

/**
 * Resuelve el gate humano de una pieza pendiente.
 *
 * La transición es atómica y condicionada a `estado: 'pendiente_aprobacion'`:
 * solo una pieza que efectivamente está esperando decisión puede resolverse, y
 * solo una vez. Sin esto, dos clics simultáneos dejarían el registro diciendo que
 * la aprobó el segundo admin, y un reintento del navegador reescribiría la fecha.
 *
 * `bloquearProhibidos` distingue las dos categorías de riesgo:
 *   - REVISABLE (una cifra, una mención a la autoridad): el humano decide con
 *     contexto. Puede aprobarla.
 *   - PROHIBIDO ("remesas", "FDIC", "regulados por ASFI"): no hay contexto que lo
 *     habilite. La regla de AV Finance no admite excepciones, así que tampoco
 *     debería admitirlas la interfaz. Se bloquea la aprobación; el rechazo sigue
 *     disponible, porque rechazar es justamente lo que corresponde hacer.
 */
async function resolver(req, res, { estadoNuevo, accionAudit, fn, bloquearProhibidos = false }) {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Identificador de pieza inválido.' });
  }

  try {
    const actor = req.user?.email || String(req.user?._id || 'admin');

    if (bloquearProhibidos) {
      const candidata = await ContentPiece.findById(id).lean();
      if (!candidata) return res.status(404).json({ error: 'Pieza no encontrada.' });

      const veto = verificarProhibiciones(textoPublicable(candidata));
      if (!veto.ok) {
        logger.warn('[marketingAgent] aprobación bloqueada por prohibición absoluta', {
          piezaId: id, actor, motivo: veto.motivo, coincidencia: veto.coincidencia,
        });
        return res.status(422).json({
          error: `Esta pieza no puede aprobarse: ${veto.motivo.toLowerCase()}. Corresponde rechazarla.`,
          motivo: veto.motivo,
          coincidencia: veto.coincidencia,
          bloqueada: true,
        });
      }
    }

    const pieza = await ContentPiece.findOneAndUpdate(
      { _id: id, estado: 'pendiente_aprobacion' },
      { $set: { estado: estadoNuevo, aprobadoPor: actor, aprobadoEn: new Date() } },
      { returnDocument: 'after' },   // `new: true` está deprecado en Mongoose
    );

    if (!pieza) {
      // No matcheó: o no existe, o ya no está pendiente. Distinguirlo importa —
      // "ya la resolvió otro" y "ese id no existe" se arreglan distinto.
      const existente = await ContentPiece.findById(id).lean();
      if (!existente) return res.status(404).json({ error: 'Pieza no encontrada.' });
      return res.status(409).json({
        error: `La pieza ya no está pendiente de aprobación (estado actual: ${existente.estado}).`,
        estado: existente.estado,
        aprobadoPor: existente.aprobadoPor,
        aprobadoEn: existente.aprobadoEn,
      });
    }

    // Evidencia de la revisión humana: quién, cuándo, desde dónde, sobre qué.
    // No bloquea la respuesta si el audit falla (ya se alerta a Sentry adentro).
    recordAdminAction({
      req,
      action:     accionAudit,
      targetType: 'ContentPiece',
      targetId:   pieza._id,
      before:     { estado: 'pendiente_aprobacion' },
      after:      { estado: estadoNuevo, aprobadoPor: actor },
      reason:     typeof req.body?.motivo === 'string' ? req.body.motivo : '',
      metadata:   {
        canal: pieza.canal,
        tipo: pieza.tipo,
        clasificacionFinal: pieza.clasificacionFinal,
        motivosClasificador: pieza.motivosClasificador,
        autoevaluacionRiesgo: pieza.autoevaluacionRiesgo,
      },
    }).catch(() => {});

    logger.info('[marketingAgent] pieza resuelta', {
      piezaId: pieza._id.toString(), estado: estadoNuevo, actor,
    });

    return res.status(200).json({ pieza });
  } catch (err) {
    return fail(res, err, fn, 'No se pudo actualizar el estado de la pieza.');
  }
}

/** POST /:id/aprobar — un humano da el visto bueno a una pieza de alto riesgo. */
export function aprobar(req, res) {
  return resolver(req, res, {
    estadoNuevo: 'aprobado', accionAudit: 'marketing.piece.approve', fn: 'aprobar',
    bloquearProhibidos: true,
  });
}

/** POST /:id/rechazar — un humano descarta la pieza. Body opcional: { motivo }. */
export function rechazar(req, res) {
  return resolver(req, res, {
    estadoNuevo: 'rechazado', accionAudit: 'marketing.piece.reject', fn: 'rechazar',
  });
}

// ─── GET /api/v1/admin/marketing/estado ──────────────────────────────────────

/** Salud del módulo: flag, modelo activo y conteo por estado. Para el header del panel. */
export async function estadoModulo(_req, res) {
  try {
    const porEstado = await ContentPiece.aggregate([
      { $group: { _id: '$estado', total: { $sum: 1 } } },
    ]);

    return res.status(200).json({
      habilitado: isMarketingAgentEnabled(),
      modelo: process.env.MARKETING_AGENT_MODEL || 'claude-sonnet-4-6',
      piezas: Object.fromEntries(porEstado.map(e => [e._id, e.total])),
      publicacion: {
        habilitada: isPublishEnabled(),
        // Verificado contra Meta, no solo "hay una variable seteada": un token
        // puede estar presente y muerto, y eso hoy solo se descubría al publicar.
        canales:    await estadoCanalesVerificado(),
      },
    });
  } catch (err) {
    return fail(res, err, 'estadoModulo', 'No se pudo obtener el estado del módulo.');
  }
}

// ─── POST /api/v1/admin/marketing/:id/publicar ───────────────────────────────

/** Publica una pieza aprobada en su red. Acción irreversible desde acá. */
export async function publicar(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Identificador de pieza inválido.' });
  }

  const actor = req.user?.email || String(req.user?._id || 'admin');

  try {
    const pieza = await publicarPieza(id, { actor });

    recordAdminAction({
      req,
      action:     'marketing.piece.publish',
      targetType: 'ContentPiece',
      targetId:   id,
      before:     { estado: 'aprobado/autopublicado', publicado: false },
      after:      { estado: 'publicado', postId: pieza.publicacion?.postId },
      metadata:   { canal: pieza.canal, url: pieza.publicacion?.url },
    }).catch(() => {});

    return res.status(200).json({ pieza });
  } catch (err) {
    const status = HTTP_PUBLICACION[err.code];
    if (status) {
      // Un fallo al publicar también se audita: importa saber que se intentó.
      if (status >= 500) {
        recordAdminAction({
          req,
          action:     'marketing.piece.publish',
          targetType: 'ContentPiece',
          targetId:   id,
          result:     'failure',
          errorMessage: err.message,
        }).catch(() => {});
      }
      return res.status(status).json({
        error: err.message, code: err.code,
        ...(err.postId ? { postId: err.postId, url: err.url } : {}),
      });
    }
    return fail(res, err, 'publicar', 'No se pudo publicar la pieza.');
  }
}

// ─── POST /api/v1/admin/marketing/:id/destrabar ──────────────────────────────

/** Libera una pieza trabada por un intento que no cerró. Requiere criterio humano. */
export async function destrabar(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Identificador de pieza inválido.' });
  }

  try {
    const pieza = await destrabarPieza(id, { actor: req.user?.email || 'admin' });

    recordAdminAction({
      req,
      action:     'marketing.piece.unlock',
      targetType: 'ContentPiece',
      targetId:   id,
      reason:     typeof req.body?.motivo === 'string' ? req.body.motivo : '',
      metadata:   { intentos: pieza.publicacion?.intentos },
    }).catch(() => {});

    return res.status(200).json({ pieza });
  } catch (err) {
    const status = HTTP_PUBLICACION[err.code];
    if (status) return res.status(status).json({ error: err.message, code: err.code });
    return fail(res, err, 'destrabar', 'No se pudo destrabar la pieza.');
  }
}

export default {
  generar, listarPendientes, listarPublicables, listarHistorial,
  aprobar, rechazar, estadoModulo, publicar, destrabar,
};
