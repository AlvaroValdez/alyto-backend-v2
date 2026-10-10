/**
 * harborSettlementTime.test.js — Plazo REAL que declara Harbor.
 *
 * Los fixtures NO son inventados: salen de un sondeo al sandbox de Harbor del
 * 2026-10-10, una cotización por ruta. Eso es lo que hace que estos tests
 * signifiquen algo: fijan el comportamiento contra la forma real de la respuesta,
 * no contra la que yo supuse (que estaba mal en la unidad).
 *
 * Lo que blindan, por orden de gravedad:
 *   1. Que una unidad DESCONOCIDA devuelva null. Leer "48" como 48 días cuando son
 *      48 horas es un error de dos órdenes de magnitud en una promesa al usuario.
 *   2. Que MINUTES no se descarte: hay rutas que liquidan en minutos.
 *   3. Que un dato ausente o roto NO se degrade a 0, que diría "mismo día".
 */

import { harborSettlementRange } from '../../src/utils/harborSettlementTime.js';

const q = (min, max, unit) => ({ settlementTimeMin: min, settlementTimeMax: max, settlementTimeUnit: unit });

describe('respuestas REALES del sandbox (sondeo 2026-10-10)', () => {
  // La unidad llega en MAYÚSCULAS. Suponerla en minúsculas habría descartado todo.
  test('US/USD ACH Push: 2–5 DAYS', () => {
    expect(harborSettlementRange(q(2, 5, 'DAYS')))
      .toEqual({ min: 2, max: 5, unit: 'days', minBusinessDays: 2, maxBusinessDays: 5 });
  });

  test('US/USD Fedwire: 1–1 DAYS', () => {
    expect(harborSettlementRange(q(1, 1, 'DAYS')))
      .toEqual({ min: 1, max: 1, unit: 'days', minBusinessDays: 1, maxBusinessDays: 1 });
  });

  test('US/USD Domestic Wire y GB/GBP Bank Transfer: 0–2 DAYS', () => {
    expect(harborSettlementRange(q(0, 2, 'DAYS')))
      .toEqual({ min: 0, max: 2, unit: 'days', minBusinessDays: 0, maxBusinessDays: 2 });
  });

  test('BR/USD International Wire: 1–3 DAYS', () => {
    expect(harborSettlementRange(q(1, 3, 'DAYS')))
      .toEqual({ min: 1, max: 3, unit: 'days', minBusinessDays: 1, maxBusinessDays: 3 });
  });

  test('SG/SGD: 1–15 MINUTES, y se conserva la unidad real', () => {
    // Colapsarlo a "0 días hábiles" perdería el dato: son minutos, y al usuario se
    // le puede decir así con la verdad en la mano.
    expect(harborSettlementRange(q(1, 15, 'MINUTES')))
      .toEqual({ min: 1, max: 15, unit: 'minutes', minBusinessDays: 0, maxBusinessDays: 0 });
  });

  test('NG/NGN: 1–5 MINUTES', () => {
    expect(harborSettlementRange(q(1, 5, 'MINUTES')))
      .toEqual({ min: 1, max: 5, unit: 'minutes', minBusinessDays: 0, maxBusinessDays: 0 });
  });
});

describe('unidad desconocida: no se adivina', () => {
  test('una unidad fuera del mapa devuelve null', () => {
    for (const u of ['week', 'weeks', 'month', 'fortnight', 'xyz', '??']) {
      expect(harborSettlementRange(q(1, 3, u))).toBeNull();
    }
  });

  test('unidad ausente, vacía o no-string devuelve null', () => {
    for (const u of [null, undefined, '', '   ', 42, {}, []]) {
      expect(harborSettlementRange(q(1, 3, u))).toBeNull();
    }
  });

  test('el caso catastrófico: 48 con unidad desconocida NO se lee como 48 días', () => {
    expect(harborSettlementRange(q(24, 48, 'unidad_nueva_de_harbor'))).toBeNull();
  });
});

describe('conversión a días hábiles para la fecha límite', () => {
  test('sub-diario colapsa a 0 días, cualquiera sea la unidad', () => {
    expect(harborSettlementRange(q(1, 59,  'MINUTES')).maxBusinessDays).toBe(0);
    expect(harborSettlementRange(q(1, 23,  'HOURS')).maxBusinessDays).toBe(0);
    expect(harborSettlementRange(q(1, 30,  'SECONDS')).maxBusinessDays).toBe(0);
  });

  test('exactamente un día es 1 día hábil', () => {
    expect(harborSettlementRange(q(24, 24, 'HOURS')).maxBusinessDays).toBe(1);
    expect(harborSettlementRange(q(1440, 1440, 'MINUTES')).maxBusinessDays).toBe(1);
  });

  test('redondea hacia ARRIBA: 25 h no caben en un día hábil', () => {
    expect(harborSettlementRange(q(25, 25, 'HOURS')).maxBusinessDays).toBe(2);
    expect(harborSettlementRange(q(48, 72, 'HOURS'))).toMatchObject({ minBusinessDays: 2, maxBusinessDays: 3 });
  });

  test('acepta las variantes de nombre para días', () => {
    for (const u of ['day', 'DAYS', 'business_day', 'BusinessDays', 'calendar_days']) {
      expect(harborSettlementRange(q(1, 3, u)).maxBusinessDays).toBe(3);
    }
  });
});

describe('ausencia y datos roto NO valen cero', () => {
  test('sin máximo devuelve null: el máximo es el que compromete', () => {
    for (const malo of [null, undefined, '']) {
      expect(harborSettlementRange(q(1, malo, 'DAYS'))).toBeNull();
    }
  });

  test('máximo inválido devuelve null', () => {
    for (const malo of [NaN, -1, 'tres', {}, []]) {
      expect(harborSettlementRange(q(1, malo, 'DAYS'))).toBeNull();
    }
  });

  test('sin mínimo se asume 0, que es un rango legítimo', () => {
    expect(harborSettlementRange(q(null, 3, 'DAYS'))).toMatchObject({ min: 0, max: 3 });
  });

  test('un mínimo mayor que el máximo se recorta, no invierte el rango', () => {
    expect(harborSettlementRange(q(5, 2, 'DAYS'))).toMatchObject({ min: 2, max: 2 });
  });

  test('cotización nula o vacía devuelve null', () => {
    expect(harborSettlementRange(null)).toBeNull();
    expect(harborSettlementRange(undefined)).toBeNull();
    expect(harborSettlementRange({})).toBeNull();
  });

  test('numéricos en string se aceptan', () => {
    expect(harborSettlementRange(q('1', '3', 'DAYS'))).toMatchObject({ min: 1, max: 3 });
  });
});
