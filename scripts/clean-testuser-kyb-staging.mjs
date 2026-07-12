/**
 * Elimina TODOS los KYB / perfiles de empresa (BusinessProfile) asociados a
 * test@avfinance.net en STAGING y deja al usuario como personal sin KYB.
 *
 * Busca por userId Y por email (para capturar perfiles huérfanos).
 *
 * Seguridad: guarda dura (solo alyto-v2-staging), dry-run por defecto (--confirm).
 *
 * Uso:
 *   node scripts/clean-testuser-kyb-staging.mjs            # dry-run
 *   node scripts/clean-testuser-kyb-staging.mjs --confirm  # aplica
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const CONFIRM      = process.argv.includes('--confirm')
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
const user = await db.collection('users').findOne({ email: TARGET_EMAIL }, { projection: { _id: 1, email: 1, accountType: 1, kybStatus: 1, businessProfileId: 1 } })
if (!user) { console.error(`❌ No existe ${TARGET_EMAIL} en ${dbName}.`); await mongoose.connection.close(); process.exit(1) }
console.log(`Usuario: ${user.email} (_id=${user._id})`)
console.log(`  accountType=${user.accountType} | kybStatus=${user.kybStatus} | businessProfileId=${user.businessProfileId ?? '-'}\n`)

// Perfiles de empresa asociados: por userId o por email.
// ⚠️ La colección real es 'business_profiles' (con guion bajo); 'businessprofiles'
// (pluralización Mongoose) suele estar vacía — limpiamos ambas por seguridad.
const COLLS = ['business_profiles', 'businessprofiles']
const filter = { $or: [{ userId: user._id }, { email: TARGET_EMAIL }] }

let total = 0
for (const coll of COLLS) {
  const profiles = await db.collection(coll)
    .find(filter, { projection: { businessId: 1, legalName: 1, email: 1, kybStatus: 1, userId: 1 } })
    .toArray()
  total += profiles.length
  console.log(`Colección "${coll}": ${profiles.length} perfil(es)`)
  for (const p of profiles) {
    console.log(`  • _id=${p._id} businessId=${p.businessId ?? '-'} legalName="${p.legalName ?? '-'}" email=${p.email ?? '-'} kyb=${p.kybStatus} userId=${p.userId ?? '-'}`)
  }
}
console.log(`Total a eliminar: ${total}`)

console.log('\nPlan:')
console.log('  • DELETE business_profiles + businessprofiles  { userId OR email }')
console.log('  • UPDATE users → accountType=personal, kybStatus=not_started, $unset businessProfileId')

if (!CONFIRM) {
  console.log('\n(DRY-RUN) No se escribió nada. Repite con --confirm para aplicar.')
  await mongoose.connection.close(); process.exit(0)
}

console.log('\nAplicando…')
let deleted = 0
for (const coll of COLLS) {
  const del = await db.collection(coll).deleteMany(filter)
  deleted += del.deletedCount
  console.log(`  ✓ ${coll} borrados: ${del.deletedCount}`)
}
const upd = await db.collection('users').updateOne(
  { _id: user._id },
  { $set: { accountType: 'personal', kybStatus: 'not_started' }, $unset: { businessProfileId: '' } }
)
console.log(`  ✓ perfiles eliminados (total): ${deleted}`)
console.log(`  ✓ usuario actualizado:         ${upd.modifiedCount} (personal, sin KYB)`)
console.log('\n✓ Listo — sin KYB ni empresas asociadas.')

await mongoose.connection.close()
