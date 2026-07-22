/**
 * anchorAdmin.test.js — Lógica pura de AnchorAdmin Fase 1.
 *
 * Cubre las piezas donde un error silencioso es más costoso (spec §7):
 * reconciliación del dual ledger y cuadre de reservas/solvencia, más la
 * clasificación de salud del listener.
 */

import '../setup.env.js'
import {
  mirrorLiabilityUSDC,
  classifyWalletReconciliation,
  computeSolvency,
  classifyListenerHealth,
  evaluateAnchorAlerts,
} from '../../src/services/anchorAdminService.js'

describe('mirrorLiabilityUSDC', () => {
  test('suma balance + balanceFrozen, ignora balanceReserved (ya incluido en balance)', () => {
    expect(mirrorLiabilityUSDC({ balance: 100, balanceFrozen: 25, balanceReserved: 10 })).toBe(125)
  })
  test('trata campos ausentes/NaN como 0', () => {
    expect(mirrorLiabilityUSDC({})).toBe(0)
    expect(mirrorLiabilityUSDC({ balance: 'x', balanceFrozen: null })).toBe(0)
    expect(mirrorLiabilityUSDC(undefined)).toBe(0)
  })
})

describe('classifyWalletReconciliation', () => {
  test('ambos cero → ok', () => {
    expect(classifyWalletReconciliation({ mirrorUSDC: 0, onChainUSDC: 0 }))
      .toEqual({ status: 'ok', deltaUSDC: 0 })
  })
  test('espejo == on-chain → ok', () => {
    expect(classifyWalletReconciliation({ mirrorUSDC: 42.5, onChainUSDC: 42.5 }).status).toBe('ok')
  })
  test('espejo positivo sin respaldo on-chain → offchain_without_onchain (esperado, ledger-only)', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 50, onChainUSDC: 0 })
    expect(r.status).toBe('offchain_without_onchain')
    expect(r.deltaUSDC).toBe(50)
  })
  test('espejo > on-chain con depósito on-chain (wallet mixta) → ledger_exceeds_onchain (esperado)', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 100, onChainUSDC: 90 })
    expect(r.status).toBe('ledger_exceeds_onchain')
    expect(r.deltaUSDC).toBe(10)
  })
  test('caso real 2026-07-22: mirror 61 / on-chain 50 → ledger_exceeds_onchain (mixta, no anomalía)', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 61, onChainUSDC: 50 })
    expect(r.status).toBe('ledger_exceeds_onchain')
    expect(r.deltaUSDC).toBe(11)
  })
  test('on-chain MAYOR que espejo (depósito sin acreditar) → onchain_exceeds_ledger, delta negativo', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 90, onChainUSDC: 100 })
    expect(r.status).toBe('onchain_exceeds_ledger')
    expect(r.deltaUSDC).toBe(-10)
  })
  test('diferencia dentro de la tolerancia de redondeo → ok', () => {
    expect(classifyWalletReconciliation({ mirrorUSDC: 10.00005, onChainUSDC: 10, toleranceUSDC: 0.001 }).status).toBe('ok')
  })
})

describe('computeSolvency', () => {
  test('reserva > pasivo → covered', () => {
    const r = computeSolvency({ liabilitiesUSDC: 1000, reservesUSDC: 1200 })
    expect(r.covered).toBe(true)
    expect(r.status).toBe('covered')
    expect(r.differenceUSDC).toBe(200)
  })
  test('reserva == pasivo → covered (diferencia 0)', () => {
    const r = computeSolvency({ liabilitiesUSDC: 500, reservesUSDC: 500 })
    expect(r.covered).toBe(true)
    expect(r.differenceUSDC).toBe(0)
  })
  test('reserva < pasivo → uncovered (subcolateralizado, el caso crítico)', () => {
    const r = computeSolvency({ liabilitiesUSDC: 1000, reservesUSDC: 950 })
    expect(r.covered).toBe(false)
    expect(r.status).toBe('uncovered')
    expect(r.differenceUSDC).toBe(-50)
  })
  test('faltante mínimo dentro de la tolerancia se considera covered', () => {
    const r = computeSolvency({ liabilitiesUSDC: 1000, reservesUSDC: 999.99995, toleranceUSDC: 0.001 })
    expect(r.covered).toBe(true)
  })
  test('solvencia de dos lados: reserva custodial+tesorería cubre saldos+en-vuelo (regresión del falso sub-colateralizado)', () => {
    // Escenario real 2026-07-22: custodial 50 + tesorería 539.71 = 589.71 reserva;
    // saldos usuarios 77.49 + payouts en vuelo 0 = 77.49 pasivo. Antes la reserva
    // contaba solo lo custodial (50) → falso 'uncovered'. Con los dos pozos → covered.
    const reservesUSDC    = 50 + 539.71
    const liabilitiesUSDC = 77.49 + 0
    const r = computeSolvency({ liabilitiesUSDC, reservesUSDC })
    expect(r.covered).toBe(true)
    expect(r.status).toBe('covered')
    // Y la trampa que se corrige: custodial-only habría reportado déficit.
    expect(computeSolvency({ liabilitiesUSDC, reservesUSDC: 50 }).covered).toBe(false)
  })
})

