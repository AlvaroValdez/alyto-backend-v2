/**
 * checkSanctions.js — Middleware de verificación de sanciones AML
 *
 * Fase 28 — ASFI Bolivia. Verifica que el usuario autenticado no esté
 * en ninguna lista de sanciones (OFAC, ONU, UIF Bolivia, PEPs).
 *
 * Comportamiento:
 *   - Hit confirmado  → 403 SANCTIONS_HIT (bloquea la operación)
 *   - Error de servicio → deja pasar + registra en Sentry (no bloquear flujo)
 *
 * Uso:
 *   router.post('/crossborder', protect, checkSanctions, initCrossBorderPayment)
 */

import * as Sentry from '@sentry/node'
import { screenUser } from '../services/sanctionsService.js'
import User from '../models/User.js'

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
    // Error inesperado en el middleware: no bloquear flujo, pero SÍ reportar —
    // un fallo sostenido del screening AML debe ser visible (audit 2026-06-11).
    console.error('[Sanctions] Error en middleware checkSanctions:', err.message)
    Sentry.captureException(err, { tags: { middleware: 'checkSanctions' } })
    next()
  }
}
