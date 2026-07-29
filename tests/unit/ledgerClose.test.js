/**
 * ledgerClose.test.js — Storno y cierre de período (Fase 4, puras).
 */

import '../setup.env.js'
import { buildReversalLines, buildClosingLines } from '../../src/services/ledgerClose.js'
import { assertBalanced, assertAccountsKnown } from '../../src/services/ledgerService.js'

describe('buildReversalLines', () => {
  test('invierte débito↔crédito y conserva cuenta/moneda', () => {
    const rev = buildReversalLines([
      { account: '1030', currency: 'BOB', debit: 100, credit: 0, dims: { userId: 'u' } },
      { account: '2010', currency: 'BOB', debit: 0, credit: 100 },
    ])
    expect(rev[0]).toMatchObject({ account: '1030', currency: 'BOB', debit: 0, credit: 100 })
    expect(rev[1]).toMatchObject({ account: '2010', currency: 'BOB', debit: 100, credit: 0 })
    expect(rev[0].dims).toEqual({ userId: 'u' })
  })

  test('la reversa de un asiento balanceado sigue balanceada', () => {
    const original = [
      { account: '2010', currency: 'BOB', debit: 100, credit: 0 },
      { account: '1030', currency: 'BOB', debit: 0, credit: 100 },
    ]
    expect(assertBalanced(buildReversalLines(original))).toBe(true)
  })
})

describe('buildClosingLines', () => {
  test('utilidad: salda ingresos/gastos y acredita el neto a 3090', () => {
    const lines = buildClosingLines([
      { account: '4020', type: 'income',  balance: 30 },
      { account: '5040', type: 'expense', balance: 20 },
    ], 'BOB')
    expect(assertBalanced(lines)).toBe(true)
    expect(assertAccountsKnown(lines)).toBe(true)
    expect(lines.find(l => l.account === '4020').debit).toBe(30)   // ingreso se debita para saldar
    expect(lines.find(l => l.account === '5040').credit).toBe(20)  // gasto se acredita para saldar
    expect(lines.find(l => l.account === '3090').credit).toBe(10)  // utilidad → patrimonio
  })

  test('pérdida: el neto negativo se debita a 3090', () => {
    const lines = buildClosingLines([
      { account: '4010', type: 'income',  balance: 10 },
      { account: '5040', type: 'expense', balance: 30 },
    ], 'BOB')
    expect(assertBalanced(lines)).toBe(true)
    expect(lines.find(l => l.account === '3090').debit).toBe(20)   // pérdida
  })

  test('sin ingresos ni gastos → null (nada que cerrar)', () => {
    expect(buildClosingLines([], 'BOB')).toBeNull()
    expect(buildClosingLines([{ account: '2010', type: 'liability', balance: 100 }], 'BOB')).toBeNull()
  })

  test('solo ingresos (sin gastos): utilidad = total ingresos', () => {
    const lines = buildClosingLines([{ account: '4050', type: 'income', balance: 5 }], 'USDC')
    expect(assertBalanced(lines)).toBe(true)
    expect(lines.find(l => l.account === '3090').credit).toBe(5)
  })
})
