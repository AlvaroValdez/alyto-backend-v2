/**
 * ledgerReports.test.js — Lógica pura de reportes/apertura del Libro Mayor (Fase 1).
 *
 * Cubre: el saldo por cuenta respeta el lado normal, y el asiento de saldos de
 * apertura balancea por moneda y fija las cuentas de control a los saldos reales.
 */

import '../setup.env.js'
import { aggregateByAccount, buildOpeningBalanceLines } from '../../src/services/ledgerReports.js'
import { assertBalanced, assertAccountsKnown, summarizeByCurrency } from '../../src/services/ledgerService.js'

describe('aggregateByAccount', () => {
  test('saldo respeta el lado normal (pasivo=acreedor, activo=deudor)', () => {
    const rows = aggregateByAccount([
      { account: '2010', currency: 'BOB',  credit: 100 },
      { account: '2010', currency: 'BOB',  debit: 30 },   // pasivo: balance = crédito − débito = 70
      { account: '1010', currency: 'USDC', debit: 50 },   // activo: balance = débito − crédito = 50
    ])
    const bob  = rows.find(r => r.account === '2010' && r.currency === 'BOB')
    const usdc = rows.find(r => r.account === '1010' && r.currency === 'USDC')
    expect(bob).toMatchObject({ debit: 30, credit: 100, balance: 70 })
    expect(usdc).toMatchObject({ debit: 50, credit: 0, balance: 50 })
  })
})

describe('buildOpeningBalanceLines', () => {
  const snap = {
    bob:  { balance: 1401.88, frozen: 0, reserved: 0 },
    usdc: { balance: 217.656389, frozen: 0, reserved: 0 },
    treasuryUsdc: 539.71,
    custodialUsdc: 0,
    channelXlm: 12.5,
    bankBob: null,
  }

  test('el asiento de apertura balancea por moneda y usa cuentas válidas', () => {
    const lines = buildOpeningBalanceLines(snap)
    expect(assertBalanced(lines)).toBe(true)
    expect(assertAccountsKnown(lines)).toBe(true)
  })

  test('fija las cuentas de control a los saldos reales de las wallets', () => {
    const lines = buildOpeningBalanceLines(snap)
    const l2010 = lines.find(l => l.account === '2010' && l.currency === 'BOB')
    const l2020 = lines.find(l => l.account === '2020' && l.currency === 'USDC')
    expect(l2010).toMatchObject({ credit: 1401.88 })   // pasivo BOB usuarios
    expect(l2020).toMatchObject({ credit: 217.656389 }) // pasivo USDC usuarios
  })

  test('la tesorería on-chain entra como activo (débito 1010)', () => {
    const lines = buildOpeningBalanceLines(snap)
    const l1010 = lines.find(l => l.account === '1010')
    expect(l1010).toMatchObject({ currency: 'USDC', debit: 539.71 })
  })

  test('sin banco BOB conocido, el pasivo BOB se plug a patrimonio (3010)', () => {
    const lines = buildOpeningBalanceLines(snap)
    const plugBob = lines.find(l => l.account === '3010' && l.currency === 'BOB')
    expect(plugBob).toMatchObject({ debit: 1401.88 })   // equilibra el crédito de 2010
  })

  test('si el activo USDC supera el pasivo, el plug 3010 va al crédito', () => {
    const lines = buildOpeningBalanceLines(snap)   // asset 539.71 > liab 217.66
    const plugUsdc = lines.find(l => l.account === '3010' && l.currency === 'USDC')
    expect(plugUsdc.credit).toBeCloseTo(539.71 - 217.656389, 6)
    expect(plugUsdc.debit).toBe(0)
  })

  test('con banco BOB conocido, se registra 1030 y el plug se reduce', () => {
    const lines = buildOpeningBalanceLines({ ...snap, bankBob: 1401.88 })
    const l1030 = lines.find(l => l.account === '1030')
    expect(l1030).toMatchObject({ debit: 1401.88 })
    // banco == pasivo → sin plug BOB
    expect(lines.find(l => l.account === '3010' && l.currency === 'BOB')).toBeUndefined()
  })

  test('omite líneas de monto cero (frozen/reserved en 0 no generan línea)', () => {
    const lines = buildOpeningBalanceLines(snap)
    expect(lines.find(l => l.account === '2011')).toBeUndefined()  // frozen BOB = 0
    expect(lines.find(l => l.account === '2022')).toBeUndefined()  // reserved USDC = 0
  })

  test('balanceo por moneda cuadra en BOB, USDC y XLM', () => {
    const s = summarizeByCurrency(buildOpeningBalanceLines(snap))
    for (const cur of ['BOB', 'USDC', 'XLM']) {
      expect(Math.abs(s[cur].debit - s[cur].credit)).toBeLessThan(1e-6)
    }
  })
})
