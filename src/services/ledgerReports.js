/**
 * ledgerReports.js — Reportes y reconciliación del Libro Mayor (Fase 1)
 *
 * - aggregateByAccount(lines)      — puro: saldo por cuenta/moneda desde líneas
 * - buildOpeningBalanceLines(snap) — puro: asiento de saldos de apertura balanceado
 * - trialBalance()                 — balance de comprobación (Σdébito=Σcrédito por moneda)
 * - captureWalletSnapshot()        — foto de saldos de wallets + on-chain
 * - reconcileControlAccounts()     — GL vs saldos reales de wallets vs on-chain
 *
 * Contexto: un sistema en marcha con historia de movimientos incompleta no se
 * reconcilia reproduciendo el pasado; se arranca con un ASIENTO DE APERTURA que
 * fija los saldos actuales, y desde ahí se postea forward (Fase 2). Ver
 * docs/PLAN_LIBRO_MAYOR_CONTABILIDAD.md §8.
 */

import JournalLine from '../models/JournalLine.js'
import WalletBOB   from '../models/WalletBOB.js'
import WalletUSDC  from '../models/WalletUSDC.js'
import { getAccountDef, assertBalanced } from './ledgerService.js'
import { getUSDCAvailableNow, getCustodialUSDCBacking } from './treasuryLiquidity.js'
import { getStellarXLMBalance } from './stellarService.js'

const R7 = (n) => +(Number(n) || 0).toFixed(7)

/** Cuenta de apertura/plug multi-moneda (patrimonio). */
const OPENING_EQUITY = '3010'

/**
 * Mapa cuenta de control → campo de wallet, para reconciliación.
 * ⚠️ `balanceReserved` NO se incluye: es un earmark DENTRO de `balance`
 * (balanceAvailable = balance − balanceReserved), no un pasivo adicional. Por eso
 * no hay cuenta de control 2012/2022 en el pasivo — las reservas no mueven dinero.
 */
export const CONTROL_ACCOUNTS = [
  { code: '2010', currency: 'BOB',  model: 'WalletBOB',  field: 'balance' },
  { code: '2011', currency: 'BOB',  model: 'WalletBOB',  field: 'balanceFrozen' },
  { code: '2020', currency: 'USDC', model: 'WalletUSDC', field: 'balance' },
  { code: '2021', currency: 'USDC', model: 'WalletUSDC', field: 'balanceFrozen' },
]

// ═══════════════════════════════════════════════════════════════════════════
// PURAS (testeables sin DB)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Agrega líneas por (cuenta, moneda): débito, crédito y saldo con signo según el
 * lado normal de la cuenta (deudor = débito−crédito; acreedor = crédito−débito).
 * @returns {Array<{account,currency,debit,credit,balance}>}
 */
export function aggregateByAccount(lines) {
  const map = new Map()
  for (const l of lines) {
    const key = `${l.account}|${l.currency}`
    if (!map.has(key)) map.set(key, { account: l.account, currency: l.currency, debit: 0, credit: 0 })
    const row = map.get(key)
    row.debit  += Number(l.debit)  || 0
    row.credit += Number(l.credit) || 0
  }
  const rows = [...map.values()].map(r => {
    const def  = getAccountDef(r.account)
    const side = def?.normalSide ?? 'debit'
    const balance = side === 'debit' ? r.debit - r.credit : r.credit - r.debit
    return { ...r, debit: R7(r.debit), credit: R7(r.credit), balance: R7(balance) }
  })
  return rows.sort((a, b) => a.account.localeCompare(b.account) || a.currency.localeCompare(b.currency))
}

/**
 * Construye las líneas del asiento de saldos de apertura, balanceado POR MONEDA
 * con la cuenta de patrimonio 3010 como plug. Omite líneas de monto cero.
 *
 * @param {object} s snapshot
 * @param {{balance,frozen,reserved}} s.bob
 * @param {{balance,frozen,reserved}} s.usdc
 * @param {number} s.treasuryUsdc   USDC on-chain tesorería SRL
 * @param {number} s.custodialUsdc  USDC on-chain Σ direcciones custodiales
 * @param {number} [s.channelXlm]   XLM del channel account
 * @param {number} [s.bankBob]      BOB en banco (si se conoce; si no, plug a equity)
 * @returns {Array} lines
 */
