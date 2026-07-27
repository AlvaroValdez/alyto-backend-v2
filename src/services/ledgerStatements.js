/**
 * ledgerStatements.js — Estados financieros del Libro Mayor (Fase 3)
 *
 * Reportes derivados del GL, por moneda (multi-moneda nativo; la moneda funcional
 * de consolidación es decisión §12.3, pendiente — aquí se reporta por moneda):
 *   - balanceSheet()      → balance general (activo = pasivo + patrimonio + resultado)
 *   - incomeStatement()   → estado de resultados (P&L) por período
 *   - treasuryStatement() → estado de cuenta de una cuenta con saldo corriente
 *
 * Builders puros (groupBalanceSheet, runningBalance) testeables sin DB.
 */

import JournalEntry from '../models/JournalEntry.js'
import JournalLine  from '../models/JournalLine.js'
import { getAccountDef } from './ledgerService.js'
import { aggregateByAccount } from './ledgerReports.js'

const R7  = (n) => +(Number(n) || 0).toFixed(7)
const EPS = 1e-6

// ═══════════════════════════════════════════════════════════════════════════
// PURAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Agrupa filas {account,currency,balance} (de aggregateByAccount) en la estructura
 * del balance general por moneda. El resultado del período (ingreso−gasto) se
 * incluye dentro de patrimonio para que cuadre: Activo = Pasivo + Patrimonio + Resultado.
 * @returns {Object<string,object>} por moneda
 */
export function groupBalanceSheet(rows) {
  const byCur = {}
  const bucket = (cur) => (byCur[cur] ??= {
    assets: [], liabilities: [], equity: [], income: 0, expense: 0,
  })

  for (const r of rows) {
    const def  = getAccountDef(r.account)
    const type = def?.type
    const item = { account: r.account, name: def?.name ?? r.account, balance: R7(r.balance) }
    const b = bucket(r.currency)
    if (type === 'asset')     b.assets.push(item)
    else if (type === 'liability') b.liabilities.push(item)
    else if (type === 'equity')    b.equity.push(item)
    else if (type === 'income')    b.income  += r.balance
    else if (type === 'expense')   b.expense += r.balance
  }

  const out = {}
  for (const [cur, b] of Object.entries(byCur)) {
    const totalAssets      = R7(b.assets.reduce((s, x) => s + x.balance, 0))
    const totalLiabilities = R7(b.liabilities.reduce((s, x) => s + x.balance, 0))
    const totalEquity      = R7(b.equity.reduce((s, x) => s + x.balance, 0))
    const result           = R7(b.income - b.expense)   // resultado del período (dentro de patrimonio)
    const liabPlusEquity   = R7(totalLiabilities + totalEquity + result)
    out[cur] = {
      assets: b.assets, liabilities: b.liabilities, equity: b.equity,
      totalAssets, totalLiabilities, totalEquity, result, liabPlusEquity,
      balanced: Math.abs(totalAssets - liabPlusEquity) < EPS,
    }
  }
  return out
}

/**
 * Calcula el saldo corriente de una secuencia de movimientos de UNA cuenta,
 * respetando su lado normal (deudor: +débito −crédito; acreedor: al revés).
 * @param {Array<{debit,credit}>} movs  en orden cronológico
 * @param {'debit'|'credit'} normalSide
 * @param {number} [opening=0]
 * @returns {Array<{...mov, running}>}
 */
export function runningBalance(movs, normalSide, opening = 0) {
  let bal = Number(opening) || 0
  return movs.map((m) => {
    const d = Number(m.debit) || 0, c = Number(m.credit) || 0
    bal += normalSide === 'debit' ? (d - c) : (c - d)
    return { ...m, running: R7(bal) }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// CON DB
// ═══════════════════════════════════════════════════════════════════════════

/** Mapa entryId → {date, description} para las entradas de un rango/entidad. */
async function entryIndex({ from, to, entity } = {}) {
  const q = {}
  if (entity) q.entity = entity
  if (from || to) { q.date = {}; if (from) q.date.$gte = new Date(from); if (to) q.date.$lte = new Date(to) }
  const entries = await JournalEntry.find(q).select('entryId date description').lean()
  return new Map(entries.map(e => [e.entryId, { date: e.date, description: e.description }]))
}

/** Balance general (as-of-now, acumulado). */
export async function balanceSheet({ entity } = {}) {
  const match = entity ? { entity } : {}
  const lines = await JournalLine.find(match).select('account currency debit credit').lean()
  const rows  = aggregateByAccount(lines)
  return { cutAt: new Date().toISOString(), byCurrency: groupBalanceSheet(rows) }
}

/** Estado de resultados (P&L) por período: cuentas 4xxx (ingreso) y 5xxx (gasto). */
export async function incomeStatement({ from, to, entity } = {}) {
  const idx = await entryIndex({ from, to, entity })
  const ids = [...idx.keys()]
  if (!ids.length) return { from, to, byCurrency: {} }
  const lines = await JournalLine.find({ entryId: { $in: ids }, account: { $regex: /^[45]/ } })
    .select('entryId account currency debit credit').lean()

  const byCur = {}
  for (const l of lines) {
    const def  = getAccountDef(l.account)
    const cur  = l.currency
    const b = (byCur[cur] ??= { income: [], expense: [], _inc: {}, _exp: {} })
    const target = def?.type === 'income' ? '_inc' : '_exp'
    const bal = def?.type === 'income'
      ? (Number(l.credit) || 0) - (Number(l.debit) || 0)
      : (Number(l.debit) || 0) - (Number(l.credit) || 0)
    b[target][l.account] = (b[target][l.account] ?? 0) + bal
  }

  const out = {}
  for (const [cur, b] of Object.entries(byCur)) {
    const income  = Object.entries(b._inc).map(([a, v]) => ({ account: a, name: getAccountDef(a)?.name ?? a, amount: R7(v) }))
    const expense = Object.entries(b._exp).map(([a, v]) => ({ account: a, name: getAccountDef(a)?.name ?? a, amount: R7(v) }))
    const totalIncome  = R7(income.reduce((s, x) => s + x.amount, 0))
    const totalExpense = R7(expense.reduce((s, x) => s + x.amount, 0))
    out[cur] = { income, expense, totalIncome, totalExpense, netResult: R7(totalIncome - totalExpense) }
  }
  return { from, to, byCurrency: out }
}

/** Estado de cuenta de UNA cuenta con saldo corriente (movimientos ordenados por fecha). */
export async function treasuryStatement({ account, from, to, entity, limit = 500 } = {}) {
  const def = getAccountDef(account)
  if (!def) throw new Error(`Cuenta desconocida: ${account}`)
  const idx = await entryIndex({ from, to, entity })
  const ids = [...idx.keys()]

  const lineQ = { account }
  if (ids.length) lineQ.entryId = { $in: ids }
  const lines = await JournalLine.find(lineQ).select('entryId currency debit credit dims').lean()

  const movs = lines
    .map(l => ({
      entryId: l.entryId,
      date: idx.get(l.entryId)?.date ?? null,
      description: idx.get(l.entryId)?.description ?? '',
      currency: l.currency,
      debit: R7(l.debit), credit: R7(l.credit),
      sourceTxId: l.dims?.sourceTxId ?? null,
    }))
    .filter(m => m.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, limit)

  return {
    account, name: def.name, normalSide: def.normalSide, currency: def.currency,
    movements: runningBalance(movs, def.normalSide),
  }
}

export default { groupBalanceSheet, runningBalance, balanceSheet, incomeStatement, treasuryStatement }
