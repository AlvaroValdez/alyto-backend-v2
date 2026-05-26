/**
 * exchangeRateService.js — Utilidades de Tasa de Cambio
 *
 * Centraliza la resolución de tasas de cambio para que tanto
 * paymentController como ipnController usen la misma fuente de verdad.
 *
 * Prioridad de resolución (BOB/USDC):
 *   1. MongoDB par 'BOB-USDC' / 'BOB/USDC' — override admin USDC específico
 *   2. Binance P2P live (cache 20 min)      — mercado real BOB/USDT
 *   3. MongoDB par 'BOB-USDT'               — auto-actualizado por refreshExchangeRates job
 *   4. MongoDB par 'BOB-USD'                — alias
 *   5. process.env.BOB_USD_RATE             — variable de entorno (fallback)
 *   6. 9.31                                 — constante hardcodeada (último recurso)
 *
 * Nota: el admin puede guardar el par como 'BOB/USDC' (con barra) o 'BOB-USDC'
 * (con guión) — ambos se normalizan a uppercase y se buscan aquí.
 */

import ExchangeRate               from '../models/ExchangeRate.js';
import { fetchBOBUSDTRate,
         getCachedBOBUSDTRate }   from './binanceP2PService.js';

/**
 * Obtiene la tasa BOB/USDC (BOB por 1 USDC).
 *
 * Prioridad:
 *  1. Override admin en MongoDB (BOB-USDC / BOB/USDC) — margen USDC específico
 *  2. Binance P2P live (cache 20 min en memoria)       — mercado real
 *  3. MongoDB BOB-USDT auto-actualizado (job 30 min)   — fallback P2P
 *  4. MongoDB BOB-USD
 *  5. env BOB_USD_RATE → 9.31
 *
 * @returns {Promise<number>} Tasa BOB por 1 USDC
 */
export async function getBOBRate() {
  // ── 1. Check admin override USDC en MongoDB ──────────────────────────────
  try {
    const usdcRecords = await ExchangeRate.find({
      pair: { $in: ['BOB-USDC', 'BOB/USDC'] },
    }).sort({ updatedAt: -1 }).lean();

    const override = usdcRecords.find(r => r?.rate > 0);
    if (override) {
      console.log('[getBOBRate] Override admin MongoDB:', override.rate,
        '| par:', override.pair,
        '| actualizado:', override.updatedAt.toISOString());
      return override.rate;
    }
  } catch (err) {
    console.warn('[getBOBRate] Error consultando MongoDB (override):', err.message);
  }

  // ── 2. Binance P2P live ───────────────────────────────────────────────────
  try {
    const liveRate = await fetchBOBUSDTRate();
    console.log('[getBOBRate] Tasa live Binance P2P:', liveRate);
    return liveRate;
  } catch (err) {
    console.warn('[getBOBRate] Binance P2P no disponible:', err.message);
    // Si hay cache vencido, úsalo antes de caer a MongoDB
    const staleCache = getCachedBOBUSDTRate();
    if (staleCache) {
      const ageMin = Math.round((Date.now() - staleCache.fetchedAt) / 60_000);
      console.warn('[getBOBRate] Usando cache vencido Binance P2P:', staleCache.rate,
        '| antigüedad:', ageMin, 'min');
      return staleCache.rate;
    }
  }

  // ── 3-4. MongoDB BOB-USDT / BOB-USD (auto-actualizado por job) ───────────
  try {
    const records = await ExchangeRate.find({
      pair: { $in: ['BOB-USDT', 'BOB-USD'] },
    }).sort({ updatedAt: -1 }).lean();

    const byPair = Object.fromEntries(records.map(r => [r.pair, r]));
    const record = ['BOB-USDT', 'BOB-USD'].map(p => byPair[p]).find(r => r?.rate > 0);

    if (record) {
      console.log('[getBOBRate] MongoDB fallback:', record.rate,
        '| par:', record.pair,
        '| actualizado:', record.updatedAt.toISOString());
      return record.rate;
    }
  } catch (err) {
    console.warn('[getBOBRate] Error consultando MongoDB (fallback):', err.message);
  }

  // ── 5. env → 9.31 ────────────────────────────────────────────────────────
  const envRate = parseFloat(process.env.BOB_USD_RATE ?? '9.31');
  console.log('[getBOBRate] Tasa desde .env:', envRate);
  return envRate;
}

/**
 * Resuelve el monto mínimo en moneda de origen para un corredor.
 *
 * Selecciona el umbral USD según accountType:
 *   - 'business' → minAmountUSDBusiness (si existe), si no cae a minAmountUSD
 *   - cualquier otro → minAmountUSD
 *
 * Luego convierte a moneda de origen:
 *   - BOB: Math.ceil(minUSD × tasa live BOB/USDC)
 *   - USD: minUSD directo (1:1)
 *   - CLP: Math.ceil(minUSD × tasa live CLP/USD)
 *   - Sin minUSD: devuelve minAmountOrigin estático
 *
 * @param {{ minAmountUSD?: number, minAmountUSDBusiness?: number, minAmountOrigin?: number, originCurrency?: string }} corridor
 * @param {string} [accountType='personal']
 * @returns {Promise<number>}
 */
export async function resolveMinAmountOrigin(corridor, accountType = 'personal') {
  const isBusiness = accountType === 'business';
  const minUSD = (isBusiness && corridor.minAmountUSDBusiness != null)
    ? corridor.minAmountUSDBusiness
    : corridor.minAmountUSD;

  if (!minUSD) return corridor.minAmountOrigin ?? 1;

  if (corridor.originCurrency === 'BOB') {
    const rate = await getBOBRate();
    return Math.ceil(minUSD * rate);
  }

  if (corridor.originCurrency === 'USD') return minUSD;

  if (corridor.originCurrency === 'CLP') {
    const clpRate = await getCLPRate();
    return Math.ceil(minUSD * clpRate);
  }

  return corridor.minAmountOrigin ?? 1;
}

/**
 * Obtiene la tasa CLP/USD (CLP por 1 USD) desde MongoDB.
 * Busca el par 'CLP-USDT' (proxy USD dado que USDT ≈ USD).
 *
 * @returns {Promise<number>}
 */
export async function getCLPRate() {
  try {
    const record = await ExchangeRate.findOne({ pair: 'CLP-USDT' })
      .sort({ updatedAt: -1 });
    if (record) return record.rate;
  } catch (err) {
    console.warn('[getCLPRate] Error consultando MongoDB, usando fallback .env:', err.message);
  }
  return parseFloat(process.env.CLP_USD_RATE ?? '966');
}
