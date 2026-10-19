#!/usr/bin/env node
/**
 * import-sanctions-lists.mjs — Carga las listas OFAC y ONU en `sanctionslists`.
 *
 *   node scripts/import-sanctions-lists.mjs --dry-run   # cuenta, no escribe
 *   node scripts/import-sanctions-lists.mjs             # carga de verdad
 *
 * POR QUÉ ES UN SCRIPT Y NO UNA CARGA MANUAL
 *
 * Estas listas cambian cada semana. Una carga a mano envejece y, peor, envejece
 * en silencio: la colección parece poblada y el cribado parece funcionar. Esto
 * es idempotente y se puede volver a correr, que es la única forma de que el
 * dato siga siendo cierto dentro de seis meses.
 *
 * FUENTES OFICIALES
 *   OFAC SDN   https://sanctionslistservice.ofac.treas.gov/.../SDN.CSV
 *   OFAC alias https://sanctionslistservice.ofac.treas.gov/.../ALT.CSV
 *   ONU        https://scsanctions.un.org/resources/xml/en/consolidated.xml
 *
 * QUÉ NO ENTRA
 *   Buques y aeronaves del SDN (~1.900). No pueden ser usuarios de Alyto y solo
 *   añaden ruido al cribado de personas.
 *   UIF Bolivia: no publica lista en formato procesable. Si algún día se obtiene,
 *   se carga con listSource='UIF_Bolivia' por esta misma vía.
 *
 * BAJAS
 *   Lo que estaba y ya no viene en el origen se marca isActive=false en lugar de
 *   borrarse: una desactivación hay que poder auditarla.
 */

import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import SanctionsList from '../src/models/SanctionsList.js'
import { tokens, normalizarDocumento } from '../src/utils/sanctionsMatch.js'

dotenv.config()

const DRY = process.argv.includes('--dry-run')

const FUENTES = {
  sdn: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
  alt: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV',
  onu: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
}

async function bajar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer()).toString('latin1')
}

/** CSV de OFAC: comillas dobles, campos vacíos marcados como `-0-`. */
function filasCsv(texto) {
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

/** Extrae documentos de identidad del campo Remarks del SDN. */
function documentosDeRemarks(remarks) {
  if (!remarks) return []
  const out = []
  for (const m of remarks.matchAll(/(?:Passport|National ID No\.|Cedula No\.|C\.I\.|Identification Number)\s+([A-Z0-9-]{4,20})/gi)) {
    out.push(m[1])
  }
  return [...new Set(out)]
}

function parsearOfac(sdnTxt, altTxt) {
  // Alias por número de entidad.
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
    if (tipoCrudo === 'vessel' || tipoCrudo === 'aircraft') continue

    const sus    = alias.get(ent) ?? []
    const remarks = limpio(f[11])
    const docs    = documentosDeRemarks(remarks)

    entradas.push({
      sourceId:   ent,
      listSource: 'OFAC',
      type:       tipoCrudo === 'individual' ? 'individual' : 'entity',
      fullName:   nombre,
      aliases:    sus,
      documentNumbers: docs,
      reason:     limpio(f[3]),   // programa de sanción
      notes:      remarks ? remarks.slice(0, 500) : null,
    })
  }
  return entradas
}

