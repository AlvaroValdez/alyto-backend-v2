/**
 * quoteCalculation.test.js — Tests unitarios del cálculo de fees y cotización
 *
 * Testea la lógica matemática de la cotización sin BD ni HTTP.
 * Todos los tests son pure functions — sin side effects.
 */

import '../setup.env.js';

// ─── Función pura extraída de paymentController.js ───────────────────────────
// Replicamos aquí la lógica para poder testearla de forma aislada.

const round2 = n => Math.round(n * 100) / 100;

function calculateQuote({ amount, corridor, exchangeRate, vitaFixedCost = 0 }) {
  const payinFee        = amount * (corridor.payinFeePercent / 100);
  const alytoCSpread    = amount * (corridor.alytoCSpread / 100);
  const fixedFee        = corridor.fixedFee;
  const profitRetention = amount * (corridor.profitRetentionPercent / 100);
  const totalFees       = payinFee + alytoCSpread + fixedFee;
  const amountAfterFees = amount - totalFees - profitRetention;

  const payoutFee = vitaFixedCost > 0 ? vitaFixedCost : corridor.payoutFeeFixed;

  const destinationAmount = round2((amountAfterFees * exchangeRate) - payoutFee);

  return {
    payinFee:        round2(payinFee),
    alytoCSpread:    round2(alytoCSpread),
    fixedFee:        round2(fixedFee),
    payoutFee:       round2(payoutFee),
    profitRetention: round2(profitRetention),
    totalDeducted:   round2(payinFee + alytoCSpread + fixedFee + payoutFee),
    destinationAmount,
    amountAfterFees: round2(amountAfterFees),
  };
}

// ─── Corredor base para los tests ─────────────────────────────────────────────

