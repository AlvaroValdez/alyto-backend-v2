/**
 * vitaEuQuote.test.js — Fix corredor EU vía Vita (2026-08-12).
 *
 * Dos defectos que hacían que el usuario recibiera menos de lo prometido:
 *  1. El quote BOB→destino NO descontaba el fixed_cost del proveedor
 *     (withdrawal['eu'] cobra 5 EUR que Vita descuenta al ejecutar).
 *  2. EU cotizaba por withdrawal['eu'] (peor rail) en vez de vita_sent['es']
 *     (mejor tasa, sin fija — el rail del corredor bo-es original).
 *
 * Caso real ALY-C-1786548682442-NE1YVC: 236 BOB → 18.24 USDC; prometido 15.52 EUR,
 * Vita habría entregado ~10.55 (withdrawal). Con el fix: promesa = entrega.
 */

import '../setup.env.js'
import { calculateQuote, toPublicFees } from '../../src/services/quoteCalculator.js'
import { getVitaSentCountry, VITA_SENT_ONLY_COUNTRIES } from '../../src/services/vitaWalletService.js'

// Corredor tipo bo-es (SRL retail): 6.5% spread + Bs 6 fija, sin payoutFeeFixed propio.
const CORRIDOR = { alytoCSpread: 6.5, fixedFee: 6, payinFeePercent: 0, profitRetentionPercent: 0, payoutFeeFixed: 0 }
const BOB_PER_USDC = 11.77   // ≈ tasa del caso real (214.66 BOB netos → 18.24 USDC)

describe('getVitaSentCountry', () => {
  test('EU se traduce a ES (la eurozona entra por España, el IBAN fija el país)', () => {
    expect(getVitaSentCountry('EU')).toBe('ES')
    expect(getVitaSentCountry('eu')).toBe('ES')
  })
  test('el resto de países vita_sent quedan idénticos', () => {
    expect(getVitaSentCountry('GT')).toBe('GT')
    expect(getVitaSentCountry('SV')).toBe('SV')
    expect(getVitaSentCountry('PL')).toBe('PL')
    expect(getVitaSentCountry('ES')).toBe('ES')
  })
  test('el set vita_sent incluye ES y EU (restaurados) sin perder GT/SV/PL', () => {
    for (const c of ['GT', 'SV', 'PL', 'ES', 'EU']) expect(VITA_SENT_ONLY_COUNTRIES.has(c)).toBe(true)
  })
})

describe('calculateQuote — providerFixedFee (fija real del proveedor)', () => {
  test('descuenta la fija del proveedor del monto destino (caso real EU withdrawal)', () => {
    // 236 BOB − 21.34 fees = 214.66 → 18.24 USDC; 18.24×0.852417 − 5 = 10.55 EUR
    const q = calculateQuote({
      amount: 236, corridor: CORRIDOR, bobPerUsdc: BOB_PER_USDC,
      providerRate: 0.852417, providerFixedFee: 5,
    })
    expect(q.digitalAssetAmount).toBe(18.24)
    expect(q.destinationAmount).toBe(10.55)
    expect(q.fees.payoutFee).toBe(5)
  })

  test('vía vita_sent (fija 0) la promesa mejora y coincide con lo que Vita entrega', () => {
    // 18.24 × 0.8676 − 0 = 15.83 EUR — MÁS que los 15.52 prometidos con el bug
    const q = calculateQuote({
      amount: 236, corridor: CORRIDOR, bobPerUsdc: BOB_PER_USDC,
      providerRate: 0.8676, providerFixedFee: 0,
    })
    expect(q.destinationAmount).toBe(15.83)
    expect(q.fees.payoutFee).toBe(0)   // fija 0 → cae a payoutFeeFixed del corredor (0)
  })

  test('sin providerFixedFee el comportamiento es el histórico (payoutFeeFixed del corredor)', () => {
    const conFee = calculateQuote({
      amount: 236, corridor: { ...CORRIDOR, payoutFeeFixed: 2 }, bobPerUsdc: BOB_PER_USDC,
      providerRate: 0.8676,
    })
    expect(conFee.fees.payoutFee).toBe(2)
    expect(conFee.destinationAmount).toBe(13.83)   // 15.83 − 2
  })

  test('providerFixedFee > 0 GANA sobre payoutFeeFixed del corredor (fuente real manda)', () => {
    const q = calculateQuote({
      amount: 236, corridor: { ...CORRIDOR, payoutFeeFixed: 2 }, bobPerUsdc: BOB_PER_USDC,
      providerRate: 0.852417, providerFixedFee: 5,
    })
    expect(q.fees.payoutFee).toBe(5)
  })
})

describe('toPublicFees — no mezclar monedas en el "Costo del envío"', () => {
  // El frontend suma payinFee+alytoCSpread+fixedFee+payoutFee y lo muestra en
  // moneda ORIGEN. La fija del proveedor está en moneda DESTINO y ya viene
  // descontada de destinationAmount → exponerla ahí mostraría, p.ej., "Bs 3.516"
  // en un envío cuyo costo real es Bs 21.34 (fija de 3495 COP de bo-co).
  const q = calculateQuote({
    amount: 1000, corridor: CORRIDOR, bobPerUsdc: BOB_PER_USDC,
    providerRate: 3100.75, providerFixedFee: 3495,   // caso real bo-co (COP)
  })

  test('payoutFee se expone en 0 (ya descontado, en otra moneda)', () => {
    const pub = toPublicFees(q.fees, { originCurrency: 'BOB', destinationCurrency: 'COP' })
    expect(q.fees.payoutFee).toBe(3495)   // interno: real
    expect(pub.payoutFee).toBe(0)         // público: no sumable en BOB
  })

  test('la suma que hace el frontend queda en moneda origen y es correcta', () => {
    const pub = toPublicFees(q.fees, { originCurrency: 'BOB', destinationCurrency: 'COP' })
    const costoEnvioFrontend = pub.payinFee + pub.alytoCSpread + pub.fixedFee + pub.payoutFee
    expect(costoEnvioFrontend).toBe(pub.totalDeducted)   // 65 + 6 = 71 BOB, sin COP mezclados
  })

  test('la fija real se conserva etiquetada con su moneda (transparencia)', () => {
    const pub = toPublicFees(q.fees, { originCurrency: 'BOB', destinationCurrency: 'COP' })
    expect(pub.providerFixedFee).toBe(3495)
    expect(pub.providerFixedFeeCurrency).toBe('COP')
    expect(pub.feeCurrency).toBe('BOB')
  })
})
