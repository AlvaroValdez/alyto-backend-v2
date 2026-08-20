/**
 * treasuryCold.test.js — Reserva fría con multifirma (Fase 42).
 *
 * La distinción que estas pruebas protegen es la que más fácil se rompe al leer el
 * código por encima: SOLVENCIA suma caliente + fría, LIQUIDEZ solo la caliente.
 * Confundirlas tiene dos formas de fallar, ambas caras:
 *   - usar solo la caliente para solvencia → déficit falso en cuanto se traslade el
 *     respaldo a la fría, y una alerta crítica que no corresponde;
 *   - sumar la fría a la liquidez → autorizar una operación que después no se puede
 *     liquidar, porque mover la fría exige dos firmas y una intervención manual.
 */

import '../setup.env.js'
import { evaluateAnchorAlerts } from '../../src/services/anchorAdminService.js'

const listenerVerde = { health: 'green', horizon: { reachable: true } }
const sinDescuadres = { discrepancies: [] }

/** Solvencia sana con reserva fría configurada. */
const solvente = (over = {}) => ({
  covered:          true,
  reliable:         true,
  coldConfigured:   true,
  treasuryHotUSDC:  100,
  treasuryColdUSDC: 400,
  liabilitiesUSDC:  90,
  reservesUSDC:     500,
  ...over,
})

describe('alerta de recarga de la cuenta caliente', () => {
  test('caliente por debajo del mínimo dispara aviso, aunque la solvencia esté sana', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ treasuryHotUSDC: 20 }),
      thresholds: { minHotUSDC: 50 },
    })
    const hot = a.find((x) => x.key === 'treasury-hot-low')
    expect(hot).toBeDefined()
    expect(hot.severity).toBe('warning')
    // El aviso tiene que decirle al operador cuánto hay en la fría para recargar.
    expect(hot.detail).toMatch(/400/)
  })

  test('es un problema de liquidez, no de solvencia: no escala a crítico', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ treasuryHotUSDC: 0 }),
      thresholds: { minHotUSDC: 50 },
    })
    expect(a.some((x) => x.key === 'solvency-uncovered')).toBe(false)
    expect(a.filter((x) => x.severity === 'critical')).toHaveLength(0)
  })

  test('caliente justo en el mínimo no alerta', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ treasuryHotUSDC: 50 }),
      thresholds: { minHotUSDC: 50 },
    })
    expect(a.some((x) => x.key === 'treasury-hot-low')).toBe(false)
  })

  test('sin reserva fría configurada la alerta no aplica', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ coldConfigured: false, treasuryHotUSDC: 1 }),
      thresholds: { minHotUSDC: 50 },
    })
    expect(a.some((x) => x.key === 'treasury-hot-low')).toBe(false)
  })

  test('sin umbral configurado la alerta no aplica', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ treasuryHotUSDC: 1 }),
      thresholds: {},
    })
    expect(a.some((x) => x.key === 'treasury-hot-low')).toBe(false)
  })

  test('no rompe el comportamiento previo: solvencia sana y sin umbral → sin alertas', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: { covered: true, reliable: true },
    })
    expect(a).toEqual([])
  })
})

describe('la reserva fría no enmascara una sub-colateralización real', () => {
  test('si el pasivo supera caliente + fría, sigue siendo crítico', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ covered: false, differenceUSDC: -120, liabilitiesUSDC: 620, reservesUSDC: 500 }),
      thresholds: { minHotUSDC: 50 },
    })
    const s = a.find((x) => x.key === 'solvency-uncovered')
    expect(s).toBeDefined()
    expect(s.severity).toBe('critical')
  })

  test('caliente baja y sub-colateralización conviven como dos alertas distintas', () => {
    const a = evaluateAnchorAlerts({
      listener: listenerVerde, reconciliation: sinDescuadres,
      solvency: solvente({ covered: false, differenceUSDC: -10, treasuryHotUSDC: 5 }),
      thresholds: { minHotUSDC: 50 },
    })
    expect(a.map((x) => x.key).sort()).toEqual(['solvency-uncovered', 'treasury-hot-low'])
  })
})