const baseCorridor = {
  alytoCSpread:           1.5,
  fixedFee:               0,
  payinFeePercent:        0,
  payoutFeeFixed:         0,
  profitRetentionPercent: 0,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('calculateQuote — fee math', () => {

  test('sin fees — destinationAmount = amount × exchangeRate', () => {
    const result = calculateQuote({
      amount:       100000,
      corridor:     { ...baseCorridor, alytoCSpread: 0, fixedFee: 0, payinFeePercent: 0, profitRetentionPercent: 0 },
      exchangeRate: 0.0045,
    });

    expect(result.destinationAmount).toBe(450);
    expect(result.alytyCSpread).toBeUndefined();  // el campo se llama alytoCSpread en el response
    expect(result.payinFee).toBe(0);
    expect(result.totalDeducted).toBe(0);
  });

  test('spread del 1.5% sobre 100000 CLP', () => {
    const result = calculateQuote({
      amount:       100000,
      corridor:     baseCorridor,
      exchangeRate: 0.0045,
    });

    expect(result.alytoCSpread).toBe(1500);       // 1.5% de 100000
    expect(result.amountAfterFees).toBe(98500);   // 100000 - 1500
    expect(result.destinationAmount).toBe(round2(98500 * 0.0045));  // 443.25
  });

  test('fee fija de 500 CLP se aplica antes del tipo de cambio', () => {
    const result = calculateQuote({
      amount:       100000,
      corridor:     { ...baseCorridor, alytoCSpread: 0, fixedFee: 500, profitRetentionPercent: 0 },
      exchangeRate: 0.0045,
    });

    expect(result.fixedFee).toBe(500);
    expect(result.amountAfterFees).toBe(99500);
    expect(result.destinationAmount).toBe(round2(99500 * 0.0045));  // 447.75
  });

  test('payoutFee (Vita fixed_cost) se resta del monto convertido', () => {
    const result = calculateQuote({
      amount:         100000,
      corridor:       { ...baseCorridor, alytoCSpread: 0 },
      exchangeRate:   0.0045,
      vitaFixedCost:  1,                // 1 BOB de fee de Vita
    });

    // destinationAmount = (100000 × 0.0045) - 1 = 450 - 1 = 449
    expect(result.payoutFee).toBe(1);
    expect(result.destinationAmount).toBe(449);
  });

  test('payoutFeeFixed del corredor se usa como fallback si vitaFixedCost es 0', () => {
    const result = calculateQuote({
      amount:         100000,
      corridor:       { ...baseCorridor, alytoCSpread: 0, payoutFeeFixed: 5 },
      exchangeRate:   0.0045,
      vitaFixedCost:  0,               // Vita no retornó fixed_cost
    });

    expect(result.payoutFee).toBe(5);
    expect(result.destinationAmount).toBe(round2(100000 * 0.0045 - 5));  // 445
  });

  test('profitRetention reduce amountAfterFees antes del cálculo de destino', () => {
    const result = calculateQuote({
      amount:       100000,
      corridor:     { ...baseCorridor, alytoCSpread: 0, profitRetentionPercent: 10 },
      exchangeRate: 0.0045,
    });

    // profitRetention = 10% de 100000 = 10000
    // amountAfterFees = 100000 - 10000 = 90000
    // destinationAmount = 90000 × 0.0045 = 405
    expect(result.profitRetention).toBe(10000);
    expect(result.amountAfterFees).toBe(90000);
    expect(result.destinationAmount).toBe(405);
  });

  test('todos los fees juntos — caso realista CL→BO', () => {
    const result = calculateQuote({
      amount:       150000,              // 150,000 CLP
      corridor: {
        alytoCSpread:           1.5,    // 1.5%
        fixedFee:               500,    // 500 CLP fija
        payinFeePercent:        0,
        payoutFeeFixed:         0,
        profitRetentionPercent: 0,
      },
      exchangeRate:   0.0045,
      vitaFixedCost:  0,
    });

    // alytoCSpread = 1.5% × 150000 = 2250
    // totalFees = 2250 + 500 = 2750
    // amountAfterFees = 150000 - 2750 = 147250
    // destinationAmount = 147250 × 0.0045 = 662.625 → 662.63
    expect(result.alytoCSpread).toBe(2250);
    expect(result.fixedFee).toBe(500);
    expect(result.amountAfterFees).toBe(147250);
    expect(result.destinationAmount).toBe(662.63);
  });

  test('monto muy pequeño — destinationAmount puede ser negativo (detectar)', () => {
    const result = calculateQuote({
      amount:       100,                // 100 CLP — muy pequeño
      corridor:     { ...baseCorridor, alytoCSpread: 1.5, fixedFee: 500 },
      exchangeRate: 0.0045,
      vitaFixedCost: 1,
    });

    // amountAfterFees = 100 - 1.5 - 500 = negativo
    // El controller rechaza si destinationAmount <= 0
    expect(result.destinationAmount).toBeLessThanOrEqual(0);
  });

  test('round2 — redondea correctamente a 2 decimales', () => {
    expect(round2(662.625)).toBe(662.63);
    expect(round2(662.624)).toBe(662.62);
    expect(round2(450)).toBe(450);
    expect(round2(0.0045 * 100000)).toBe(450);
  });

});

// ─── Tests de extractVitaPricing (lógica de lookup en respuesta Vita) ─────────

describe('extractVitaPricing — lookup de tasas en respuesta Vita', () => {

  // Reimplementamos la función para testearla independientemente
  function extractVitaPricing(vitaPricesResponse, originCurrency, destinationCountry) {
    const withdrawal = vitaPricesResponse?.withdrawal;
    if (!withdrawal) return null;

    const priceKey   = `${originCurrency.toLowerCase()}_sell`;
    const countryKey = destinationCountry.toLowerCase();

    const rateRaw = withdrawal?.prices?.attributes?.[priceKey]?.[countryKey];
    if (rateRaw == null) return null;

    const rate = Number(rateRaw);
    if (!isFinite(rate) || rate <= 0) return null;

    const fixedCost  = Number(withdrawal?.[countryKey]?.fixed_cost ?? 0);
    const validUntil = vitaPricesResponse?.valid_until ?? null;

    return { rate, fixedCost, validUntil };
  }

  const vitaResponse = {
    withdrawal: {
      prices: {
        attributes: {
          clp_sell: { bo: 0.0045, co: 4.5 },
          usd_sell: { bo: 6.96 },
        },
      },
      bo: { fixed_cost: 0.5 },
      co: { fixed_cost: 200 },
    },
    valid_until: '2026-03-20T18:00:00Z',
  };

  test('extrae tasa CLP→BO correctamente', () => {
    const result = extractVitaPricing(vitaResponse, 'CLP', 'BO');
    expect(result).not.toBeNull();
    expect(result.rate).toBe(0.0045);
    expect(result.fixedCost).toBe(0.5);
    expect(result.validUntil).toBe('2026-03-20T18:00:00Z');
  });

  test('extrae tasa CLP→CO correctamente', () => {
    const result = extractVitaPricing(vitaResponse, 'CLP', 'CO');
    expect(result).not.toBeNull();
    expect(result.rate).toBe(4.5);
    expect(result.fixedCost).toBe(200);
  });

  test('retorna null si el par de monedas no existe', () => {
    const result = extractVitaPricing(vitaResponse, 'USD', 'CO');
    expect(result).toBeNull();
  });

  test('retorna null si la respuesta de Vita está vacía', () => {
    expect(extractVitaPricing({}, 'CLP', 'BO')).toBeNull();
    expect(extractVitaPricing(null, 'CLP', 'BO')).toBeNull();
  });

  test('fixedCost fallback a 0 si el país no tiene fixed_cost', () => {
    const responseWithoutFixedCost = {
      ...vitaResponse,
      withdrawal: {
        ...vitaResponse.withdrawal,
        pe: {},   // Perú sin fixed_cost
        prices: {
          attributes: {
            clp_sell: { ...vitaResponse.withdrawal.prices.attributes.clp_sell, pe: 0.0042 },
          },
        },
      },
    };
    const result = extractVitaPricing(responseWithoutFixedCost, 'CLP', 'PE');
    expect(result).not.toBeNull();
    expect(result.fixedCost).toBe(0);
  });

});
