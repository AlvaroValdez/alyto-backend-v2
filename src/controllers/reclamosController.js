/**
 * reclamosController.js — PRILI: Punto de Reclamo de Primera Instancia
 *
 * Fase 27 — Exigencia ASFI para licencia ETF/PSAV de AV Finance SRL.
 * Aplica a TODOS los usuarios (SpA, LLC, SRL).
 *
 * Plazos regulatorios:
 *   Acuse:    inmediato (al crear el reclamo)
 *   Respuesta: 10 días hábiles (campo plazoVence en Reclamo)
 *   Escalado:  si no hay resolución → ASFI segunda instancia
 */

import * as Sentry      from '@sentry/node'
import Reclamo          from '../models/Reclamo.js'
import Transaction      from '../models/Transaction.js'
import User             from '../models/User.js'
import { sendEmail }    from '../services/email.js'

const TIPO_ENUM = ['cobro_indebido', 'transferencia_no_recibida', 'demora', 'error_monto', 'cuenta_bloqueada', 'otro']

// ─── FUNCIÓN 1 (USER): POST /api/v1/reclamos ─────────────────────────────────

/**
 * Presenta un nuevo reclamo PRILI.
 * Multipart/form-data: tipo, descripcion, montoReclamado?, currency?,
 *   transactionId?, documentos[] (archivos opcionales, máx 3, 5 MB c/u)
 */
export async function crearReclamo(req, res) {
  try {
    const userId = req.user._id
    const { tipo, descripcion, montoReclamado, currency, transactionId } = req.body

    // ── Validaciones ────────────────────────────────────────────────────────
    if (!tipo || !TIPO_ENUM.includes(tipo)) {
      return res.status(400).json({
        error: `tipo inválido. Valores aceptados: ${TIPO_ENUM.join(', ')}`,
      })
    }
    if (!descripcion || descripcion.trim().length < 20) {
      return res.status(400).json({ error: 'descripcion debe tener al menos 20 caracteres.' })
    }
    if (descripcion.length > 1000) {
      return res.status(400).json({ error: 'descripcion supera 1000 caracteres.' })
    }

    // Verificar que la transacción (si se proporciona) pertenece al usuario
    if (transactionId) {
      const tx = await Transaction.findOne({ _id: transactionId, userId }).lean()
      if (!tx) {
        return res.status(400).json({ error: 'transactionId no válido o no pertenece al usuario.' })
      }
    }

    // ── Documentos adjuntos → base64 ─────────────────────────────────────────
    const documentos = (req.files ?? []).map(f => ({
      filename:  f.originalname,
      base64:    f.buffer.toString('base64'),
      mimetype:  f.mimetype,
      uploadedAt: new Date(),
    }))

    // ── Crear reclamo ────────────────────────────────────────────────────────
    const reclamo = await Reclamo.create({
      userId,
      transactionId:  transactionId ?? null,
      tipo,
      descripcion:    descripcion.trim(),
      montoReclamado: montoReclamado ? Number(montoReclamado) : null,
      currency:       currency ?? null,
      documentos,
    })

    // ── Emails fire-and-forget ───────────────────────────────────────────────
    const user       = await User.findById(userId).lean()
    const plazoStr   = reclamo.plazoVence?.toLocaleDateString('es-BO', { timeZone: 'America/La_Paz' }) ?? '—'

    // Confirmación al usuario
    if (user && process.env.SENDGRID_TEMPLATE_COMPLETED) {
      sendEmail(user.email, process.env.SENDGRID_TEMPLATE_COMPLETED, {
        firstName: user.firstName,
        subject:   `Reclamo recibido — ${reclamo.reclamoId}`,
        message:   `Tu reclamo fue registrado. Número: ${reclamo.reclamoId}. Te responderemos antes del ${plazoStr} (10 días hábiles).`,
      }).catch(() => {})
    }

    // Alerta al admin
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@alyto.app'
    if (process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA) {
      sendEmail(adminEmail, process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA, {
        subject: `[PRILI] Nuevo reclamo — ${reclamo.reclamoId}`,
        message: `Usuario: ${user?.email ?? userId}. Tipo: ${tipo}. Plazo ASFI: ${plazoStr}.`,
      }).catch(() => {})
    }

    return res.status(201).json({
      reclamoId:  reclamo.reclamoId,
      status:     reclamo.status,
      plazoVence: reclamo.plazoVence,
      message:    `Reclamo recibido. Te responderemos antes del ${plazoStr}.`,
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'crearReclamo' } })
    console.error('[PRILI] Error en crearReclamo:', err.message)
    return res.status(500).json({ error: 'Error al registrar el reclamo.' })
  }
}

// ─── FUNCIÓN 2 (USER): GET /api/v1/reclamos ──────────────────────────────────

/**
 * Lista los reclamos del usuario autenticado.
 * Query: status?, page?, limit?
 * NO incluye base64 de documentos.
 */