/** XML de la ONU, sin dependencias: los campos que interesan son planos. */
function parsearOnu(xml) {
  const entradas = []
  const campo = (bloque, etiqueta) => {
    const m = bloque.match(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`))
    return m ? m[1].trim().replace(/\s+/g, ' ') : null
  }
  const todos = (bloque, etiqueta) =>
    [...bloque.matchAll(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`, 'g'))]
      .map(m => m[1].trim().replace(/\s+/g, ' ')).filter(Boolean)

  for (const [etiqueta, tipo] of [['INDIVIDUAL', 'individual'], ['ENTITY', 'entity']]) {
    for (const m of xml.matchAll(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`, 'g'))) {
      const b = m[1]
      const partes = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME']
        .map(e => campo(b, e)).filter(Boolean)
      const completo = partes.join(' ').trim()
      if (!completo) continue

      entradas.push({
        sourceId:   campo(b, 'DATAID') ?? completo,
        listSource: 'ONU',
        type:       tipo,
        fullName:   completo,
        aliases:    todos(b, 'ALIAS_NAME'),
        documentNumbers: todos(b, 'NUMBER'),
        reason:     campo(b, 'UN_LIST_TYPE'),
        nationality: campo(b, 'NATIONALITY'),
        notes:      (campo(b, 'COMMENTS1') ?? '').slice(0, 500) || null,
      })
    }
  }
  return entradas
}

function aDocumento(e) {
  const nombres = [e.fullName, ...(e.aliases ?? [])].join(' ')
  return {
    ...e,
    entryId:    `${e.listSource}-${e.sourceId}`,
    nameTokens: tokens(nombres),
    documentsNormalized: (e.documentNumbers ?? [])
      .map(normalizarDocumento).filter(d => d.length >= 4),
    isActive:   true,
  }
}

// ── Ejecución ─────────────────────────────────────────────────────────────────

console.log(DRY ? '— SIMULACIÓN, no se escribe nada —\n' : '— CARGA REAL —\n')

console.log('Descargando fuentes…')
const [sdn, alt, onu] = await Promise.all([bajar(FUENTES.sdn), bajar(FUENTES.alt), bajar(FUENTES.onu)])

const entradas = [...parsearOfac(sdn, alt), ...parsearOnu(onu)].map(aDocumento)
const porFuente = entradas.reduce((a, e) => ({ ...a, [e.listSource]: (a[e.listSource] ?? 0) + 1 }), {})
const sinTokens = entradas.filter(e => e.nameTokens.length === 0).length

console.log(`\nEntradas preparadas: ${entradas.length}`)
console.log('  por fuente:', Object.entries(porFuente).map(([k, v]) => `${k}=${v}`).join(' '))
console.log('  con documento:', entradas.filter(e => e.documentsNormalized.length).length)
console.log('  sin tokens de nombre (se descartan):', sinTokens)

if (DRY) {
  console.log('\nMuestra:')
  for (const e of entradas.slice(0, 3)) {
    console.log(`  ${e.entryId} [${e.type}] ${e.fullName}`)
    console.log(`     tokens: ${e.nameTokens.slice(0, 8).join(' ')}`)
  }
  process.exit(0)
}

await mongoose.connect(process.env.MONGODB_URI)
const col = mongoose.connection.collection('sanctionslists')

const utiles = entradas.filter(e => e.nameTokens.length > 0)
let escritas = 0
for (let i = 0; i < utiles.length; i += 1000) {
  const lote = utiles.slice(i, i + 1000)
  const ops = lote.map(e => ({
    updateOne: {
      filter: { listSource: e.listSource, sourceId: e.sourceId },
      update: { $set: { ...e, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      upsert: true,
    },
  }))
  const r = await col.bulkWrite(ops, { ordered: false })
  escritas += (r.upsertedCount ?? 0) + (r.modifiedCount ?? 0)
  process.stdout.write(`\r  escritas ${Math.min(i + 1000, utiles.length)}/${utiles.length}`)
}
console.log()

// Bajas: lo que ya no viene del origen deja de estar activo, pero se conserva.
const vigentes = utiles.map(e => `${e.listSource}-${e.sourceId}`)
const baja = await col.updateMany(
  { listSource: { $in: ['OFAC', 'ONU'] }, entryId: { $nin: vigentes }, isActive: true },
  { $set: { isActive: false, updatedAt: new Date() } },
)

const total = await col.countDocuments({ isActive: true })
console.log(`\nListo. Escritas/actualizadas: ${escritas}`)
console.log(`Dadas de baja (ya no figuran en el origen): ${baja.modifiedCount}`)
console.log(`Total activas en la colección: ${total}`)
process.exit(0)
