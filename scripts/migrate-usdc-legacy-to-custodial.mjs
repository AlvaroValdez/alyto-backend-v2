// scripts/migrate-usdc-legacy-to-custodial.mjs
// H4 (Camino A) — Migra WalletUSDC legacy (dirección compartida + memo) a la
// dirección custodial del propio usuario. SOLO-DB: reapunta stellarAddress y limpia
// stellarMemo para usuarios que YA tienen keypair custodial. NO provisiona (eso
// requiere KMS/fallback del servidor y operaciones Stellar); los usuarios sin
// keypair se reportan para migración lazy (al abrir deposit-instructions).
//
// Idempotente. Dry-run por defecto; --confirm para escribir.
//
// Uso:
//   node scripts/migrate-usdc-legacy-to-custodial.mjs staging
//   node scripts/migrate-usdc-legacy-to-custodial.mjs staging --confirm
//   node scripts/migrate-usdc-legacy-to-custodial.mjs production --confirm
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const CONFIRM  = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/migrate-usdc-legacy-to-custodial.mjs staging|production [--confirm]')
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

const srlShared = process.env.STELLAR_SRL_PUBLIC_KEY ?? null

// Candidatas: WalletUSDC con memo (modelo viejo) o que apuntan a la dirección compartida
const legacy = await db.collection('walletusdcs').find({
  $or: [
    { stellarMemo: { $ne: null } },
    ...(srlShared ? [{ stellarAddress: srlShared }] : []),
  ],
}).toArray()

console.log(`\nWalletUSDC legacy candidatas: ${legacy.length}`)

const toUpdate = []   // tienen keypair custodial → reapuntar (solo-DB)
const noCustody = []  // sin keypair → migración lazy/server-side

for (const w of legacy) {
  const u = await db.collection('users').findOne(
    { _id: w.userId },
    { projection: { email: 1, 'stellarAccount.publicKey': 1 } },
  )
  const custodial = u?.stellarAccount?.publicKey ?? null
  if (custodial) {
    // ¿ya migrada? (dirección ya custodial y sin memo)
    const already = w.stellarAddress === custodial && !w.stellarMemo
    toUpdate.push({ _id: w._id, email: u?.email, custodial, already })
  } else {
    noCustody.push({ _id: w._id, email: u?.email })
  }
}

console.log('\n── Con keypair custodial (reapuntar solo-DB) ──')
for (const t of toUpdate) console.log(`  ${t.email}: → ${t.custodial.slice(0, 10)}.. ${t.already ? '(ya migrada, no-op)' : ''}`)
console.log('\n── SIN keypair custodial (migración lazy/server-side) ──')
for (const n of noCustody) console.log(`  ${n.email} — se migrará al abrir deposit-instructions, o provisionar en el servidor`)

const pending = toUpdate.filter(t => !t.already)
console.log(`\nA reapuntar ahora: ${pending.length} | ya migradas: ${toUpdate.length - pending.length} | sin custodia: ${noCustody.length}`)

if (!CONFIRM) {
  console.log('\n🔍 DRY-RUN — no se escribió. Agregar --confirm para ejecutar.\n')
  await mongoose.disconnect(); process.exit(0)
}

let updated = 0
for (const t of pending) {
  await db.collection('walletusdcs').updateOne(
    { _id: t._id },
    { $set: { stellarAddress: t.custodial, stellarMemo: null } },
  )
  updated++
}
console.log(`\n✅ Reapuntadas: ${updated}. Sin custodia (no tocadas): ${noCustody.length}.\n`)
await mongoose.disconnect()
process.exit(0)
