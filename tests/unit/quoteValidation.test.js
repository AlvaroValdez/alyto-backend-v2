/**
 * quoteValidation.test.js — Validación del destinationAmount declarado por el cliente
 *
 * Pura: sin BD ni HTTP.
 */

import '../setup.env.js';
import {
  validateQuotedDestinationAmount,
  quoteDriftTolerancePct,
} from '../../src/services/quoteValidation.js';

describe('quoteDriftTolerancePct', () => {
  const original = process.env.QUOTE_DEST_TOLERANCE_PCT;
  afterEach(() => {
    if (original === undefined) delete process.env.QUOTE_DEST_TOLERANCE_PCT;
    else process.env.QUOTE_DEST_TOLERANCE_PCT = original;
  });

  it('default 1% cuando la variable no está', () => {
    delete process.env.QUOTE_DEST_TOLERANCE_PCT;
    expect(quoteDriftTolerancePct()).toBe(1);
  });

  it('respeta la variable de entorno', () => {
    process.env.QUOTE_DEST_TOLERANCE_PCT = '2.5';
    expect(quoteDriftTolerancePct()).toBe(2.5);
  });

  it('un valor inválido o cero cae al default en vez de desactivar el control', () => {
    for (const v of ['0', '-3', 'abc', '']) {
      process.env.QUOTE_DEST_TOLERANCE_PCT = v;
      expect(quoteDriftTolerancePct()).toBe(1);
    }
  });
});

describe('validateQuotedDestinationAmount — acepta', () => {
  it('coincidencia exacta', () => {
    const r = validateQuotedDestinationAmount({ quoted: 1000, expected: 1000 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('within_tolerance');
    expect(r.driftPct).toBe(0);
  });

  it('deriva dentro de la tolerancia, en los dos sentidos', () => {
    expect(validateQuotedDestinationAmount({ quoted: 1005, expected: 1000 }).ok).toBe(true);
    expect(validateQuotedDestinationAmount({ quoted: 995,  expected: 1000 }).ok).toBe(true);
  });

  it('justo en el borde de la tolerancia se acepta', () => {
    const r = validateQuotedDestinationAmount({ quoted: 1010, expected: 1000, tolerancePct: 1 });
    expect(r.ok).toBe(true);
    expect(r.driftPct).toBe(1);
  });

  it('sin cotización del cliente no hay nada que validar', () => {
    const r = validateQuotedDestinationAmount({ quoted: null, expected: 1000 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no_quote');
  });

  it('sin referencia propia es fail-open deliberado', () => {
    for (const expected of [null, 0, undefined, NaN]) {
      const r = validateQuotedDestinationAmount({ quoted: 1000, expected });
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('no_reference');
    }
  });
});

describe('validateQuotedDestinationAmount — rechaza', () => {
  it('deriva por encima de la tolerancia', () => {
    const r = validateQuotedDestinationAmount({ quoted: 1200, expected: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('drift_exceeded');
    expect(r.driftPct).toBe(20);
  });

  it('deriva por debajo de la tolerancia', () => {
    const r = validateQuotedDestinationAmount({ quoted: 800, expected: 1000 });
    expect(r.ok).toBe(false);
    expect(r.driftPct).toBe(-20);
  });

  it('un monto declarado no positivo', () => {
    for (const quoted of [0, -50]) {
      const r = validateQuotedDestinationAmount({ quoted, expected: 1000 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('invalid_quote');
    }
  });

  it('un monto declarado no numérico', () => {
    const r = validateQuotedDestinationAmount({ quoted: 'mucho', expected: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_quote');
  });

  it('cierra el hueco de inflar el monto de destino', () => {
    // El caso que motiva el cerrojo: el cliente declara 10x lo cotizado y hoy
    // eso quedaba persistido y emitido en el Comprobante Oficial.
    const r = validateQuotedDestinationAmount({ quoted: 10000, expected: 1000 });
    expect(r.ok).toBe(false);
    expect(r.expected).toBe(1000);
  });
});

describe('validateQuotedDestinationAmount — la diferencia entre rieles se detecta', () => {
  // Medido el 2026-10-05: el riel CLP entrega +1,62% en CL y +1,73% en EU.
  // Con tolerancia 1% esa diferencia NO pasa desapercibida, que es justo lo que
  // hace seguro persistir el riel y despachar con él.
  it('un +1,62% por cotizar con otro riel se rechaza con tolerancia 1%', () => {
    const r = validateQuotedDestinationAmount({ quoted: 101.62, expected: 100 });
    expect(r.ok).toBe(false);
    expect(r.driftPct).toBe(1.62);
  });

  it('con tolerancia 2% esa misma diferencia pasaría — el valor importa', () => {
    const r = validateQuotedDestinationAmount({ quoted: 101.62, expected: 100, tolerancePct: 2 });
    expect(r.ok).toBe(true);
  });
});
