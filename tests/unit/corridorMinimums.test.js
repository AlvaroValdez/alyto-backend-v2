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

/**
 * Piso POR RUTA (barrido de producción 2026-10-05).
 *
 * El piso de Harbor no es uno solo: la constante global (31) es de familia, pero
 * la API exige además mínimos por corredor. `bo-jp` pide `source.amount >= 75.02`.
 * Como el mínimo configurado (40 USD) ya superaba al genérico, el guard nunca se
 * disparaba y la operación moría DESPUÉS del cobro.
 */
describe('providerFloorUSD — override por ruta', () => {
  test('el piso propio de la ruta gana cuando supera al genérico (caso bo-jp)', () => {
    expect(providerFloorUSD({ payoutMethod: 'owlPay', providerFloorUSD: 75.02 })).toBe(75.02)
  })

  test('un override más BAJO que el genérico no desprotege', () => {
    // Si Harbor sube su mínimo global y el override quedó viejo, manda el genérico.
    const floor = providerFloorUSD({ payoutMethod: 'owlPay', providerFloorUSD: 10 })
    expect(floor).toBeGreaterThanOrEqual(30)
  })

  test('en Vita se compone con el min_amount vivo, tomando el mayor', () => {
    const prices = {
      usd: { withdrawal: { prices: { attributes: { min_amount: { au: 50 } } } } },
    }
    const base = { payoutMethod: 'vitaWallet', destinationCountry: 'AU' }
    // Override por encima del vivo → manda el override
    expect(providerFloorUSD({ ...base, providerFloorUSD: 80 }, prices)).toBe(80)
    // Override por debajo del vivo → manda el vivo (que es el dato fresco)
    expect(providerFloorUSD({ ...base, providerFloorUSD: 20 }, prices)).toBe(50)
  })

  test('un override vacío o absurdo se ignora en vez de romper el piso', () => {
    const harbor = providerFloorUSD({ payoutMethod: 'owlPay' })
    for (const v of [null, undefined, 0, -5, NaN, 'setenta']) {
      expect(providerFloorUSD({ payoutMethod: 'owlPay', providerFloorUSD: v })).toBe(harbor)
    }
  })

  test('da piso a un corredor manual, que no tiene API de donde derivarlo', () => {
    expect(providerFloorUSD({ payoutMethod: 'anchorBolivia', providerFloorUSD: 25 })).toBe(25)
  })
})

describe('bo-jp — la aritmética que dejaba pasar el cobro', () => {
  // Fees retail reales del corredor: 6.5% spread + Bs 6 fija (ver CLAUDE.md §1).
  const BOB_PER_USD_HOY = 12.01
  const FLOOR_JP        = 75.02
  const configuredMin   = Math.ceil(40 * BOB_PER_USD_HOY)   // minAmountUSD = 40 → 481 BOB

  test('con el piso genérico (31) el guard NO se disparaba', () => {
    const r = effectiveMinOrigin({
      corridor: CORRIDOR, configuredMin, originPerUsd: BOB_PER_USD_HOY, floorUSD: 31,
    })
    expect(r.raisedBy).toBeNull()
    expect(r.min).toBe(configuredMin)

    // Y ese mínimo mandaba a Harbor un neto muy por debajo de lo que exige la ruta:
    const netUSD = (configuredMin * (1 - 6.5 / 100) - 6) / BOB_PER_USD_HOY
    expect(netUSD).toBeLessThan(FLOOR_JP)
  })

  test('con el piso real de la ruta eleva el mínimo y el neto YA alcanza', () => {
    const r = effectiveMinOrigin({
      corridor: CORRIDOR, configuredMin, originPerUsd: BOB_PER_USD_HOY, floorUSD: FLOOR_JP,
    })
    expect(r.raisedBy).toBe('provider_floor')
    expect(r.min).toBeGreaterThan(configuredMin)

    // Verificación inversa: aplicarle los fees al mínimo nuevo deja ≥ 75.02 USD.
    const netUSD = (r.min * (1 - 6.5 / 100) - 6) / BOB_PER_USD_HOY
    expect(netUSD).toBeGreaterThanOrEqual(FLOOR_JP)
  })

  test('business nunca estuvo afectado: su mínimo ya supera el piso', () => {
    // minAmountUSDBusiness = 300 con fees business (4% + Bs 10).
    const corridorBiz = { ...CORRIDOR, businessAlytoCSpread: 4, businessFixedFee: 10 }
    const minBiz      = Math.ceil(300 * BOB_PER_USD_HOY)
    const r = effectiveMinOrigin({
      corridor: corridorBiz, configuredMin: minBiz, originPerUsd: BOB_PER_USD_HOY,
      floorUSD: FLOOR_JP, accountType: 'business',
    })
    expect(r.raisedBy).toBeNull()
    expect(r.min).toBe(minBiz)
  })
})
