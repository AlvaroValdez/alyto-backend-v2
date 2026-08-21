/**
 * ecpLimits.test.js — Límites agregados del ECP (ASFI).
 *
 * El Protocolo de Pruebas declara ocho límites ante ASFI. Estas pruebas acreditan
 * que los seis agregados se aplican como control técnico y no como expectativa.
 * Art. 13° inc. f: el exceso de límites es causal de rechazo del servicio.
 */

import { evaluateEcpLimits, ecpViolationMessage } from '../../src/services/ecpLimits.js';

const LIMITS = {
  perOperationMaxBOB: 20_000,
  dailyAmountBOB:     26_000,
  dailyOperations:    45,
  monthlyAmountBOB:   480_000,
  periodAmountBOB:    3_500_000,
  periodOperations:   4_500,
  maxConsumers:       600,
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
    const r = evaluateEcpLimits({ amountBOB: 20_001, usage: sinConsumo(), limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_OPERATION_LIMIT');
    expect(r.violation.limit).toBe(20_000);
  });

  it('admite exactamente el máximo por operación (el límite es inclusivo)', () => {
    const r = evaluateEcpLimits({ amountBOB: 20_000, usage: sinConsumo(), limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  // ── Diario, en monto ─────────────────────────────────────────────────────────
  it('rechaza cuando la operación haría exceder el acumulado diario', () => {
    const usage = sinConsumo();
    usage.day = { amount: 20_000, count: 3 };
    // 20.000 consumidos + 6.001 = 26.001 > 26.000
    const r = evaluateEcpLimits({ amountBOB: 6_001, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_DAILY_AMOUNT_LIMIT');
    expect(r.violation.remaining).toBe(6_000);
  });

  it('admite la operación que agota exactamente el acumulado diario', () => {
    const usage = sinConsumo();
    usage.day = { amount: 20_000, count: 3 };
    const r = evaluateEcpLimits({ amountBOB: 6_000, usage, limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  // ── Diario, en número ────────────────────────────────────────────────────────
  it('rechaza la operación número 46 del día aunque el monto sea mínimo', () => {
    const usage = sinConsumo();
    usage.day = { amount: 1_000, count: 45 };
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_DAILY_COUNT_LIMIT');
    expect(r.violation.unit).toBe('operaciones');
  });

  it('admite la operación número 45 del día', () => {
    const usage = sinConsumo();
    usage.day = { amount: 1_000, count: 44 };
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(true);
  });

  // ── Mensual y período ────────────────────────────────────────────────────────
  it('rechaza por el acumulado mensual', () => {
    const usage = sinConsumo();
    usage.day   = { amount: 0,       count: 0 };
    usage.month = { amount: 479_000, count: 300 };
    const r = evaluateEcpLimits({ amountBOB: 2_000, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_MONTHLY_AMOUNT_LIMIT');
  });

  it('rechaza por el acumulado del período', () => {
    const usage = sinConsumo();
    usage.period = { amount: 3_499_000, count: 4_000 };
    const r = evaluateEcpLimits({ amountBOB: 2_000, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_PERIOD_AMOUNT_LIMIT');
  });

  it('rechaza por el número de operaciones del período', () => {
    const usage = sinConsumo();
    usage.period = { amount: 1_000, count: 4_500 };
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.code).toBe('ECP_PERIOD_COUNT_LIMIT');
  });

  // ── Precedencia ──────────────────────────────────────────────────────────────
  it('informa el límite por operación antes que los acumulados', () => {
    // Excede los cuatro a la vez: debe reportarse el más específico.
    const usage = { day:    { amount: 25_000, count: 44 },
                    month:  { amount: 479_000, count: 300 },
                    period: { amount: 3_499_000, count: 4_499 } };
    const r = evaluateEcpLimits({ amountBOB: 50_000, usage, limits: LIMITS });
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
    usage.day   = { amount: 30_000, count: 5 };   // ya por encima de 26.000
    const r = evaluateEcpLimits({ amountBOB: 400, usage, limits: LIMITS });
    expect(r.allowed).toBe(false);
    expect(r.violation.remaining).toBe(0);
  });
});

describe('ecpViolationMessage — el mensaje no filtra el agregado de la plataforma', () => {

  it('no revela el consumo ni el límite en el texto', () => {
    const violation = { code: 'ECP_DAILY_AMOUNT_LIMIT', scope: 'diario', unit: 'BOB',
                        limit: 26_000, used: 25_800, requested: 400, remaining: 200 };
    const msg = ecpViolationMessage(violation);
    expect(msg).not.toMatch(/26.?000/);
    expect(msg).not.toMatch(/25.?800/);
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
