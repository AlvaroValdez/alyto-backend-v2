/**
 * payoutRateGuard.test.js — Resolución del tipo de cambio del Comprobante Oficial.
 *
 * `exchangeRateBob` se estampa en el Comprobante Oficial de Transacción, un
 * documento con valor regulatorio ante ASFI. Antes lo fijaba el cliente sin
 * ninguna cota (`tipoCambioManual`), así que un valor arbitrario terminaba
 * impreso y persistido. Aquí se fija el contrato: manda la tasa bloqueada en la
 * cotización y el override solo se acepta dentro de una banda.
 */

import '../setup.env.js'
import { resolveComprobanteRate, maxManualRateDeviationPct } from '../../src/controllers/payoutController.js'

const ORIGINAL_DEV = process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT

afterEach(() => {
  if (ORIGINAL_DEV === undefined) delete process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT
  else process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT = ORIGINAL_DEV
})

describe('maxManualRateDeviationPct', () => {
  test('default 5% si no está configurado', () => {
    delete process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT
    expect(maxManualRateDeviationPct()).toBe(5)
  })

  test('respeta el valor del entorno', () => {
    process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT = '2.5'
    expect(maxManualRateDeviationPct()).toBe(2.5)
  })

  test('un valor basura cae al default en vez de abrir la banda', () => {
    for (const bad of ['abc', '', '-1']) {
      process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT = bad
      expect(maxManualRateDeviationPct()).toBe(5)
    }
  })

  test('0% es válido — cierra el override por completo', () => {
    process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT = '0'
    expect(maxManualRateDeviationPct()).toBe(0)
  })
})

describe('resolveComprobanteRate — sin override', () => {
  test('usa la tasa bloqueada en la cotización', () => {
    const r = resolveComprobanteRate({ manualRate: undefined, lockedRate: 6.96, maxDeviationPct: 5 })
    expect(r).toEqual({ ok: true, rate: 6.96, source: 'locked_quote', referenceRate: 6.96, deviationPct: 0 })
  })

  test('null y string vacío se tratan como "sin override"', () => {
    for (const manualRate of [null, '']) {
      const r = resolveComprobanteRate({ manualRate, lockedRate: 6.96, maxDeviationPct: 5 })
      expect(r.ok).toBe(true)
      expect(r.source).toBe('locked_quote')
    }
  })

  test('sin tasa bloqueada → NO_RATE_AVAILABLE (no inventa una tasa)', () => {
    const r = resolveComprobanteRate({ manualRate: undefined, lockedRate: undefined, maxDeviationPct: 5 })
    expect(r).toMatchObject({ ok: false, code: 'NO_RATE_AVAILABLE' })
  })

  test('tasa bloqueada 0 o negativa no cuenta como tasa', () => {
    for (const lockedRate of [0, -3]) {
      expect(resolveComprobanteRate({ manualRate: undefined, lockedRate, maxDeviationPct: 5 }).ok).toBe(false)
    }
  })
})

describe('resolveComprobanteRate — override acotado', () => {
  test('dentro de la banda: se acepta y se marca como manual_override', () => {
    // 7.10 vs 6.96 → 2.01% de desviación, dentro del 5%
    const r = resolveComprobanteRate({ manualRate: 7.10, lockedRate: 6.96, maxDeviationPct: 5 })
    expect(r.ok).toBe(true)
    expect(r.rate).toBe(7.10)
    expect(r.source).toBe('manual_override')
    expect(r.referenceRate).toBe(6.96)
    expect(r.deviationPct).toBeCloseTo(2.011, 2)
  })

  test('exactamente en el borde de la banda se acepta', () => {
    const r = resolveComprobanteRate({ manualRate: 6.96 * 1.05, lockedRate: 6.96, maxDeviationPct: 5 })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('manual_override')
  })

  test('fuera de la banda: rechazo con la desviación calculada', () => {
    // El caso que importa: el cliente manda una tasa arbitraria para inflar el
    // comprobante. 20 vs 6.96 → 187% de desviación.
    const r = resolveComprobanteRate({ manualRate: 20, lockedRate: 6.96, maxDeviationPct: 5 })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('MANUAL_RATE_OUT_OF_BOUNDS')
    expect(r.referenceRate).toBe(6.96)
    expect(r.deviationPct).toBeGreaterThan(100)
  })

  test('la banda es simétrica — también rechaza a la baja', () => {
    const r = resolveComprobanteRate({ manualRate: 1, lockedRate: 6.96, maxDeviationPct: 5 })
    expect(r).toMatchObject({ ok: false, code: 'MANUAL_RATE_OUT_OF_BOUNDS' })
  })

  test('banda 0% rechaza cualquier override distinto de la referencia', () => {
    expect(resolveComprobanteRate({ manualRate: 6.97, lockedRate: 6.96, maxDeviationPct: 0 }).ok).toBe(false)
    expect(resolveComprobanteRate({ manualRate: 6.96, lockedRate: 6.96, maxDeviationPct: 0 }).ok).toBe(true)
  })

  test('valores no numéricos o no positivos → MANUAL_RATE_INVALID', () => {
    for (const manualRate of ['abc', 0, -1, NaN, {}, [1, 2]]) {
      const r = resolveComprobanteRate({ manualRate, lockedRate: 6.96, maxDeviationPct: 5 })
      expect(r).toMatchObject({ ok: false, code: 'MANUAL_RATE_INVALID' })
    }
  })

  test('numérico como string se acepta si cae dentro de la banda', () => {
    const r = resolveComprobanteRate({ manualRate: '7.00', lockedRate: 6.96, maxDeviationPct: 5 })
    expect(r.ok).toBe(true)
    expect(r.rate).toBe(7)
  })
})

describe('resolveComprobanteRate — sin tasa bloqueada, con tasa de mercado', () => {
  test('la tasa de mercado sirve de referencia cuando la tx no tiene locked', () => {
    const r = resolveComprobanteRate({ manualRate: 7.0, lockedRate: null, fallbackRate: 6.9, maxDeviationPct: 5 })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('manual_override')
    expect(r.referenceRate).toBe(6.9)
  })

  test('sin locked y sin mercado no hay contra qué validar → NO_REFERENCE_RATE', () => {
    const r = resolveComprobanteRate({ manualRate: 7.0, lockedRate: null, fallbackRate: null, maxDeviationPct: 5 })
    expect(r).toMatchObject({ ok: false, code: 'NO_REFERENCE_RATE' })
  })

  test('la tasa bloqueada tiene prioridad sobre la de mercado', () => {
    const r = resolveComprobanteRate({ manualRate: 7.0, lockedRate: 6.96, fallbackRate: 9.31, maxDeviationPct: 5 })
    expect(r.referenceRate).toBe(6.96)
  })
})
