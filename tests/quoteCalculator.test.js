/**
 * quoteCalculator.test.js — SEND_MONEY_FLOW v1.0 §8 fixture compliance
 *
 * Tests the canonical calculation formula from docs/SEND_MONEY_FLOW.md §3.2.
 * If any fixture fails, the implementation is out of spec.
 *
 * Note on Fixture 1: the spec's §3.3 example states destinationAmount=275,698.64
 * and effectiveRate=434.17. The arithmetic (65.62 × 4201.32) actually yields
 * 275,690.62 and effectiveRate 434.16. The formula in §3.2 is authoritative;
 * the small arithmetic slip in §3.3 has been filed for spec v1.1 correction.
 * Tests assert the formula, not the illustrative numbers.
 */

import { calculateQuote } from '../src/services/quoteCalculator.js';

describe('calculateQuote — SEND_MONEY_FLOW v1.0 compliance', () => {

  // ── Fixture 1: Simple BOB → COP ────────────────────────────────────────────
  it('Fixture 1: 635 BOB → COP (bo-co corridor)', () => {
    const result = calculateQuote({
      amount: 635,
      corridor: {
        alytoCSpread:           2,
        fixedFee:               5,
        payinFeePercent:        0,
        payoutFeeFixed:         0,
        profitRetentionPercent: 1,
      },
      bobPerUsdc: 9.31,
      vitaRate:   4201.32,
    });

    expect(result.totalDeducted).toBeCloseTo(17.70, 2);
    expect(result.totalDeductedReal).toBeCloseTo(24.05, 2);
    expect(result.digitalAssetAmount).toBeCloseTo(65.62, 2);
    expect(result.destinationAmount).toBeCloseTo(275690.62, 2);
    expect(result.effectiveRate).toBeCloseTo(434.16, 2);
    expect(result.fees.vitaRateMarkup).toBe(0);
  });

  // ── Fixture 2: Minimum amount (valid) ──────────────────────────────────────
  it('Fixture 2: 300 BOB (corridor minimum) → valid quote, no error', () => {
    const result = calculateQuote({
      amount: 300,
      corridor: {
        alytoCSpread:           2,
        fixedFee:               5,
        payinFeePercent:        0,
        payoutFeeFixed:         0,
        profitRetentionPercent: 1,
      },
      bobPerUsdc: 9.31,
      vitaRate:   4201.32,
    });

    expect(result.destinationAmount).toBeGreaterThan(0);
    expect(result.fees.vitaRateMarkup).toBe(0);
  });

  // ── Fixture 3: Below minimum (calculator-level — math still works) ─────────
  // Spec §8 Fixture 3 is a HANDLER-level check ("Error: Monto mínimo: 300 BOB").
  // calculateQuote does not enforce corridor minimums; that's the quote
  // endpoint's responsibility. We assert the math produces a sensible result.
  it('Fixture 3: 299 BOB (handler enforces min — calc still pure)', () => {
    const result = calculateQuote({
      amount: 299,
      corridor: {
        alytoCSpread:           2,
        fixedFee:               5,
        payinFeePercent:        0,
        payoutFeeFixed:         0,
        profitRetentionPercent: 1,
      },
      bobPerUsdc: 9.31,
      vitaRate:   4201.32,
    });

    expect(result.destinationAmount).toBeGreaterThan(0);
    expect(result.fees.vitaRateMarkup).toBe(0);
  });

  // ── Fixture 4: No markup in any calculation ────────────────────────────────
  it('Fixture 4: vitaRateMarkup is always 0 in the output', () => {
    const result = calculateQuote({
      amount: 1000,
      corridor: {
        alytoCSpread:           2,
        fixedFee:               5,
        profitRetentionPercent: 1,
      },
      bobPerUsdc: 9.31,
      vitaRate:   4200,
    });
    expect(result.fees.vitaRateMarkup).toBe(0);
  });

  // ── Extra: destinationAmount uses raw vitaRate (no shave) ──────────────────
  it('No rate-markup shave: destAmount must equal usdcTransit × vitaRate − payoutFeeInDest', () => {
    const amount     = 1000;
    const bobPerUsdc = 9.31;
    const vitaRate   = 4200;
    const corridor   = { alytoCSpread: 2, fixedFee: 5, profitRetentionPercent: 1, payoutFeeFixed: 0 };

    const result = calculateQuote({ amount, corridor, bobPerUsdc, vitaRate });

    const round2           = n => Math.round(n * 100) / 100;
    const expectedDestFromRaw = round2(result.digitalAssetAmount * vitaRate);
    expect(result.destinationAmount).toBeCloseTo(expectedDestFromRaw, 2);
  });

  // ── Extra: input validation ────────────────────────────────────────────────
  describe('input validation', () => {
    const corridor = { alytoCSpread: 2, fixedFee: 5, profitRetentionPercent: 1, payoutFeeFixed: 0 };

    it('rejects zero or negative amount', () => {
      expect(() => calculateQuote({ amount: 0,   corridor, bobPerUsdc: 9.31, vitaRate: 4200 })).toThrow();
      expect(() => calculateQuote({ amount: -10, corridor, bobPerUsdc: 9.31, vitaRate: 4200 })).toThrow();
    });

    it('rejects missing corridor', () => {
      expect(() => calculateQuote({ amount: 100, corridor: null, bobPerUsdc: 9.31, vitaRate: 4200 })).toThrow();
    });

    it('rejects missing or non-positive bobPerUsdc', () => {
      expect(() => calculateQuote({ amount: 100, corridor, bobPerUsdc: 0,    vitaRate: 4200 })).toThrow();
      expect(() => calculateQuote({ amount: 100, corridor, bobPerUsdc: null, vitaRate: 4200 })).toThrow();
    });

    it('rejects missing or non-positive vitaRate', () => {
      expect(() => calculateQuote({ amount: 100, corridor, bobPerUsdc: 9.31, vitaRate: 0    })).toThrow();
      expect(() => calculateQuote({ amount: 100, corridor, bobPerUsdc: 9.31, vitaRate: null })).toThrow();
    });
  });

  // ── Extra: conversionRate audit payload shape ──────────────────────────────
  it('returns audit conversionRate block (BOB→USDC)', () => {
    const result = calculateQuote({
      amount: 635,
      corridor: { alytoCSpread: 2, fixedFee: 5, profitRetentionPercent: 1 },
      bobPerUsdc: 9.31,
      vitaRate:   4201.32,
    });
    expect(result.conversionRate).toEqual({
      fromCurrency:    'BOB',
      toCurrency:      'USDC',
      rate:            9.31,
      convertedAmount: result.digitalAssetAmount,
    });
    expect(result.digitalAsset).toBe('USDC');
  });
});
