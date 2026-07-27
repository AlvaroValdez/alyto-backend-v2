/**
 * ledgerStatements.test.js — Estados financieros del Libro Mayor (Fase 3, puras).
 */

import '../setup.env.js'
import { groupBalanceSheet, runningBalance } from '../../src/services/ledgerStatements.js'

describe('groupBalanceSheet', () => {
  test('agrupa por tipo y cumple Activo = Pasivo + Patrimonio + Resultado', () => {
    const bs = groupBalanceSheet([
      { account: '1010', currency: 'USDC', balance: 100 },  // activo
      { account: '2020', currency: 'USDC', balance: 90 },   // pasivo
      { account: '4050', currency: 'USDC', balance: 10 },   // ingreso → resultado
    ])
    expect(bs.USDC.totalAssets).toBe(100)
    expect(bs.USDC.totalLiabilities).toBe(90)
    expect(bs.USDC.result).toBe(10)          // ingreso 10 − gasto 0
    expect(bs.USDC.liabPlusEquity).toBe(100) // 90 + 0 + 10
    expect(bs.USDC.balanced).toBe(true)
  })

  test('resta gastos del resultado', () => {
    const bs = groupBalanceSheet([
      { account: '1030', currency: 'BOB', balance: 100 },   // activo
      { account: '4020', currency: 'BOB', balance: 30 },    // ingreso
      { account: '5040', currency: 'BOB', balance: 20 },    // gasto
      { account: '2010', currency: 'BOB', balance: 90 },    // pasivo
    ])
    expect(bs.BOB.result).toBe(10)           // 30 − 20
    expect(bs.BOB.liabPlusEquity).toBe(100)  // 90 + 0 + 10
    expect(bs.BOB.balanced).toBe(true)
  })

  test('separa por moneda', () => {
    const bs = groupBalanceSheet([
      { account: '1010', currency: 'USDC', balance: 5 },
      { account: '1030', currency: 'BOB',  balance: 7 },
    ])
    expect(bs.USDC.totalAssets).toBe(5)
    expect(bs.BOB.totalAssets).toBe(7)
  })
})

describe('runningBalance', () => {
  test('cuenta deudora: +débito −crédito', () => {
    const r = runningBalance([{ debit: 100, credit: 0 }, { debit: 0, credit: 30 }], 'debit')
    expect(r.map(x => x.running)).toEqual([100, 70])
  })
  test('cuenta acreedora: +crédito −débito', () => {
    const r = runningBalance([{ debit: 0, credit: 100 }, { debit: 30, credit: 0 }], 'credit')
    expect(r.map(x => x.running)).toEqual([100, 70])
  })
  test('respeta el saldo de apertura', () => {
    const r = runningBalance([{ debit: 50, credit: 0 }], 'debit', 200)
    expect(r[0].running).toBe(250)
  })
})