export async function listarReclamos(req, res) {
  try {
    const userId = req.user._id
    const { status, page = 1, limit = 20 } = req.query

    const filter = { userId }
    if (status) filter.status = status

    const skip  = (Number(page) - 1) * Number(limit)
    const total = await Reclamo.countDocuments(filter)
    const reclamos = await Reclamo.find(filter)
      .select('-documentos.base64')   // NO devolver base64 en listado
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean()

    return res.json({
      reclamos,
      pagination: {
        total,
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'listarReclamos' } })
    console.error('[PRILI] Error en listarReclamos:', err.message)
    return res.status(500).json({ error: 'Error al listar reclamos.' })
  }
}

// ─── FUNCIÓN 3 (USER): GET /api/v1/reclamos/:reclamoId ───────────────────────

/**
 * Detalle de un reclamo. Solo el dueño puede verlo (incluye documentos base64).
 */
export async function getReclamo(req, res) {
  try {
    const userId     = req.user._id
    const { reclamoId } = req.params

    const reclamo = await Reclamo.findOne({ reclamoId }).lean()
    if (!reclamo) {
      return res.status(404).json({ error: 'Reclamo no encontrado.' })
    }
    if (reclamo.userId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'No tienes acceso a este reclamo.' })
    }

    return res.json(reclamo)

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'getReclamo' } })
    console.error('[PRILI] Error en getReclamo:', err.message)
    return res.status(500).json({ error: 'Error al obtener el reclamo.' })
  }
}

// ─── FUNCIÓN 4 (USER): POST /api/v1/reclamos/:reclamoId/docs ─────────────────

/**
 * Agrega documentos adicionales a un reclamo existente.
 * Solo si el reclamo no está cerrado ni resuelto.
 */
export async function subirDocumentosReclamo(req, res) {
  try {
    const userId        = req.user._id
    const { reclamoId } = req.params

    const reclamo = await Reclamo.findOne({ reclamoId })
    if (!reclamo) {
      return res.status(404).json({ error: 'Reclamo no encontrado.' })
    }
    if (reclamo.userId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'No tienes acceso a este reclamo.' })
    }
    if (['cerrado', 'resuelto'].includes(reclamo.status)) {
      return res.status(400).json({ error: 'No se pueden agregar documentos a un reclamo cerrado o resuelto.' })
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se recibieron archivos.' })
    }

    const nuevosDocumentos = req.files.map(f => ({
      filename:   f.originalname,
      base64:     f.buffer.toString('base64'),
      mimetype:   f.mimetype,
      uploadedAt: new Date(),
    }))

    reclamo.documentos.push(...nuevosDocumentos)
    await reclamo.save()

    return res.json({
      reclamoId,
      documentosAgregados: nuevosDocumentos.length,
      totalDocumentos:     reclamo.documentos.length,
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'subirDocumentosReclamo' } })
    console.error('[PRILI] Error en subirDocumentosReclamo:', err.message)
    return res.status(500).json({ error: 'Error al subir documentos.' })
  }
}

// ─── FUNCIÓN 5 (ADMIN): GET /api/v1/admin/reclamos ───────────────────────────

/**
 * Lista todos los reclamos con filtros y paginación.
 * Incluye diasRestantes y flag urgente (<=2 días).
 * Ordenado por plazoVence asc (más urgentes primero).
 */
export async function adminListarReclamos(req, res) {
  try {
    const { status, tipo, userId, page = 1, limit = 20 } = req.query

    const filter = {}
    if (status) filter.status = status
    if (tipo)   filter.tipo   = tipo
    if (userId) filter.userId = userId

    const skip  = (Number(page) - 1) * Number(limit)
    const total = await Reclamo.countDocuments(filter)
    const reclamos = await Reclamo.find(filter)
      .select('-documentos.base64')
      .populate('userId', 'firstName lastName email legalEntity')
      .sort({ plazoVence: 1 })
      .skip(skip)
      .limit(Number(limit))
      .lean()

    const now = Date.now()
    const result = reclamos.map(r => {
      const diasRestantes = r.plazoVence
        ? Math.ceil((new Date(r.plazoVence).getTime() - now) / 86400000)
        : null
      return {
        ...r,
        diasRestantes,
        urgente: diasRestantes !== null && diasRestantes <= 2 &&
          !['resuelto', 'cerrado', 'escalado_asfi'].includes(r.status),
      }
    })

    return res.json({
      reclamos: result,
      pagination: {
        total,
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'adminListarReclamos' } })
    console.error('[PRILI] Error en adminListarReclamos:', err.message)
    return res.status(500).json({ error: 'Error al listar reclamos.' })
  }
}

// ─── FUNCIÓN 6 (ADMIN): GET /api/v1/admin/reclamos/vencimientos ──────────────

