/**
 * refreshExchangeRates.test.js — El job que mantiene vivas las tasas.
 *
 * Existe por un defecto concreto: `SpAConfig.clpPerBob` era un campo manual, se
 * cargó bien en mayo de 2026 y nadie lo volvió a tocar. Cuando Bolivia pasó a
 * flotación administrada quedó 14% desviado, y el efecto habría sido entregarle
 * al beneficiario 12% menos de bolivianos con esa diferencia como margen no
 * declarado. No afectó a nadie porque el corredor no tuvo operaciones.
 *
 * El defecto no era el número: era que nada lo vigilaba. Lo que se prueba acá es
 * que ahora algo lo vigila, y que ese algo no se vuelve un riesgo nuevo
 * publicando cualquier cosa que le devuelva la fuente.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js'

const p2p = jest.fn()
await jest.unstable_mockModule('../../src/services/binanceP2PService.js', () => ({
  fetchFiatUSDTRate:     p2p,
  fetchBOBUSDTRate:      () => p2p('BOB'),
  getCachedBOBUSDTRate:  () => null,
  invalidateCache:       () => {},
}))

let job, ExchangeRate, SpAConfig

beforeAll(async () => {
  await connectTestDb()
  job          = await import('../../src/jobs/refreshExchangeRates.js')
  ExchangeRate = (await import('../../src/models/ExchangeRate.js')).default
  SpAConfig    = (await import('../../src/models/SpAConfig.js')).default
})

afterEach(async () => { p2p.mockReset(); await clearCollections() })
afterAll(async () => { await disconnectTestDb() })

/** El mercado responde estos valores por moneda. */
function mercado({ BOB = 12.02, CLP = 998.5 } = {}) {
  p2p.mockImplementation(async (fiat) => {
    if (fiat === 'BOB') return BOB
    if (fiat === 'CLP') return CLP
    throw new Error(`moneda no esperada: ${fiat}`)
  })
}

const tasa = async (pair) => (await ExchangeRate.findOne({ pair }).lean())?.rate

describe('la tasa del corredor se deriva sola', () => {
  test('CLP-BOB sale de dividir las dos puntas de la misma corrida', async () => {
    mercado({ BOB: 12.02, CLP: 998.5 })

    await job.refreshExchangeRates()

    // 998,5 / 12,02 = 83,0699
    expect(await tasa('CLP-BOB')).toBeCloseTo(83.07, 2)
    expect(await tasa('CLP-USDT')).toBe(998.5)
  })

  test('SpAConfig.clpPerBob queda sincronizado, que es el que cotiza al usuario', async () => {
    await SpAConfig.create({ clpPerBob: 93.9628 })   // el valor congelado de mayo
    mercado()

    await job.refreshExchangeRates()

    const cfg = await SpAConfig.findOne({}).lean()
    expect(cfg.clpPerBob).toBeCloseTo(83.07, 2)
    expect(cfg.rateSource).toBe('binance_p2p_auto')
    expect(cfg.rateUpdatedAt).toBeInstanceOf(Date)
  })

  test('un admin puede fijarla a mano y el job no la pisa', async () => {
    await SpAConfig.create({ clpPerBob: 90, rateSource: 'manual' })
    mercado()

    await job.refreshExchangeRates()

    expect((await SpAConfig.findOne({}).lean()).clpPerBob).toBe(90)
    // La tasa de referencia sí se actualiza: lo fijado es lo que cotiza, no el dato.
    expect(await tasa('CLP-BOB')).toBeCloseTo(83.07, 2)
  })
})

describe('el guard de saltos', () => {
  // Automatizar la tasa sin vigilar la fuente cambia un riesgo por otro: antes
  // se cotizaba con un número viejo, ahora se cotizaría con uno absurdo.
  test('rechaza un salto implausible y conserva la tasa anterior', async () => {
    await ExchangeRate.create({ pair: 'BOB-USDT', rate: 12.0, source: 'binance_p2p_auto' })
    mercado({ BOB: 1.2 })   // un decimal corrido en la fuente

    await job.refreshExchangeRates()

    expect(await tasa('BOB-USDT')).toBe(12.0)
  })

  test('deja pasar la corrección real que motivó todo esto', async () => {
    // 93,96 → 83,07 es un 11,6%: grande, pero es el mercado moviéndose de verdad.
    await ExchangeRate.create({ pair: 'CLP-BOB', rate: 93.9628, source: 'calculated' })
    mercado()

    await job.refreshExchangeRates()

    expect(await tasa('CLP-BOB')).toBeCloseTo(83.07, 2)
  })

  test('una tasa que no existía se publica sin comparar contra nada', async () => {
    mercado()
    await job.refreshExchangeRates()
    expect(await tasa('CLP-USDT')).toBe(998.5)
  })
})

describe('fallos parciales', () => {
  test('si falla Chile, lo boliviano igual queda actualizado', async () => {
    p2p.mockImplementation(async (fiat) => {
      if (fiat === 'BOB') return 12.02
      throw new Error('HTTP 503')
    })

    await job.refreshExchangeRates()

    expect(await tasa('BOB-USDT')).toBe(12.02)
    expect(await tasa('CLP-BOB')).toBeUndefined()
  })

  test('si falla Bolivia no se publica nada: CLP-BOB depende de esa punta', async () => {
    p2p.mockRejectedValue(new Error('HTTP 503'))

    await job.refreshExchangeRates()

    expect(await tasa('BOB-USDT')).toBeUndefined()
    expect(await tasa('CLP-USDT')).toBeUndefined()
  })

  test('sin SpAConfig no falla: el corredor puede no estar configurado', async () => {
    mercado()
    await expect(job.refreshExchangeRates()).resolves.not.toThrow()
    expect(await tasa('CLP-BOB')).toBeCloseTo(83.07, 2)
  })
})
