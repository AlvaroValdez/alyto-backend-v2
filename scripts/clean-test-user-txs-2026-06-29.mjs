// scripts/clean-test-user-txs-2026-06-29.mjs
// Elimina SOLO las transacciones de un usuario (transactions + wallettransactions)
// para dejar el ambiente limpio de pruebas. NO toca saldos ni el usuario.
//
// Uso:
//   node scripts/clean-test-user-txs-2026-06-29.mjs staging              # dry-run
//   node scripts/clean-test-user-txs-2026-06-29.mjs staging --confirm    # borra
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const EMAIL   = 'test@avfinance.net'
const TARGET  = process.argv[2]
const CONFIRM = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/clean-test-user-txs-2026-06-29.mjs staging|production [--confirm]')
  process.exit(1)
}

const PROD_URI = process.env.MONGODB_URI
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db     = mongoose.connection.db
const dbName = db.databaseName

console.log(`\n⚠️  OBJETIVO: ${TARGET.toUpperCase()} — Base de datos: "${dbName}"`)

// Verificación de seguridad
if (TARGET === 'production' && dbName !== 'alyto-v2') {
  console.error('❌ Inconsistencia: TARGET=production pero DB no es alyto-v2'); process.exit(1)
}
if (TARGET === 'staging' && dbName !== 'alyto-v2-staging') {
  console.error(`❌ Inconsistencia: TARGET=staging pero DB es "${dbName}" (esperaba alyto-v2-staging)`); process.exit(1)
}

// Resolver el usuario
const user = await db.collection('users').findOne({ email: EMAIL.toLowerCase() })
if (!user) { console.error(`❌ No existe el usuario ${EMAIL} en "${dbName}".`); await mongoose.disconnect(); process.exit(1) }
console.log(`\nUsuario: ${EMAIL} → _id=${user._id} (legalEntity=${user.legalEntity ?? '—'}, role=${user.role ?? '—'})`)

const filter = { userId: user._id }
const [nTx, nWtx] = await Promise.all([
  db.collection('transactions').countDocuments(filter),
  db.collection('wallettransactions').countDocuments(filter),
])

console.log('\nA eliminar (solo transacciones, NO saldos ni usuario):')
console.log(`   transactions:        ${nTx}`)
console.log(`   wallettransactions:  ${nWtx}`)
console.log(`   TOTAL:               ${nTx + nWtx}`)

if (!CONFIRM) {
  console.log('\n🔍 DRY-RUN — no se borró nada. Para ejecutar: agregá --confirm\n')
  await mongoose.disconnect(); process.exit(0)
}

const [rTx, rWtx] = await Promise.all([
  db.collection('transactions').deleteMany(filter),
  db.collection('wallettransactions').deleteMany(filter),
])

console.log('\n✅ Borrado completado:')
console.log(`   transactions:        ${rTx.deletedCount}`)
console.log(`   wallettransactions:  ${rWtx.deletedCount}`)

await mongoose.disconnect()
process.exit(0)