export function buildOpeningBalanceLines(s) {
  const lines = []
  const push = (account, currency, debit, credit) => {
    const d = R7(debit), c = R7(credit)
    if (d === 0 && c === 0) return
    lines.push({ account, currency, debit: d, credit: c, dims: { sourceTxId: 'OPENING' } })
  }

  // ── BOB ── pasivo usuarios (crédito) vs banco (débito) + plug equity ──
  // Pasivo = balance + frozen. `reserved` NO se suma: es un earmark dentro de balance.
  const bobLiab   = R7((s.bob?.balance || 0) + (s.bob?.frozen || 0))
  const bankBob   = R7(s.bankBob || 0)
  push('2010', 'BOB', 0, s.bob?.balance || 0)
  push('2011', 'BOB', 0, s.bob?.frozen || 0)
  push('1030', 'BOB', bankBob, 0)
  // plug: equilibra BOB. liab (crédito) vs banco (débito): falta débito = liab−banco.
  const bobPlug = R7(bobLiab - bankBob)
  if (bobPlug > 0) push(OPENING_EQUITY, 'BOB', bobPlug, 0)
  else if (bobPlug < 0) push(OPENING_EQUITY, 'BOB', 0, -bobPlug)

  // ── USDC ── pasivo usuarios (crédito) vs tesorería+custodia (débito) + plug ──
  // Pasivo = balance + frozen (reserved está dentro de balance, no se suma).
  const usdcLiab  = R7((s.usdc?.balance || 0) + (s.usdc?.frozen || 0))
  const usdcAsset = R7((s.treasuryUsdc || 0) + (s.custodialUsdc || 0))
  push('2020', 'USDC', 0, s.usdc?.balance || 0)
  push('2021', 'USDC', 0, s.usdc?.frozen || 0)
  push('1010', 'USDC', s.treasuryUsdc || 0, 0)
  push('1020', 'USDC', s.custodialUsdc || 0, 0)
  // plug: débito total = usdcAsset; crédito total = usdcLiab. diff → equity.
  const usdcPlug = R7(usdcLiab - usdcAsset)
  if (usdcPlug > 0) push(OPENING_EQUITY, 'USDC', usdcPlug, 0)
  else if (usdcPlug < 0) push(OPENING_EQUITY, 'USDC', 0, -usdcPlug)

  // ── XLM ── channel account (débito) vs plug equity (crédito) ──
  const xlm = R7(s.channelXlm || 0)
  if (xlm > 0) {
    push('1015', 'XLM', xlm, 0)
    push(OPENING_EQUITY, 'XLM', 0, xlm)
  }

  return lines
}

// ═══════════════════════════════════════════════════════════════════════════
// CON DB
// ═══════════════════════════════════════════════════════════════════════════

/** Foto de saldos de wallets (agregado) + on-chain, para apertura y reconciliación. */
export async function captureWalletSnapshot({ entity = 'SRL' } = {}) {
  const [bobAgg, usdcAgg, treasury, custodial] = await Promise.all([
    WalletBOB.aggregate([{ $group: { _id: null, balance: { $sum: '$balance' }, frozen: { $sum: '$balanceFrozen' }, reserved: { $sum: '$balanceReserved' }, n: { $sum: 1 } } }]),
    WalletUSDC.aggregate([{ $group: { _id: null, balance: { $sum: '$balance' }, frozen: { $sum: '$balanceFrozen' }, reserved: { $sum: '$balanceReserved' }, n: { $sum: 1 } } }]),
    getUSDCAvailableNow(entity).catch(() => ({ treasury: null })),
    getCustodialUSDCBacking().catch(() => ({ sum: null, partial: true })),
  ])
  const bob  = bobAgg[0]  ?? { balance: 0, frozen: 0, reserved: 0, n: 0 }
  const usdc = usdcAgg[0] ?? { balance: 0, frozen: 0, reserved: 0, n: 0 }
  let channelXlm = null
  const chan = process.env.STELLAR_MASTER_PUBLIC
  if (chan) channelXlm = await getStellarXLMBalance(chan).catch(() => null)

  return {
    entity,
    bob:  { balance: R7(bob.balance),  frozen: R7(bob.frozen),  reserved: R7(bob.reserved),  wallets: bob.n },
    usdc: { balance: R7(usdc.balance), frozen: R7(usdc.frozen), reserved: R7(usdc.reserved), wallets: usdc.n },
    treasuryUsdc:  treasury?.treasury != null ? R7(treasury.treasury) : null,
    custodialUsdc: custodial?.sum != null ? R7(custodial.sum) : null,
    custodialPartial: !!custodial?.partial,
    channelXlm: channelXlm != null ? R7(channelXlm) : null,
  }
}

