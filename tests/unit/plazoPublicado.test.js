/**
 * plazoPublicado.test.js — Plazo que se publica al consumidor.
 *
 * Acredita la regla acordada el 2026-10-10: manda el plazo REAL del proveedor, y se
 * expresa APROXIMADO, nunca como número cerrado. El tramo del Entorno Controlado de
 * Pruebas solo cubre el hueco cuando el corredor no tiene el dato.
 *
 * Dos cosas distintas que hay que blindar por separado:
 *   1. Que el plazo salga del proveedor y no del tramo, en las dos direcciones.
 *   2. Que el TEXTO nunca sea un número cerrado sin cualificador. Un plazo de
 *      liquidación no es determinista, y "1 día hábil" a secas es una promesa de
 *      precisión que nadie puede sostener.
 */

import { resolvePlazoLiquidacion, plazoTexto } from '../../src/utils/plazoPublicado.js';

// Lunes: evita que el corrimiento de fin de semana contamine las aserciones.
const LUNES = new Date('2026-10-12T10:00:00');

const resolver = (amountBOB, min, max, desde = LUNES) => resolvePlazoLiquidacion({
  amountBOB, payoutEtaMinBusinessDays: min, payoutEtaMaxBusinessDays: max, desde,
});

describe('plazoTexto — bandas de días hábiles, nunca un plazo acotado', () => {
  test('las cuatro formas publicables', () => {
    expect(plazoTexto(0, 0)).toBe('el mismo día hábil');
    expect(plazoTexto(1, 1)).toBe('aproximadamente 1 día hábil');
    expect(plazoTexto(3, 3)).toBe('aproximadamente 3 días hábiles');
    expect(plazoTexto(0, 3)).toBe('hasta 3 días hábiles');
    expect(plazoTexto(2, 5)).toBe('entre 2 y 5 días hábiles');
  });

  test('el piso de granularidad es el DÍA HÁBIL: nada de minutos ni horas', () => {
    // Harbor cotiza Singapur en 1–15 MINUTES y Nigeria en 1–5 MINUTES. Son datos
    // reales, pero publicarlos seria comprometer una precision que ningun eslabon
    // garantiza. Sub-diario dice "el mismo dia habil" y punto.
    for (let min = 0; min <= 5; min++) {
      for (let max = min; max <= 5; max++) {
        const t = plazoTexto(min, max);
        expect(t).not.toMatch(/minuto|hora|segundo/i);
      }
    }
  });

  test('ningún texto es un número desnudo', () => {
    for (let min = 0; min <= 5; min++) {
      for (let max = min; max <= 5; max++) {
        const t = plazoTexto(min, max);
        expect(t).toMatch(/el mismo día hábil|aproximadamente|^hasta |^entre /);
      }
    }
  });
});

describe('resolvePlazoLiquidacion — manda el plazo del proveedor', () => {
  test('proveedor MÁS LENTO que el tramo: publica el del proveedor y marca el exceso', () => {
    // Bs 5.000 = tramo Estándar (mismo día). Harbor tarda 1 a 3 días hábiles.
    const r = resolver(5000, 1, 3);
    expect(r.plazoLiquidacion).toBe('entre 1 y 3 días hábiles');
    expect(r.plazoMaxDiasHabiles).toBe(3);
    expect(r.origen).toBe('proveedor');
    expect(r.excedeTramoEcp).toBe(true);
    expect(r.tramo).toBe('estandar');
  });

  test('proveedor MÁS RÁPIDO que el tramo: publica el del proveedor, no el tramo', () => {
    // Bs 100.000 = tramo Corporativo (2 días). Vita liquida en horas a 1 día.
    const r = resolver(100000, 0, 1);
    expect(r.plazoLiquidacion).toBe('hasta 1 día hábil');
    expect(r.plazoMaxDiasHabiles).toBe(1);
    expect(r.origen).toBe('proveedor');
    expect(r.excedeTramoEcp).toBe(false);
  });

  test('proveedor sub-diario: "el mismo día hábil", aunque el tramo dé dos días', () => {
    const r = resolver(100000, 0, 0);
    expect(r.plazoLiquidacion).toBe('el mismo día hábil');
    expect(r.plazoMaxDiasHabiles).toBe(0);
    expect(r.origen).toBe('proveedor');
  });

  test('el máximo publicado es EXACTAMENTE el del proveedor, en todo el rango', () => {
    for (const amount of [5000, 50000, 100000]) {
      for (const max of [0, 1, 2, 3, 4, 5]) {
        const r = resolver(amount, 0, max);
        expect(r.plazoMaxDiasHabiles).toBe(max);
        expect(r.origen).toBe('proveedor');
      }
    }
  });
});