/**
 * Reclamos con plazoVence en los próximos 3 días.
 * Para el banner de alertas del dashboard admin.
 */
export async function adminReclamosVencimientos(req, res) {
  try {
    const now    = new Date()
    const limite = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)

    const reclamos = await Reclamo.find({
      plazoVence: { $gte: now, $lte: limite },
      status:     { $nin: ['resuelto', 'cerrado', 'escalado_asfi'] },
    })
      .select('-documentos.base64')
      .populate('userId', 'firstName lastName email')
      .sort({ plazoVence: 1 })
      .lean()

    const result = reclamos.map(r => ({
      ...r,
      diasRestantes: Math.ceil((new Date(r.plazoVence).getTime() - now.getTime()) / 86400000),
    }))

    return res.json({ vencimientos: result, total: result.length })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'adminReclamosVencimientos' } })
    console.error('[PRILI] Error en adminReclamosVencimientos:', err.message)
    return res.status(500).json({ error: 'Error al obtener vencimientos.' })
  }
}

// ─── FUNCIÓN 7 (ADMIN): GET /api/v1/admin/reclamos/:reclamoId ────────────────

/**
 * Detalle completo de un reclamo incluyendo documentos base64.
 */
export async function adminGetReclamo(req, res) {
  try {
    const { reclamoId } = req.params

    const reclamo = await Reclamo.findOne({ reclamoId })
      .populate('userId',        'firstName lastName email legalEntity')
      .populate('respondidoPor', 'firstName lastName email')
      .lean()

    if (!reclamo) {
      return res.status(404).json({ error: 'Reclamo no encontrado.' })
    }

    return res.json(reclamo)

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'adminGetReclamo' } })
    console.error('[PRILI] Error en adminGetReclamo:', err.message)
    return res.status(500).json({ error: 'Error al obtener reclamo.' })
  }
}

// ─── FUNCIÓN 8 (ADMIN): PATCH /api/v1/admin/reclamos/:reclamoId ──────────────

/**
 * Responde o actualiza el status de un reclamo.
 * Body: { status, respuesta?, internalNote?, satisfecho? }
 *
 * status:
 *   'en_revision'   → solo actualiza status
 *   'resuelto'      → requiere respuesta, notifica al usuario
 *   'escalado_asfi' → requiere respuesta, setea escaladoAt
 *   'cerrado'       → setea cerradoAt
 */
export async function adminResponderReclamo(req, res) {
  try {
    const { reclamoId }                              = req.params
    const { status, respuesta, internalNote, satisfecho } = req.body
    const admin = req.user

    const VALID_STATUS = ['en_revision', 'resuelto', 'escalado_asfi', 'cerrado']
    if (!status || !VALID_STATUS.includes(status)) {
      return res.status(400).json({
        error: `status inválido. Valores aceptados: ${VALID_STATUS.join(', ')}`,
      })
    }

    const reclamo = await Reclamo.findOne({ reclamoId })
    if (!reclamo) {
      return res.status(404).json({ error: 'Reclamo no encontrado.' })
    }
    if (reclamo.status === 'cerrado') {
      return res.status(400).json({ error: 'El reclamo ya está cerrado.' })
    }

    if (['resuelto', 'escalado_asfi'].includes(status) && !respuesta?.trim()) {
      return res.status(400).json({ error: 'El campo respuesta es obligatorio para este status.' })
    }

    const now = new Date()
    reclamo.status = status
    if (respuesta?.trim()) {
      reclamo.respuesta     = respuesta.trim()
      reclamo.respondidoPor = admin._id
      reclamo.respondidoAt  = now
    }
    if (internalNote?.trim()) reclamo.internalNote = internalNote.trim()
    if (satisfecho !== undefined) reclamo.satisfecho = satisfecho

    if (status === 'escalado_asfi') reclamo.escaladoAt = now
    if (status === 'cerrado')       reclamo.cerradoAt  = now

    await reclamo.save()

    // Notificar al usuario si se resuelve o cierra con respuesta
    if (['resuelto', 'cerrado'].includes(status) && respuesta?.trim()) {
      const usuario = await User.findById(reclamo.userId).lean()
      if (usuario && process.env.SENDGRID_TEMPLATE_COMPLETED) {
        sendEmail(usuario.email, process.env.SENDGRID_TEMPLATE_COMPLETED, {
          firstName: usuario.firstName,
          subject:   `Respuesta a tu reclamo — ${reclamo.reclamoId}`,
          message:   respuesta.trim(),
        }).catch(() => {})
      }
    }

    return res.json({
      reclamoId: reclamo.reclamoId,
      status:    reclamo.status,
      respondidoAt: reclamo.respondidoAt,
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'reclamosController', fn: 'adminResponderReclamo' } })
    console.error('[PRILI] Error en adminResponderReclamo:', err.message)
    return res.status(500).json({ error: 'Error al responder reclamo.' })
  }
}