/** Balance de comprobación: saldo por cuenta/moneda + verificación Σdébito=Σcrédito por moneda. */
export async function trialBalance({ entity } = {}) {
  const match = entity ? { entity } : {}
  const lines = await JournalLine.find(match).select('account currency debit credit').lean()
  const rows = aggregateByAccount(lines)

  const byCur = {}
  for (const l of lines) {
    const c = l.currency
    if (!byCur[c]) byCur[c] = { debit: 0, credit: 0 }
    byCur[c].debit  += Number(l.debit)  || 0
    byCur[c].credit += Number(l.credit) || 0
  }
  const balanced = Object.entries(byCur).map(([currency, v]) => ({
    currency, debit: R7(v.debit), credit: R7(v.credit), diff: R7(v.debit - v.credit),
    ok: Math.abs(v.debit - v.credit) < 1e-6,
  }))

  return { rows, balanced, allBalanced: balanced.every(b => b.ok), lineCount: lines.length }
}

/** Reconcilia las cuentas de control del GL contra los saldos reales de wallets y on-chain. */
export async function reconcileControlAccounts({ entity } = {}) {
  const snap  = await captureWalletSnapshot({ entity: entity ?? 'SRL' })
  const match = entity ? { entity } : {}
  const lines = await JournalLine.find(match).select('account currency debit credit').lean()
  const rows  = aggregateByAccount(lines)
  const glBal = (code, currency) => rows.find(r => r.account === code && r.currency === currency)?.balance ?? 0

  const walletField = { WalletBOB: snap.bob, WalletUSDC: snap.usdc }
  const fieldKey    = { balance: 'balance', balanceFrozen: 'frozen', balanceReserved: 'reserved' }

  const control = CONTROL_ACCOUNTS.map(c => {
    const actual = walletField[c.model][fieldKey[c.field]] ?? 0
    const gl     = glBal(c.code, c.currency)
    const delta  = R7(gl - actual)
    return { account: c.code, currency: c.currency, field: c.field, gl: R7(gl), actual: R7(actual), delta, ok: Math.abs(delta) < 1e-6 }
  })

  const onchain = [
    { account: '1010', currency: 'USDC', label: 'Tesorería USDC', gl: glBal('1010', 'USDC'), actual: snap.treasuryUsdc },
    { account: '1020', currency: 'USDC', label: 'Custodia USDC',  gl: glBal('1020', 'USDC'), actual: snap.custodialUsdc },
    { account: '1015', currency: 'XLM',  label: 'Channel XLM',    gl: glBal('1015', 'XLM'),  actual: snap.channelXlm },
  ].map(o => ({ ...o, gl: R7(o.gl), actual: o.actual != null ? R7(o.actual) : null, delta: o.actual != null ? R7(o.gl - o.actual) : null, ok: o.actual != null ? Math.abs(o.gl - o.actual) < 1e-6 : null }))

  return { snapshot: snap, control, onchain, controlOk: control.every(c => c.ok) }
}

export { assertBalanced }
export default { aggregateByAccount, buildOpeningBalanceLines, trialBalance, captureWalletSnapshot, reconcileControlAccounts, CONTROL_ACCOUNTS }
