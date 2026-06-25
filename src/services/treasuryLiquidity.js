/**
 * treasuryLiquidity.js — Liquidez de tesorería USDC disponible AHORA
 *
 * Fuente única para los pre-checks de liquidez que respaldan operaciones que
 * acreditan/envían USDC contra la tesorería (conversión BOB→USDC, payouts, y el
 * futuro swap). Misma base que `getUSDCForecast` y el pre-check de payout
 * (`tryOwlPayV2`): **saldo on-chain de la tesorería − USDC en vuelo**.
 *
 *   available = max(0, tesorería_on_chain − payouts_en_vuelo)
 *
 * IMPORTANTE — modelo custodial (Fase 40): los depósitos USDC de usuarios caen en
 * sus DIRECCIONES CUSTODIALES propias, NO en la tesorería. Por eso este número mide
 * SOLO la liquidez de la tesorería (respaldo de USDC convertido / por enviar), no el
 * respaldo total de saldos de usuarios (eso incluye las cuentas custodiales).
 */

import Transaction from '../models/Transaction.js';
import WalletUSDC from '../models/WalletUSDC.js';
import { getStellarUSDCBalance } from './stellarService.js';

const INFLIGHT_STATUSES = ['payout_pending_usdc_send', 'payout_in_transit', 'payout_sent'];

/**
 * @param {string} entity 'SRL' | 'LLC'
 * @returns {Promise<{ available:number|null, treasury:number|null, inflight:number, reason?:string }>}
 *   available = null cuando no se puede determinar (sin pubkey) → el caller decide (fail-open).
 */
export async function getUSDCAvailableNow(entity = 'SRL') {
  const pubKey = entity === 'SRL'
    ? process.env.STELLAR_SRL_PUBLIC_KEY
    : process.env.STELLAR_LLC_PUBLIC_KEY;

  if (!pubKey) return { available: null, treasury: null, inflight: 0, reason: 'no_pubkey' };

  const treasury = await getStellarUSDCBalance(pubKey);

  const agg = await Transaction.aggregate([
    { $match: { legalEntity: entity, status: { $in: INFLIGHT_STATUSES } } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$digitalAssetAmount', 0] } } } },
  ]);
  const inflight = agg[0]?.total ?? 0;

  return { available: Math.max(0, treasury - inflight), treasury, inflight };
}

// ── Respaldo custodial (Fase 40) ────────────────────────────────────────────────

let _custodialCache = null;
const CUSTODIAL_TTL_MS = Number(process.env.USDC_CUSTODIAL_CACHE_MS ?? 60_000);

/**
 * Suma el USDC on-chain en TODAS las direcciones custodiales activas. Es el respaldo de
 * los saldos USDC DEPOSITADOS por usuarios (modelo Fase 40: los depósitos caen en la
 * cuenta custodial propia de cada usuario, NO en la tesorería). Necesario para medir la
 * solvencia USDC sin falsos negativos.
 *
 * O(N) cuentas → cacheado (TTL `USDC_CUSTODIAL_CACHE_MS`, default 60s; `getStellarUSDCBalance`
 * además cachea 30s por cuenta). Lectura por-cuenta defensiva:
 *   - cuenta sin fondear (404) → 0 (getStellarUSDCBalance ya lo maneja), NO es falla.
 *   - error de red → cuenta como falla → `partial: true` para que el caller NO afirme
 *     sub-colateralización con respaldo incompleto.
 *
 * @returns {Promise<{ sum:number, partial:boolean, addresses:number, failures:number }>}
 */
export async function getCustodialUSDCBacking({ fresh = false } = {}) {
  if (!fresh && _custodialCache && Date.now() - _custodialCache.at < CUSTODIAL_TTL_MS) {
    return _custodialCache;
  }

  const srlShared = process.env.STELLAR_SRL_PUBLIC_KEY ?? null;
  const addresses = await WalletUSDC.distinct('stellarAddress', {
    stellarAddress: { $nin: [null, '', srlShared] },
    status:         'active',
  });

  let sum = 0;
  let failures = 0;
  for (const addr of addresses) {
    try {
      sum += await getStellarUSDCBalance(addr); // 404 → 0 dentro de la función
    } catch {
      failures += 1; // error de red → respaldo parcial
    }
  }

  const result = {
    sum:       Number(sum.toFixed(7)),
    partial:   failures > 0,
    addresses: addresses.length,
    failures,
    at:        Date.now(),
  };
  _custodialCache = result;
  return result;
}

export default { getUSDCAvailableNow, getCustodialUSDCBacking };
