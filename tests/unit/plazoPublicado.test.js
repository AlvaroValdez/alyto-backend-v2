/**
 * plazoPublicado.test.js — Plazo que se publica al consumidor.
 *
 * Acredita la regla acordada el 2026-10-10: se informa el plazo REAL del proveedor
 * siempre que esté configurado. El tramo del Entorno Controlado de Pruebas solo
 * cubre el hueco cuando el corredor no tiene el dato.
 *
 * Lo que hay que blindar es que el plazo publicado sea EXACTO, no conservador.
 * Publicar más de lo que tarda el proveedor es tan falso como publicar menos: en un
 * caso no se cumple la promesa, en el otro se le oculta al usuario que su pago llega
 * antes. Estos tests fijan las dos direcciones.
 */

import { resolvePlazoLiquidacion, plazoTexto } from '../../src/utils/plazoPublicado.js';

// Lunes: evita que el corrimiento de fin de semana contamine las aserciones.
const LUNES = new Date('2026-10-12T10:00:00');

describe('resolvePlazoLiquidacion — manda el plazo del proveedor', () => {
  test('proveedor MÁS LENTO que el tramo: publica el del proveedor y marca el exceso', () => {
    // Bs 5.000 = tramo Estándar (mismo día). Harbor tarda 3 días hábiles.
    // Publicar "mismo día" seria una promesa incumplible.
    const r = resolvePlazoLiquidacion({ amountBOB: 5000, payoutEtaBusinessDays: 3, desde: LUNES });
    expect(r.diasHabiles).toBe(3);
    expect(r.plazoLiquidacion).toBe('Hasta 3 días hábiles');
    expect(r.origen).toBe('proveedor');
    expect(r.excedeTramoEcp).toBe(true);
    expect(r.tramo).toBe('estandar');
  });

  test('proveedor MÁS RÁPIDO que el tramo: publica el del proveedor, no el tramo', () => {
    // Bs 100.000 = tramo Corporativo (2 días). Vita liquida en 1.
    // Publicar 2 días tambien es falso: le oculta al usuario que llega antes.
    const r = resolvePlazoLiquidacion({ amountBOB: 100000, payoutEtaBusinessDays: 1, desde: LUNES });
    expect(r.diasHabiles).toBe(1);
    expect(r.plazoLiquidacion).toBe('Hasta 1 día hábil');
    expect(r.origen).toBe('proveedor');
    expect(r.excedeTramoEcp).toBe(false);
  });

  test('proveedor que liquida el mismo día: se publica así aunque el tramo dé más', () => {
    const r = resolvePlazoLiquidacion({ amountBOB: 100000, payoutEtaBusinessDays: 0, desde: LUNES });
    expect(r.diasHabiles).toBe(0);
    expect(r.plazoLiquidacion).toBe('Mismo día hábil');
    expect(r.origen).toBe('proveedor');
  });

  test('el plazo publicado es EXACTAMENTE el del proveedor, en todo el rango', () => {
    // Barrido sobre los tres tramos y plazos de proveedor de 0 a 5 días.
    // Ni redondea hacia arriba por "prudencia" ni hacia abajo.
    for (const amount of [5000, 50000, 100000]) {
      for (const eta of [0, 1, 2, 3, 4, 5]) {
        const r = resolvePlazoLiquidacion({ amountBOB: amount, payoutEtaBusinessDays: eta, desde: LUNES });
        expect(r.diasHabiles).toBe(eta);
        expect(r.origen).toBe('proveedor');
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