describe('resolvePlazoLiquidacion — la fecha límite sale del MÁXIMO', () => {
  test('el vencimiento se calcula con el máximo, no con el mínimo', () => {
    const r = resolver(5000, 1, 3);
    // Lunes 12/10 + 3 días hábiles = jueves 15/10/2026.
    const v = new Date(r.plazoLiquidacionHasta);
    expect(v.getDay()).toBe(4);        // jueves
    expect(v.getDate()).toBe(15);
  });

  test('⚠️ el prefijo del ISO NO es la fecha local del vencimiento', () => {
    // Trampa para quien consuma este campo: el plazo vence a las 23:59:59 LOCALES,
    // así que en cualquier zona al oeste de UTC el toISOString() corre al día
    // siguiente. Hacer plazoLiquidacionHasta.slice(0,10) para mostrar la fecha
    // muestra un día de más. Hay que parsear a Date y formatear en local.
    const r = resolver(5000, 1, 3);
    const v = new Date(r.plazoLiquidacionHasta);
    if (v.getTimezoneOffset() > 0) {   // al oeste de UTC
      expect(r.plazoLiquidacionHasta.slice(0, 10)).not.toBe('2026-10-15');
    }
    expect(v.getDate()).toBe(15);      // en local siempre es el 15
  });

  test('mostrar aproximado no impide comprometerse: siempre hay fecha límite', () => {
    for (const [min, max] of [[0, 0], [0, 1], [1, 3], [2, 2]]) {
      const r = resolver(50000, min, max);
      expect(r.plazoLiquidacionHasta).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test('el vencimiento no cae nunca en sábado ni domingo', () => {
    for (const dia of ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']) {
      const r = resolver(5000, 0, 1, new Date(`${dia}T15:00:00`));
      expect([0, 6]).not.toContain(new Date(r.plazoLiquidacionHasta).getDay());
    }
  });
});

describe('resolvePlazoLiquidacion — bordes y datos faltantes', () => {
  test('sin rango configurado cae al tramo y lo marca como no verificado', () => {
    const r = resolver(10000, null, null);
    expect(r.etaProveedorVerificada).toBe(false);
    expect(r.origen).toBe('ecp');
    expect(r.plazoLiquidacion).toBe('el mismo día hábil');   // tramo Estándar = 0 días
  });

  test('basta el máximo para considerarlo configurado; sin mínimo se asume 0', () => {
    const r = resolver(10000, null, 2);
    expect(r.etaProveedorVerificada).toBe(true);
    expect(r.plazoLiquidacion).toBe('hasta 2 días hábiles');
  });

  test('un mínimo mayor que el máximo se recorta, no produce un rango invertido', () => {
    const r = resolver(10000, 5, 2);
    expect(r.plazoMinDiasHabiles).toBe(2);
    expect(r.plazoLiquidacion).toBe('aproximadamente 2 días hábiles');
  });

  test('un máximo inválido se trata como ausente, no como cero', () => {
    for (const malo of [NaN, -1, undefined, 'dos']) {
      const r = resolver(100000, 0, malo);
      expect(r.etaProveedorVerificada).toBe(false);
      expect(r.plazoMaxDiasHabiles).toBe(2);   // el tramo Corporativo, no 0
    }
  });

  test('importe fuera de los tramos devuelve null: lo rechaza el control de límites', () => {
    expect(resolver(200000, 0, 1)).toBeNull();
    expect(resolver(100,    0, 1)).toBeNull();
  });
});
