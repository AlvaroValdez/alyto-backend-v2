/**
 * refreshSanctionsLists.js — Recarga semanal de las listas OFAC y ONU.
 *
 * Existe porque la carga manual se degrada sola. Las listas cambian cada semana;
 * si nadie recarga, la colección sigue pareciendo poblada mientras envejece en
 * silencio, que es exactamente el estado del que se venía: 2 entradas sin tocar
 * desde marzo mientras el expediente declaraba "OFAC / ONU / UIF Bolivia".
 *
 * Es el mismo código que usa `scripts/import-sanctions-lists.mjs`, que ahora es
 * una cáscara sobre esta función. Dos copias acabarían separándose.
 *
 * Idempotente por (listSource, sourceId). Lo que desaparece del origen se marca
 * isActive:false en lugar de borrarse: una desactivación hay que poder auditarla.
 *
 * NO conecta a Mongo: se ejecuta dentro del proceso, que ya está conectado.
 */

import SanctionsList from '../models/SanctionsList.js'
import { tokens, normalizarDocumento } from '../utils/sanctionsMatch.js'
import { logger } from '../utils/logger.js'

const FUENTES = {
  sdn: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
  alt: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV',
  onu: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
}

/**
 * Si una recarga trae muchas MENOS entradas de las que ya hay, algo fue mal en el
 * origen (mantenimiento, respuesta truncada, formato cambiado). Antes que vaciar
 * el cribado a medias, se aborta y se deja la lista anterior en pie.
 */
const CAIDA_MAXIMA = 0.5

async function bajar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer()).toString('latin1')
}

/** CSV de OFAC: comillas dobles, campos vacíos marcados como `-0-`. */
export function filasCsv(texto) {
  const filas = []
  let campo = '', fila = [], enComillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (enComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++ }
      else if (c === '"') enComillas = false
      else campo += c
    } else if (c === '"') enComillas = true
    else if (c === ',') { fila.push(campo); campo = '' }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = '' }
    else if (c !== '\r') campo += c
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila) }
  return filas
}

const limpio = v => {
  const t = (v ?? '').trim()
  return !t || t === '-0-' ? null : t
}

/** Documentos de identidad que vienen embebidos en el campo Remarks del SDN. */
function documentosDeRemarks(remarks) {
  if (!remarks) return []
  const out = []
  for (const m of remarks.matchAll(
    /(?:Passport|National ID No\.|Cedula No\.|C\.I\.|Identification Number)\s+([A-Z0-9-]{4,20})/gi)) {
    out.push(m[1])
  }
  return [...new Set(out)]
}

export function parsearOfac(sdnTxt, altTxt) {
  const alias = new Map()
  for (const f of filasCsv(altTxt)) {
    if (f.length < 4) continue
    const ent = limpio(f[0]); const nombre = limpio(f[3])
    if (!ent || !nombre) continue
    if (!alias.has(ent)) alias.set(ent, [])
    alias.get(ent).push(nombre)
  }

  const entradas = []
  for (const f of filasCsv(sdnTxt)) {
    if (f.length < 12) continue
    const ent = limpio(f[0]); const nombre = limpio(f[1])
    if (!ent || !nombre) continue
    const tipoCrudo = (f[2] ?? '').trim()
    // Buques y aeronaves no pueden ser usuarios: solo añaden ruido al cribado.
    if (tipoCrudo === 'vessel' || tipoCrudo === 'aircraft') continue

    const remarks = limpio(f[11])
    entradas.push({
      sourceId:   ent,
      listSource: 'OFAC',
      type:       tipoCrudo === 'individual' ? 'individual' : 'entity',
      fullName:   nombre,
      aliases:    alias.get(ent) ?? [],
      documentNumbers: documentosDeRemarks(remarks),
      reason:     limpio(f[3]),
      notes:      remarks ? remarks.slice(0, 500) : null,
    })
  }
  return entradas
}

