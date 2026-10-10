/**
 * plazoPublicado.test.js — Plazo que se publica al consumidor.
 *
 * Acredita la regla acordada el 2026-10-10: se informa el MAYOR entre el plazo real
 * del proveedor y el tramo declarado del Entorno Controlado de Pruebas. Nunca un
 * plazo más corto que el entregable.
 *
 * Lo que de verdad hay que blindar es el caso peligroso: un importe pequeño en un
 * corredor lento. Cae en el tramo "Estándar / mismo día hábil" y el proveedor tarda
 * días; si el max() se rompiera, la app volvería a prometer un plazo falso sin que
 * nada avise.
 */

import { resolvePlazoLiquidacion, plazoTexto } from '../../src/utils/plazoPublicado.js';

// Lunes: evita que el corrimiento de fin de semana contamine las aserciones.
const LUNES = new Date('2026-10-12T10:00:00');

describe('resolvePlazoLiquidacion — el mayor de los dos plazos', () => {
  test('proveedor MÁS LENTO que el tramo: publica el del proveedor y lo marca', () => {
    // Bs 5.000 = tramo Estándar (mismo día). Harbor tarda 3 días hábiles.
    const r = resolvePlazoLiquidacion({ amountBOB: 5000, payoutEtaBusinessDays: 3, desde: LUNES });
    expect(r.diasHabiles).toBe(3);
    expect(r.plazoLiquidacion).toBe('Hasta 3 días hábiles');
    expect(r.origen).toBe('proveedor');
    expect(r.excedeTramoEcp).toBe(true);
    expect(r.tramo).toBe('estandar');
  });

  test('proveedor MÁS RÁPIDO que el tramo: publica el del ECP, que es el comprometido', () => {
    // Bs 100.000 = tramo Corporativo (2 días). Vita liquida en 1.
    const r = resolvePlazoLiquidacion({ amountBOB: 100000, payoutEtaBusinessDays: 1, desde: LUNES });
    expect(r.diasHabiles).toBe(2);
    expect(r.origen).toBe('ecp');
    expect(r.excedeTramoEcp).toBe(false);
  });

  test('empate: se atribuye al ECP, que es el plazo declarado', () => {
    const r = resolvePlazoLiquidacion({ amountBOB: 50000, payoutEtaBusinessDays: 1, desde: LUNES });
    expect(r.diasHabiles).toBe(1);
    expect(r.origen).toBe('ecp');
    expect(r.excedeTramoEcp).toBe(false);
  });

  test('NUNCA publica un plazo menor que el del proveedor', () => {
    // Barrido sobre los tres tramos y plazos de proveedor de 0 a 5 días.
    for (const amount of [5000, 50000, 100000]) {
      for (const eta of [0, 1, 2, 3, 4, 5]) {
        const r = resolvePlazoLiquidacion({ amountBOB: amount, payoutEtaBusinessDays: eta, desde: LUNES });
        expect(r.diasHabiles).toBeGreaterThanOrEqual(eta);
      }
    }
  });
});

describe('resolvePlazoLiquidacion — bordes y datos faltantes', () => {
  test('sin ETA configurada cae al tramo y lo marca como no verificado', () => {
    const r = resolvePlazoLiquidacion({ amountBOB: 10000, payoutEtaBusinessDays: null, desde: LUNES });
    expect(r.diasHabiles).toBe(0);
    expect(r.etaProveedorVerificada).toBe(false);
    expect(r.origen).toBe('ecp');
  });

  test('con ETA configurada queda marcada como verificada', () => {
    const r = resolvePlazoLiquidacion({ amountBOB: 10000, payoutEtaBusinessDays: 2, desde: LUNES });
    expect(r.etaProveedorVerificada).toBe(true);
  });

  test('importe fuera de los tramos devuelve null: lo rechaza el control de límites', () => {
    // Por encima del máximo del ECP (Bs 120.000) y por debajo del mínimo (Bs 400).
    expect(resolvePlazoLiquidacion({ amountBOB: 200000, payoutEtaBusinessDays: 1, desde: LUNES })).toBeNull();
    expect(resolvePlazoLiquidacion({ amountBOB: 100,    payoutEtaBusinessDays: 1, desde: LUNES })).toBeNull();
  });

  test('ETA inválida se trata como ausente, no como cero', () => {
    // Un NaN o un negativo no deben convertirse en "mismo día hábil".
    for (const malo of [NaN, -1, undefined, 'dos']) {
      const r = resolvePlazoLiquidacion({ amountBOB: 100000, payoutEtaBusinessDays: malo, desde: LUNES });
      expect(r.etaProveedorVerificada).toBe(false);
      expect(r.diasHabiles).toBe(2);   // el tramo Corporativo, no 0
    }
  });

  test('el vencimiento no cae nunca en sábado ni domingo', () => {
    for (const dia of ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']) {
      const r = resolvePlazoLiquidacion({
        amountBOB: 5000, payoutEtaBusinessDays: 1, desde: new Date(`${dia}T15:00:00`),
      });
      const d = new Date(r.plazoLiquidacionHasta).getDay();
      expect([0, 6]).not.toContain(d);
    }
  });
});

describe('plazoTexto', () => {
  test('singular, plural y mismo día', () => {
    expect(plazoTexto(0)).toBe('Mismo día hábil');
    expect(plazoTexto(1)).toBe('Hasta 1 día hábil');
    expect(plazoTexto(3)).toBe('Hasta 3 días hábiles');
  });
});
