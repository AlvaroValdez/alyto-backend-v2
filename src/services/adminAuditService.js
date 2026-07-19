/**
 * adminAuditService.js — Auditoría de acciones sensibles del admin.
 *
 * Función canónica: recordAdminAction(). Todo endpoint que MUTE estado desde el
 * panel admin (congelamiento, fees, límites, etc.) la llama para dejar registro de
 * quién/qué/cuándo/valor anterior y nuevo (spec §5).
 *
 * La lógica pura (redacción de secretos + normalización del registro) se separa y
 * se testea en tests/unit/adminAudit.test.js — un audit que filtre una secretKey o
 * que pierda el snapshot del actor es un fallo silencioso costoso.
 */

import AdminAuditLog from '../models/AdminAuditLog.js'
import { logger }    from '../utils/logger.js'
import * as Sentry   from '@sentry/node'

// ═══════════════════════════════════════════════════════════════════════════
// LÓGICA PURA (testeable sin DB)
// ═══════════════════════════════════════════════════════════════════════════

/** Substrings de nombre de campo que NUNCA deben persistirse en el audit. */
const SENSITIVE_KEY_PATTERNS = [
  'secret', 'password', 'passwd', 'token', 'aeskey', 'aes_key', 'apikey', 'api_key',
  'privatekey', 'private_key', 'seed', 'mnemonic', 'ciphertext', 'jwt', 'signingkey',
  'signing_key', 'credential',
]

function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[_-]/g, '')
  return SENSITIVE_KEY_PATTERNS.some(p => k.includes(p.replace(/[_-]/g, '')))
}

/**
 * Devuelve una copia de `value` con cualquier campo sensible reemplazado por
 * '[REDACTED]'. Recursivo sobre objetos y arrays, con tope de profundidad para
 * evitar recursión infinita ante estructuras cíclicas o muy anidadas.
 *
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
export function redactSensitive(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]'
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(v => redactSensitive(v, depth + 1))
  if (typeof value === 'object') {
    // No intentar clonar tipos especiales (Date, ObjectId, Buffer) — devolver string.
    if (value instanceof Date) return value.toISOString()
    if (typeof value.toHexString === 'function') return value.toHexString()   // ObjectId
    if (Buffer.isBuffer(value)) return '[BUFFER]'
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactSensitive(v, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Normaliza los datos de una acción admin al documento que se persiste.
 * Redacta before/after/metadata y toma snapshot del actor. Función pura.
 *
 * @param {object} p
 * @param {{_id?:any, email?:string, role?:string}} [p.actor]
 * @param {string} p.action
 * @param {string} [p.targetType]
 * @param {string|number} [p.targetId]
 * @param {*} [p.before]
 * @param {*} [p.after]
 * @param {string} [p.reason]
 * @param {object} [p.metadata]
 * @param {string} [p.ip]
 * @param {string} [p.userAgent]
 * @param {'success'|'failure'} [p.result]
 * @param {string} [p.errorMessage]
 * @returns {object}
 */
export function buildAuditRecord({
  actor = {}, action, targetType = '', targetId = '',
  before = null, after = null, reason = '', metadata = {},
  ip = '', userAgent = '', result = 'success', errorMessage = '',
}) {
  if (!action) throw new Error('buildAuditRecord: action es requerido')
  return {
    actorId:      actor?._id ?? null,
    actorEmail:   actor?.email ?? '',
    actorRole:    actor?.role ?? '',
    action,
    targetType,
    targetId:     targetId != null ? String(targetId) : '',
    before:       redactSensitive(before),
    after:        redactSensitive(after),
    reason:       reason ?? '',
    metadata:     redactSensitive(metadata ?? {}),
    ip,
    userAgent,
    result,
    errorMessage: errorMessage ?? '',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// I/O
// ═══════════════════════════════════════════════════════════════════════════

/** Extrae la IP real del request (respeta x-forwarded-for del proxy). */
function ipFromReq(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    ?? req?.ip
    ?? ''
}

/**
 * Registra una acción sensible del admin. Función canónica para todos los
 * endpoints que mutan estado desde el panel.
 *
 * Confiabilidad: si se pasa una `session` (Mongoose), el audit se escribe dentro de
 * la misma transacción que la mutación (ambos commitean o ninguno) — recomendado
 * para acciones críticas como el congelamiento. Sin session, un fallo al escribir el
 * audit se registra en logs + Sentry pero NO revierte la mutación ya aplicada (no se
 * bloquea la operación por un fallo de auditoría; se alerta para no perder el rastro).
 *
 * @param {object} p
 * @param {import('express').Request} [p.req]  — de aquí salen actor, ip, userAgent
 * @param {object} [p.actor]                   — override del actor si no hay req
 * @param {import('mongoose').ClientSession} [p.session]
 * @param {string} p.action
 * @param {string} [p.targetType]
 * @param {string|number} [p.targetId]
 * @param {*} [p.before]
 * @param {*} [p.after]
 * @param {string} [p.reason]
 * @param {object} [p.metadata]
 * @param {'success'|'failure'} [p.result]
 * @param {string} [p.errorMessage]
 * @returns {Promise<object|null>} el documento creado, o null si falló (sin session)
 */
export async function recordAdminAction({ req, actor, session, ...rest }) {
  const record = buildAuditRecord({
    actor:     actor ?? req?.user,
    ip:        rest.ip ?? ipFromReq(req),
    userAgent: rest.userAgent ?? req?.headers?.['user-agent'] ?? '',
    ...rest,
  })

  try {
    const [doc] = await AdminAuditLog.create([record], session ? { session } : {})
    return doc
  } catch (err) {
    // Con session: propagar para que la transacción de la mutación aborte también.
    if (session) throw err
    // Sin session: la mutación ya se aplicó — alertar, no romper la operación.
    logger.error('[adminAudit] No se pudo escribir el registro de auditoría', {
      action: record.action, targetType: record.targetType, err: err.message,
    })
    Sentry.captureException(err, { tags: { service: 'adminAudit', action: record.action } })
    return null
  }
}

/**
 * Lista registros de auditoría con filtros y paginación (para que el panel sea
 * auditable — spec §5).
 *
 * @param {object} f
 * @param {string} [f.action]
 * @param {string} [f.actorId]
 * @param {string} [f.targetType]
 * @param {string} [f.targetId]
 * @param {string} [f.from]  — ISO date
 * @param {string} [f.to]    — ISO date
 * @param {number} [f.page]
 * @param {number} [f.limit]
 * @returns {Promise<{logs:Array, pagination:object}>}
 */
export async function listAuditLogs({ action, actorId, targetType, targetId, from, to, page = 1, limit = 50 } = {}) {
  const filter = {}
  if (action)     filter.action     = action
  if (actorId)    filter.actorId    = actorId
  if (targetType) filter.targetType = targetType
  if (targetId)   filter.targetId   = targetId
  if (from || to) {
    filter.createdAt = {}
    if (from) filter.createdAt.$gte = new Date(from)
    if (to)   filter.createdAt.$lte = new Date(to)
  }

  const lim  = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const pg   = Math.max(parseInt(page, 10) || 1, 1)
  const skip = (pg - 1) * lim

  const [logs, total] = await Promise.all([
    AdminAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    AdminAuditLog.countDocuments(filter),
  ])

  return {
    logs,
    pagination: { page: pg, limit: lim, total, pages: Math.ceil(total / lim) },
  }
}
