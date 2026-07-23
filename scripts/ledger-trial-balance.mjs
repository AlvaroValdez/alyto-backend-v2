/**
 * ledger-trial-balance.mjs — Balance de comprobación + reconciliación del GL.
 *
 * Imprime:
 *   1. Balance de comprobación: saldo por cuenta/moneda + verificación Σdébito=Σcrédito.
 *   2. Reconciliación de cuentas de control: GL vs saldos reales de wallets.
 *   3. Reconciliación on-chain: GL vs tesorería/custodia/channel (Horizon).
 *
 * Solo LECTURA. Uso:
 *   node scripts/ledger-trial-balance.mjs [--entity SRL]
 */

import * as dotenv from 'dotenv'
dotenv.config()
import mongoose from 'mongoose'
import { trialBalance, reconcileControlAccounts } from '../src/services/ledgerReports.js'

const args   = process.argv.slice(2)
const entity = args.includes('--entity') ? args[args.indexOf('--entity') + 1] : undefined

const URI = process.env.MONGODB_URI
if (!URI) { console.error('❌ MONGODB_URI no definida.'); process.exit(1) }

await mongoose.connect(URI)
console.log(`[trial] DB: ${mongoose.connection.db.databaseName}${entity ? ` · entity: ${entity}` : ''}\n`)

// 1. Balance de comprobación
const tb = await trialBalance({ entity })
console.log('═══ BALANCE DE COMPROBACIÓN ═══')
console.log('Cuenta  Moneda        Débito         Crédito          Saldo')
for (const r of tb.rows) {
  console.log(`${r.account.padEnd(6)}  ${r.currency.padEnd(4)}  ${String(r.debit).padStart(14)}  ${String(r.credit).padStart(14)}  ${String(r.balance).padStart(14)}`)
}
console.log(`\nLíneas: ${tb.lineCount}`)
console.log('Balanceo por moneda:')
for (const b of tb.balanced) console.log(`  ${b.currency}: débito ${b.debit} vs crédito ${b.credit} → ${b.ok ? 'OK ✅' : `DESCUADRE (${b.diff}) ❌`}`)
console.log(`Global: ${tb.allBalanced ? 'CUADRADO ✅' : 'DESCUADRADO ❌'}`)

// 2 + 3. Reconciliación
const rec = await reconcileControlAccounts({ entity })
console.log('\n═══ RECONCILIACIÓN CUENTAS DE CONTROL (GL vs wallets) ═══')
console.log('Cuenta  Campo             GL          Real         Δ')
for (const c of rec.control) {
  console.log(`${c.account.padEnd(6)}  ${c.field.padEnd(15)}  ${String(c.gl).padStart(10)}  ${String(c.actual).padStart(10)}  ${String(c.delta).padStart(8)}  ${c.ok ? '✅' : '❌'}`)
}
console.log(`Control: ${rec.controlOk ? 'RECONCILIADO ✅' : 'CON DESVÍOS ❌'}`)

console.log('\n═══ RECONCILIACIÓN ON-CHAIN (GL vs Horizon) ═══')
for (const o of rec.onchain) {
  const status = o.ok == null ? '— (sin dato on-chain)' : (o.ok ? '✅' : '❌')
  console.log(`${o.account.padEnd(6)}  ${o.label.padEnd(16)}  GL=${String(o.gl).padStart(10)}  chain=${o.actual ?? 'N/D'}  ${status}`)
}

await mongoose.connection.close()
