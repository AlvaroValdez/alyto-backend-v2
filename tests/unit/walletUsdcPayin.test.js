/**
 * walletUsdcPayin.test.js — Lógica pura del pago con saldo USDC.
 *
 * Cubre la aritmética que decide cuánto USDC se debita y que la cotización desde USDC
 * delega en la fórmula canónica sin alterar fees ni destino.
 */

import { jest } from '@jest/globals'

import { calculateQuote, quoteFromUSDC } from '../../src/services/quoteCalculator.js'
import { bobToUsdcDebit }                from '../../src/services/walletPaymentService.js'

const corridor = {
  payinFeePercent:        0,      // sin fee de cobro bancario (no hay banco en el pago con saldo)
  alytoCSpread:           6.5,
  fixedFee:               6,
  profitRetentionPercent: 0,
  payoutFeeFixed:         0,
  originCurrency:         'BOB',
  destinationCurrency:    'ARS',
}

describe('bobToUsdcDebit', () => {
  test('convierte BOB a USDC con la tasa bloqueada (6 decimales)', () => {
    // 696 BOB a 6.96 BOB/USDC = 100 USDC exactos
    expect(bobToUsdcDebit(696, 6.96)).toBe(100)
  })

  test('redondea a 6 decimales sin perder precisión de centavos', () => {
    const r = bobToUsdcDebit(1000, 6.96)
    expect(r).toBeCloseTo(143.678161, 6)
  })

  test('rechaza montos o tasas no positivos', () => {
    expect(() => bobToUsdcDebit(0, 6.96)).toThrow()
    expect(() => bobToUsdcDebit(100, 0)).toThrow()
    expect(() => bobToUsdcDebit(-5, 6.96)).toThrow()
  })
})

describe('quoteFromUSDC', () => {
  const bobPerUsdc  = 6.96
  const providerRate = 1200   // ARS por USDC (raw, sin markup)

  test('equivale a calculateQuote con el BOB equivalente', () => {
    const usdcAmount = 100
    const amountBOB  = usdcAmount * bobPerUsdc   // 696

    const fromUsdc = quoteFromUSDC({ usdcAmount, corridor, bobPerUsdc, providerRate })
    const fromBob  = calculateQuote({ amount: amountBOB, corridor, bobPerUsdc, providerRate })

    // Misma economía: fees, tránsito y destino idénticos.
    expect(fromUsdc.totalDeducted).toBe(fromBob.totalDeducted)
    expect(fromUsdc.destinationAmount).toBe(fromBob.destinationAmount)
    expect(fromUsdc.digitalAssetAmount).toBe(fromBob.digitalAssetAmount)
  })

  test('expone el origen en USDC y el BOB equivalente', () => {
    const q = quoteFromUSDC({ usdcAmount: 100, corridor, bobPerUsdc, providerRate })
    expect(q.originAmountUSDC).toBe(100)
    expect(q.originAmountBOB).toBe(696)
    // La transacción sigue denominada en BOB: originAmount es el BOB alimentado a la fórmula.
    expect(q.originAmount).toBe(696)
  })

  test('sin FX drift: lo debitado menos lo liquidado (USDC) es el fee en USDC', () => {
    const usdcAmount = 100
    const q = quoteFromUSDC({ usdcAmount, corridor, bobPerUsdc, providerRate })
    // usdcTransit = (amountBOB - totalDeducted) / bobPerUsdc ; debitado = amountBOB / bobPerUsdc
    const feeUsdc = q.totalDeducted / bobPerUsdc
    // Tolerancia 2 decimales: el único delta es el round2 sobre el USDC de tránsito, no un
    // drift de tasa (bobPerUsdc entra y sale con el mismo valor).
    expect(usdcAmount - q.digitalAssetAmount).toBeCloseTo(feeUsdc, 2)
  })

  test('rechaza usdcAmount o tasa no positivos', () => {
    expect(() => quoteFromUSDC({ usdcAmount: 0, corridor, bobPerUsdc, providerRate })).toThrow()
    expect(() => quoteFromUSDC({ usdcAmount: 100, corridor, bobPerUsdc: 0, providerRate })).toThrow()
  })
})
