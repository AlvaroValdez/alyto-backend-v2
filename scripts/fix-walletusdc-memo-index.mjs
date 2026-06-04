// scripts/fix-walletusdc-memo-index.mjs
// Camino A — Corrige el índice de stellarMemo en walletusdcs.
// El índice viejo (unique+sparse, o unique a secas) rompe con E11000 al segundo
// documento con stellarMemo:null (sparse no excluye null explícitos). Lo reemplaza
// por un índice único PARCIAL solo sobre strings (permite múltiples null, mantiene
// únicos los memos legacy). Crea también el índice de stellarAddress.
//
// Idempotente. Dry-run por defecto; --confirm para aplicar.
//
// Uso:
//   node scripts/fix-walletusdc-memo-index.mjs staging --confirm
//   node scripts/fix-walletusdc-memo-index.mjs production --confirm
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const CONFIRM  = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/fix-walletusdc-memo-index.mjs staging|production [--confirm]')
  process.exit(1)
}
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db   = mongoose.connection.db
const name = db.databaseName
console.log(`\n⚠️  OBJETIVO: ${TARGET.toUpperCase()} — DB: "${name}"`)
if (TARGET === 'staging'    && name !== 'alyto-v2-staging') { console.error('❌ DB inesperada'); process.exit(1) }
if (TARGET === 'production' && name !== 'alyto-v2')         { console.error('❌ DB inesperada'); process.exit(1) }

const coll = db.collection('walletusdcs')
const before = await coll.indexes()
console.log('\nÍndices actuales:')
for (const i of before) console.log('  ', i.name, '| unique=', !!i.unique, '| sparse=', !!i.sparse, '| partial=', !!i.partialFilterExpression)

const hasOld = before.some(i => i.name === 'stellarMemo_1')
const hasAddr = before.some(i => i.name === 'stellarAddress_1')

console.log('\nAcciones:')
console.log(`  ${hasOld ? 'DROP' : '(no existe)'} stellarMemo_1`)
console.log('  CREATE stellarMemo_1 { unique, partial: stellarMemo is string }')
console.log(`  ${hasAddr ? '(ya existe)' : 'CREATE'} stellarAddress_1`)

if (!CONFIRM) {
  console.log('\n🔍 DRY-RUN — agregá --confirm para aplicar.\n')
  await mongoose.disconnect(); process.exit(0)
}

if (hasOld) { await coll.dropIndex('stellarMemo_1'); console.log('  ✅ drop stellarMemo_1') }
await coll.createIndex(
  { stellarMemo: 1 },
  { unique: true, partialFilterExpression: { stellarMemo: { $type: 'string' } }, name: 'stellarMemo_1' },
)
console.log('  ✅ create stellarMemo_1 (partial unique)')
if (!hasAddr) { await coll.createIndex({ stellarAddress: 1 }, { name: 'stellarAddress_1' }); console.log('  ✅ create stellarAddress_1') }

console.log('\nÍndices resultantes:')
for (const i of await coll.indexes()) console.log('  ', i.name, '| unique=', !!i.unique, '| partial=', !!i.partialFilterExpression)
console.log('')
await mongoose.disconnect()
process.exit(0)
