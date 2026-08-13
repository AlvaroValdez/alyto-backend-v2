/**
 * corridorMinimums.test.js — Guard de mínimo-neto (auditoría 2026-08-12).
 *
 * El mínimo se validaba sobre el BRUTO, pero el proveedor recibe el NETO. En 16
 * corredores eso dejaba pasar montos que Vita/Harbor luego rechazaban — con el
 * payin ya cobrado. Estos tests fijan la aritmética del piso efectivo.
 */

import '../setup.env.js'
import {
  minOriginForFloor, effectiveMinOrigin, totalFeePct, fixedFeeOrigin, providerFloorUSD,
} from '../../src/services/corridorMinimums.js'

// Corredor tipo bo-au: 6.5% spread + Bs 6 fija. Piso de Vita para AU = $50.
const CORRIDOR = { alytoCSpread: 6.5, fixedFee: 6, payinFeePercent: 0, profitRetentionPercent: 0 }
const BOB_PER_USD = 11.54

describe('totalFeePct / fixedFeeOrigin', () => {
  test('suma los porcentuales que se descuentan del bruto', () => {
    expect(totalFeePct({ payinFeePercent: 1, alytoCSpread: 6.5, profitRetentionPercent: 0.5 })).toBe(8)
  })
  test('usa la tarifa business cuando corresponde', () => {
    const c = { alytoCSpread: 6.5, businessAlytoCSpread: 4, fixedFee: 6, businessFixedFee: 3 }
    expect(totalFeePct(c, 'business')).toBe(4)
    expect(fixedFeeOrigin(c, 'business')).toBe(3)
    expect(totalFeePct(c, 'personal')).toBe(6.5)
    expect(fixedFeeOrigin(c, 'personal')).toBe(6)
  })
})

describe('minOriginForFloor', () => {
  test('el bruto calculado deja un neto que SÍ alcanza el piso', () => {
    const min = minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 6.5, fixedOrigin: 6, bufferPct: 0 })
    // Verificación inversa: aplicar los fees al bruto debe dar ≥ 50 USD
    const netUSD = (min * (1 - 6.5 / 100) - 6) / BOB_PER_USD
    expect(netUSD).toBeGreaterThanOrEqual(50)
    // Y el mínimo previo (347 BOB del caso real) NO alcanzaba
    const netAntes = (347 * (1 - 6.5 / 100) - 6) / BOB_PER_USD
    expect(netAntes).toBeLessThan(50)
  })

  test('por defecto NO aplica colchón (el que se EXIGE es el piso exacto)', () => {
    const a = minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 6.5, fixedOrigin: 6 })
    const b = minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 6.5, fixedOrigin: 6, bufferPct: 0 })
    expect(a).toBe(b)
  })

  test('el colchón (solo para MOSTRAR) deja el mostrado por ENCIMA del exigido', () => {
    const exigido  = minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 6.5, fixedOrigin: 6, bufferPct: 0 })
    const mostrado = minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 6.5, fixedOrigin: 6, bufferPct: 2 })
    // Asimetría: teclear el mostrado SIEMPRE pasa la validación, incluso si la
    // tasa viva subió un poco entre el listado y el quote.
    expect(mostrado).toBeGreaterThan(exigido)
  })

  test('sin piso del proveedor no inventa mínimo', () => {
    expect(minOriginForFloor({ floorUSD: null, originPerUsd: BOB_PER_USD })).toBeNull()
    expect(minOriginForFloor({ floorUSD: 0, originPerUsd: BOB_PER_USD })).toBeNull()
  })

  test('sin tasa de conversión no inventa mínimo (fail-open)', () => {
    expect(minOriginForFloor({ floorUSD: 50, originPerUsd: 0 })).toBeNull()
    expect(minOriginForFloor({ floorUSD: 50, originPerUsd: null })).toBeNull()
  })

  test('config inválida (fees ≥ 100%) devuelve null en vez de un número absurdo', () => {
    expect(minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 100 })).toBeNull()
    expect(minOriginForFloor({ floorUSD: 50, originPerUsd: BOB_PER_USD, feePct: 150 })).toBeNull()
  })
})

describe('effectiveMinOrigin', () => {
  test('eleva el mínimo cuando el configurado no alcanza el piso (caso bo-au)', () => {
    const r = effectiveMinOrigin({
      corridor: CORRIDOR, configuredMin: 347, originPerUsd: BOB_PER_USD, floorUSD: 50,
    })
    expect(r.raisedBy).toBe('provider_floor')
    expect(r.min).toBeGreaterThan(347)
  })

  test('NUNCA baja un mínimo configurado más alto que el piso', () => {
    const r = effectiveMinOrigin({
      corridor: CORRIDOR, configuredMin: 5000, originPerUsd: BOB_PER_USD, floorUSD: 50,
    })
    expect(r.min).toBe(5000)
    expect(r.raisedBy).toBeNull()
  })

  test('sin piso conocido respeta el configurado (fail-open)', () => {
    const r = effectiveMinOrigin({
      corridor: CORRIDOR, configuredMin: 300, originPerUsd: BOB_PER_USD, floorUSD: null,
    })
    expect(r.min).toBe(300)
    expect(r.raisedBy).toBeNull()
  })
})

describe('providerFloorUSD', () => {
  test('Harbor usa el límite de su API', () => {
    expect(providerFloorUSD({ payoutMethod: 'owlPay' })).toBeGreaterThanOrEqual(30)
  })
  test('anchorBolivia (manual) no tiene piso de API', () => {
    expect(providerFloorUSD({ payoutMethod: 'anchorBolivia' })).toBeNull()
  })
  test('Vita lee min_amount del rail que ejecutará el dispatch', () => {
    // Forma real de /prices: withdrawal tiene mapas POR PAÍS; vita_sent es una
    // tarifa plana ({ valid_until, usd_sell, fixed_cost, fixed_cost_usd }) y no
    // declara min_amount — de ahí que GT/SV/PL caigan al mínimo configurado.
    const prices = {
      usd: {
        withdrawal: { prices: { attributes: { min_amount: { co: 1, au: 50, eu: 10 } } } },
        vita_sent:  { prices: { attributes: { usd_sell: 0.86, fixed_cost: 0 } } },
      },
    }
    expect(providerFloorUSD({ payoutMethod: 'vitaWallet', destinationCountry: 'AU' }, prices)).toBe(50)
    // EU se paga por withdrawal['eu'] — vita_sent es red interna, no rail bancario
    expect(providerFloorUSD({ payoutMethod: 'vitaWallet', destinationCountry: 'EU' }, prices)).toBe(10)
    // GT va por vita_sent, que no publica piso → null (fail-open al configurado)
    expect(providerFloorUSD({ payoutMethod: 'vitaWallet', destinationCountry: 'GT' }, prices)).toBeNull()
  })
})
