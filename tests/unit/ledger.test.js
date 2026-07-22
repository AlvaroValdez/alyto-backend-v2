/**
 * ledger.test.js — Lógica pura del Libro Mayor (Fase 0).
 *
 * Cubre lo que, si falla en silencio, corrompe la contabilidad: el balanceo de
 * doble entrada por moneda, la validación de cuentas/moneda, y que las
 * conversiones cross-currency (§6) balanceen en cada moneda por separado.
 */

import '../setup.env.js'
import {
  assertBalanced,
  assertAccountsKnown,
  summarizeByCurrency,
  CHART_OF_ACCOUNTS,
  LedgerError,
} from '../../src/services/ledgerService.js'

describe('summarizeByCurrency', () => {
  test('agrupa débitos y créditos por moneda', () => {
    const s = summarizeByCurrency([
      { currency: 'BOB', debit: 100 },
      { currency: 'BOB', credit: 60 },
      { currency: 'USDC', debit: 5 },
    ])
    expect(s.BOB).toEqual({ debit: 100, credit: 60 })
    expect(s.USDC).toEqual({ debit: 5, credit: 0 })
  })
})

describe('assertBalanced', () => {
  test('depósito BOB balanceado (mono-moneda) pasa', () => {
    expect(assertBalanced([
      { account: '1030', currency: 'BOB', debit: 100 },
      { account: '2010', currency: 'BOB', credit: 100 },
    ])).toBe(true)
  })

  test('conversión BOB→USDC balancea en CADA moneda por separado (§6)', () => {
    const bobAmount = 696, swap = 6.96, usdcAmount = 100
    const lines = [
      { account: '2010', currency: 'BOB',  debit:  bobAmount },
      { account: '1090', currency: 'BOB',  credit: bobAmount - swap },
      { account: '4060', currency: 'BOB',  credit: swap },
      { account: '1090', currency: 'USDC', debit:  usdcAmount },
      { account: '2020', currency: 'USDC', credit: usdcAmount },
    ]
    expect(assertBalanced(lines)).toBe(true)
  })

  test('descuadre en una moneda lanza LedgerError', () => {
    expect(() => assertBalanced([
      { account: '1030', currency: 'BOB', debit: 100 },
      { account: '2010', currency: 'BOB', credit: 99 },
    ])).toThrow(LedgerError)
  })

  test('descuadre en UNA de dos monedas lanza (aunque la otra cuadre)', () => {
    expect(() => assertBalanced([
      { account: '2010', currency: 'BOB',  debit: 100 },
      { account: '1090', currency: 'BOB',  credit: 100 },
      { account: '1090', currency: 'USDC', debit: 10 },
      { account: '2020', currency: 'USDC', credit: 9 },   // ← descuadrado
    ])).toThrow(/USDC/)
  })

  test('menos de 2 líneas lanza', () => {
    expect(() => assertBalanced([{ account: '1030', currency: 'BOB', debit: 100 }])).toThrow(LedgerError)
  })

  test('línea con débito Y crédito a la vez lanza', () => {
    expect(() => assertBalanced([
      { account: '1030', currency: 'BOB', debit: 100, credit: 100 },
      { account: '2010', currency: 'BOB', credit: 100 },
    ])).toThrow(LedgerError)
  })

  test('línea sin débito ni crédito lanza', () => {
    expect(() => assertBalanced([
      { account: '1030', currency: 'BOB', debit: 0, credit: 0 },
      { account: '2010', currency: 'BOB', credit: 0 },
    ])).toThrow(LedgerError)
  })

  test('monto negativo lanza', () => {
    expect(() => assertBalanced([
      { account: '1030', currency: 'BOB', debit: -100 },
      { account: '2010', currency: 'BOB', credit: -100 },
    ])).toThrow(LedgerError)
  })

  test('línea sin moneda lanza', () => {
    expect(() => assertBalanced([
      { account: '1030', debit: 100 },
      { account: '2010', currency: 'BOB', credit: 100 },
    ])).toThrow(LedgerError)
  })

  test('tolera redondeo float dentro de epsilon', () => {
    expect(assertBalanced([
      { account: '1010', currency: 'USDC', debit: 0.1 + 0.2 },   // 0.30000000000000004
      { account: '2020', currency: 'USDC', credit: 0.3 },
    ])).toBe(true)
  })
})

describe('assertAccountsKnown', () => {
  test('cuenta desconocida lanza', () => {
    expect(() => assertAccountsKnown([{ account: '9999', currency: 'BOB', debit: 1 }])).toThrow(/desconocida/)
  })

  test('moneda de la línea distinta a la de la cuenta lanza', () => {
    // 1030 es BOB; enviar una línea USDC debe fallar.
    expect(() => assertAccountsKnown([{ account: '1030', currency: 'USDC', debit: 1 }])).toThrow(/moneda/)
  })

  test('cuenta multi-moneda (1090 clearing) acepta cualquier moneda', () => {
    expect(assertAccountsKnown([
      { account: '1090', currency: 'BOB',  debit: 1 },
      { account: '1090', currency: 'USDC', credit: 1 },
    ])).toBe(true)
  })

  test('cuentas válidas con su moneda pasan', () => {
    expect(assertAccountsKnown([
      { account: '2010', currency: 'BOB',  debit: 1 },
      { account: '2020', currency: 'USDC', credit: 1 },
    ])).toBe(true)
  })
})

describe('CHART_OF_ACCOUNTS — integridad del catálogo', () => {
  test('códigos únicos', () => {
    const codes = CHART_OF_ACCOUNTS.map(a => a.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  test('normalSide coherente con el tipo (activo/gasto=deudor; pasivo/patrimonio/ingreso=acreedor)', () => {
    for (const a of CHART_OF_ACCOUNTS) {
      const expected = (a.type === 'asset' || a.type === 'expense') ? 'debit' : 'credit'
      expect(a.normalSide).toBe(expected)
    }
  })

  test('toda cuenta tiene code, name y type válido', () => {
    for (const a of CHART_OF_ACCOUNTS) {
      expect(a.code).toMatch(/^\d{4}$/)
      expect(a.name.length).toBeGreaterThan(0)
      expect(['asset', 'liability', 'equity', 'income', 'expense']).toContain(a.type)
    }
  })
})
