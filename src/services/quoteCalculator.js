/**
 * quoteCalculator.js — Canonical quote formula for SRL (BOB → LatAm).
 *
 * SEND MONEY FLOW v1.0 — see docs/SEND_MONEY_FLOW.md §3 for the spec.
 *
 * This is the ONLY implementation of the BOB quote formula. All quote
 * sites (HTTP calculateBOBQuote, HTTP getQuote manual branch, WebSocket
 * quoteSocket BRANCH 2) MUST call calculateQuote — no duplicated math.
 *
 * Anti-patterns forbidden by spec §6:
 *   1. Applying vitaRateMarkup > 0 in the calculation chain
 *   2. Showing a rate different from destinationAmount / originAmount
 *   9. Referencing vitaRateMarkup in calculation (schema field exists
 *      but is always 0 for new transactions)
 *
 * Do not modify this formula without updating docs/SEND_MONEY_FLOW.md
 * and docs/CHANGELOG_FLOWS.md first.
 */

const round2 = n => Math.round(n * 100) / 100;

/**
 * @param {object}  input
 * @param {number}  input.amount        Origin amount in BOB (user input)
 * @param {object}  input.corridor      TransactionConfig doc or plain config
 * @param {number}  input.bobPerUsdc    BOB → USDC rate (admin-configured or env fallback)
 * @param {number}  input.vitaRate      USDC → destination currency rate (raw from Vita, no markup)
 * @returns {{
 *   originAmount:       number,
 *   totalDeducted:      number,
 *   destinationAmount:  number,
 *   effectiveRate:      number,
 *   totalDeductedReal:  number,
 *   fees:               object,
 *   conversionRate:     object,
 *   digitalAssetAmount: number,
 *   digitalAsset:       string
 * }}
 */
export function calculateQuote({ amount, corridor, bobPerUsdc, vitaRate }) {
  if (!amount || amount <= 0) {
    throw new Error('calculateQuote: amount must be positive');
  }
  if (!corridor) {
    throw new Error('calculateQuote: corridor config required');
  }
  if (!bobPerUsdc || bobPerUsdc <= 0) {
    throw new Error('calculateQuote: bobPerUsdc must be positive');
  }
  if (!vitaRate || vitaRate <= 0) {
    throw new Error('calculateQuote: vitaRate must be positive');
  }

  // Step 1 — fees in origin currency (BOB)
  const payinFee         = amount * ((corridor.payinFeePercent         ?? 0) / 100);
  const alytoCSpread     = amount * ((corridor.alytoCSpread            ?? 0) / 100);
  const fixedFee         = corridor.fixedFee                            ?? 0;
  const profitRetention  = amount * ((corridor.profitRetentionPercent  ?? 0) / 100);

  // Step 2 — user-facing total (no hidden retention)
  const visibleFees      = payinFee + alytoCSpread + fixedFee;
  const totalDeducted    = round2(visibleFees);

  // Step 3 — internal total (adds hidden retention)
  const totalDeductedReal = round2(visibleFees + profitRetention);

  // Step 4 — net BOB for conversion
  const netBOB            = amount - totalDeductedReal;

  // Step 5 — USDC transit (audit trail; never shown to user)
  const usdcTransitAmount = round2(netBOB / bobPerUsdc);

  // Step 6 — destination amount using RAW Vita rate (no markup — spec §1.2, §6.1)
  const payoutFeeUSD      = corridor.payoutFeeFixed ?? 0;
  const payoutFeeInDest   = payoutFeeUSD * vitaRate;
  const destinationAmount = round2((usdcTransitAmount * vitaRate) - payoutFeeInDest);

  // Step 7 — effective rate for display
  const effectiveRate     = round2(destinationAmount / amount);

  return {
    originAmount:      amount,
    totalDeducted,
    destinationAmount,
    effectiveRate,

    totalDeductedReal,
    fees: {
      payinFee:        round2(payinFee),
      alytoCSpread:    round2(alytoCSpread),
      fixedFee,
      payoutFee:       payoutFeeUSD,
      profitRetention: round2(profitRetention),
      totalDeducted,
      totalDeductedReal,
      vitaRateMarkup:  0,   // spec §3.5, §6.9 — always zero
    },

    conversionRate: {
      fromCurrency:    'BOB',
      toCurrency:      'USDC',
      rate:            bobPerUsdc,
      convertedAmount: usdcTransitAmount,
    },
    digitalAssetAmount: usdcTransitAmount,
    digitalAsset:       'USDC',
  };
}

export default { calculateQuote };
