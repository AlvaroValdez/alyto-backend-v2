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
import { tokens, coincideAlgunaVariante, normalizarDocumento } from '../utils/sanctionsMatch.js'

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
 * Escapa metacaracteres de regex en input de usuario antes de usarlo en $regex.
 * Sin esto, un nombre con regex maligno causa ReDoS o degrada el match AML.
 */
function escapeRegex(str = '') {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    const tConsulta = tokens([firstName, lastName].filter(Boolean).join(' '))
    const docNorm   = normalizarDocumento(documentNumber ?? '')

    const or = []
    // Por documento: exacto, es la senal fuerte. Se consulta normalizado y crudo
    // porque las entradas antiguas no tienen el campo normalizado.
    if (docNorm) {
      or.push({ documentsNormalized: docNorm })
      or.push({ documentNumbers: documentNumber.trim() })
    }
    // Por nombre: la entrada tiene que contener TODOS los tokens del consultado.
    // $all sobre un array indexado: ni regex ni recorrido de la coleccion.
    if (tConsulta.length >= 2) {
      or.push({ nameTokens: { $all: tConsulta } })
    }

    if (or.length === 0) {
      return { isClean: true, hits: [], screenedAt: new Date() }
    }

    const candidatos = await SanctionsList.find({ isActive: true, $or: or })
      .select('entryId fullName listSource reason type documentNumbers documentsNormalized nameTokens nameVariants')
      .limit(50)
      .lean()

    // Confirmacion. El acierto por documento es inapelable. El de nombre se
    // vuelve a comprobar aqui para que la regla viva en un solo sitio
    // (utils/sanctionsMatch) y sea testeable sin base de datos.
    // Cada acierto se etiqueta con COMO coincidio, porque la politica depende de
    // eso: el documento es exacto y bloquea; el nombre no identifica por si solo
    // y va a revision humana. Ver checkSanctions.
    const confirmados = []
    for (const hit of candidatos) {
      const porDocumento = !!docNorm && (
        hit.documentsNormalized?.includes(docNorm) ||
        hit.documentNumbers?.includes(documentNumber.trim())
      )
      if (porDocumento) { confirmados.push({ ...hit, matchType: 'document' }); continue }
      // Variante a variante, nunca contra la bolsa comun de tokens.
      const variantes = hit.nameVariants?.length ? hit.nameVariants : [hit.fullName]
      if (coincideAlgunaVariante(tConsulta, variantes)) {
        confirmados.push({ ...hit, matchType: 'name' })
      }
    }

    return {
      isClean:    confirmados.length === 0,
      hits:       confirmados,
      // Atajo para quien decide: ¿hay algun acierto por documento?
      hasDocumentMatch: confirmados.some(h => h.matchType === 'document'),
      screenedAt: new Date(),
    }

  } catch (err) {
    console.error('[Sanctions] Error en screenUser:', err.message)
    Sentry.captureException(err, { tags: { service: 'sanctionsService', fn: 'screenUser' } })
    // Se devuelve `error`: checkSanctions lo convierte en 503 (fail-closed) en
    // produccion. Este "clean" NO es un cribado real.
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
