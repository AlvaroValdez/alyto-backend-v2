/**
 * aliasController.js — Alias público Alyto (@usuario) para transferencias P2P
 *
 * El alias es el identificador amigable para enviar USDC (y, a futuro, BOB) entre
 * usuarios Alyto sin exponer el email. Único, minúsculas, 3-20 chars.
 *
 * Endpoints (montados bajo /api/v1/wallet/alias):
 *   GET  /available?alias=  — ¿está disponible?
 *   GET  /me                — mi alias actual
 *   PUT  /                  — fijar/cambiar alias (cooldown 30 días)
 */

import Sentry from '../services/sentry.js'
import User   from '../models/User.js'

const ALIAS_RE = /^[a-z0-9_]{3,20}$/
const RESERVED = new Set([
  'admin', 'soporte', 'support', 'alyto', 'avfinance', 'av_finance', 'root',
  'system', 'sistema', 'help', 'ayuda', 'info', 'contacto', 'contact', 'oficial',
  'tesoreria', 'treasury', 'wallet', 'usdc', 'bob',
])
const CHANGE_COOLDOWN_DAYS = 30

/** Normaliza: quita @, espacios, a minúsculas. */
export function normalizeAlias(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/^@+/, '')
}

/** Valida formato + reservados. Devuelve { ok, alias } o { ok:false, error }. */
export function validateAlias(raw) {
  const alias = normalizeAlias(raw)
  if (!ALIAS_RE.test(alias)) {
    return { ok: false, error: 'El alias debe tener 3 a 20 caracteres: minúsculas, números o guion bajo.' }
  }
  if (RESERVED.has(alias)) {
    return { ok: false, error: 'Ese alias está reservado y no puede usarse.' }
  }
  return { ok: true, alias }
}

// ─── GET /api/v1/wallet/alias/available ──────────────────────────────────────

export async function checkAliasAvailable(req, res) {
  try {
    const v = validateAlias(req.query.alias)
    if (!v.ok) return res.json({ available: false, alias: normalizeAlias(req.query.alias), reason: v.error })

    const taken = await User.exists({ alytoAlias: v.alias, _id: { $ne: req.user._id } })
    return res.json({ available: !taken, alias: v.alias, reason: taken ? 'Ese alias ya está en uso.' : null })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'aliasController', fn: 'checkAliasAvailable' } })
    return res.status(500).json({ error: 'Error al verificar el alias.' })
  }
}

// ─── GET /api/v1/wallet/alias/me ─────────────────────────────────────────────

export async function getMyAlias(req, res) {
  try {
    const u = await User.findById(req.user._id).select('alytoAlias aliasUpdatedAt').lean()
    const canChangeAt = u?.aliasUpdatedAt
      ? new Date(new Date(u.aliasUpdatedAt).getTime() + CHANGE_COOLDOWN_DAYS * 86400000)
      : null
    return res.json({ alias: u?.alytoAlias ?? null, aliasUpdatedAt: u?.aliasUpdatedAt ?? null, canChangeAt })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'aliasController', fn: 'getMyAlias' } })
    return res.status(500).json({ error: 'Error al obtener el alias.' })
  }
}

// ─── PUT /api/v1/wallet/alias ────────────────────────────────────────────────

export async function setAlias(req, res) {
  try {
    const v = validateAlias(req.body.alias)
    if (!v.ok) return res.status(400).json({ error: v.error })

    const current = await User.findById(req.user._id).select('alytoAlias aliasUpdatedAt').lean()

    // Sin cambios
    if (current?.alytoAlias === v.alias) {
      return res.json({ alias: v.alias, changed: false })
    }

    // Cooldown de cambios (no aplica a la primera vez que se fija)
    if (current?.alytoAlias && current?.aliasUpdatedAt) {
      const nextAllowed = new Date(current.aliasUpdatedAt).getTime() + CHANGE_COOLDOWN_DAYS * 86400000
      if (Date.now() < nextAllowed) {
        return res.status(429).json({
          error: `Solo podés cambiar tu alias cada ${CHANGE_COOLDOWN_DAYS} días.`,
          canChangeAt: new Date(nextAllowed),
        })
      }
    }

    // Unicidad
    const taken = await User.exists({ alytoAlias: v.alias, _id: { $ne: req.user._id } })
    if (taken) return res.status(409).json({ error: 'Ese alias ya está en uso.' })

    try {
      await User.updateOne({ _id: req.user._id }, { alytoAlias: v.alias, aliasUpdatedAt: new Date() })
    } catch (e) {
      if (e?.code === 11000) return res.status(409).json({ error: 'Ese alias ya está en uso.' })
      throw e
    }

    return res.json({ alias: v.alias, changed: true })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'aliasController', fn: 'setAlias' } })
    return res.status(500).json({ error: 'Error al fijar el alias.' })
  }
}
