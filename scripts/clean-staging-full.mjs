// scripts/clean-staging-full.mjs
// Limpieza completa de STAGING para pruebas limpias (Camino A + USDC P2P).
// Borra transaccional/test; preserva usuarios, configs, sanciones, tasas, keypairs.
// Dry-run por defecto; --confirm para ejecutar.
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const CONFIRM = process.argv.includes('--confirm')
const URI = process.env.MONGODB_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
await mongoose.connect(URI)
const db = mongoose.connection.db
const name = db.databaseName
console.log(`\n⚠️  OBJETIVO: STAGING — DB: "${name}"`)
if (name !== 'alyto-v2-staging') { console.error('❌ DB inesperada — abortando.'); process.exit(1) }

// Colecciones a VACIAR (transaccional / test)
const DELETE = ['transactions', 'wallettransactions', 'funding_intents', 'fundingrecords',
  'ros_alerts', 'notifications', 'idempotencykeys', 'contacts', 'reclamos']
// Wallets: reset de saldos a 0 (se conservan docs + dirección custodial)
const RESET_WALLETS = ['walletbobs', 'walletusdcs']

console.log('\n── Conteo actual ──')
for (const c of [...DELETE, ...RESET_WALLETS, 'users', 'wallet_fee_configs']) {
  const n = await db.collection(c).countDocuments().catch(() => 0)
  console.log(`   ${c.padEnd(22)} ${n}`)
}

if (!CONFIRM) {
  console.log('\n🔍 DRY-RUN — agregá --confirm para ejecutar.')
  console.log('Acciones: DELETE', DELETE.join(','), '| RESET saldos', RESET_WALLETS.join(','),
    '| reset revenue + alias de usuarios.\n')
  await mongoose.disconnect(); process.exit(0)
}

console.log('\n── Ejecutando ──')
for (const c of DELETE) {
  const { deletedCount } = await db.collection(c).deleteMany({}).catch(() => ({ deletedCount: 0 }))
  console.log(`   🗑️  ${c.padEnd(22)} ${deletedCount} eliminados`)
}
for (const c of RESET_WALLETS) {
  const { modifiedCount } = await db.collection(c).updateMany({}, { $set: { balance: 0, balanceReserved: 0, balanceFrozen: 0 } })
  console.log(`   ♻️  ${c.padEnd(22)} ${modifiedCount} saldos a 0`)
}
// Reset revenue de comisiones
await db.collection('wallet_fee_configs').updateMany({}, { $set: { revenueAccruedUsdc: 0, usdcP2pEnabled: false } })
console.log('   ♻️  wallet_fee_configs       revenue=0, comisión OFF')
// Liberar aliases de usuarios
const al = await db.collection('users').updateMany(
  { alytoAlias: { $ne: null } },
  { $set: { alytoAlias: null, aliasUpdatedAt: null } },
)
console.log(`   ♻️  users                    ${al.modifiedCount} alias liberados`)

console.log('\n✅ Staging limpio (usuarios, configs, sanciones, tasas y keypairs custodiales preservados).\n')
await mongoose.disconnect()
process.exit(0)
