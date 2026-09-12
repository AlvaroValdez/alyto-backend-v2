/**
 * limitRejectionService.js — Registro persistente de rechazos por límite del ECP.
 *
 * Función canónica que convierte un `violation` de `ecpLimits.evaluateEcpLimits` en un
 * asiento `LimitRejection` consultable. Se invoca en el punto donde el sistema rechaza
 * la operación por exceso de límite, ANTES de crearla.
 *
 * Confiabilidad: NUNCA lanza. El rechazo hacia el usuario (HTTP 409) ya está decidido;
 * un fallo al persistir el asiento se registra en logs + Sentry pero no convierte un
 * rechazo legítimo en un error 500. Mismo criterio que recordAdminAction sin session.
 */

import * as Sentry from '@sentry/node'
import LimitRejection from '../models/LimitRejection.js'
import { logger } from '../utils/logger.js'

/** Extrae la IP real del request (respeta x-forwarded-for del proxy). */
function ipFromReq(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    ?? req?.ip
    ?? ''
}

/** Convierte un número a `Number` o null (evita NaN/undefined en el asiento). */
function num(v) {
  return Number.isFinite(v) ? v : null
}

/**
 * Construye el asiento a partir del violation y el contexto de la operación.
 * Función pura, para poder probar el mapeo sin base de datos.
 *
 * @param {object} p
 * @param {object} p.violation   — de evaluateEcpLimits: {code,scope,unit,limit,used,requested,remaining}
 * @param {number} [p.amountBOB]
 * @param {object} [p.corridor]  — TransactionConfig del corredor
 * @param {object} [p.user]      — req.user
 * @param {string} [p.ip]
 * @param {string} [p.userAgent]
 */
export function buildLimitRejectionRecord({ violation, amountBOB, corridor, user, ip, userAgent } = {}) {
  const v = violation ?? {}
  return {
    code:      v.code ?? 'ECP_LIMIT_REJECTED',
    scope:     v.scope ?? '',
    unit:      v.unit ?? '',
    limit:     num(v.limit),
    used:      num(v.used),
    requested: num(v.requested),
    remaining: num(v.remaining),

    amountBOB:          num(amountBOB),
    legalEntity:        user?.legalEntity ?? '',
    corridorCode:       corridor?.corridorId ?? '',
    corridorId:         corridor?._id ?? undefined,
    destinationCountry: corridor?.destinationCountry ?? '',

    userId:    user?._id ?? undefined,
    ip:        ip ?? '',
    userAgent: userAgent ?? '',
  }
}

/**
 * Persiste el rechazo por límite. Devuelve el documento creado, o null si falló.
 * No lanza nunca.
 *
 * @param {object} p
 * @param {import('express').Request} [p.req]  — de aquí salen user, ip, userAgent
 * @param {object} p.violation
 * @param {number} [p.amountBOB]
 * @param {object} [p.corridor]
 * @returns {Promise<object|null>}
 */
export async function recordEcpRejection({ req, violation, amountBOB, corridor } = {}) {
  const record = buildLimitRejectionRecord({
    violation,
    amountBOB,
    corridor,
    user:      req?.user,
    ip:        ipFromReq(req),
    userAgent: req?.headers?.['user-agent'] ?? '',
  })

  try {
    return await LimitRejection.create(record)
  } catch (err) {
    logger.error('[ECP] No se pudo persistir el rechazo por límite', {
      code: record.code, err: err.message,
    })
    Sentry.captureException(err, { tags: { service: 'limitRejection', code: record.code } })
    return null
  }
}

export default { buildLimitRejectionRecord, recordEcpRejection }
