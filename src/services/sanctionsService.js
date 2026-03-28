/**
 * sanctionsService.js — Escaneo de sanciones OFAC / ONU / UIF Bolivia
 *
 * Fase 28 — Compliance AML (ASFI Bolivia).
 *
 * Implementación: lista local MongoDB. En caso de error → dejar pasar
 * y registrar en Sentry para revisión manual (no bloquear flujo de pago).
 *
 * Ruta de actualización: reemplazar búsqueda MongoDB por llamada a API
 * de proveedor especializado (ComplyAdvantage, Refinitiv World-Check, etc.)
 */

import * as Sentry   from '@sentry/node'
import SanctionsList from '../models/SanctionsList.js'

/**
 * Normaliza un string para comparación:
 * minúsculas, sin tildes, sin caracteres especiales.
 */
function normalize(str = '') {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

/**
 * Verifica si un usuario está en la lista de sanciones.
 * Busca por nombre completo, aliases y número de documento.
 *
 * @param {{ firstName?, lastName?, documentNumber? }} data
 * @returns {Promise<{ isClean: boolean, hits: Array, screenedAt: Date, error?: string }>}
 */
export async function screenUser({ firstName, lastName, documentNumber } = {}) {
  try {
    const orConditions = []

    if (firstName?.trim()) {
      orConditions.push(
        { fullName: { $regex: firstName.trim(), $options: 'i' } },
        { aliases:  { $elemMatch: { $regex: firstName.trim(), $options: 'i' } } },
      )
    }
    if (lastName?.trim()) {
      orConditions.push(
        { fullName: { $regex: lastName.trim(), $options: 'i' } },
      )
    }
    if (documentNumber?.trim()) {
      orConditions.push({ documentNumbers: documentNumber.trim() })
    }

    if (orConditions.length === 0) {
      return { isClean: true, hits: [], screenedAt: new Date() }
    }

    const hits = await SanctionsList.find({ isActive: true, $or: orConditions })
      .select('entryId fullName listSource reason type documentNumbers')
      .lean()

    // Filtro adicional para reducir falsos positivos:
    // - Hits por documento exacto → siempre confirmados (match preciso, sin ambigüedad)
    // - Hits por nombre/alias → requieren que al menos firstName o lastName aparezca en fullName
    const docQuery = documentNumber?.trim()
    const confirmed = hits.filter(hit => {
      if (docQuery && hit.documentNumbers?.includes(docQuery)) return true
      const hitName = normalize(hit.fullName)
      const hasFirst = !firstName || hitName.includes(normalize(firstName))
      const hasLast  = !lastName  || hitName.includes(normalize(lastName))
      return hasFirst || hasLast
    })

    return {
      isClean:    confirmed.length === 0,
      hits:       confirmed,
      screenedAt: new Date(),
    }

  } catch (err) {
    console.error('[Sanctions] Error en screenUser:', err.message)
    Sentry.captureException(err, { tags: { service: 'sanctionsService', fn: 'screenUser' } })
    // En caso de error: retornar clean para no bloquear flujo
    // Sentry registra para revisión manual del Oficial de Cumplimiento
    return { isClean: true, hits: [], screenedAt: new Date(), error: err.message }
  }
}

/**
 * Verifica si un número de documento está en la lista.
 * Más rápido y preciso que la búsqueda por nombre.
 *
 * @param {string} documentNumber
 * @returns {Promise<{ isClean: boolean, hits: Array, screenedAt: Date }>}
 */
export async function screenDocument(documentNumber) {
  if (!documentNumber?.trim()) {
    return { isClean: true, hits: [], screenedAt: new Date() }
  }

  try {
    const hits = await SanctionsList.find({
      isActive:        true,
      documentNumbers: documentNumber.trim(),
    }).select('entryId fullName listSource reason').lean()

    return { isClean: hits.length === 0, hits, screenedAt: new Date() }

  } catch (err) {
    Sentry.captureException(err, { tags: { service: 'sanctionsService', fn: 'screenDocument' } })
    return { isClean: true, hits: [], screenedAt: new Date(), error: err.message }
  }
}
