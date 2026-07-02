/**
 * checkSanctions.js — Middleware de verificación de sanciones AML
 *
 * Fase 28 — ASFI Bolivia. Verifica que el usuario autenticado no esté
 * en ninguna lista de sanciones (OFAC, ONU, UIF Bolivia, PEPs).
 *
 * Comportamiento:
 *   - Hit confirmado  → 403 SANCTIONS_HIT (bloquea la operación)
 *   - Error de servicio:
 *       · PRODUCCIÓN → 503 SCREENING_UNAVAILABLE (FAIL-CLOSED, endurecido 2026-07).
 *         Un screening que "deja pasar ante error" permitiría evadir el control AML
 *         provocando el error. La SanctionsList vive en el mismo MongoDB que las
 *         transacciones: si el screening falla, la operación tampoco habría podido
 *         persistirse — el costo de disponibilidad es casi nulo. El cliente puede
 *         reintentar (503 = transitorio).
 *       · DEV/TEST → deja pasar + registra en Sentry (no fricciona desarrollo)
 *
 * Uso:
 *   router.post('/crossborder', protect, checkSanctions, initCrossBorderPayment)
 */

import * as Sentry from '@sentry/node'
import { screenUser } from '../services/sanctionsService.js'
import User from '../models/User.js'

const SCREENING_UNAVAILABLE_RESPONSE = {
  error:   'Servicio temporalmente no disponible.',
  message: 'No pudimos completar la verificación de seguridad. Intenta nuevamente en unos minutos.',
  code:    'SCREENING_UNAVAILABLE',
}

function isFailClosed() {
  return process.env.NODE_ENV === 'production'
}

export async function checkSanctions(req, res, next) {
  try {
    const user = req.user
    if (!user) return next()

    // protect() no incluye identityDocument en su .select() — sin esta lectura
    // el screening corría SIEMPRE solo por nombre (audit 2026-06-11).
    let documentNumber = user.identityDocument?.number
    if (!documentNumber && user._id) {
      const docUser = await User.findById(user._id).select('identityDocument.number').lean()
      documentNumber = docUser?.identityDocument?.number
    }

    const result = await screenUser({
      firstName:      user.firstName,
      lastName:       user.lastName,
      documentNumber,
    })

    // screenUser traga errores internamente y devuelve { isClean:true, error } —
    // ese "clean" NO es un screening real. En producción: fail-closed.
    if (result.error && isFailClosed()) {
      console.error('[Sanctions] Screening falló (interno) — FAIL-CLOSED en producción:', {
        userId: user._id?.toString(),
        error:  result.error,
      })
      return res.status(503).json(SCREENING_UNAVAILABLE_RESPONSE)
    }

    if (!result.isClean) {
      console.warn('[Sanctions] ⛔ Usuario bloqueado por lista de sanciones:', {
        userId: user._id?.toString(),
        email:  user.email,
        hits:   result.hits.map(h => `${h.entryId} (${h.listSource})`),
      })
      return res.status(403).json({
        error:   'Operación no permitida.',
        message: 'Tu cuenta no puede realizar esta operación en este momento. Contacta a soporte.',
        code:    'SANCTIONS_HIT',
      })
    }

    // Adjuntar resultado al request para auditoría en el controlador
    req.sanctionsResult = result
    next()

  } catch (err) {
    // Error inesperado en el middleware — siempre reportar (audit 2026-06-11).
    console.error('[Sanctions] Error en middleware checkSanctions:', err.message)
    Sentry.captureException(err, { tags: { middleware: 'checkSanctions' } })

    // PRODUCCIÓN → FAIL-CLOSED (503 retryable). DEV/TEST → fail-open.
    if (isFailClosed()) {
      return res.status(503).json(SCREENING_UNAVAILABLE_RESPONSE)
    }
    next()
  }
}
