// scripts/set-srl-bankdata.mjs
// Setea srl_config.bankData (cuenta receptora del payin BOB SRL). Toma precedencia
// sobre las env SRL_* en el email "Instrucciones para tu transferencia".
//
// Valores por ENV (no se hardcodean en git):
//   SRL_NEW_BANK_NAME, SRL_NEW_ACCOUNT_HOLDER, SRL_NEW_ACCOUNT_NUMBER, SRL_NEW_ACCOUNT_TYPE
//
// Uso (en el VPS, dentro del contenedor):
//   docker compose exec \
//     -e SRL_NEW_BANK_NAME="Banco X" -e SRL_NEW_ACCOUNT_HOLDER="Nombre Personal" \
//     -e SRL_NEW_ACCOUNT_NUMBER="123456789" -e SRL_NEW_ACCOUNT_TYPE="Cuenta de Ahorro" \
//     alyto-backend node scripts/set-srl-bankdata.mjs production            # dry-run
//   ... mismo comando + --confirm
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const CONFIRM  = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/set-srl-bankdata.mjs staging|production [--confirm]')
  process.exit(1)
}

const bankData = {
  bankName:      process.env.SRL_NEW_BANK_NAME,
  accountHolder: process.env.SRL_NEW_ACCOUNT_HOLDER,
  accountNumber: process.env.SRL_NEW_ACCOUNT_NUMBER,
  accountType:   process.env.SRL_NEW_ACCOUNT_TYPE,
}
const missing = Object.entries(bankData).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k)
if (missing.length) {
  console.error('❌ Faltan env vars:', missing.join(', '), '— pasalas con -e en docker compose exec.')
  process.exit(1)
}

const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db = mongoose.connection.db
console.log(`\n⚠️  OBJETIVO: ${TARGET.toUpperCase()} — DB: "${db.databaseName}"`)
if (TARGET === 'staging'    && db.databaseName !== 'alyto-v2-staging') { console.error('❌ DB inesperada'); process.exit(1) }
if (TARGET === 'production' && db.databaseName !== 'alyto-v2')         { console.error('❌ DB inesperada'); process.exit(1) }

const current = await db.collection('srl_config').findOne({ key: 'srl_bolivia' }, { projection: { bankData: 1 } })
console.log('\nbankData ACTUAL:', JSON.stringify(current?.bankData ?? '(vacío → usa env SRL_*)'))
console.log('bankData NUEVO: ', JSON.stringify(bankData))

if (!CONFIRM) {
  console.log('\n🟡 DRY-RUN — no se escribió nada. Re-ejecutá con --confirm para aplicar.')
  await mongoose.disconnect()
  process.exit(0)
}

const res = await db.collection('srl_config').updateOne(
  { key: 'srl_bolivia' },
  { $set: { bankData } },
  { upsert: true },
)
console.log(`\n✅ bankData actualizado (matched=${res.matchedCount}, modified=${res.modifiedCount}, upserted=${res.upsertedCount ?? 0}).`)
console.log('El email de payin ahora usará esta cuenta (precede a las env SRL_*).')

await mongoose.disconnect()
process.exit(0)