describe('classifyListenerHealth', () => {
  const interval = 30000
  test('sin heartbeat → unknown', () => {
    expect(classifyListenerHealth({ heartbeatAt: null }).status).toBe('unknown')
  })
  test('latido reciente → green', () => {
    const now = 1_000_000_000_000
    expect(classifyListenerHealth({ heartbeatAt: now - 10_000, now, intervalMs: interval }).status).toBe('green')
  })
  test('3 ciclos perdidos → amber', () => {
    const now = 1_000_000_000_000
    expect(classifyListenerHealth({ heartbeatAt: now - 3 * interval, now, intervalMs: interval }).status).toBe('amber')
  })
  test('6+ ciclos perdidos → red (listener probablemente muerto)', () => {
    const now = 1_000_000_000_000
    const r = classifyListenerHealth({ heartbeatAt: now - 7 * interval, now, intervalMs: interval })
    expect(r.status).toBe('red')
    expect(r.secondsSinceHeartbeat).toBe(210)
    expect(r.missedCycles).toBe(7)
  })
})

describe('evaluateAnchorAlerts', () => {
  const green = { health: 'green', horizon: { reachable: true }, secondsSinceHeartbeat: 10, missedCycles: 0 }

  test('todo verde → sin alertas', () => {
    expect(evaluateAnchorAlerts({ listener: green, reconciliation: { discrepancies: [] } })).toEqual([])
  })
  test("listener 'red' → alerta crítica listener-dead", () => {
    const a = evaluateAnchorAlerts({ listener: { ...green, health: 'red' } })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ key: 'listener-dead', severity: 'critical' })
  })
  test("listener 'amber' → aviso listener-lagging", () => {
    const a = evaluateAnchorAlerts({ listener: { ...green, health: 'amber' } })
    expect(a[0]).toMatchObject({ key: 'listener-lagging', severity: 'warning' })
  })
  test("listener 'unknown' (arranque) → sin alerta", () => {
    expect(evaluateAnchorAlerts({ listener: { ...green, health: 'unknown' } })).toEqual([])
  })
  test('Horizon inalcanzable → alerta crítica', () => {
    const a = evaluateAnchorAlerts({ listener: { health: 'green', horizon: { reachable: false } } })
    expect(a.some(x => x.key === 'listener-horizon-unreachable' && x.severity === 'critical')).toBe(true)
  })
  test('descuadre real (on-chain sin acreditar) → alerta crítica con total de los reales', () => {
    const recon = {
      totalMismatchUSDC: 100,   // suma de TODOS (incluye esperados) — NO debe usarse
      discrepancies: [
        { type: 'onchain_exceeds_ledger', deltaUSDC: -8 },
        { type: 'ledger_exceeds_onchain', deltaUSDC: 40 },   // esperado, no cuenta
        { type: 'offchain_without_onchain', deltaUSDC: 50 }, // esperado, no cuenta
      ],
    }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon })
    const critical = a.find(x => x.key === 'reconciliation-discrepancy')
    expect(critical).toMatchObject({ severity: 'critical' })
    // El total del email es solo del descuadre real (|−8| = 8), no de los 100 agregados.
    expect(critical.detail).toContain('1 wallet(s)')
    expect(critical.detail).toContain('8 USDC')
  })
  test('solo saldos ledger-only esperados (espejo > on-chain) → SIN alerta crítica', () => {
    // Regresión del caso real 2026-07-22: 1 mixta + 2 puro ledger-only, todos esperados.
    const recon = {
      discrepancies: [
        { type: 'ledger_exceeds_onchain', deltaUSDC: 11 },
        { type: 'offchain_without_onchain', deltaUSDC: 14.627471 },
        { type: 'offchain_without_onchain', deltaUSDC: 1.866737 },
      ],
    }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon, solvency: { covered: true, reliable: true } })
    expect(a).toEqual([])
  })
  test('solo errores de fetch Horizon → aviso, no crítico', () => {
    const recon = { discrepancies: [{ type: 'onchain_fetch_error' }, { type: 'onchain_fetch_error' }] }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ key: 'reconciliation-fetch-errors', severity: 'warning' })
  })
  test('descuadres reales bajo el umbral no alertan (maxDiscrepancies)', () => {
    const recon = { discrepancies: [{ type: 'onchain_exceeds_ledger', deltaUSDC: -5 }] }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon, thresholds: { maxDiscrepancies: 1 } })
    expect(a.some(x => x.key === 'reconciliation-discrepancy')).toBe(false)
  })
})

describe('evaluateAnchorAlerts — solvencia agregada', () => {
  const green = { health: 'green', horizon: { reachable: true }, secondsSinceHeartbeat: 10, missedCycles: 0 }

  test('solvencia cubierta → sin alerta', () => {
    const solvency = { covered: true, reliable: true, liabilitiesUSDC: 77.49, reservesUSDC: 589.71, differenceUSDC: 512.22 }
    expect(evaluateAnchorAlerts({ listener: green, solvency })).toEqual([])
  })
  test('sub-colateralización (covered:false) → alerta crítica con déficit', () => {
    const solvency = { covered: false, reliable: true, liabilitiesUSDC: 1000, reservesUSDC: 950, differenceUSDC: -50 }
    const a = evaluateAnchorAlerts({ listener: green, solvency })
    const crit = a.find(x => x.key === 'solvency-uncovered')
    expect(crit).toMatchObject({ severity: 'critical' })
    expect(crit.detail).toContain('50 USDC')
  })
  test('solvencia no medible con fiabilidad (reliable:false) → aviso, no crítico', () => {
    const solvency = { covered: true, reliable: false }
    const a = evaluateAnchorAlerts({ listener: green, solvency })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ key: 'solvency-unreliable', severity: 'warning' })
  })
  test('déficit real gana a la fiabilidad: covered:false + reliable:false → solo crítico', () => {
    const solvency = { covered: false, reliable: false, liabilitiesUSDC: 100, reservesUSDC: 80, differenceUSDC: -20 }
    const a = evaluateAnchorAlerts({ listener: green, solvency })
    expect(a).toHaveLength(1)
    expect(a[0].key).toBe('solvency-uncovered')
  })
})
