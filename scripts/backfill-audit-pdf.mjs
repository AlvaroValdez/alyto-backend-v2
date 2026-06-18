// scripts/backfill-audit-pdf.mjs
// Backfill de audit trail Stellar + comprobante PDF para tx SRL ya 'completed'
// que quedaron sin ellos (ej. completadas por el job reconcile antes del fix).
//
// ⚠️ registerAuditTrail hace una tx ON-CHAIN real (memo, paga XLM del channel).
// generateComprobanteOnCompletion genera PDF + sube a S3/R2 (idempotente).
//
//   node scripts/backfill-audit-pdf.mjs production ALY-C-1781760497164-3KSXZ0            # dry-run (1 tx)
//   node scripts/backfill-audit-pdf.mjs production ALY-C-1781760497164-3KSXZ0 --confirm
//   node scripts/backfill-audit-pdf.mjs production --confirm   # bulk: todas las SRL completed sin audit/PDF (límite 25)
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()
import Transaction from '../src/models/Transaction.js'
import { registerAuditTrail } from '../src/services/stellarService.js'
import { generateComprobanteOnCompletion } from '../src/controllers/ipnController.js'

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const TXID     = process.argv.slice(3).find(a => a.startsWith('ALY-'))
const CONFIRM  = process.argv.includes('--confirm')

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/backfill-audit-pdf.mjs staging|production [ALY-...] [--confirm]')
  process.exit(1)
}
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
console.log(`\n⚠️  OBJETIVO: ${TARGET.toUpperCase()} — DB: "${mongoose.connection.db.databaseName}"`)
if (TARGET === 'production' && mongoose.connection.db.databaseName !== 'alyto-v2') { console.error('❌ DB inesperada'); process.exit(1) }

const query = TXID
  ? { alytoTransactionId: TXID }
  : {
      legalEntity: 'SRL',
      status: 'completed',
      $or: [
        { stellarTxId: { $in: [null, undefined, ''] } },
        { 'boliviaCompliance.comprobanteUrl': { $in: [null, undefined, ''] } },
      ],
    }

const txs = await Transaction.find(query).sort({ createdAt: -1 }).limit(TXID ? 1 : 25)
console.log(`\n${txs.length} tx encontrada(s):`)
for (const tx of txs) {
  const needAudit = !tx.stellarTxId
  const needPdf   = !tx.boliviaCompliance?.comprobanteUrl
  console.log(`  - ${tx.alytoTransactionId}  status=${tx.status}  audit=${needAudit ? 'FALTA' : 'ok'}  pdf=${needPdf ? 'FALTA' : 'ok'}`)
}

if (!CONFIRM) {
  console.log('\n🟡 DRY-RUN — no se generó nada. Re-ejecutá con --confirm para procesar.')
  await mongoose.disconnect(); process.exit(0)
}

for (const tx of txs) {
  if (tx.status !== 'completed') { console.log(`\n${tx.alytoTransactionId}: skip (status=${tx.status}, no completed)`); continue }
  console.log(`\n▶ ${tx.alytoTransactionId}`)
  if (!tx.stellarTxId) {
    try {
      const id = await registerAuditTrail(tx)
      if (id) { tx.stellarTxId = id; await tx.save(); console.log(`  ✅ audit trail: ${id}`) }
      else console.log('  ⚠️ registerAuditTrail no devolvió txId')
    } catch (e) { console.error('  ❌ audit error:', e.message) }
  } else console.log('  audit ya existe:', tx.stellarTxId)

  if (!tx.boliviaCompliance?.comprobanteUrl) {
    try { await generateComprobanteOnCompletion(tx); console.log('  ✅ comprobante PDF generado') }
    catch (e) { console.error('  ❌ PDF error:', e.message) }
  } else console.log('  PDF ya existe')
}

await mongoose.disconnect()
process.exit(0)
