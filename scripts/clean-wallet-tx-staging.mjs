// scripts/clean-wallet-tx-staging.mjs
// Limpia transacciones (envíos) y datos de wallet en STAGING para pruebas limpias.
// Por defecto corre en DRY-RUN (no borra). Pasar --confirm para ejecutar la limpieza real.
//
// Uso:
//   node scripts/clean-wallet-tx-staging.mjs staging            # dry-run (solo muestra)
//   node scripts/clean-wallet-tx-staging.mjs staging --confirm  # ejecuta limpieza
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const CONFIRM  = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/clean-wallet-tx-staging.mjs staging|production [--confirm]')
  process.exit(1)
}

// Derivar URI de staging desde la de producción (DB correcta: alyto-v2-staging)
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db     = mongoose.connection.db
const dbName = db.databaseName

console.log(`\n⚠️  OBJETIVO: ${TARGET.toUpperCase()} — Base de datos: "${dbName}"`)

// ── Guards de seguridad ───────────────────────────────────────────────────────
if (TARGET === 'production' && dbName !== 'alyto-v2') {
  console.error('❌ Inconsistencia: TARGET=production pero DB no es alyto-v2'); process.exit(1)
}
if (TARGET === 'staging' && dbName !== 'alyto-v2-staging') {
  console.error(`❌ Inconsistencia: TARGET=staging pero DB es "${dbName}" (esperaba alyto-v2-staging). Abortando por seguridad.`)
  process.exit(1)
}

// Colecciones a vaciar por completo (envíos + movimientos de wallet)
const DELETE_COLLECTIONS = ['transactions', 'wallettransactions']
// Wallets: NO se borran los documentos; se resetean los saldos a 0
const RESET_WALLETS = ['walletbobs', 'walletusdcs']

console.log('\n── Conteo actual ──────────────────────────────────────────────')
for (const c of [...DELETE_COLLECTIONS, ...RESET_WALLETS]) {
  const n = await db.collection(c).countDocuments()
  console.log(`   ${c.padEnd(20)} ${n} documentos`)
}

if (!CONFIRM) {
  console.log('\n🔍 DRY-RUN — no se borró nada. Para ejecutar: agregar --confirm\n')
  await mongoose.disconnect()
  process.exit(0)
}

console.log('\n── Ejecutando limpieza ────────────────────────────────────────')
for (const c of DELETE_COLLECTIONS) {
  const { deletedCount } = await db.collection(c).deleteMany({})
  console.log(`   🗑️  ${c.padEnd(20)} ${deletedCount} eliminados`)
}
for (const c of RESET_WALLETS) {
  const { modifiedCount } = await db.collection(c).updateMany(
    {},
    { $set: { balance: 0, balanceReserved: 0, balanceFrozen: 0 } },
  )
  console.log(`   ♻️  ${c.padEnd(20)} ${modifiedCount} wallets reseteadas a 0`)
}

console.log('\n✅ Limpieza completada en', dbName, '\n')
await mongoose.disconnect()
process.exit(0)
