#!/usr/bin/env node
/**
 * import-sanctions-lists.mjs — Recarga manual de las listas OFAC y ONU.
 *
 *   node scripts/import-sanctions-lists.mjs --dry-run   # cuenta, no escribe
 *   node scripts/import-sanctions-lists.mjs             # recarga de verdad
 *
 * Es una cáscara: la lógica vive en `src/jobs/refreshSanctionsLists.js`, que es
 * lo que dispara el cron semanal. Tener dos copias acabaría con una de las dos
 * desactualizada, y la que importa es la que corre sola.
 *
 * Sigue siendo útil a mano: para la primera carga, para forzar una recarga tras
 * una designación urgente, y para ver qué traería el origen sin escribir nada.
 *
 * FUENTES OFICIALES
 *   OFAC SDN   https://sanctionslistservice.ofac.treas.gov/.../SDN.CSV
 *   OFAC alias https://sanctionslistservice.ofac.treas.gov/.../ALT.CSV
 *   ONU        https://scsanctions.un.org/resources/xml/en/consolidated.xml
 *
 * UIF Bolivia no publica lista en formato procesable. Si se obtiene, entra por
 * aquí con listSource='UIF_Bolivia'.
 */

import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import { prepararEntradas, refreshSanctionsLists } from '../src/jobs/refreshSanctionsLists.js'

dotenv.config()

const DRY = process.argv.includes('--dry-run')

console.log(DRY ? '— SIMULACIÓN, no se escribe nada —\n' : '— RECARGA REAL —\n')
console.log('Descargando fuentes…')

if (DRY) {
  const entradas = await prepararEntradas()
  const porFuente = entradas.reduce((a, e) => ({ ...a, [e.listSource]: (a[e.listSource] ?? 0) + 1 }), {})
  console.log(`\nEntradas preparadas: ${entradas.length}`)
  console.log('  por fuente:', Object.entries(porFuente).map(([k, v]) => `${k}=${v}`).join(' '))
  console.log('  con documento:', entradas.filter(e => e.documentsNormalized.length).length)
  console.log('\nMuestra:')
  for (const e of entradas.slice(0, 3)) {
    console.log(`  ${e.entryId} [${e.type}] ${e.fullName}`)
    console.log(`     tokens: ${e.nameTokens.slice(0, 8).join(' ')}`)
  }
  process.exit(0)
}

await mongoose.connect(process.env.MONGODB_URI)
const stats = await refreshSanctionsLists()

if (stats.abortado) {
  console.error(`\n⛔ ABORTADA: el origen trajo ${stats.recibidas} entradas y había ${stats.activasAntes} activas.`)
  console.error('   No se tocó nada. Mejor una lista vieja que media lista.')
  process.exit(1)
}

console.log(`\nListo en ${stats.ms} ms`)
console.log(`  escritas o actualizadas: ${stats.escritas}`)
console.log(`  dadas de baja (ya no figuran en el origen): ${stats.dadasDeBaja}`)
console.log(`  total activas: ${stats.activas}`)
process.exit(0)
