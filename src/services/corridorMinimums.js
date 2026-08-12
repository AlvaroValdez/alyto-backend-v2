/**
 * corridorMinimums.js — Mínimo EFECTIVO por corredor (guard de piso del proveedor)
 *
 * PROBLEMA QUE RESUELVE (auditoría 2026-08-12): el mínimo se validaba sobre el monto
 * BRUTO que escribe el usuario, pero el proveedor recibe el NETO (después de spread,
 * fee fija y retención). En 16 corredores el mínimo configurado dejaba un neto por
 * DEBAJO del piso del proveedor → el usuario cotizaba, pagaba su payin en BOB y el
 * payout fallaba después (dinero en limbo, no un simple error de formulario).
 *   Ejemplos reales: bo-au mín. 347 BOB → neto $28.94 < min Vita $50
 *                    bo-mx mín. 347 BOB → neto $27.59 < min Harbor $31
 *
 * SOLUCIÓN: el mínimo efectivo es el MAYOR entre el configurado y el que hace que
 * el neto alcance el piso del proveedor. Se despeja de la fórmula del quote:
 *
 *   neto_USD = (bruto_origen × (1 − fee%) − fijaOrigen) / origenPorUSD ≥ pisoUSD
 *   ⇒ bruto_origen ≥ (pisoUSD × origenPorUSD + fijaOrigen) / (1 − fee%)
 *
 * Así el piso queda derivado de la config real (fees del corredor) y del piso vivo
 * del proveedor — no hay valores mágicos que se desincronicen.
 */

import { getVitaCountryKey, getVitaSentCountry, VITA_SENT_ONLY_COUNTRIES, getPrices } from './vitaWalletService.js';
import { HARBOR_MIN_USD } from '../routing/euAmountRouter.js';
import { getBOBRate, getCLPRate, resolveMinAmountOrigin } from './exchangeRateService.js';

/** Suma de fees porcentuales que se descuentan del bruto (spread + payin + retención). */
export function totalFeePct(corridor, accountType = 'personal') {
  const isBusiness = accountType === 'business';
  const spread = (isBusiness && corridor?.businessAlytoCSpread != null)
    ? corridor.businessAlytoCSpread
    : (corridor?.alytoCSpread ?? 0);
  return (corridor?.payinFeePercent ?? 0) + spread + (corridor?.profitRetentionPercent ?? 0);
}

/** Fee fija de Alyto en moneda origen (retail o business). */
export function fixedFeeOrigin(corridor, accountType = 'personal') {
  const isBusiness = accountType === 'business';
  return (isBusiness && corridor?.businessFixedFee != null)
    ? corridor.businessFixedFee
    : (corridor?.fixedFee ?? 0);
}

/**
 * Colchón que se aplica SOLO al mínimo que se MUESTRA, no al que se EXIGE.
 *
 * La tasa BOB/USD es viva: entre que el usuario ve el mínimo en el selector y
 * envía el quote pueden pasar minutos y la tasa moverse, dejando el monto
 * tecleado por debajo del piso recalculado ("me dijiste 592 y ahora me pides 596").
 *
 * ⚠️ Un colchón simétrico NO resuelve esto: subiría ambos lados por igual y el
 * drift seguiría cruzando el umbral. La asimetría es la que funciona —
 * **mostrar de más, exigir lo justo**: así el número que el usuario ve siempre
 * es aceptado, y quien teclea un poco menos igual pasa si de verdad supera el
 * piso real del proveedor.
 */
export const MIN_FLOOR_BUFFER_PCT = Number(process.env.MIN_FLOOR_BUFFER_PCT ?? 2);

/**
 * PURA — bruto mínimo en moneda origen para que el neto alcance `floorUSD`.
 *
 * @param {object} p
 * @param {number} p.floorUSD       piso del proveedor en USD
 * @param {number} p.originPerUsd   unidades de moneda origen por 1 USD (ej. bobPerUsdc)
 * @param {number} p.feePct         % total descontado del bruto
 * @param {number} p.fixedOrigin    fee fija en moneda origen
 * @param {number} [p.bufferPct]    colchón sobre el piso (default MIN_FLOOR_BUFFER_PCT)
 * @returns {number|null} bruto mínimo (redondeado hacia arriba), o null si no aplica
 */
export function minOriginForFloor({ floorUSD, originPerUsd, feePct = 0, fixedOrigin = 0, bufferPct = 0 }) {
  if (!floorUSD || floorUSD <= 0) return null;
  if (!originPerUsd || originPerUsd <= 0) return null;
  const pctRemaining = 1 - (feePct / 100);
  // Fees ≥ 100%: ningún monto deja neto positivo — config inválida, no inventamos piso.
  if (pctRemaining <= 0) return null;
  const floorWithBuffer = floorUSD * (1 + bufferPct / 100);
  return Math.ceil((floorWithBuffer * originPerUsd + fixedOrigin) / pctRemaining);
}

