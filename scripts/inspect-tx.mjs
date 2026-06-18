// scripts/inspect-tx.mjs
// Estado de una transacción cross-border: status, audit trail Stellar, PDF, ipnLog.
// Read-only.
//   node scripts/inspect-tx.mjs production ALY-C-1781760497164-3KSXZ0
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const TXID     = process.argv[3]

if (!TARGET || !['staging', 'production'].includes(TARGET) || !TXID) {
  console.error('❌ Uso: node scripts/inspect-tx.mjs staging|production <alytoTransactionId>')
  process.exit(1)
}
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db = mongoose.connection.db
console.log(`DB: ${db.databaseName}\n`)

const t = await db.collection('transactions').findOne({ alytoTransactionId: TXID })
if (!t) { console.log(`NO encontrada: ${TXID}`); await mongoose.disconnect(); process.exit(0) }

console.log(`alytoTransactionId:  ${t.alytoTransactionId}`)
console.log(`status:              ${t.status}`)
console.log(`legalEntity:         ${t.legalEntity}`)
console.log(`originalAmount:      ${t.originalAmount} ${t.originCurrency}`)
console.log(`destinationAmount:   ${t.destinationAmount} ${t.destinationCurrency}`)
console.log(`digitalAssetAmount:  ${t.digitalAssetAmount} USDC`)
console.log(`stellarTxId (audit): ${t.stellarTxId ?? '(sin audit trail)'}`)
console.log(`comprobanteUrl:      ${t.boliviaCompliance?.comprobanteUrl ?? '(sin PDF)'}`)
console.log(`numeroComprobante:   ${t.boliviaCompliance?.numeroComprobante ?? '—'}`)
console.log(`harborTransferId:    ${t.harborTransferId ?? t.payinReference ?? '—'}`)
console.log(`harborStatus:        ${t.harborStatus ?? t.owlPayStatus ?? '—'}`)
console.log(`\nipnLog (webhooks recibidos):`)
for (const l of (t.ipnLog ?? [])) {
  console.log(`  - ${l.provider}:${l.eventType}  (status=${l.status})  @ ${l.receivedAt ? new Date(l.receivedAt).toISOString() : '?'}`)
}
if (!(t.ipnLog ?? []).length) console.log('  (ninguno)')

await mongoose.disconnect()
process.exit(0)
