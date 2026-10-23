/**
 * vitaBusinessDays.test.js — Lectura del plazo REAL que declara Vita.
 *
 * `business_days_of_payment` viene en la respuesta de precios de Vita, en la misma
 * sección que `valid_until` y `fixed_cost`: "Number of business days Vita Wallet
 * Business needs to complete payment on destination bank account" (BusinessAPI.txt).
 * Se recibía en cada cotización y se descartaba.
 *
 * No hay una respuesta real de referencia que fije la forma del campo, así que el
 * extractor acepta las dos posibles —por país (como `fixed_cost`) o escalar de la
 * sección (como `valid_until`)— y ante la ausencia devuelve null.
 *
 * Lo que estos tests blindan es que un dato ausente o roto NO se convierta en 0:
 * un 0 significaria "pocas horas" y seria la promesa falsa que queremos evitar.
 */

import { extractVitaBusinessDays } from '../../src/utils/vitaBusinessDays.js';

describe('extractVitaBusinessDays — las dos formas posibles', () => {
  test('por país, como fixed_cost', () => {
    const attrs = { business_days_of_payment: { co: 1, pe: 2, ar: 3 } };
    expect(extractVitaBusinessDays(attrs, 'co')).toBe(1);
    expect(extractVitaBusinessDays(attrs, 'pe')).toBe(2);
    expect(extractVitaBusinessDays(attrs, 'ar')).toBe(3);
  });

  test('escalar de la sección, como valid_until', () => {
    expect(extractVitaBusinessDays({ business_days_of_payment: 2 }, 'co')).toBe(2);
  });

  test('cero es un valor válido: liquidación sub-diaria', () => {
    expect(extractVitaBusinessDays({ business_days_of_payment: 0 }, 'co')).toBe(0);
    expect(extractVitaBusinessDays({ business_days_of_payment: { co: 0 } }, 'co')).toBe(0);
  });

  test('numérico en string se acepta (las APIs los mandan así a menudo)', () => {
    expect(extractVitaBusinessDays({ business_days_of_payment: '2' }, 'co')).toBe(2);
  });
});

describe('extractVitaBusinessDays — ausencia y datos roto NO valen cero', () => {
  test('campo ausente devuelve null, no 0', () => {
    expect(extractVitaBusinessDays({ valid_until: 'x', fixed_cost: { co: 200 } }, 'co')).toBeNull();
  });

  test('país no presente en el mapa devuelve null', () => {
    expect(extractVitaBusinessDays({ business_days_of_payment: { co: 1 } }, 'pe')).toBeNull();
  });

  test('attrs nulo o indefinido devuelve null', () => {
    expect(extractVitaBusinessDays(null, 'co')).toBeNull();
    expect(extractVitaBusinessDays(undefined, 'co')).toBeNull();
  });

  test('valores inválidos devuelven null', () => {
    for (const malo of [NaN, -1, 'dos', '', null, {}, []]) {
      expect(extractVitaBusinessDays({ business_days_of_payment: malo }, 'co')).toBeNull();
    }
  });

  test('decimal se trunca, no se redondea hacia arriba', () => {
    // 1.8 días hábiles no existe; truncar deja el dato en el valor declarado entero.
    expect(extractVitaBusinessDays({ business_days_of_payment: 1.8 }, 'co')).toBe(1);
  });
});
