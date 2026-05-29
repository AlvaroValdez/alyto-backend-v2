/**
 * clean-staging.mjs — Limpieza completa de staging para demo ASFI
 *
 * ⚠️  El .env local apunta a PRODUCCIÓN (alyto-v2).
 *     Este script deriva automáticamente la URI de staging → alyto-v2-staging.
 *
 * Uso:
 *   node scripts/clean-staging.mjs staging     — limpia staging (alyto-v2-staging)
 *   node scripts/clean-staging.mjs production  — limpia producción (requiere confirmación)
 */

import mongoose from 'mongoose'
import * as dotenv from 'dotenv'

dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/clean-staging.mjs staging|production')
  process.exit(1)
}

if (!PROD_URI) {
  console.error('❌ MONGODB_URI no definida en .env')
  process.exit(1)
}

// Derivar URI según target
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

if (TARGET === 'staging' && URI === PROD_URI) {
  console.error('❌ No se pudo derivar la URI de staging. Verifica que MONGODB_URI contenga /alyto-v2')
  process.exit(1)
}

await mongoose.connect(URI)
const dbName = mongoose.connection.db.databaseName

// Verificación de seguridad
if (TARGET === 'staging'    && dbName !== 'alyto-v2-staging') {
  console.error(`❌ INCONSISTENCIA: TARGET=staging pero DB es "${dbName}" (esperado: alyto-v2-staging)`)
  process.exit(1)
}
if (TARGET === 'production' && dbName !== 'alyto-v2') {
  console.error(`❌ INCONSISTENCIA: TARGET=production pero DB es "${dbName}" (esperado: alyto-v2)`)
  process.exit(1)
}

console.log(`\n✅ Conectado a ${TARGET.toUpperCase()} — DB: "${dbName}"`)
console.log('─'.repeat(50))

const db = mongoose.connection.db

// ─── Colecciones a vaciar ─────────────────────────────────

const TO_DROP = [
  'transactions',
  'wallettransactions',
  'walletbobs',
  'walletusdcs',
  'reclamos',
  'notifications',
  'idempotencykeys',
  'fundingrecords',
  'contacts',
]

for (const col of TO_DROP) {
  try {
    const result = await db.collection(col).deleteMany({})
    console.log(`🗑️  ${col}: ${result.deletedCount} documentos eliminados`)
  } catch (err) {
    console.warn(`⚠️  ${col}: ${err.message}`)
  }
}

// ─── Usuarios: eliminar todos excepto admins ──────────────

const usersResult = await db.collection('users').deleteMany({ role: { $ne: 'admin' } })
console.log(`👤 users (no-admin): ${usersResult.deletedCount} eliminados`)

// ─── Contadores: resetear a 0 ─────────────────────────────

try {
  const counterResult = await db.collection('counters').updateMany({}, { $set: { seq: 0 } })
  console.log(`🔢 counters: ${counterResult.modifiedCount} reseteados`)
} catch (err) {
  console.warn(`⚠️  counters: ${err.message}`)
}

// ─── Resumen de lo conservado ─────────────────────────────

const adminCount     = await db.collection('users').countDocuments({ role: 'admin' })
const configCount    = await db.collection('transaction_configs').countDocuments()
const sanctionsCount = await db.collection('sanctionslists').countDocuments()
const srlCount       = await db.collection('srlconfigs').countDocuments()

console.log('\n📊 Conservado:')
console.log(`   Admins:            ${adminCount}`)
console.log(`   TransactionConfig: ${configCount} corredores`)
console.log(`   SanctionsList:     ${sanctionsCount} registros`)
console.log(`   SRLConfig:         ${srlCount}`)

console.log(`\n✅ ${TARGET.toUpperCase()} limpio y listo`)

await mongoose.disconnect()
process.exit(0)
