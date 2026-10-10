/**
 * harborSettlementTime.test.js — Plazo REAL que declara Harbor.
 *
 * Harbor devuelve el plazo como rango con unidad (`settlement_time_min/max/unit`).
 * `owlPayService` ya los normalizaba y nadie los consumía.
 *
 * Lo que estos tests blindan, por orden de gravedad:
 *   1. Que una unidad DESCONOCIDA devuelva null. Leer "48" como 48 días cuando son
 *      48 horas es un error de dos órdenes de magnitud en una promesa al usuario.
 *   2. Que un dato ausente o roto NO se degrade a 0, que diría "pocas horas".
 *   3. Que la conversión vaya en la dirección conservadora.
 */

import { harborSettlementToBusinessDays } from '../../src/utils/harborSettlementTime.js';

const q = (min, max, unit) => ({ settlementTimeMin: min, settlementTimeMax: max, settlementTimeUnit: unit });

describe('unidad desconocida: no se adivina', () => {
  test('una unidad que no se reconoce devuelve null', () => {
    for (const u of ['week', 'weeks', 'month', 'minute', 'minutes', 'fortnight', 'xyz', '??']) {
      expect(harborSettlementToBusinessDays(q(1, 3, u))).toBeNull();
    }
  });

  test('unidad ausente, vacía o no-string devuelve null', () => {
    for (const u of [null, undefined, '', '   ', 42, {}, []]) {
      expect(harborSettlementToBusinessDays(q(1, 3, u))).toBeNull();
    }
  });

  test('el caso catastrófico: 48 con unidad desconocida NO se lee como 48 días', () => {
    expect(harborSettlementToBusinessDays(q(24, 48, 'unidad_nueva_de_harbor'))).toBeNull();
  });
});

describe('días: se toman como hábiles (dirección conservadora)', () => {
  test('acepta las variantes de nombre que puede usar Harbor', () => {
    for (const u of ['day', 'days', 'D', 'business_day', 'business_days', 'BusinessDays', 'calendar_days']) {
      expect(harborSettlementToBusinessDays(q(1, 3, u))).toEqual({ min: 1, max: 3 });
    }
  });

  test('un rango de un solo valor se conserva', () => {
    expect(harborSettlementToBusinessDays(q(2, 2, 'days'))).toEqual({ min: 2, max: 2 });
  });

  test('cero días es válido: liquidación el mismo día', () => {
    expect(harborSettlementToBusinessDays(q(0, 0, 'days'))).toEqual({ min: 0, max: 0 });
  });
});

describe('horas: menos de 24 es el mismo día hábil', () => {
  test('sub-diario colapsa a 0', () => {
    expect(harborSettlementToBusinessDays(q(1, 4,  'hours'))).toEqual({ min: 0, max: 0 });
    expect(harborSettlementToBusinessDays(q(2, 23, 'hour'))).toEqual({ min: 0, max: 0 });
  });

  test('24 h es un día hábil', () => {
    expect(harborSettlementToBusinessDays(q(24, 24, 'hours'))).toEqual({ min: 1, max: 1 });
  });

  test('redondea hacia ARRIBA: 25 h no caben en un día hábil', () => {
    expect(harborSettlementToBusinessDays(q(25, 25, 'hours'))).toEqual({ min: 2, max: 2 });
    expect(harborSettlementToBusinessDays(q(48, 72, 'hours'))).toEqual({ min: 2, max: 3 });
  });

  test('rango que cruza el día: mínimo sub-diario, máximo de días', () => {
    expect(harborSettlementToBusinessDays(q(4, 48, 'hours'))).toEqual({ min: 0, max: 2 });
  });
});

describe('ausencia y datos roto NO valen cero', () => {
  test('sin máximo devuelve null: el máximo es el que compromete', () => {
    expect(harborSettlementToBusinessDays(q(1, null,      'days'))).toBeNull();
    expect(harborSettlementToBusinessDays(q(1, undefined, 'days'))).toBeNull();
    expect(harborSettlementToBusinessDays(q(1, '',        'days'))).toBeNull();
  });

  test('máximo inválido devuelve null', () => {
    for (const malo of [NaN, -1, 'tres', {}, []]) {
      expect(harborSettlementToBusinessDays(q(1, malo, 'days'))).toBeNull();
    }
  });

  test('sin mínimo se asume 0, que es un rango legítimo', () => {
    expect(harborSettlementToBusinessDays(q(null, 3, 'days'))).toEqual({ min: 0, max: 3 });
  });

  test('un mínimo mayor que el máximo se recorta, no invierte el rango', () => {
    expect(harborSettlementToBusinessDays(q(5, 2, 'days'))).toEqual({ min: 2, max: 2 });
  });

  test('cotización nula o vacía devuelve null', () => {
    expect(harborSettlementToBusinessDays(null)).toBeNull();
    expect(harborSettlementToBusinessDays(undefined)).toBeNull();
    expect(harborSettlementToBusinessDays({})).toBeNull();
  });
});

describe('numéricos en string', () => {
  test('se aceptan, que es como suelen venir de una API', () => {
    expect(harborSettlementToBusinessDays(q('1', '3', 'days'))).toEqual({ min: 1, max: 3 });
  });
});
