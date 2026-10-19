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
import ROSAlert from '../models/ROSAlert.js'
import { readDocumentNumber } from '../utils/clientDocument.js'
import { ensureDek, isPiiEncryptionEnabled } from '../services/piiCrypto.js'

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
    // El CI se descifra vía readDocumentNumber (numberCiphertext, select:false).
    let documentNumber = null
    try { documentNumber = readDocumentNumber(user) } catch { documentNumber = null }
    if (!documentNumber && user._id) {
      const docUser = await User.findById(user._id)
        .select('identityDocument.number +identityDocument.numberCiphertext').lean()
      if (isPiiEncryptionEnabled()) { try { await ensureDek() } catch { /* cae a solo-nombre */ } }
      try { documentNumber = readDocumentNumber(docUser) } catch { documentNumber = null }
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

    // ── Politica de aciertos ────────────────────────────────────────────────
    //
    // Bloquea SOLO el acierto por documento. El acierto por nombre genera una
    // alerta y deja pasar.
    //
    // No es laxitud, es lo unico viable: medido contra las listas reales de
    // OFAC y ONU, 1 de cada 23 usuarios de la base casa por nombre con un ALIAS
    // de la lista. Nombres hispanos corrientes colisionan de verdad: "CASTRO,
    // Jorge" figura tal cual como alias del SDN. Bloquear por eso dejaria sin
    // operar a gente legitima, sin recurso y con un mensaje que solo dice
    // "contacta a soporte". El documento, en cambio, identifica.
    // Se deja pasar UNICAMENTE si consta que todos los aciertos son por nombre.
    // Un acierto sin etiquetar es de procedencia desconocida y bloquea: ante la
    // duda, un control de seguridad tiene que cerrarse, no abrirse.
    const soloPorNombre = !result.isClean
      && !result.hasDocumentMatch
      && result.hits.length > 0
      && result.hits.every(h => h.matchType === 'name')

    if (soloPorNombre) {
      const porNombre = result.hits
      console.warn('[Sanctions] ⚠️ Coincidencia por NOMBRE — pasa a revision, no bloquea:', {
        userId: user._id?.toString(),
        hits:   porNombre.map(h => `${h.entryId} (${h.listSource})`),
      })
      // La alerta no debe tumbar la operacion si falla: se registra aparte.
      registrarAlertaNombre(user, porNombre).catch(err =>
        Sentry.captureException(err, { tags: { middleware: 'checkSanctions', fn: 'alerta' } }))
      req.sanctionsResult = result
      return next()
    }

    if (!result.isClean) {
      console.warn('[Sanctions] ⛔ Usuario bloqueado por DOCUMENTO en lista de sanciones:', {
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

/**
 * Deja constancia de una coincidencia por nombre para que la revise un humano.
 *
 * Una alerta por usuario y conjunto de entradas, no una por operacion: el
 * cribado corre en cada deposito, envio y retiro, y sin este control un solo
 * usuario con un apellido frecuente generaria cientos de alertas al dia y
 * enterraria las que importan.
 */
async function registrarAlertaNombre(user, hits) {
  if (!user?._id || !hits?.length) return
  const entryIds = hits.map(h => h.entryId).sort()

  // Si ya hay una alerta abierta para este usuario con las MISMAS entradas, se
  // actualiza la fecha en vez de crear otra.
  const existente = await ROSAlert.findOne({
    userId: user._id,
    rule:   'sanctions_name_match',
    status: 'open',
    'details.entryIds': entryIds,
  }).select('_id').lean()

  if (existente) {
    await ROSAlert.updateOne({ _id: existente._id }, { $set: { updatedAt: new Date() } })
    return
  }

  await ROSAlert.create({
    userId:   user._id,
    rule:     'sanctions_name_match',
    severity: 'high',
    source:   'sanctions',
    details: {
      entryIds,
      coincidencias: hits.map(h => ({
        entryId: h.entryId, fullName: h.fullName, listSource: h.listSource, reason: h.reason ?? null,
      })),
      nombreConsultado: [user.firstName, user.lastName].filter(Boolean).join(' '),
      nota: 'Coincidencia solo por NOMBRE. No identifica por si sola: verificar documento, fecha de nacimiento y nacionalidad antes de actuar.',
    },
  })
}
