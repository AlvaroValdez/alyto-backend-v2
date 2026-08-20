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
// FX rates necesitan 6 decimales: rates < 1 (ej. BOB→USD ≈ 0.107) pierden ~95% de la
// info con round2. round2 sigue siendo correcto para amounts en moneda fiat.
export const round6 = n => Math.round(n * 1e6) / 1e6;

/**
 * Devuelve el spread efectivo (%) aplicable a una transacción según el tier
 * del usuario. Fuente única para todos los flujos de quote (HTTP + WS).
 *
 *   - Cuenta business + corredor con businessAlytoCSpread configurado
 *     → tarifa business (descuento).
 *   - Cualquier otro caso → tarifa retail (alytoCSpread) o 0 si no está
 *     configurado.
 *
 * @param {{ alytoCSpread?: number, businessAlytoCSpread?: number }} corridor
 * @param {{ accountType?: string }} [user]
 * @returns {number} Porcentaje de spread (0–100), ej. 0.5 = 0.5%.
 */
export function getEffectiveSpreadPct(corridor, user) {
  return (user?.accountType === 'business' && corridor?.businessAlytoCSpread != null)
    ? corridor.businessAlytoCSpread
    : (corridor?.alytoCSpread ?? 0);
}

/**
 * @param {object}  input
 * @param {number}  input.amount        Origin amount in BOB (user input)
 * @param {object}  input.corridor      TransactionConfig doc or plain config
 * @param {number}  input.bobPerUsdc    BOB → USDC rate (admin-configured or env fallback)
 * @param {number}  input.providerRate   USDC → destination currency rate (raw from provider, no markup)
 * @param {number}  [input.providerFixedFee] Comisión FIJA del proveedor en moneda DESTINO
 *                                      (ej. fixed_cost de Vita /prices). Si > 0, GANA sobre
 *                                      corridor.payoutFeeFixed — es lo que el proveedor
 *                                      descuenta de verdad al ejecutar; sin esto el quote
 *                                      promete más de lo que el beneficiario recibe.
 * @param {string}  [input.accountType] 'business' applies businessAlytoCSpread when set
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
export function calculateQuote({ amount, corridor, bobPerUsdc, providerRate, providerFixedFee = null, accountType = 'personal' }) {
  if (!amount || amount <= 0) {
    throw new Error('calculateQuote: amount must be positive');
  }
  if (!corridor) {
    throw new Error('calculateQuote: corridor config required');
  }
  if (!bobPerUsdc || bobPerUsdc <= 0) {
    throw new Error('calculateQuote: bobPerUsdc must be positive');
  }
  if (!providerRate || providerRate <= 0) {
    throw new Error('calculateQuote: providerRate must be positive');
  }

  // Step 1 — fees in origin currency (BOB)
  const payinFee         = amount * ((corridor.payinFeePercent         ?? 0) / 100);
  const isBusiness       = accountType === 'business';
  const effectiveSpreadPct = (isBusiness && corridor.businessAlytoCSpread != null)
    ? corridor.businessAlytoCSpread
    : (corridor.alytoCSpread ?? 0);
  const alytoCSpread     = amount * (effectiveSpreadPct / 100);
  const fixedFee         = (isBusiness && corridor.businessFixedFee != null)
    ? corridor.businessFixedFee
    : (corridor.fixedFee ?? 0);
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

  // Step 6 — destination amount using RAW provider rate (no markup — spec §1.2, §6.1)
  // Comisión fija en moneda DESTINO — do NOT multiply by providerRate.
  // Prioridad: la fija REAL del proveedor (fixed_cost live de Vita) sobre la
  // configurada en el corredor — mismo criterio que la rama CLP del WS y el
  // getQuote no-manual (`vitaFixedCost > 0 ? vitaFixedCost : payoutFeeFixed`).
  const payoutFeeInDest   = (providerFixedFee > 0) ? providerFixedFee : (corridor.payoutFeeFixed ?? 0);
  const destinationAmount = round2((usdcTransitAmount * providerRate) - payoutFeeInDest);

  // Step 7 — effective rate for display (6 decimales para preservar rates < 1)
  const effectiveRate     = round6(destinationAmount / amount);

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
      payoutFee:       payoutFeeInDest,  // en moneda destino, no en BOB
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

/**
 * Convierte los fees internos al shape PÚBLICO que consume el frontend.
 *
 * ⚠️ `payoutFee` sale en 0 A PROPÓSITO: está en moneda DESTINO y ya viene
 * descontado de `destinationAmount`. El frontend suma los fees para mostrar
 * "Costo del envío" en moneda ORIGEN (Step1Amount / Step4Confirm), así que
 * incluirlo mezclaría unidades y mostraría un total absurdo (ej. sumar 3495 COP
 * a Bs 21.34 → "Bs 3.516"). Es la misma convención que ya usaban las rutas CLP.
 *
 * La fija real del proveedor se expone aparte y ETIQUETADA con su moneda, para
 * que el frontend pueda mostrarla si algún día se quiere ser explícito.
 *
 * ⚠️ LISTA BLANCA, no `...fees`. Esta función se escribió spreando el objeto
 * interno y eso dejaba viajar al usuario `profitRetention`, `totalDeductedReal`,
 * `vitaRateMarkup` y `alytoProfitUSDC` — el margen de Alyto, que la regla 11 de
 * CLAUDE.md prohíbe mostrar. Al ser lista blanca, un campo interno nuevo en
 * calculateQuote NO se filtra solo: hay que agregarlo aquí a propósito.
 *
 * @param {object} fees                 quote.fees de calculateQuote
 * @param {string} originCurrency       moneda en la que están los fees sumables
 * @param {string} destinationCurrency  moneda de la fija del proveedor
 */
export function toPublicFees(fees, { originCurrency, destinationCurrency } = {}) {
  return {
    payinFee:      fees?.payinFee     ?? 0,
    alytoCSpread:  fees?.alytoCSpread ?? 0,
    fixedFee:      fees?.fixedFee     ?? 0,
    // Ya descontado de destinationAmount y en otra moneda → no sumable aquí.
    payoutFee:     0,
    totalDeducted: fees?.totalDeducted ?? 0,
    feeCurrency:   originCurrency ?? null,
    // Transparencia: la fija del proveedor, etiquetada con SU moneda.
    providerFixedFee:         fees?.payoutFee ?? 0,
    providerFixedFeeCurrency: destinationCurrency ?? null,
  };
}

export default { calculateQuote, toPublicFees };
