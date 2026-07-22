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
  test('espejo positivo sin respaldo on-chain → offchain_without_onchain', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 50, onChainUSDC: 0 })
    expect(r.status).toBe('offchain_without_onchain')
    expect(r.deltaUSDC).toBe(50)
  })
  test('diferencia por encima de la tolerancia → balance_mismatch', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 100, onChainUSDC: 90 })
    expect(r.status).toBe('balance_mismatch')
    expect(r.deltaUSDC).toBe(10)
  })
  test('on-chain MAYOR que espejo (posible inflow externo) → balance_mismatch con delta negativo', () => {
    const r = classifyWalletReconciliation({ mirrorUSDC: 90, onChainUSDC: 100 })
    expect(r.status).toBe('balance_mismatch')
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
  test('descuadre real de reconciliación → alerta crítica', () => {
    const recon = {
      totalMismatchUSDC: 12.5,
      discrepancies: [
        { type: 'balance_mismatch' },
        { type: 'offchain_without_onchain' },
      ],
    }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon })
    expect(a.some(x => x.key === 'reconciliation-discrepancy' && x.severity === 'critical')).toBe(true)
  })
  test('solo errores de fetch Horizon → aviso, no crítico', () => {
    const recon = { discrepancies: [{ type: 'onchain_fetch_error' }, { type: 'onchain_fetch_error' }] }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ key: 'reconciliation-fetch-errors', severity: 'warning' })
  })
  test('descuadres bajo el umbral no alertan (maxDiscrepancies)', () => {
    const recon = { discrepancies: [{ type: 'balance_mismatch' }] }
    const a = evaluateAnchorAlerts({ listener: green, reconciliation: recon, thresholds: { maxDiscrepancies: 1 } })
    expect(a.some(x => x.key === 'reconciliation-discrepancy')).toBe(false)
  })
})
