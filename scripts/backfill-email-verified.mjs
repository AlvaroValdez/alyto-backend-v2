// scripts/backfill-email-verified.mjs
// Backfill emailVerified=true para usuarios YA aprobados (kycStatus='approved')
// que se registraron antes de existir el flujo de verificación de email.
//
// Razón: su identidad ya fue verificada (KYC aprobado) → su email es de confianza.
// El gate requireEmailVerified solo aplica a /kyc/session y /user/kyc-profile, que
// los aprobados no usan, pero los dejamos consistentes (emailVerified=true) por
// higiene y para que no rompan si en el futuro se gatea otra ruta.
//
// NO toca usuarios en onboarding (pending/in_review/rejected): ellos deben verificar
// su email por el flujo normal.
//
// Idempotente. Dry-run por defecto; --confirm para escribir.
//
// Uso:
//   node scripts/backfill-email-verified.mjs staging
//   node scripts/backfill-email-verified.mjs staging --confirm
//   node scripts/backfill-email-verified.mjs production --confirm
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const CONFIRM  = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/backfill-email-verified.mjs staging|production [--confirm]')
  process.exit(1)
}
if (!PROD_URI) {
  console.error('❌ MONGODB_URI no está configurado en el entorno (.env).')
  process.exit(1)
}

const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db     = mongoose.connection.db
const dbName = db.databaseName
console.log(`\n⚠️  OBJETIVO: ${TARGET.toUpperCase()} — DB: "${dbName}"`)
if (TARGET === 'staging'    && dbName !== 'alyto-v2-staging') { console.error('❌ DB inesperada'); process.exit(1) }
if (TARGET === 'production' && dbName !== 'alyto-v2')         { console.error('❌ DB inesperada'); process.exit(1) }

// Candidatos: KYC aprobado y emailVerified aún no es true (campo ausente o false).
const filter = { kycStatus: 'approved', emailVerified: { $ne: true } }
const users  = await db.collection('users')
  .find(filter, { projection: { email: 1, kycStatus: 1, emailVerified: 1 } })
  .toArray()

console.log(`\n${users.length} usuario(s) aprobado(s) sin emailVerified=true:`)
for (const u of users) {
  console.log(`  - ${u.email} (emailVerified=${u.emailVerified ?? 'ausente'})`)
}

if (users.length === 0) {
  console.log('\n✅ Nada que backfillear.')
  await mongoose.disconnect()
  process.exit(0)
}

if (!CONFIRM) {
  console.log('\n🟡 DRY-RUN — no se escribió nada. Re-ejecuta con --confirm para aplicar.')
  await mongoose.disconnect()
  process.exit(0)
}

const res = await db.collection('users').updateMany(filter, { $set: { emailVerified: true } })
console.log(`\n✅ Backfill aplicado — ${res.modifiedCount} usuario(s) actualizado(s).`)

await mongoose.disconnect()
process.exit(0)
