// scripts/register-funding-staging.mjs
// Registra un FundingRecord confirmado de USDC para SRL en STAGING, para destrabar
// transacciones en 'pending_funding'. Por defecto DRY-RUN; pasar --confirm para escribir.
//
// Uso:
//   node scripts/register-funding-staging.mjs            # dry-run
//   node scripts/register-funding-staging.mjs --confirm  # registra
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const CONFIRM = process.argv.includes('--confirm')
const URI = process.env.MONGODB_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')

await mongoose.connect(URI)
const db = mongoose.connection.db
const dbName = db.databaseName
if (dbName !== 'alyto-v2-staging') {
  console.error(`❌ DB inesperada: "${dbName}". Abortando.`); process.exit(1)
}
console.log('DB:', dbName)

// Buscar un admin para registeredBy
const admin = await db.collection('users').findOne({ role: 'admin' })
if (!admin) { console.error('❌ No hay usuario admin en staging.'); process.exit(1) }
console.log('Admin registeredBy:', admin.email, admin._id.toString())

// Saldo on-chain real (lo que muestra el header / forecast)
const AMOUNT = 517.18

const doc = {
  fundingId:     `FUND-SRL-${1780600000000}-RECON1`,   // id fijo determinístico (sin Date.now)
  entity:        'SRL',
  type:          'internal',
  asset:         'USDC',
  amount:        AMOUNT,
  usdEquivalent: AMOUNT,
  exchangeRate:  1,
  note:          'Reconciliación staging: registro del saldo USDC ya existente on-chain en wallet Stellar SRL para destrabar pruebas.',
  registeredBy:  admin._id,
  status:        'confirmed',
  createdAt:     new Date(),
  updatedAt:     new Date(),
}

console.log('\nFundingRecord a registrar:')
console.log(`   entity=${doc.entity} asset=${doc.asset} amount=${doc.amount} status=${doc.status}`)

if (!CONFIRM) {
  console.log('\n🔍 DRY-RUN — no se escribió. Para registrar: --confirm\n')
  await mongoose.disconnect(); process.exit(0)
}

// Evitar duplicado si se corre dos veces
const exists = await db.collection('fundingrecords').findOne({ fundingId: doc.fundingId })
if (exists) {
  console.log('\n⚠️  Ya existe ese fundingId. No se duplica.')
} else {
  await db.collection('fundingrecords').insertOne(doc)
  console.log('\n✅ FundingRecord registrado.')
}

// Verificar nuevo disponible contable
const inflow = await db.collection('fundingrecords').aggregate([
  { $match: { entity: 'SRL', asset: 'USDC', status: 'confirmed' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]).toArray()
console.log('getAvailableUSDC(SRL) [contable] ahora =', inflow[0]?.total ?? 0)

await mongoose.disconnect()
process.exit(0)
