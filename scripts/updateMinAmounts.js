/**
 * updateMinAmounts.js — Establece montos mínimos de origen por entidad legal.
 *
 * Bolivia SRL : 300 BOB general / 2200 BOB para destino GB
 * Chile  SpA  : 30.000 CLP en todos los corredores cl-*
 * LLC         : sin cambios
 *
 * Uso: node scripts/updateMinAmounts.js
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import TransactionConfig from '../src/models/TransactionConfig.js'

await mongoose.connect(process.env.MONGODB_URI)
console.log('[updateMinAmounts] Conectado a MongoDB\n')

// ── Bolivia SRL — 300 BOB general, 2200 BOB para GB ──────────────────────────
const SRL_DEFAULT = 300
const SRL_GB      = 2200

const srlCorredores = await TransactionConfig
  .find({ legalEntity: 'SRL', isActive: true })
  .select('corridorId destinationCountry')
  .lean()

console.log('=== SRL ===')
for (const c of srlCorredores) {
  const min = (c.destinationCountry === 'GB') ? SRL_GB : SRL_DEFAULT
  await TransactionConfig.updateOne(
    { corridorId: c.corridorId },
    { $set: { minAmountOrigin: min } }
  )
  console.log(`  ✅ ${c.corridorId.padEnd(18)} → ${String(min).padStart(4)} BOB`)
}

// ── Chile SpA — 30.000 CLP ────────────────────────────────────────────────────
const SPA_DEFAULT = 30000

const spaCorredores = await TransactionConfig
  .find({ legalEntity: 'SpA', isActive: true })
  .select('corridorId')
  .lean()

console.log('\n=== SpA ===')
for (const c of spaCorredores) {
  await TransactionConfig.updateOne(
    { corridorId: c.corridorId },
    { $set: { minAmountOrigin: SPA_DEFAULT } }
  )
  console.log(`  ✅ ${c.corridorId.padEnd(18)} → ${SPA_DEFAULT} CLP`)
}

// ── LLC — sin cambios ─────────────────────────────────────────────────────────
console.log('\n⏭  LLC: sin cambios')

console.log('\n────────────────────────────────')
console.log('Resumen:')
console.log(`  SRL general : ${SRL_DEFAULT} BOB`)
console.log(`  SRL GB      : ${SRL_GB} BOB`)
console.log(`  SpA todos   : ${SPA_DEFAULT} CLP`)
console.log(`  SRL actualizados: ${srlCorredores.length}`)
console.log(`  SpA actualizados: ${spaCorredores.length}`)

await mongoose.disconnect()
console.log('\n[updateMinAmounts] Conexión cerrada.')
