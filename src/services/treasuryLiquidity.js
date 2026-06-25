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

export default { getUSDCAvailableNow };
