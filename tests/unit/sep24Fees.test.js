/**
 * sep24Fees.test.js — Comisión del retiro SEP-24.
 *
 * Acredita el apdo. 5.4 del Informe Técnico: lo que se descuenta es lo que se informa.
 *
 * El defecto que este módulo corrige era estructural: `/info` publicaba `6.5` y `/fee`
 * calculaba con `0.065`, dos literales independientes en unidades distintas. La prueba
 * central de este archivo es que **no puedan divergir**.
 */

import { jest } from '@jest/globals';

const mockFind = jest.fn();
jest.unstable_mockModule('../../src/models/TransactionConfig.js', () => ({
  default: { find: mockFind },
}));

const { resolveWithdrawFeePercent, resolveWithdrawFeeFraction, computeFee,
        __resetSep24FeeCacheForTest } = await import('../../src/services/sep24Fees.js');

/** Encadena `.find().select().lean()` devolviendo los corredores dados. */
function corredores(lista) {
  mockFind.mockReturnValue({ select: () => ({ lean: async () => lista }) });
}

beforeEach(() => {
  __resetSep24FeeCacheForTest();
  mockFind.mockReset();
});

describe('resolveWithdrawFeePercent — resuelve desde el tarifario', () => {

  it('toma el spread configurado cuando todos los corredores coinciden', async () => {
    corredores([{ alytoCSpread: 6.5 }, { alytoCSpread: 6.5 }, { alytoCSpread: 6.5 }]);
    expect(await resolveWithdrawFeePercent()).toBe(6.5);
  });

  it('sigue al tarifario si cambia', async () => {
    // Este es el punto: antes el 6,5% estaba fijo y no acompañaba un cambio de tarifa.
    corredores([{ alytoCSpread: 5 }, { alytoCSpread: 5 }]);
    expect(await resolveWithdrawFeePercent()).toBe(5);
  });

  it('publica el MAYOR cuando el tarifario está disperso', async () => {
    // La comisión publicada es un techo: que se cobre menos de lo anunciado es
    // admisible; que se cobre más, no.
    corredores([{ alytoCSpread: 4 }, { alytoCSpread: 6.5 }, { alytoCSpread: 2 }]);
    expect(await resolveWithdrawFeePercent()).toBe(6.5);
  });

  it('ignora spreads nulos o no numéricos', async () => {
    corredores([{ alytoCSpread: null }, { alytoCSpread: 6.5 }, { alytoCSpread: 'x' }]);
    expect(await resolveWithdrawFeePercent()).toBe(6.5);
  });

  it('usa el valor de resguardo sin corredores configurados', async () => {
    corredores([]);
    expect(await resolveWithdrawFeePercent()).toBe(6.5);
  });

  it('usa el valor de resguardo si la consulta falla, en lugar de romper /info', async () => {
    // No es fail-closed a propósito: /info es un documento de descubrimiento que el
    // ecosistema consulta sin sesión; devolverlo vacío rompería la interoperabilidad
    // del anchor sin proteger a nadie.
    mockFind.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('db caída'); } }) });
    expect(await resolveWithdrawFeePercent()).toBe(6.5);
  });

  it('memoiza: no consulta el tarifario en cada llamada', async () => {
    corredores([{ alytoCSpread: 6.5 }]);
    await resolveWithdrawFeePercent();
    await resolveWithdrawFeePercent();
    await resolveWithdrawFeePercent();
    expect(mockFind).toHaveBeenCalledTimes(1);
  });
});

describe('/info y /fee no pueden divergir', () => {

  it('la fracción es exactamente el porcentaje dividido cien', async () => {
    corredores([{ alytoCSpread: 6.5 }]);
    const pct  = await resolveWithdrawFeePercent();
    const frac = await resolveWithdrawFeeFraction();
    expect(frac).toBeCloseTo(pct / 100, 10);
  });

  it('un cambio de tarifa mueve las dos formas a la vez', async () => {
    corredores([{ alytoCSpread: 3.25 }]);
    expect(await resolveWithdrawFeePercent()).toBe(3.25);
    expect(await resolveWithdrawFeeFraction()).toBeCloseTo(0.0325, 10);
  });
});

describe('computeFee — el importe que se descuenta', () => {

  it.each([
    [1_000, 6.5, 65],
    [100,   6.5, 6.5],
    [10,    6.5, 0.65],
    [1_000, 4,   40],
  ])('sobre %i al %s%% → %s', (amount, feePercent, esperado) => {
    expect(computeFee({ amount, feePercent })).toBeCloseTo(esperado, 2);
  });

  it('redondea a dos decimales', () => {
    expect(computeFee({ amount: 33.33, feePercent: 6.5 })).toBe(2.17);
  });

  it('devuelve cero ante entradas inválidas, sin lanzar', () => {
    for (const p of [{ amount: 0, feePercent: 6.5 }, { amount: -100, feePercent: 6.5 },
                     { amount: 1_000, feePercent: 0 }, { amount: NaN, feePercent: 6.5 },
                     { amount: 1_000, feePercent: undefined }]) {
      expect(computeFee(p)).toBe(0);
    }
  });
});
