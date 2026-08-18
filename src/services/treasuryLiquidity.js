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
 * Clave pública de la reserva fría de la entidad, si está configurada.
 *
 * La reserva fría es una cuenta con multifirma (N-de-M) donde vive el grueso del
 * respaldo. El servidor conoce SOLO su clave pública: las privadas no están en la
 * infraestructura, que es justamente lo que hace que ningún proceso automatizado
 * —ni nadie con acceso al servidor— pueda movilizarla por su cuenta.
 *
 * Ausente = despliegue sin reserva fría; todo el respaldo vive en la caliente y el
 * comportamiento es idéntico al anterior.
 */
export function coldPubKey(entity = 'SRL') {
  return entity === 'SRL'
    ? (process.env.STELLAR_SRL_COLD_PUBLIC_KEY || null)
    : (process.env.STELLAR_LLC_COLD_PUBLIC_KEY || null);
}

/**
 * LIQUIDEZ DISPONIBLE AHORA — solo la cuenta caliente.
 *
 * Deliberadamente NO incluye la reserva fría: mover fondos desde la fría exige dos
 * firmas y una intervención manual, así que no es liquidez ejecutable en el momento.
 * Confundir ambas cosas haría que un pre-check autorizara una operación que después
 * no se puede liquidar.
 *
 * Para saber si el respaldo total cubre el pasivo (solvencia, no liquidez), usar
 * `getTreasuryReserveUSDC`.
 *
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

  // Las cuentas corporativas se excluyen del respaldo custodial: se contabilizan
  // por separado en `getTreasuryReserveUSDC`. Sin excluir la fría, una wallet que
  // apuntara a ella la sumaría dos veces e inflaría la reserva.
  const corporate = [process.env.STELLAR_SRL_PUBLIC_KEY ?? null, coldPubKey('SRL')].filter(Boolean);
  const addresses = await WalletUSDC.distinct('stellarAddress', {
    stellarAddress: { $nin: [null, '', ...corporate] },
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

// ── Reserva de tesorería: caliente + fría (Fase 42) ─────────────────────────────

/**
 * RESPALDO TOTAL DE TESORERÍA — caliente + fría.
 *
 * Es la magnitud que corresponde usar para medir SOLVENCIA: la reserva fría respalda
 * el pasivo con clientes aunque no sea movilizable en el acto. Usar solo la caliente
 * para esto reportaría un déficit inexistente en cuanto se traslade el grueso del
 * respaldo a la fría.
 *
 * Distinción explícita frente a `getUSDCAvailableNow`:
 *   - solvencia  = caliente + fría   → ¿alcanza el respaldo para cubrir el pasivo?
 *   - liquidez   = caliente − vuelo  → ¿se puede ejecutar ahora mismo?
 *
 * Lectura defensiva: si falla la consulta on-chain de cualquiera de las dos cuentas
 * se marca `partial`, para que el caller no afirme cobertura con datos incompletos.
 *
 * @param {string} entity 'SRL' | 'LLC'
 * @returns {Promise<{ total:number|null, hot:number|null, cold:number|null,
 *                     coldConfigured:boolean, partial:boolean }>}
 */
export async function getTreasuryReserveUSDC(entity = 'SRL') {
  const hotKey  = entity === 'SRL'
    ? process.env.STELLAR_SRL_PUBLIC_KEY
    : process.env.STELLAR_LLC_PUBLIC_KEY;
  const cold = coldPubKey(entity);

  let hotBal = null, coldBal = null, partial = false;

  if (!hotKey) {
    partial = true;
  } else {
    try { hotBal = await getStellarUSDCBalance(hotKey); }
    catch { partial = true; }
  }

  if (cold) {
    try { coldBal = await getStellarUSDCBalance(cold); }
    catch { partial = true; }
  }

  const total = (hotBal == null && coldBal == null)
    ? null
    : Number(((hotBal ?? 0) + (coldBal ?? 0)).toFixed(7));

  return {
    total,
    hot:            hotBal == null ? null : Number(hotBal.toFixed(7)),
    cold:           coldBal == null ? null : Number(coldBal.toFixed(7)),
    coldConfigured: Boolean(cold),
    partial,
  };
}

/**
 * Umbral por debajo del cual la cuenta caliente necesita recarga desde la fría.
 * Debe fijarse en el tope diario declarado en el protocolo de pruebas del ECP: si la
 * caliente no alcanza para cubrir un día de operación al máximo, hay que recargar.
 */
export function minHotUSDC() {
  const raw = Number(process.env.STELLAR_HOT_MIN_USDC);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export default {
  getUSDCAvailableNow,
  getCustodialUSDCBacking,
  getTreasuryReserveUSDC,
  coldPubKey,
  minHotUSDC,
};
