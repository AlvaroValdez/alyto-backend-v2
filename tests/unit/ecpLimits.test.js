/**
 * ecpLimits.test.js — Límites agregados del ECP (ASFI).
 *
 * El Protocolo de Pruebas declara ocho límites ante ASFI. Estas pruebas acreditan
 * que los seis agregados se aplican como control técnico y no como expectativa.
 * Art. 13° inc. f: el exceso de límites es causal de rechazo del servicio.
 */

import { evaluateEcpLimits, ecpViolationMessage } from '../../src/services/ecpLimits.js';

const LIMITS = {
  perOperationMaxBOB: 120_000,
  dailyAmountBOB:     170_000,
  dailyOperations:    0,          // el Protocolo vigente no declara tope de conteo diario
  monthlyAmountBOB:   0,          // ni tope mensual
  periodAmountBOB:    8_000_000,
  periodOperations:   6_000,
  maxConsumers:       630,
};

/** Consumo en cero, para partir de un estado limpio en cada caso. */
const sinConsumo = () => ({
  day:    { amount: 0, count: 0 },
  month:  { amount: 0, count: 0 },
  period: { amount: 0, count: 0 },
});

describe('evaluateEcpLimits — los seis límites agregados', () => {

  it('admite una operación dentro de todos los límites', () => {
    const r = evaluateEcpLimits({ amountBOB: 5_000, usage: sinConsumo(), limits: LIMITS });
    expect(r.allowed).toBe(true);
    expect(r.violation).toBeNull();
  });

  // ── Por operación ────────────────────────────────────────────────────────────
  it('rechaza por encima del máximo por operación', () => {
    const r = evaluateEcpLimits({ amountBOB: 120_001, usage: sinConsumo(), limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_OPERATION_LIMIT');
    expect(r.violation.limit).toBe(120_000);
  });

  it('admite exactamente el máximo por operación (el límite es inclusivo)', () => {
    const r = evaluateEcpLimits({ amountBOB: 120_000, usage: sinConsumo(), limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  // ── Diario, en monto ─────────────────────────────────────────────────────────
  it('rechaza cuando la operación haría exceder el acumulado diario', () => {
    const usage = sinConsumo();
    usage.day = { amount: 100_000, count: 3 };
    // 100.000 consumidos + 70.001 = 170.001 > 170.000
    const r = evaluateEcpLimits({ amountBOB: 70_001, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_DAILY_AMOUNT_LIMIT');
    expect(r.violation.remaining).toBe(70_000);
  });

  it('admite la operación que agota exactamente el acumulado diario', () => {
    const usage = sinConsumo();
    usage.day = { amount: 100_000, count: 3 };
    const r = evaluateEcpLimits({ amountBOB: 70_000, usage, limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  // ── Conteo diario y tope mensual: desactivados en el Protocolo vigente ───────
  it('no aplica tope de conteo diario, porque el Protocolo no lo declara', () => {
    const usage = sinConsumo();
    usage.day = { amount: 1_000, count: 500 };
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  it('no aplica tope mensual, porque el Protocolo no lo declara', () => {
    const usage = sinConsumo();
    usage.month = { amount: 5_000_000, count: 300 };
    const r = evaluateEcpLimits({ amountBOB: 2_000, usage, limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  // ── Período ──────────────────────────────────────────────────────────────────

  it('rechaza por el acumulado del período', () => {
    const usage = sinConsumo();
    usage.period = { amount: 7_999_000, count: 4_000 };
    const r = evaluateEcpLimits({ amountBOB: 2_000, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_PERIOD_AMOUNT_LIMIT');
  });

  it('rechaza por el número de operaciones del período', () => {
    const usage = sinConsumo();
    usage.period = { amount: 1_000, count: 6_000 };
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_PERIOD_COUNT_LIMIT');
  });

  // ── Precedencia ──────────────────────────────────────────────────────────────
  it('informa el límite por operación antes que los acumulados', () => {
    // Excede los cuatro a la vez: debe reportarse el más específico.
    const usage = { day:    { amount: 169_000, count: 44 },
                    month:  { amount: 0, count: 0 },
                    period: { amount: 7_999_000, count: 5_999 } };
    const r = evaluateEcpLimits({ amountBOB: 500_000, usage, limits: LIMITS });
    expect(r.violation.code).toBe('ECP_OPERATION_LIMIT');
  });

  // ── Desactivación por límite en cero ─────────────────────────────────────────
  it('ignora un límite configurado en cero, sin afectar a los demás', () => {
    const limits = { ...LIMITS, dailyAmountBOB: 0 };
    const usage  = sinConsumo();
    usage.day    = { amount: 999_999, count: 1 };
    const r = evaluateEcpLimits({ amountBOB: 1_000, usage, limits });
    expect(r.allowed).toBe(true);
  });

  // ── Invariante: el remanente informado nunca es negativo ─────────────────────
  it('no informa remanente negativo aunque el consumo ya exceda el límite', () => {
    const usage = sinConsumo();
    usage.day   = { amount: 180_000, count: 5 };  // ya por encima de 170.000
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.remaining).toBe(0);
  });
});

describe('ecpViolationMessage — el mensaje no filtra el agregado de la plataforma', () => {

  it('no revela el consumo ni el límite en el texto', () => {
    const violation = { code: 'ECP_DAILY_AMOUNT_LIMIT', scope: 'diario', unit: 'BOB',
                        limit: 170_000, used: 169_800, requested: 400, remaining: 200 };
    const msg = ecpViolationMessage(violation);
    expect(msg).not.toMatch(/170.?000/);
    expect(msg).not.toMatch(/169.?800/);
    expect(msg).toMatch(/diario/);
  });

  it('distingue el agotamiento por número de operaciones', () => {
    const msg = ecpViolationMessage({ code: 'ECP_DAILY_COUNT_LIMIT', scope: 'diario',
                                      unit: 'operaciones', limit: 45, used: 45 });
    expect(msg).toMatch(/número máximo de operaciones/);
  });

  it('tiene mensaje propio para la verificación no disponible', () => {
    const msg = ecpViolationMessage({ code: 'ECP_LIMIT_CHECK_UNAVAILABLE' });
    expect(msg).toMatch(/No fue posible verificar/);
  });

  it('devuelve null sin violación', () => {
    expect(ecpViolationMessage(null)).toBeNull();
  });
});