/**
 * Piso del proveedor en USD para un corredor, leído de la fuente REAL:
 *   - Vita  → min_amount del rail que ejecutará el dispatch (withdrawal | vita_sent)
 *   - Harbor→ HARBOR_MIN_USD (límite de la API, hoy 31)
 *
 * @param {object} corridor
 * @param {object} [vitaPrices] respuesta de getPrices() (evita re-fetch si ya se tiene)
 * @returns {number|null} piso en USD, o null si el proveedor no declara uno
 */
export function providerFloorUSD(corridor, vitaPrices = null) {
  if (corridor?.payoutMethod === 'owlPay') return HARBOR_MIN_USD;
  if (corridor?.payoutMethod !== 'vitaWallet') return null;   // anchorBolivia: manual

  const dest   = (corridor.destinationCountry ?? '').toUpperCase();
  const isSent = VITA_SENT_ONLY_COUNTRIES.has(dest);
  const key    = isSent ? getVitaSentCountry(dest).toLowerCase()
                        : getVitaCountryKey(dest, corridor.destinationCurrency);

  const attrs = isSent
    ? vitaPrices?.usd?.vita_sent?.prices?.attributes
    : vitaPrices?.usd?.withdrawal?.prices?.attributes;

  const min = Number(attrs?.min_amount?.[key] ?? NaN);
  return (isFinite(min) && min > 0) ? min : null;
}

/**
 * Mínimo EFECTIVO en moneda origen: el mayor entre el configurado y el exigido por
 * el piso del proveedor. Nunca baja el mínimo — solo lo sube cuando haría falta.
 *
 * @param {object} p
 * @param {object} p.corridor
 * @param {number} p.configuredMin  resultado de resolveMinAmountOrigin()
 * @param {number} p.originPerUsd   unidades origen por USD
 * @param {number|null} p.floorUSD  piso del proveedor (providerFloorUSD)
 * @param {string} [p.accountType]
 * @param {number} [p.bufferPct]    colchón — solo para el mínimo que se MUESTRA
 * @returns {{ min:number, raisedBy:'provider_floor'|null, floorUSD:number|null }}
 */
export function effectiveMinOrigin({ corridor, configuredMin, originPerUsd, floorUSD, accountType = 'personal', bufferPct = 0 }) {
  const needed = minOriginForFloor({
    floorUSD,
    originPerUsd,
    feePct:      totalFeePct(corridor, accountType),
    fixedOrigin: fixedFeeOrigin(corridor, accountType),
    bufferPct,
  });
  if (needed != null && needed > configuredMin) {
    return { min: needed, raisedBy: 'provider_floor', floorUSD };
  }
  return { min: configuredMin, raisedBy: null, floorUSD };
}

/** Unidades de moneda origen por 1 USD (BOB/CLP vía tasa viva; USD = 1). */
export async function originPerUsdFor(originCurrency) {
  if (originCurrency === 'BOB') return await getBOBRate();
  if (originCurrency === 'CLP') return await getCLPRate();
  if (originCurrency === 'USD') return 1;
  return null;
}

/**
 * Resolución completa del mínimo de un corredor, lista para usar en endpoints.
 * Combina el mínimo configurado (resolveMinAmountOrigin) con el guard de piso del
 * proveedor. Fail-open: si no se puede leer la tasa o el piso, devuelve el configurado.
 *
 * @param {object} corridor
 * @param {string} [accountType]
 * @param {object} [vitaPrices] respuesta de getPrices() ya obtenida (opcional, evita re-fetch)
 * @param {object} [opts]
 * @param {boolean} [opts.forDisplay=false] true en el listado/UI → aplica el colchón
 *   (muestra un poco de más). false al VALIDAR → exige el piso exacto. Ver
 *   MIN_FLOOR_BUFFER_PCT: la asimetría es lo que evita "te muestro 592 y te pido 596".
 * @returns {Promise<{min:number, minUSD:number|null, raisedBy:string|null, floorUSD:number|null, currency:string}>}
 */
export async function resolveEffectiveMinimum(corridor, accountType = 'personal', vitaPrices = null, { forDisplay = false } = {}) {
  const currency     = corridor?.originCurrency;
  const configured   = await resolveMinAmountOrigin(corridor, accountType);
  const originPerUsd = await originPerUsdFor(currency).catch(() => null);

  if (!originPerUsd) {
    return { min: configured, minUSD: null, raisedBy: null, floorUSD: null, currency };
  }

  let prices = vitaPrices;
  if (!prices && corridor?.payoutMethod === 'vitaWallet') {
    // getPrices cachea ~10s → llamarlo aquí no agrega latencia real al quote.
    prices = await getPrices().catch(() => null);
  }

  const floorUSD = providerFloorUSD(corridor, prices);
  const { min, raisedBy } = effectiveMinOrigin({
    corridor, configuredMin: configured, originPerUsd, floorUSD, accountType,
    bufferPct: forDisplay ? MIN_FLOOR_BUFFER_PCT : 0,
  });

  return {
    min,
    minUSD:  Math.ceil((min / originPerUsd) * 100) / 100,
    raisedBy,
    floorUSD,
    currency,
  };
}

export default {
  totalFeePct, fixedFeeOrigin, minOriginForFloor, providerFloorUSD,
  effectiveMinOrigin, originPerUsdFor, resolveEffectiveMinimum,
};