/** XML de la ONU, sin dependencias: los campos que interesan son planos. */
export function parsearOnu(xml) {
  const entradas = []
  const campo = (b, etiqueta) => {
    const m = b.match(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`))
    return m ? m[1].trim().replace(/\s+/g, ' ') : null
  }
  const todos = (b, etiqueta) =>
    [...b.matchAll(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`, 'g'))]
      .map(m => m[1].trim().replace(/\s+/g, ' ')).filter(Boolean)

  for (const [etiqueta, tipo] of [['INDIVIDUAL', 'individual'], ['ENTITY', 'entity']]) {
    for (const m of xml.matchAll(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`, 'g'))) {
      const b = m[1]
      const partes = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME']
        .map(e => campo(b, e)).filter(Boolean)
      const completo = partes.join(' ').trim()
      if (!completo) continue

      entradas.push({
        sourceId:    campo(b, 'DATAID') ?? completo,
        listSource:  'ONU',
        type:        tipo,
        fullName:    completo,
        aliases:     todos(b, 'ALIAS_NAME'),
        documentNumbers: todos(b, 'NUMBER'),
        reason:      campo(b, 'UN_LIST_TYPE'),
        nationality: campo(b, 'NATIONALITY'),
        notes:       (campo(b, 'COMMENTS1') ?? '').slice(0, 500) || null,
      })
    }
  }
  return entradas
}

export function aDocumento(e) {
  // Variantes SIN mezclar: `nameTokens` es solo prefiltro indexado; la
  // confirmación se hace variante a variante para no cruzar tokens.
  const variantes = [e.fullName, ...(e.aliases ?? [])].filter(Boolean)
  return {
    ...e,
    entryId:      `${e.listSource}-${e.sourceId}`,
    nameVariants: variantes,
    nameTokens:   tokens(variantes.join(' ')),
    documentsNormalized: (e.documentNumbers ?? [])
      .map(normalizarDocumento).filter(d => d.length >= 4),
    isActive: true,
  }
}

/** Descarga y prepara las entradas, sin tocar la base. */
export async function prepararEntradas() {
  const [sdn, alt, onu] = await Promise.all([
    bajar(FUENTES.sdn), bajar(FUENTES.alt), bajar(FUENTES.onu),
  ])
  return [...parsearOfac(sdn, alt), ...parsearOnu(onu)]
    .map(aDocumento)
    .filter(e => e.nameTokens.length > 0)
}

/**
 * Recarga completa. Devuelve estadísticas; no lanza salvo fallo de red o base,
 * para que `runJob` lo registre como cualquier otro job.
 */
export async function refreshSanctionsLists() {
  const t0 = Date.now()
  const entradas = await prepararEntradas()

  const activasAntes = await SanctionsList.countDocuments({ isActive: true })
  if (activasAntes > 0 && entradas.length < activasAntes * CAIDA_MAXIMA) {
    // Mejor una lista vieja que media lista.
    logger.error('[Sanciones] Recarga ABORTADA: el origen trajo muchas menos entradas', {
      activasAntes, recibidas: entradas.length,
    })
    return { ok: false, abortado: true, activasAntes, recibidas: entradas.length }
  }

  let escritas = 0
  for (let i = 0; i < entradas.length; i += 1000) {
    const ops = entradas.slice(i, i + 1000).map(e => ({
      updateOne: {
        filter: { listSource: e.listSource, sourceId: e.sourceId },
        update: { $set: { ...e, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    }))
    const r = await SanctionsList.bulkWrite(ops, { ordered: false })
    escritas += (r.upsertedCount ?? 0) + (r.modifiedCount ?? 0)
  }

  const vigentes = entradas.map(e => e.entryId)
  const baja = await SanctionsList.updateMany(
    { listSource: { $in: ['OFAC', 'ONU'] }, entryId: { $nin: vigentes }, isActive: true },
    { $set: { isActive: false, updatedAt: new Date() } },
  )

  const activas = await SanctionsList.countDocuments({ isActive: true })
  const stats = {
    ok: true,
    preparadas: entradas.length,
    escritas,
    dadasDeBaja: baja.modifiedCount ?? 0,
    activas,
    ms: Date.now() - t0,
  }
  logger.info('[Sanciones] Recarga completada', stats)
  return stats
}

export default refreshSanctionsLists
