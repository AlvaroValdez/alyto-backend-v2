/**
 * ledger-opening-balance.mjs — Asiento de saldos de apertura del Libro Mayor.
 *
 * Toma una FOTO de los saldos actuales (wallets BOB/USDC + tesorería/custodia
 * on-chain + channel XLM) y postea UN asiento de apertura balanceado por moneda,
 * con la cuenta 3010 como plug. A partir de ese punto el GL se postea forward.
 *
 * Idempotente: sourceType='manual', sourceRef fijo 'OPENING-<entity>'. Correrlo
 * de nuevo NO duplica (devuelve el asiento existente). Para reabrir con otra foto,
 * primero hay que reversar el asiento anterior (no lo hace este script).
 *
 * Uso:
 *   node scripts/ledger-opening-balance.mjs                 # DRY-RUN (no postea)
 *   node scripts/ledger-opening-balance.mjs --commit        # postea el asiento
 *   node scripts/ledger-opening-balance.mjs --commit --bank-bob 12000 --entity SRL
 */

import * as dotenv from 'dotenv'
dotenv.config()
import mongoose from 'mongoose'
import { captureWalletSnapshot, buildOpeningBalanceLines } from '../src/services/ledgerReports.js'
import { postEntry, assertBalanced, summarizeByCurrency, syncChartOfAccounts } from '../src/services/ledgerService.js'

const args   = process.argv.slice(2)
const COMMIT = args.includes('--commit')
const entity = (args[args.indexOf('--entity') + 1] && args.includes('--entity')) ? args[args.indexOf('--entity') + 1] : 'SRL'
const bankArg = args.includes('--bank-bob') ? Number(args[args.indexOf('--bank-bob') + 1]) : null
const vitaArg = args.includes('--vita-usd') ? Number(args[args.indexOf('--vita-usd') + 1]) : null

const URI = process.env.MONGODB_URI
if (!URI) { console.error('❌ MONGODB_URI no definida.'); process.exit(1) }

await mongoose.connect(URI)
console.log(`[opening] DB: ${mongoose.connection.db.databaseName} · entity: ${entity} · modo: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}`)

// Asegura que el catálogo exista antes de postear.
await syncChartOfAccounts()

const snap = await captureWalletSnapshot({ entity })
snap.bankBob = bankArg
console.log('\n[opening] Foto de saldos:')
console.log(`  BOB  usuarios: balance=${snap.bob.balance} frozen=${snap.bob.frozen} reserved=${snap.bob.reserved} (${snap.bob.wallets} wallets)`)
console.log(`  USDC usuarios: balance=${snap.usdc.balance} frozen=${snap.usdc.frozen} reserved=${snap.usdc.reserved} (${snap.usdc.wallets} wallets)`)
console.log(`  Tesorería USDC on-chain: ${snap.treasuryUsdc ?? 'N/D'}`)
console.log(`  Custodia USDC on-chain:  ${snap.custodialUsdc ?? 'N/D'}${snap.custodialPartial ? ' (parcial — fetch incompleto)' : ''}`)
console.log(`  Channel XLM: ${snap.channelXlm ?? 'N/D'}`)
console.log(`  Banco BOB (input): ${bankArg ?? 'N/D — se plug a patrimonio 3010'}`)
if (vitaArg != null) console.log(`  Vita USD (input): ${vitaArg} — nota: la cuenta 1040 se cablea cuando se defina su conciliación`)

const lines = buildOpeningBalanceLines(snap)
console.log('\n[opening] Líneas del asiento de apertura:')
for (const l of lines) {
  const side = l.debit > 0 ? `D ${l.debit}` : `H ${l.credit}`
  console.log(`  ${l.account}  ${l.currency.padEnd(4)}  ${side}`)
}

// Verificación de balanceo por moneda (falla ruidosamente si algo no cuadra).
assertBalanced(lines)
console.log('\n[opening] Balanceo por moneda:', JSON.stringify(summarizeByCurrency(lines)))

if (!COMMIT) {
  console.log('\n[opening] DRY-RUN — no se posteó nada. Reejecuta con --commit para postear.')
  await mongoose.connection.close()
  process.exit(0)
}

const entry = await postEntry({
  entity,
  sourceType: 'manual',
  sourceRef: `OPENING-${entity}`,
  posturePurpose: 'opening',
  description: `Saldos de apertura ${entity}`,
  postedBy: 'system:opening',
  lines,
})
console.log(`\n[opening] ✅ Asiento de apertura posteado: ${entry.entryId}`)

await mongoose.connection.close()
console.log('[opening] Conexión cerrada.')
