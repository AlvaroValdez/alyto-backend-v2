/**
 * accessLogService.js — Registro de accesos y bloqueo por intentos fallidos.
 *
 * Cubre el Artículo 2°, inciso d, Sección 4 del Reglamento para ETF. Ver el
 * encabezado de models/AccessLog.js para el detalle de qué cubre cada parte.
 *
 * Dos responsabilidades, deliberadamente juntas porque comparten el mismo evento:
 *   1. dejar constancia de cada intento de acceso, exitoso o no;
 *   2. contar los fallos por cuenta y bloquearla temporalmente al superar el umbral.
 *
 * La constancia NUNCA hace fallar el login: si la escritura del registro falla,
 * se loguea y se continúa. Pero el CONTADOR sí se espera, porque de él depende el
 * bloqueo y un contador que se pierde deja la puerta abierta.
 */

import AccessLog from '../models/AccessLog.js'
import User      from '../models/User.js'
import { logger } from '../utils/logger.js'

/**
 * Intentos fallidos consecutivos antes de bloquear. Se lee dentro de la función
 * (regla 21: nunca capturar env en el ámbito de módulo, o se toma el valor
 * anterior a la carga de secretos).
 */
export function maxFailedAttempts() {
  const raw = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5
}

/** Duración del bloqueo, en minutos. */
export function lockoutMinutes() {
  const raw = Number(process.env.AUTH_LOCKOUT_MINUTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 15
}

/**
 * ¿La cuenta está bloqueada en este momento?
 *
 * Función pura para poder probarla sin base de datos.
 *
 * @param {{ lockedUntil?: Date|string|null }} user
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isLockedOut(user, now = new Date()) {
  if (!user?.lockedUntil) return false
  return new Date(user.lockedUntil) > now
}

/**
 * Decide el estado de bloqueo tras un intento fallido.
 *
 * Pura y testeable: recibe la racha previa y devuelve la nueva racha y, si
 * corresponde, hasta cuándo bloquear. El llamador persiste el resultado.
 *
 * @param {number} previousStreak  — fallos consecutivos antes de este intento
 * @param {Date}   now
 * @returns {{ streak: number, lockedUntil: Date|null }}
 */
export function nextLockoutState(previousStreak, now = new Date()) {
  const streak = Math.max(0, Number(previousStreak) || 0) + 1
  if (streak < maxFailedAttempts()) return { streak, lockedUntil: null }
  return { streak, lockedUntil: new Date(now.getTime() + lockoutMinutes() * 60_000) }
}

/** Extrae IP y agente sin depender de la forma exacta del request. */
function requestContext(req) {
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    ?? req?.ip
    ?? req?.connection?.remoteAddress
    ?? null
  const ua = req?.headers?.['user-agent'] ?? null
  return { ip, userAgent: ua ? String(ua).slice(0, 300) : null }
}

/**
 * Deja constancia de un intento de acceso. No lanza nunca.
 *
 * @param {object} p
 * @param {object} [p.req]
 * @param {string} p.email
 * @param {'success'|'failed'|'blocked'} p.outcome
 * @param {string|null} [p.reason]
 * @param {object|null} [p.user]         — documento del usuario, si se resolvió
 * @param {number} [p.failedStreak]
 */
export async function recordAccess({ req, email, outcome, reason = null, user = null, failedStreak = 0 }) {
  try {
    const { ip, userAgent } = requestContext(req)
    await AccessLog.create({
      userId: user?._id ?? null,
      email:  String(email ?? '').toLowerCase().trim(),
      outcome,
      reason,
      role:   user?.role ?? null,
      ip,
      userAgent,
      failedStreak,
    })
  } catch (err) {
    // Un fallo al registrar no puede impedir ni conceder un acceso. Se avisa alto
    // porque implica que, mientras dure, se está perdiendo evidencia exigida.
    logger.error('[accessLog] No se pudo registrar el intento de acceso', {
      outcome, reason, error: err.message,
    })
  }
}

/**
 * Registra un intento fallido y actualiza el contador de la cuenta.
 *
 * @returns {Promise<{ streak: number, lockedUntil: Date|null }>}
 */
export async function registerFailedAttempt({ req, email, reason, user }) {
  let state = { streak: 0, lockedUntil: null }

  if (user?._id) {
    state = nextLockoutState(user.failedLoginAttempts ?? 0)
    try {
      await User.updateOne(
        { _id: user._id },
        { $set: { failedLoginAttempts: state.streak, lockedUntil: state.lockedUntil } },
      )
    } catch (err) {
      logger.error('[accessLog] No se pudo actualizar el contador de fallos', { error: err.message })
    }
  }

  await recordAccess({ req, email, outcome: 'failed', reason, user, failedStreak: state.streak })
  return state
}

/** Registra un acceso exitoso y limpia el contador de fallos. */
export async function registerSuccess({ req, email, user }) {
  if (user?._id && ((user.failedLoginAttempts ?? 0) > 0 || user.lockedUntil)) {
    try {
      await User.updateOne(
        { _id: user._id },
        { $set: { failedLoginAttempts: 0, lockedUntil: null } },
      )
    } catch (err) {
      logger.error('[accessLog] No se pudo limpiar el contador de fallos', { error: err.message })
    }
  }
  await recordAccess({ req, email, outcome: 'success', user, failedStreak: 0 })
}

/** Registra un intento rechazado por bloqueo vigente. */
export async function registerBlocked({ req, email, user }) {
  await recordAccess({
    req, email, outcome: 'blocked', reason: 'locked_out', user,
    failedStreak: user?.failedLoginAttempts ?? 0,
  })
}

export default {
  recordAccess, registerFailedAttempt, registerSuccess, registerBlocked,
  isLockedOut, nextLockoutState, maxFailedAttempts, lockoutMinutes,
}
