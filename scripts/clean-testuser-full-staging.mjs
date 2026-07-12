/**
 * Limpieza INTEGRAL de test@avfinance.net en STAGING para grabación limpia.
 *
 * Borra toda la huella transaccional/operativa del usuario y resetea saldos y KYB:
 *   - transactions (cross-border), wallettransactions
 *   - business_profiles + businessprofiles (KYB / empresas)
 *   - reclamos (PRILI), ros_alerts (AML), notifications, contacts, idempotencykeys
 *   - walletbobs / walletusdcs → saldos a 0
 *   - users → accountType=personal, kybStatus=not_started, $unset businessProfileId
 *
 * ⚠️ Colecciones con nombres mixtos (snake_case vs plural Mongoose) — se usan los
 *    nombres REALES verificados en la BD (p.ej. business_profiles, ros_alerts).
 *
 * Seguridad: guarda dura (solo alyto-v2-staging). Dry-run por defecto (--confirm).
 *
 * Uso:
 *   node scripts/clean-testuser-full-staging.mjs            # dry-run
 *   node scripts/clean-testuser-full-staging.mjs --confirm  # aplica
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const CONFIRM      = process.argv.includes('--confirm')
const EXPECTED_DB  = 'alyto-v2-staging'
const TARGET_EMAIL = 'test@avfinance.net'

// Colecciones a borrar por completo (docs del usuario)
const DELETE_COLLS = [
  'transactions', 'wallettransactions',
  'business_profiles', 'businessprofiles',
  'reclamos', 'ros_alerts', 'notifications', 'contacts', 'idempotencykeys',
]
// Wallets a resetear a 0
const WALLET_RESETS = [
  { coll: 'walletbobs',  set: { balance: 0, balanceReserved: 0, balanceFrozen: 0 } },
  { coll: 'walletusdcs', set: { balance: 0, balanceReserved: 0 } },
]

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
const dbName = mongoose.connection.name
console.log(`\n⚠️  OBJETIVO: STAGING — Base de datos: "${dbName}"`)
if (dbName !== EXPECTED_DB) {
  console.error(`❌ ABORTADO: la base es "${dbName}", se esperaba "${EXPECTED_DB}". No se tocó nada.`)
  await mongoose.connection.close(); process.exit(2)
}
console.log(CONFIRM ? '   MODO ESCRITURA (--confirm)\n' : '   DRY-RUN (solo lectura)\n')

const db = mongoose.connection.db
const user = await db.collection('users').findOne({ email: TARGET_EMAIL }, { projection: { _id: 1, email: 1, accountType: 1, kybStatus: 1 } })
if (!user) { console.error(`❌ No existe ${TARGET_EMAIL} en ${dbName}.`); await mongoose.connection.close(); process.exit(1) }
console.log(`Usuario: ${user.email} (_id=${user._id}) accountType=${user.accountType} kybStatus=${user.kybStatus}\n`)

const uid = user._id
const filter = { $or: [{ userId: uid }, { user: uid }, { senderId: uid }] }

console.log('Conteo actual (docs del usuario):')
for (const coll of DELETE_COLLS) {
  const n = await db.collection(coll).countDocuments(filter).catch(() => 0)
  if (n > 0) console.log(`  ${coll.padEnd(20)} ${n}`)
}
for (const { coll } of WALLET_RESETS) {
  const w = await db.collection(coll).findOne({ userId: uid }, { projection: { balance: 1, balanceReserved: 1, balanceFrozen: 1 } }).catch(() => null)
  if (w) console.log(`  ${coll.padEnd(20)} balance=${w.balance} reserved=${w.balanceReserved ?? 0} frozen=${w.balanceFrozen ?? 0} → 0`)
}

if (!CONFIRM) {
  console.log('\n(DRY-RUN) No se escribió nada. Repite con --confirm para aplicar.')
  await mongoose.connection.close(); process.exit(0)
}

console.log('\nAplicando…')
for (const coll of DELETE_COLLS) {
  const r = await db.collection(coll).deleteMany(filter).catch(e => ({ deletedCount: `err:${e.message}` }))
  if (r.deletedCount) console.log(`  ✓ ${coll}: ${r.deletedCount} borrados`)
}
for (const { coll, set } of WALLET_RESETS) {
  const r = await db.collection(coll).updateOne({ userId: uid }, { $set: set }).catch(() => ({ modifiedCount: 0 }))
  console.log(`  ✓ ${coll}: reseteada (${r.modifiedCount})`)
}
const upd = await db.collection('users').updateOne(
  { _id: uid },
  { $set: { accountType: 'personal', kybStatus: 'not_started' }, $unset: { businessProfileId: '' } }
)
console.log(`  ✓ users: ${upd.modifiedCount} (personal, sin KYB)`)
console.log('\n✓ Listo — usuario totalmente limpio para grabación.')

await mongoose.connection.close()
