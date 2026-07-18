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
