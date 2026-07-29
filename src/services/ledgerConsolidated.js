/**
 * ledgerConsolidated.js — Consolidación multi-moneda del Libro Mayor (Fase 4)
 *
 * Decisiones de contador (2026-07-28):
 *   §12.3 Moneda funcional = USD, con un balance general en BOB también disponible.
 *   §12.2 Revaluación FX: se manifiesta en la CONSOLIDACIÓN — cada saldo en moneda
 *         distinta de la funcional se traduce a la tasa de cierre; la posición de la
 *         cuenta 1090 (clearing de conversión) traducida ES la posición cambiaria
 *         neta. En un libro nativo multi-moneda NO se postea un asiento de revaluación
 *         (no balancearía entre monedas): la traducción a la funcional al cierre es la
 *         revaluación a efectos de reporte. La realización se cristaliza al fondear.
 *
 * Nota clave: como el libro balancea POR MONEDA, traducir cada moneda a una tasa y
 * sumar preserva el balance (débitos y créditos escalan por la misma tasa). Por eso
 * el balance general consolidado cuadra por construcción, sin plug.
 */

import { aggregateByAccount } from './ledgerReports.js'
import { getAccountDef } from './ledgerService.js'
import JournalLine from '../models/JournalLine.js'
import { getBOBUSDCRate } from './exchangeRateService.js'

const R2 = (n) => +(Number(n) || 0).toFixed(2)

/** Valor en USD de 1 unidad de cada moneda. USDC≈USD=1; BOB=1/bobPerUsdc; XLM=env. */
export async function getUsdPerUnit() {
  let bobPerUsd = parseFloat(process.env.BOB_USD_RATE ?? '9.31')
  try { const r = await getBOBUSDCRate(); if (r > 0) bobPerUsd = r } catch { /* fallback env */ }
  const xlmUsd = parseFloat(process.env.XLM_USD_RATE ?? '0.12')
  return { USD: 1, USDC: 1, BOB: 1 / bobPerUsd, XLM: xlmUsd, _bobPerUsd: bobPerUsd, _xlmUsd: xlmUsd }
}

/**
 * Traduce filas {account,currency,balance} a la moneda funcional y las agrupa en la
 * estructura del balance general consolidado. Puro y testeable.
 * @param {Array<{account,currency,balance}>} rows
 * @param {Object} usdPerUnit  USD por unidad de cada moneda
 * @param {'USD'|'BOB'} functional
 */
export function consolidate(rows, usdPerUnit, functional = 'USD') {
  const fUnit = usdPerUnit[functional]
  if (!fUnit) throw new Error(`moneda funcional no soportada: ${functional}`)
  const toF = (balance, currency) => {
    const u = usdPerUnit[currency]
    if (u == null) throw new Error(`sin tasa para ${currency}`)
    return (Number(balance) || 0) * u / fUnit
  }

  const assets = [], liabilities = [], equity = []
  let income = 0, expense = 0, fxPositionClearing = 0

  for (const r of rows) {
    const def   = getAccountDef(r.account)
    const type  = def?.type
    const value = toF(r.balance, r.currency)
    if (r.account === '1090') fxPositionClearing += value   // posición FX neta (traducida)
    const item = { account: r.account, name: def?.name ?? r.account, value: R2(value) }
    if (type === 'asset')          assets.push(item)
    else if (type === 'liability') liabilities.push(item)
    else if (type === 'equity')    equity.push(item)
    else if (type === 'income')    income += value
    else if (type === 'expense')   expense += value
  }

  // Colapsar cuentas repetidas (misma cuenta en varias monedas) sumando su valor funcional.
  const collapse = (arr) => {
    const m = new Map()
    for (const it of arr) {
      const e = m.get(it.account) ?? { account: it.account, name: it.name, value: 0 }
      e.value = R2(e.value + it.value); m.set(it.account, e)
    }
    return [...m.values()].sort((a, b) => a.account.localeCompare(b.account))
  }
  const A = collapse(assets), L = collapse(liabilities), E = collapse(equity)

  const totalAssets      = R2(A.reduce((s, x) => s + x.value, 0))
  const totalLiabilities = R2(L.reduce((s, x) => s + x.value, 0))
  const totalEquity      = R2(E.reduce((s, x) => s + x.value, 0))
  const result           = R2(income - expense)
  const liabPlusEquity   = R2(totalLiabilities + totalEquity + result)

  return {
    functional,
    assets: A, liabilities: L, equity: E,
    totalAssets, totalLiabilities, totalEquity, result, liabPlusEquity,
    fxPositionClearing: R2(fxPositionClearing),
    balanced: Math.abs(totalAssets - liabPlusEquity) < 0.01,
  }
}

/** Balance general consolidado en la moneda funcional (default USD; también BOB). */
export async function consolidatedBalanceSheet({ functional = 'USD', entity } = {}) {
  const match = entity ? { entity } : {}
  const lines = await JournalLine.find(match).select('account currency debit credit').lean()
  const rows  = aggregateByAccount(lines)
  const usdPerUnit = await getUsdPerUnit()
  const bs = consolidate(rows, usdPerUnit, functional)
  return {
    cutAt: new Date().toISOString(),
    rates: { bobPerUsd: R2(usdPerUnit._bobPerUsd), xlmUsd: usdPerUnit._xlmUsd },
    ...bs,
  }
}

export default { getUsdPerUnit, consolidate, consolidatedBalanceSheet }
