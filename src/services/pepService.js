/**
 * pepService.js — Identificación de PEP y clasificación de riesgo.
 *
 * Una Persona Expuesta Políticamente no es un delincuente y NO debe excluirse:
 * lo que obliga es a diligencia REFORZADA. Por eso nada de este módulo bloquea
 * operaciones. Clasifica el riesgo y abre una revisión.
 *
 * DOS FUENTES, Y LA PRIMARIA ES LA DECLARACIÓN
 *
 * 1. Declaración del propio usuario en el alta.
 * 2. Coincidencia contra entradas con `listSource:'PEP'` en `sanctionslists`.
 *
 * La declaración va primera a propósito. No existe lista pública fiable de PEPs
 * bolivianos: las seguras son de pago (ComplyAdvantage, Refinitiv, Dow Jones) y
 * las gratuitas son parciales o tienen licencia no comercial. Construir el
 * control sobre una lista vacía sería declarar un control que no existe, que es
 * exactamente el problema que tenía el cribado de sanciones antes del 19-oct.
 *
 * La lista queda soportada para cuando se contrate una: el importador y el
 * comparador ya la admiten, y el día que entre, este módulo la usa sin cambios.
 */

import SanctionsList from '../models/SanctionsList.js'
import { tokens, coincideAlgunaVariante, normalizarDocumento } from '../utils/sanctionsMatch.js'
import { logger } from '../utils/logger.js'

/** Relaciones admitidas en la declaración. */
export const RELACIONES_PEP = ['self', 'family', 'associate']

/**
 * ¿Coincide el usuario con alguna entrada de la lista de PEP?
 *
 * Deliberadamente SEPARADO del cribado de sanciones: un acierto de PEP clasifica
 * riesgo, uno de sanciones puede bloquear. Mezclarlos haría que una coincidencia
 * de PEP generase una alerta rotulada como sanción, y el Oficial de Cumplimiento
 * leería un expediente equivocado.
 */
export async function buscarEnListaPep({ firstName, lastName, documentNumber } = {}) {
  try {
    const tConsulta = tokens([firstName, lastName].filter(Boolean).join(' '))
    const docNorm   = normalizarDocumento(documentNumber ?? '')

    const or = []
    if (docNorm) or.push({ documentsNormalized: docNorm })
    if (tConsulta.length >= 2) or.push({ nameTokens: { $all: tConsulta } })
    if (or.length === 0) return { hit: false, entradas: [] }

    const candidatos = await SanctionsList.find({ isActive: true, listSource: 'PEP', $or: or })
      .select('entryId fullName nameVariants documentsNormalized reason')
      .limit(25)
      .lean()

    const confirmadas = candidatos.filter(e =>
      (docNorm && e.documentsNormalized?.includes(docNorm)) ||
      coincideAlgunaVariante(tConsulta, e.nameVariants?.length ? e.nameVariants : [e.fullName]))

    return { hit: confirmadas.length > 0, entradas: confirmadas }
  } catch (err) {
    // No se traga el error en silencio: quien llama decide, pero queda el rastro.
    logger.error('[PEP] Fallo al consultar la lista', { error: err.message })
    return { hit: false, entradas: [], error: err.message }
  }
}

/**
 * Decide nivel de riesgo y estado de EDD a partir de las dos señales.
 *
 * Función pura: se puede probar sin base de datos y la regla vive en un solo
 * sitio. Devuelve lo que hay que persistir, no lo persiste.
 *
 * @param {{ declarado?: boolean|null, relacion?: string|null, enLista?: boolean, sancionado?: boolean }} señales
 */
export function clasificarRiesgo({ declarado = null, relacion = null, enLista = false, sancionado = false } = {}) {
  // Un acierto de sanciones manda sobre todo lo demás.
  if (sancionado) {
    return { riskLevel: 'high', eddStatus: 'pending', motivo: 'coincidencia en listas de sanciones' }
  }
  if (declarado === true || enLista) {
    // Un allegado no es lo mismo que el titular del cargo, pero ambos exigen
    // revisión: la diferencia la pondera el Oficial de Cumplimiento, no el código.
    const motivo = declarado === true
      ? `PEP declarado por el usuario (${relacion ?? 'sin especificar'})`
      : 'coincidencia en lista de PEP'
    return { riskLevel: 'high', eddStatus: 'pending', motivo }
  }
  if (declarado === null) {
    // Todavía no se le preguntó: no es bajo riesgo, es riesgo desconocido.
    return { riskLevel: 'medium', eddStatus: 'not_required', motivo: 'declaración PEP pendiente' }
  }
  return { riskLevel: 'low', eddStatus: 'not_required', motivo: null }
}

export default { buscarEnListaPep, clasificarRiesgo, RELACIONES_PEP }
