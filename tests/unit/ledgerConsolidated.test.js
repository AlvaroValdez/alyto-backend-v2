/**
 * ledgerConsolidated.test.js — Consolidación multi-moneda (Fase 4, puras).
 * Verifica que traducir a la moneda funcional preserva el balance (cuadra por
 * construcción) y que la posición FX de 1090 se traduce correctamente.
 */

import '../setup.env.js'
import { consolidate } from '../../src/services/ledgerConsolidated.js'

// BOB a 8 por USD → USD por BOB = 0.125. USDC≈USD=1.
const RATES = { USD: 1, USDC: 1, BOB: 0.125, XLM: 0.10 }

describe('consolidate', () => {
  test('USD funcional: traduce y cuadra (activo = pasivo + patrimonio + resultado)', () => {
    const bs = consolidate([
      { account: '1010', currency: 'USDC', balance: 100 },  // activo USDC → USD 100
      { account: '1030', currency: 'BOB',  balance: 800 },  // activo BOB  → USD 100
      { account: '2020', currency: 'USDC', balance: 100 },  // pasivo USDC → USD 100
      { account: '2010', currency: 'BOB',  balance: 800 },  // pasivo BOB  → USD 100
    ], RATES, 'USD')
    expect(bs.functional).toBe('USD')
    expect(bs.totalAssets).toBe(200)
    expect(bs.liabPlusEquity).toBe(200)
    expect(bs.balanced).toBe(true)
    expect(bs.assets.find(a => a.account === '1030').value).toBe(100)  // 800 BOB → 100 USD
  })

  test('BOB funcional: el mismo libro cuadra traducido a BOB', () => {
    const bs = consolidate([
      { account: '1010', currency: 'USDC', balance: 100 },  // → 800 BOB
      { account: '2010', currency: 'BOB',  balance: 800 },  // 800 BOB
    ], RATES, 'BOB')
    expect(bs.functional).toBe('BOB')
    expect(bs.assets.find(a => a.account === '1010').value).toBe(800)   // 100 USDC → 800 BOB
    expect(bs.balanced).toBe(true)
  })

  test('posición FX de 1090 = valor funcional neto de la cuenta clearing', () => {
    const bs = consolidate([
      { account: '1090', currency: 'USDC', balance: 99 },   // +99 USD
      { account: '1090', currency: 'BOB',  balance: -800 }, // −100 USD
    ], RATES, 'USD')
    expect(bs.fxPositionClearing).toBe(-1)   // 99 − 100
  })

  test('el resultado consolidado suma ingresos menos gastos traducidos', () => {
    const bs = consolidate([
      { account: '4060', currency: 'BOB', balance: 80 },   // ingreso → USD 10
      { account: '5040', currency: 'BOB', balance: 16 },   // gasto   → USD 2
    ], RATES, 'USD')
    expect(bs.result).toBe(8)   // 10 − 2
  })

  test('colapsa la misma cuenta en varias monedas sumando su valor funcional', () => {
    const bs = consolidate([
      { account: '1010', currency: 'USDC', balance: 50 },
      { account: '1010', currency: 'USDC', balance: 50 },
    ], RATES, 'USD')
    expect(bs.assets.filter(a => a.account === '1010').length).toBe(1)
    expect(bs.assets.find(a => a.account === '1010').value).toBe(100)
  })
})
