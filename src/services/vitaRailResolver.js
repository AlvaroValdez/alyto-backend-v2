/**
 * vitaRailResolver.js — ¿En qué moneda se debita el saldo de Vita?
 *
 * Vita publica sus precios anidados por moneda (`prices.clp`, `prices.usd`, …) y
 * las dos vías NO rinden igual. Medido contra producción el 2026-10-05, el riel
 * CLP entregaba más moneda destino en 13 de 14 destinos: +0,83% promedio y
 * +1,73% en EU. Los costos fijos también difieren (CO 3000 vía CLP contra 3495
 * vía USD), y por eso la comparación tiene que ser sobre el NETO del monto
 * concreto, no sobre la tasa: en CR el riel CLP tiene peor tasa pero 230 CRC
 * menos de fijo, así que gana por debajo de ~232 USD y pierde por encima.
 *
 * Este módulo es el ÚNICO lugar donde se elige el riel. La decisión que devuelve
 * alimenta la cotización Y se persiste en la transacción, para que el pay-out
 * debite la misma moneda que se cotizó. Si se recalculara al despachar, las
 * tasas se mueven cada ~2 min y el beneficiario podría recibir algo distinto de
 * lo prometido.
 *
 * Unidad de comparación: `rate` siempre es "moneda destino por 1 USD". El riel
 * CLP se normaliza con la propia tasa CLP→USD de Vita (`clp_sell.us`), así no
 * entra ningún supuesto de FX externo.
 */

import {
  VITA_SENT_ONLY_COUNTRIES,
  getVitaSentCountry,
  getVitaCountryKey,
} from './vitaWalletService.js';

const round2 = n => Math.round(n * 100) / 100;

/** Atributos de precios de una moneda, eligiendo withdrawal vs vita_sent. */
function sectionAttrs(prices, currency, destUpper) {
  const section = prices?.[currency];
  if (!section) return null;
  return VITA_SENT_ONLY_COUNTRIES.has(destUpper)
    ? (section?.vita_sent?.prices?.attributes ?? null)
    : (section?.withdrawal?.prices?.attributes ?? null);
}

/**
 * Clave de país dentro de los atributos de Vita.
 *
 * Los destinos vita_sent usan su clave propia. Para el resto, el riel USD se
 * indexa por la clave USD (CN → 'cnusd') igual que hacía extractPricingUSD, y el
 * riel CLP por la clave de la moneda de destino del corredor (CN → 'cn' si paga
 * CNY), que es lo que corresponde a la sección CLP.
 */
function destKey(currency, destinationCountry, destinationCurrency, destUpper) {
  if (VITA_SENT_ONLY_COUNTRIES.has(destUpper)) {
    return getVitaSentCountry(destUpper).toLowerCase();
  }
  return currency === 'usd'
    ? getVitaCountryKey(destinationCountry, 'USD')
    : getVitaCountryKey(destinationCountry, destinationCurrency);
}

