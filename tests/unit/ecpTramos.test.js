/**
 * ecpTramos.test.js — Tramos del Protocolo y plazo de liquidación comprometido.
 *
 * Acredita el apartado 5.7 del Informe Técnico y el Art. 9°, Sec. 5: el plazo se
 * determina por el importe y se informa antes de que el consumidor confirme.
 *
 * Las pruebas de frontera son las que importan: un error de un boliviano en el borde
 * de un tramo cambia el plazo comprometido al consumidor.
 */

import {
  ECP_TRAMOS, resolveTramo, addBusinessDays, plazoLiquidacion, tramoPublico,
} from '../../src/utils/ecpTramos.js';

describe('resolveTramo — fronteras exactas de los tres tramos', () => {

  it.each([
    [400,     'estandar'],     // mínimo absoluto
    [10_000,  'estandar'],
    [20_000,  'estandar'],     // borde superior estándar
    [20_001,  'ampliado'],     // primer boliviano de ampliado
    [45_000,  'ampliado'],
    [70_000,  'ampliado'],     // borde superior ampliado
    [70_001,  'corporativo'],  // primer boliviano de corporativo
    [120_000, 'corporativo'],  // máximo absoluto
  ])('Bs %i → tramo %s', (monto, esperado) => {
    expect(resolveTramo(monto).id).toBe(esperado);
  });

  it.each([399, 120_001, 0, -100])('Bs %i queda fuera de rango', (monto) => {
    // Fuera de rango devuelve null, no el tramo más cercano: lo rechaza el control
    // de límites, no lo absorbe el cálculo.
    expect(resolveTramo(monto)).toBeNull();
  });

  it('rechaza un importe no numérico', () => {
    expect(resolveTramo(undefined)).toBeNull();
    expect(resolveTramo(NaN)).toBeNull();
    expect(resolveTramo('mil')).toBeNull();
  });

  it('los tres tramos son contiguos y no se solapan', () => {
    for (let i = 1; i < ECP_TRAMOS.length; i++) {
      expect(ECP_TRAMOS[i].minBOB).toBe(ECP_TRAMOS[i - 1].maxBOB + 1);
    }
  });

  it('el plazo crece con el tramo', () => {
    const dias = ECP_TRAMOS.map(t => t.diasHabiles);
    expect(dias).toEqual([...dias].sort((a, b) => a - b));
    expect(new Set(dias).size).toBe(dias.length);
  });
});

describe('addBusinessDays', () => {

  it('salta el fin de semana', () => {
    // viernes 21/08/2026 + 1 hábil = lunes 24
    const r = addBusinessDays(new Date('2026-08-21T12:00:00'), 1);
    expect(r.getDay()).toBe(1);
    expect(r.getDate()).toBe(24);
  });

  it('con cero devuelve la misma fecha', () => {
    const d = new Date('2026-08-21T12:00:00');
    expect(addBusinessDays(d, 0).getTime()).toBe(d.getTime());
  });

  it('no muta la fecha recibida', () => {
    const d = new Date('2026-08-21T12:00:00');
    const antes = d.getTime();
    addBusinessDays(d, 3);
    expect(d.getTime()).toBe(antes);
  });
});

describe('plazoLiquidacion — la fecha que se compromete', () => {

  it('el tramo estándar vence el mismo día hábil', () => {
    const jueves = new Date('2026-08-20T10:00:00');
    const { tramo, venceAt } = plazoLiquidacion({ amountBOB: 5_000, desde: jueves });
    expect(tramo.id).toBe('estandar');
    expect(venceAt.getDate()).toBe(20);
    expect(venceAt.getHours()).toBe(23);
  });

  it('el tramo corporativo vence dos días hábiles después', () => {
    // jueves 20/08 + 2 hábiles = lunes 24 (vi 21, lu 24)
    const { venceAt } = plazoLiquidacion({ amountBOB: 100_000, desde: new Date('2026-08-20T10:00:00') });
    expect(venceAt.getDate()).toBe(24);
  });

  it('una operación de sábado no compromete un plazo en día no hábil', () => {
    // sábado 22/08 → el "mismo día hábil" del tramo estándar es el lunes 24
    const sabado = new Date('2026-08-22T10:00:00');
    expect(sabado.getDay()).toBe(6);
    const { venceAt } = plazoLiquidacion({ amountBOB: 5_000, desde: sabado });
    expect(venceAt.getDay()).toBe(1);
    expect(venceAt.getDate()).toBe(24);
  });

  it('devuelve null fuera de rango', () => {
    expect(plazoLiquidacion({ amountBOB: 200_000 })).toBeNull();
  });
});

describe('tramoPublico — lo que ve el consumidor antes de confirmar', () => {

  it('entrega el plazo en texto y su fecha límite', () => {
    const p = tramoPublico(50_000, new Date('2026-08-20T10:00:00'));
    expect(p.tramo).toBe('ampliado');
    expect(p.plazoLiquidacion).toBe('Hasta 1 día hábil');
    expect(p.plazoDiasHabiles).toBe(1);
    expect(typeof p.plazoLiquidacionHasta).toBe('string');
  });

  it('no publica los bordes del tramo', () => {
    // Publicarlos invitaría a fraccionar para bajar de tramo, que es justo lo que
    // los límites agregados existen para impedir.
    const p = tramoPublico(50_000);
    expect(p).not.toHaveProperty('minBOB');
    expect(p).not.toHaveProperty('maxBOB');
  });

  it('devuelve null fuera de rango, para que el quote no invente un plazo', () => {
    expect(tramoPublico(300)).toBeNull();
    expect(tramoPublico(150_000)).toBeNull();
  });
});

describe('integración con la cotización canónica', () => {

  it('calculateQuote incorpora el tramo y el plazo', async () => {
    const { calculateQuote } = await import('../../src/services/quoteCalculator.js');
    const q = calculateQuote({
      amount: 90_000,
      corridor: { alytoCSpread: 6.5, fixedFee: 6 },
      bobPerUsdc: 11.8626,
      providerRate: 1,
    });
    expect(q.tramo).toBe('corporativo');
    expect(q.plazoLiquidacion).toBe('Hasta 2 días hábiles');
  });

  it('un importe fuera de tramo no agrega plazo al quote', async () => {
    // La cotización no inventa un plazo para un importe que el control de límites
    // va a rechazar por exceder el máximo por operación.
    const { calculateQuote } = await import('../../src/services/quoteCalculator.js');
    const q = calculateQuote({
      amount: 150_000,
      corridor: { alytoCSpread: 6.5, fixedFee: 6 },
      bobPerUsdc: 11.8626,
      providerRate: 1,
    });
    expect(q.tramo).toBeUndefined();
    expect(q.plazoLiquidacion).toBeUndefined();
  });
});
