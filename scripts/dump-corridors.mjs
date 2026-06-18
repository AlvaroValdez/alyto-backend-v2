// scripts/dump-corridors.mjs
// Lista todos los corredores (TransactionConfig) de un entorno. Read-only.
//   node scripts/dump-corridors.mjs staging
//   node scripts/dump-corridors.mjs production
//   node scripts/dump-corridors.mjs staging --json     # JSON completo (para clonar)
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const JSON_OUT = process.argv.includes('--json')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/dump-corridors.mjs staging|production [--json]')
  process.exit(1)
}
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db = mongoose.connection.db
console.log(`DB: ${db.databaseName}`)

const cs = await db.collection('transaction_configs').find({})
  .sort({ legalEntity: 1, corridorId: 1 }).toArray()
console.log(`TOTAL: ${cs.length}\n`)

if (JSON_OUT) {
  console.log(JSON.stringify(cs, null, 2))
} else {
  for (const c of cs) {
    console.log([
      (c.corridorId ?? '?').padEnd(16),
      (c.legalEntity ?? '?').padEnd(4),
      (c.destinationCountry ?? '?').padEnd(3),
      (c.destinationCurrency ?? '?').padEnd(4),
      (c.payinMethod ?? '?').padEnd(8),
      (c.payoutMethod ?? '?').padEnd(12),
      c.isActive ? 'ON ' : 'off',
      'spr=' + (c.alytoCSpread ?? '?'),
      'fix=' + (c.fixedFee ?? '?'),
      'min$=' + (c.minAmountUSD ?? '?'),
    ].join(' | '))
  }
}

await mongoose.disconnect()
process.exit(0)
