/**
 * Limpieza acotada — deja a test@avfinance.net SIN transacciones (wallet + cross-border)
 * en STAGING, para pruebas y grabación limpia.
 *
 * Seguridad:
 *   - Guarda dura: aborta si la base conectada NO es 'alyto-v2-staging'.
 *   - Dry-run por defecto. Escribe SOLO con --confirm.
 *   - NO borra el usuario ni configs; solo su data transaccional y resetea saldos.
 *
 * Uso:
 *   node scripts/clean-testuser-staging.mjs            # dry-run
 *   node scripts/clean-testuser-staging.mjs --confirm  # aplica
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const CONFIRM      = process.argv.includes('--confirm')
const KEEP_BAL     = process.argv.includes('--keep-balances')
const EXPECTED_DB  = 'alyto-v2-staging'
const TARGET_EMAIL = 'test@avfinance.net'

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
const dbName = mongoose.connection.name
console.log(`\n⚠️  OBJETIVO: STAGING — Base de datos: "${dbName}"`)

if (dbName !== EXPECTED_DB) {
  console.error(`❌ ABORTADO: la base es "${dbName}", se esperaba "${EXPECTED_DB}". No se tocó nada.`)
  await mongoose.connection.close(); process.exit(2)
}
console.log(CONFIRM ? '   MODO ESCRITURA (--confirm)\n' : '   DRY-RUN (solo lectura)\n')

const db = mongoose.connection.db
const user = await db.collection('users').findOne({ email: TARGET_EMAIL }, { projection: { _id: 1, email: 1, accountType: 1, legalEntity: 1 } })
if (!user) { console.error(`❌ No existe ${TARGET_EMAIL} en ${dbName}.`); await mongoose.connection.close(); process.exit(1) }
console.log(`Usuario: ${user.email}  (_id=${user._id}, accountType=${user.accountType}, legalEntity=${user.legalEntity})\n`)

const uid = user._id
const q = { userId: uid }

// Conteos actuales
const txCount   = await db.collection('transactions').countDocuments(q)
const wtxCount  = await db.collection('wallettransactions').countDocuments(q)
const bob       = await db.collection('walletbobs').findOne(q, { projection: { balance: 1, balanceReserved: 1, balanceFrozen: 1 } })
const usdc      = await db.collection('walletusdcs').findOne(q, { projection: { balance: 1, balanceReserved: 1 } })
const idemCount = await db.collection('idempotencykeys').countDocuments(q)
const notifCount= await db.collection('notifications').countDocuments(q)

console.log('Estado actual:')
console.log(`  transactions (cross-border/payin/payout/fx): ${txCount}`)
console.log(`  wallettransactions (Wallet BOB/USDC):        ${wtxCount}`)
console.log(`  WalletBOB:  ${bob  ? `balance=${bob.balance} reserved=${bob.balanceReserved} frozen=${bob.balanceFrozen}` : '(sin wallet)'}`)
console.log(`  WalletUSDC: ${usdc ? `balance=${usdc.balance} reserved=${usdc.balanceReserved}` : '(sin wallet)'}`)
console.log(`  idempotencykeys: ${idemCount} | notifications: ${notifCount}`)

console.log('\nPlan:')
console.log('  • DELETE transactions      { userId }')
console.log('  • DELETE wallettransactions{ userId }')
console.log('  • RESET  walletbobs  → balance=0, reserved=0, frozen=0')
console.log('  • RESET  walletusdcs → balance=0, reserved=0')
console.log('  • DELETE idempotencykeys   { userId }   (evita replays viejos)')
console.log('  • DELETE notifications     { userId }')
console.log('  • (se PRESERVAN: usuario, contactos, configs)')

if (!CONFIRM) {
  console.log('\n(DRY-RUN) No se escribió nada. Repite con --confirm para aplicar.')
  await mongoose.connection.close(); process.exit(0)
}

console.log(`\nAplicando…${KEEP_BAL ? ' (conservando saldos)' : ''}`)
const r1 = await db.collection('transactions').deleteMany(q)
const r2 = await db.collection('wallettransactions').deleteMany(q)
const r5 = await db.collection('idempotencykeys').deleteMany(q)
const r6 = await db.collection('notifications').deleteMany(q)
console.log(`  ✓ transactions borradas:       ${r1.deletedCount}`)
console.log(`  ✓ wallettransactions borradas: ${r2.deletedCount}`)
if (!KEEP_BAL) {
  const r3 = await db.collection('walletbobs').updateOne(q, { $set: { balance: 0, balanceReserved: 0, balanceFrozen: 0 } })
  const r4 = await db.collection('walletusdcs').updateOne(q, { $set: { balance: 0, balanceReserved: 0 } })
  console.log(`  ✓ WalletBOB reseteada:         ${r3.modifiedCount}`)
  console.log(`  ✓ WalletUSDC reseteada:        ${r4.modifiedCount}`)
} else {
  console.log('  • Saldos WalletBOB/WalletUSDC: CONSERVADOS')
}
console.log(`  ✓ idempotencykeys borradas:    ${r5.deletedCount}`)
console.log(`  ✓ notifications borradas:      ${r6.deletedCount}`)
console.log('\n✓ Listo — usuario limpio para grabación.')

await mongoose.connection.close()
