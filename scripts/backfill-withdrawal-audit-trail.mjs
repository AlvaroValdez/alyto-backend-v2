/**
 * backfill-withdrawal-audit-trail.mjs
 *
 * Registra el audit trail Stellar (Dual-Ledger ASFI) de los retiros BOB que quedaron
 * COMPLETADOS pero con stellarTxId = null, porque el flujo de retiro no lo disparaba
 * (bug corregido en walletController: fireAuditTrail en confirm + settle).
 *
 * ⚠️ Registra una transacción ON-CHAIN real con la cuenta SRL. La red la determina
 *    STELLAR_NETWORK del .env (prod = mainnet). Idempotente: solo toca retiros sin hash.
 *
 * Uso:
 *   node scripts/backfill-withdrawal-audit-trail.mjs              # DRY RUN (staging)
 *   node scripts/backfill-withdrawal-audit-trail.mjs --prod       # DRY RUN sobre alyto-v2
 *   node scripts/backfill-withdrawal-audit-trail.mjs --prod --apply        # aplica en prod
 *   node scripts/backfill-withdrawal-audit-trail.mjs --prod --apply --wtx=WTX-...  # uno solo
 */
import 'dotenv/config'                                  // debe ir PRIMERO (mainnet creds)
import mongoose from 'mongoose'
import { registerAuditTrail } from '../src/services/stellarService.js'

const args  = process.argv.slice(2)
const PROD  = args.includes('--prod')
const APPLY = args.includes('--apply')
const ONLY  = (args.find(a => a.startsWith('--wtx=')) ?? '').split('=')[1] || null

const BASE = process.env.MONGODB_URI
if (!BASE) { console.error('❌ MONGODB_URI no definido'); process.exit(1) }
const URI = PROD ? BASE.replace('/alyto-v2-staging?', '/alyto-v2?') : BASE

async function main() {
  await mongoose.connect(URI)
  const db = mongoose.connection.db
  console.log(`\n🗄️  DB: ${db.databaseName}  |  Stellar: ${process.env.STELLAR_NETWORK}  |  modo: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (PROD && db.databaseName !== 'alyto-v2') {
    console.error('❌ Se pidió --prod pero la DB no es alyto-v2. Abortando.'); process.exit(1)
  }

  const filter = {
    type:   'withdrawal',
    status: 'completed',
    stellarTxId: { $in: [null, '', undefined] },
    ...(ONLY ? { wtxId: ONLY } : {}),
  }
  const pendientes = await db.collection('wallettransactions').find(filter).toArray()
  console.log(`\n🔎 Retiros completados sin stellarTxId: ${pendientes.length}`)
  pendientes.forEach(w => console.log(`   • ${w.wtxId} | Bs.${w.amount} | ${w.description ?? ''}`))

  if (!APPLY) {
    console.log('\nℹ️  DRY RUN — no se registró nada. Añade --apply para escribir on-chain.\n')
    process.exit(0)
  }

  let ok = 0, fail = 0
  for (const w of pendientes) {
    process.stdout.write(`\n→ ${w.wtxId} … `)
    const hash = await registerAuditTrail({ alytoTransactionId: w.wtxId, legalEntity: 'SRL' })
    if (hash) {
      await db.collection('wallettransactions').updateOne({ _id: w._id }, { $set: { stellarTxId: hash } })
      console.log(`✅ ${hash}`); ok++
    } else {
      console.log('❌ registerAuditTrail devolvió null (no se escribió)'); fail++
    }
  }
  console.log(`\n=== Backfill terminado: ${ok} ok, ${fail} fallidos ===\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1) })