/** Tasa CLP→USD de Vita. Vive siempre en la sección withdrawal de `clp`. */
function clpToUsdRate(prices) {
  const raw = prices?.clp?.withdrawal?.prices?.attributes?.clp_sell?.us;
  const rate = Number(raw);
  return isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Construye un candidato de riel, o null si Vita no publica ese precio.
 *
 * @returns {{ currency, rate, fixedCost, validUntil } | null}
 */
function buildRail({ currency, prices, destinationCountry, destinationCurrency, destUpper }) {
  const attrs = sectionAttrs(prices, currency, destUpper);
  if (!attrs) return null;

  const key = destKey(currency, destinationCountry, destinationCurrency, destUpper);
  if (!key) return null;

  let rate;
  if (currency === 'usd') {
    rate = Number(attrs?.usd_sell?.[key]);
  } else {
    const perClp = Number(attrs?.clp_sell?.[key]);
    const clpUsd = clpToUsdRate(prices);
    // destino por CLP ÷ USD por CLP = destino por USD
    rate = (isFinite(perClp) && clpUsd) ? perClp / clpUsd : NaN;
  }
  if (!isFinite(rate) || rate <= 0) return null;

  return {
    currency,
    rate,
    fixedCost: Number(attrs?.fixed_cost?.[key] ?? 0) || 0,
    validUntil: attrs?.valid_until ?? null,
  };
}

/** Monto a enviar expresado en la moneda del riel. */
function amountInRailCurrency(amountUSD, currency, prices) {
  if (currency === 'usd') return round2(amountUSD);
  const clpUsd = clpToUsdRate(prices);
  return clpUsd ? Math.round(amountUSD / clpUsd) : null; // CLP no usa decimales
}

/** ¿El saldo de Vita en esa moneda alcanza para enviar el monto? */
function isFunded(rail, amountInCurrency, balances) {
  if (!balances) return null;                 // no se evaluó
  const saldo = Number(balances?.[rail.currency]);
  if (!isFinite(saldo)) return false;
  return amountInCurrency != null && saldo >= amountInCurrency;
}

/**
 * Elige el riel de pago de Vita.
 *
 * @param {object}  p
 * @param {number}  p.amountUSD            Monto neto a dispersar, en USD
 * @param {string}  p.destinationCountry   ISO alpha-2
 * @param {string} [p.destinationCurrency] Moneda de destino del corredor (desambigua CN)
 * @param {'usd'|'clp'|'auto'} [p.mode]    TransactionConfig.vitaPayoutCurrency
 * @param {object}  p.prices               Respuesta de getPrices()
 * @param {object} [p.balances]            { clp, usd, … } de getWallets(); omitir = no evaluar saldo
 * @returns {{ currency, rate, fixedCost, amountInCurrency, netDestination,
 *             validUntil, funded, considered } | null}
 */
export function resolveVitaRail({
  amountUSD,
  destinationCountry,
  destinationCurrency = null,
  mode = 'usd',
  prices,
  balances = null,
}) {
  const destUpper = (destinationCountry ?? '').toUpperCase();
  if (!destUpper || !prices) return null;

  const base = { prices, destinationCountry, destinationCurrency, destUpper };
  const usdRail = buildRail({ currency: 'usd', ...base });
  const clpRail = buildRail({ currency: 'clp', ...base });

  const monto = Number(amountUSD);
  const montoValido = isFinite(monto) && monto > 0;

  // CLP por USD — se devuelve SIEMPRE para poder congelarla en la transacción:
  // el pay-out convierte con esta y no con una tasa viva, porque el cobro BOB es
  // manual y puede confirmarse horas después de cotizar.
  const clpUsd    = clpToUsdRate(prices);
  const clpPerUsd = clpUsd ? Math.round((1 / clpUsd) * 1e6) / 1e6 : null;

  const decorar = (rail) => {
    if (!rail) return null;
    const amountInCurrency = amountInRailCurrency(montoValido ? monto : 0, rail.currency, prices);
    return {
      ...rail,
      amountInCurrency,
      clpPerUsd,
      netDestination: round2((montoValido ? monto : 0) * rail.rate - rail.fixedCost),
      funded: isFunded(rail, amountInCurrency, balances),
    };
  };

  const usd = decorar(usdRail);
  const clp = decorar(clpRail);
  const considered = [usd, clp].filter(Boolean).map(r => ({
    currency: r.currency, rate: r.rate, fixedCost: r.fixedCost,
    netDestination: r.netDestination, funded: r.funded,
  }));

  const conTraza = rail => (rail ? { ...rail, considered } : null);

  // Modo fijo: si Vita no publica ese riel, caemos al otro para no romper el
  // corredor. Cotización y pay-out siguen coherentes porque ambos leen esto.
  if (mode === 'usd') return conTraza(usd ?? clp);
  if (mode === 'clp') return conTraza(clp ?? usd);

  // ── auto ──────────────────────────────────────────────────────────────────
  // Sin un monto positivo no hay neto que comparar: no adivinamos, usamos USD.
  if (!montoValido) return conTraza(usd ?? clp);

  const candidatos = [usd, clp].filter(Boolean);
  if (candidatos.length === 0) return null;

  // Preferimos entre los que tienen saldo; si ninguno lo tiene, devolvemos el
  // mejor igual con funded=false y que el pre-check del pay-out decida.
  const conSaldo = candidatos.filter(r => r.funded !== false);
  const elegibles = conSaldo.length > 0 ? conSaldo : candidatos;

  const ganador = elegibles.reduce((a, b) => (b.netDestination > a.netDestination ? b : a));
  return conTraza(ganador);
}

/**
 * Segunda pasada: re-cotiza con el riel elegido si difiere del que se usó.
 *
 * Existe porque el riel NO se puede resolver antes de cotizar: el modo 'auto'
 * compara el neto del monto, y el USDC neto lo produce calculateQuote.
 * Estimarlo ignorando los fees (~9%) elegiría mal cerca del cruce de Costa Rica
 * (~232 USD), así que primero se cotiza y después se resuelve con el monto exacto.
 *
 * Centralizado a propósito: lo consumen el WS y los dos sitios REST. Tres copias
 * de esta lógica repetirían el problema que ya arrastra la fórmula de fees.
 *
 * @param {object}   p
 * @param {object}   p.quote               Resultado de la primera pasada de calculateQuote
 * @param {object}   p.corridor            TransactionConfig del corredor
 * @param {string}   p.destinationCountry  ISO alpha-2
 * @param {object}   p.prices              Respuesta de getPrices()
 * @param {number}   p.rate                Tasa usada en la primera pasada
 * @param {number}   p.fixedCost           Fija usada en la primera pasada
 * @param {string?}  p.validUntil          validUntil de la primera pasada
 * @param {Function} p.rerun               (rate, fixedFee) => quote — re-ejecuta calculateQuote
 * @param {Function} [p.onLog]             (mensaje, extra) para trazar la decisión
 * @returns {{ quote, rate, fixedCost, validUntil, rail }} valores ya resueltos
 */
export function applyVitaRail({
  quote, corridor, destinationCountry, prices,
  rate, fixedCost, validUntil, rerun, onLog = null,
}) {
  const sinCambio = { quote, rate, fixedCost, validUntil, rail: null };

  // anchorBolivia comparte la rama de cotización pero no pasa por Vita.
  if (corridor?.payoutMethod !== 'vitaWallet') return sinCambio;
  if (!(quote?.digitalAssetAmount > 0)) return sinCambio;

  const rail = resolveVitaRail({
    amountUSD:           quote.digitalAssetAmount,
    destinationCountry,
    destinationCurrency: corridor.destinationCurrency,
    mode:                corridor.vitaPayoutCurrency ?? 'usd',
    prices,
  });

  if (!rail) return sinCambio;
  if (rail.rate === rate && rail.fixedCost === fixedCost) return { ...sinCambio, rail };

  try {
    const reQuote = rerun(rail.rate, rail.fixedCost);
    // Si el re-cálculo no deja monto entregable, nos quedamos con el anterior en
    // vez de devolver una cotización inválida.
    if (!(reQuote?.destinationAmount > 0)) return { ...sinCambio, rail };

    onLog?.(`riel Vita ${rail.currency} para ${destinationCountry}`, {
      rate: rail.rate, fixedCost: rail.fixedCost, dest: reQuote.destinationAmount,
    });

    return {
      quote:      reQuote,
      rate:       rail.rate,
      fixedCost:  rail.fixedCost,
      validUntil: rail.validUntil ?? validUntil,
      rail,
    };
  } catch (err) {
    onLog?.(`re-quote con riel ${rail.currency} rechazado, se mantiene el anterior`, { error: err.message });
    return { ...sinCambio, rail };
  }
}

export default { resolveVitaRail, applyVitaRail };
