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

// ── Colchón cambiario (FX buffer) ────────────────────────────────────────────
// El payin SRL es manual: el usuario transfiere BOB y el admin confirma horas
// después; recién entonces compramos USDC al precio de ese momento. Entre la
// cotización (T0) y el fondeo (T+) el BOB puede depreciarse, dejando el monto
// neto por debajo del costo real del USDC. Para no entregar transacciones por
// debajo de costo, la tasa de cotización incorpora un colchón configurable
// sobre la tasa de mercado (más BOB por USDC = colchón a favor de Alyto).
//
//   FX_BUFFER_PCT          colchón % por defecto (corridor.fxBufferPct lo anula)
//   FX_REQUOTE_THRESHOLD_PCT  umbral de drift que dispara el guard en dispatch
const FX_BUFFER_PCT_DEFAULT      = parseFloat(process.env.FX_BUFFER_PCT ?? '2');
const FX_REQUOTE_THRESHOLD_PCT   = parseFloat(process.env.FX_REQUOTE_THRESHOLD_PCT ?? '3');
// Spread del corredor USDC (wallet): la tasa de conversión BOB→USDC se DERIVA de
// la tasa de mercado × (1 + spread%) para que nunca quede por debajo del costo de
// fondeo. Por defecto reusa FX_BUFFER_PCT. El override admin BOB-USDC solo puede
// SUBIR la tasa por encima de este piso, nunca bajarla bajo costo.
const USDC_CONVERT_SPREAD_PCT    = parseFloat(process.env.USDC_CONVERT_SPREAD_PCT ?? process.env.FX_BUFFER_PCT ?? '2');

const round6 = n => Math.round(n * 1e6) / 1e6;

/**
 * Obtiene la tasa BOB/USD de mercado (BOB por 1 USD).
 * Usada para: cotizaciones Vita, mínimos de corredor, conversiones generales.
 *
 * Prioridad:
 *  1. Binance P2P live (cache 20 min en memoria)       — mercado real
 *  2. MongoDB BOB-USDT auto-actualizado (job 30 min)   — fallback P2P
 *  3. MongoDB BOB-USD
 *  4. env BOB_USD_RATE → 9.31
 *
 * NOTA: El override BOB-USDC del admin es específico para el corredor USDC
 * (margen de cambio manual). NO aplica aquí para no contaminar cotizaciones
 * Vita ni mínimos de corredor con una tasa posiblemente desactualizada.
 * Usar getBOBUSDCRate() para operaciones del corredor USDC.
 *
 * @returns {Promise<number>} Tasa BOB por 1 USD
 */
export async function getBOBRate() {
  // ── 1. Binance P2P live ───────────────────────────────────────────────────
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

  // ── 4. env → 9.31 ────────────────────────────────────────────────────────
  const envRate = parseFloat(process.env.BOB_USD_RATE ?? '9.31');
  console.log('[getBOBRate] Tasa desde .env:', envRate);
  return envRate;
}

/**
 * Tasa BOB/USDC para el corredor WalletUSDC (conversión BOB→USDC del usuario).
 * Solo usar para operaciones del corredor WalletUSDC — NO para Vita ni mínimos.
 *
 * La tasa se DERIVA de la tasa de mercado (Binance P2P BOB/USDT) × (1 + spread%)
 * para que nunca quede por debajo del costo de fondeo (más BOB por USDC = margen
 * a favor de Alyto). El override admin BOB-USDC actúa solo como PISO SUPERIOR:
 * si el admin lo fija por encima de la tasa derivada, gana (más margen); si lo
 * fija por debajo del costo, se ignora y se usa la derivada (protección de margen).
 *
 * @returns {Promise<number>} Tasa BOB por 1 USDC (≥ mercado × (1 + spread%))
 */
export async function getBOBUSDCRate() {
  return (await getBOBUSDCRateDetailed()).bobPerUsdc;
}

/**
 * Igual que getBOBUSDCRate pero devuelve el desglose para exponer en la UI.
 * @returns {Promise<{ bobPerUsdc, marketRate, spreadPct, derivedRate, override, source }>}
 */
export async function getBOBUSDCRateDetailed() {
  const marketRate  = await getBOBRate();
  const spreadPct   = USDC_CONVERT_SPREAD_PCT;
  const derivedRate = round6(marketRate * (1 + spreadPct / 100));

  let override = null;
  try {
    const records = await ExchangeRate.find({
      pair: { $in: ['BOB-USDC', 'BOB/USDC'] },
    }).sort({ updatedAt: -1 }).lean();
    // Solo cuenta como override si el admin lo fijó manualmente (source='manual').
    // Los registros source='binance_p2p_auto' son para visibilidad en el panel,
    // no deben interferir con la derivación live.
    const rec = records.find(r => r?.rate > 0 && r.source === 'manual');
    if (rec) override = rec.rate;
  } catch (_) { /* sin override → solo derivada */ }

  // El override solo puede SUBIR la tasa por encima del piso derivado.
  const useOverride = override != null && override > derivedRate;
  const bobPerUsdc  = useOverride ? override : derivedRate;

  return {
    bobPerUsdc,
    marketRate,
    spreadPct,
    derivedRate,
    override,
    source: useOverride ? 'admin_override' : 'binance_p2p+spread',
  };
}

/**
 * Tasa USDC→BOB (lado VENTA) para la conversión inversa del usuario en la wallet.
 * Alyto COMPRA el USDC del usuario, así que paga MENOS BOB por USDC que el mercado
 * (market × (1 − spread%)) — el spread queda a favor de Alyto, simétrico a
 * getBOBUSDCRate (que cobra de más al comprar USDC). Ledger-only: NO mueve on-chain.
 *
 * @returns {Promise<number>} Tasa BOB por 1 USDC (≤ mercado × (1 − spread%))
 */
export async function getUSDCBOBRate() {
  return (await getUSDCBOBRateDetailed()).bobPerUsdc;
}

/**
 * Igual que getUSDCBOBRate pero con desglose para la UI.
 * @returns {Promise<{ bobPerUsdc, marketRate, spreadPct, source }>}
 */
export async function getUSDCBOBRateDetailed() {
  const marketRate = await getBOBRate();
  const spreadPct  = USDC_CONVERT_SPREAD_PCT;
  // Lado venta: market × (1 − spread%). Piso de seguridad: nunca negativo/cero.
  const bobPerUsdc = round6(Math.max(marketRate * (1 - spreadPct / 100), marketRate * 0.5));
  return { bobPerUsdc, marketRate, spreadPct, source: 'binance_p2p-spread' };
}

/**
 * Resuelve la tasa BOB/USDC para COTIZAR al usuario (corredores SRL Bolivia).
 *
 * Fuente única para los 4 sitios de quote (REST calculateBOBQuote, REST getQuote
 * manual, WS quoteSocket, y el recalc de dispatchPayout). Reemplaza el patrón
 * duplicado `manualExchangeRate > 0 ? manualExchangeRate : getBOBRate()`.
 *
 * Reglas:
 *   - manualExchangeRate del admin GANA y NO recibe colchón (ya es una tasa
 *     deliberada fijada por el admin, presumiblemente con su propio margen).
 *   - Si no hay tasa manual → tasa de mercado (Binance P2P) × (1 + colchón%).
 *     El colchón es corridor.fxBufferPct si está definido, si no FX_BUFFER_PCT.
 *
 * @param {{ manualExchangeRate?: number, fxBufferPct?: number }} corridor
 * @returns {Promise<{ bobPerUsdc: number, marketRate: number, bufferPct: number, source: string }>}
 */
export async function resolveQuoteRate(corridor) {
  if (corridor?.manualExchangeRate > 0) {
    return {
      bobPerUsdc: corridor.manualExchangeRate,
      marketRate: corridor.manualExchangeRate,
      bufferPct:  0,
      source:     'corridor_manualRate',
    };
  }

  const marketRate = await getBOBRate();
  const bufferPct  = (corridor?.fxBufferPct != null) ? corridor.fxBufferPct : FX_BUFFER_PCT_DEFAULT;
  const bobPerUsdc = round6(marketRate * (1 + bufferPct / 100));

  return {
    bobPerUsdc,
    marketRate,
    bufferPct,
    source: bufferPct > 0 ? 'binance_p2p+buffer' : 'binance_p2p',
  };
}

/**
 * Guard de drift cambiario para dispatchPayout (corredores SRL con tasa live).
 *
 * Compara la tasa de mercado ACTUAL (momento del fondeo) contra la tasa que se
 * congeló al cotizar (ya incluye el colchón). Si el mercado superó la tasa
 * congelada por más de FX_REQUOTE_THRESHOLD_PCT, el colchón no alcanza y NO se
 * debe fondear a ciegas → el caller debe pausar y avisar al admin.
 *
 * Fail-open: si no se puede leer el mercado o no hay tasa congelada, devuelve
 * drifted=false (coherente con el pre-check de liquidez, que también es optimista).
 *
 * @param {{ lockedBobPerUsdc: number, manualRateActive?: boolean }} input
 * @returns {Promise<{ drifted: boolean, marketNow?: number, lockedBobPerUsdc?: number, driftPct?: number, thresholdPct: number, reason?: string }>}
 */
export async function checkFxDrift({ lockedBobPerUsdc, manualRateActive = false }) {
  // Tasa fija del admin: sin exposición live → nunca dispara.
  if (manualRateActive) {
    return { drifted: false, thresholdPct: FX_REQUOTE_THRESHOLD_PCT, reason: 'manual_rate' };
  }
  if (!lockedBobPerUsdc || lockedBobPerUsdc <= 0) {
    return { drifted: false, thresholdPct: FX_REQUOTE_THRESHOLD_PCT, reason: 'no_locked_rate' };
  }

  const marketNow = await getBOBRate().catch(() => null);
  if (marketNow == null || marketNow <= 0) {
    // No bloquear el flujo si no podemos leer el mercado.
    return { drifted: false, thresholdPct: FX_REQUOTE_THRESHOLD_PCT, reason: 'market_unavailable' };
  }

  const ceiling  = lockedBobPerUsdc * (1 + FX_REQUOTE_THRESHOLD_PCT / 100);
  const drifted  = marketNow > ceiling;
  const driftPct = round6(((marketNow - lockedBobPerUsdc) / lockedBobPerUsdc) * 100);

  return { drifted, marketNow, lockedBobPerUsdc, driftPct, thresholdPct: FX_REQUOTE_THRESHOLD_PCT };
}

/**
 * Resuelve el monto mínimo en moneda de origen para un corredor.
 *
 * Selecciona el umbral USD según accountType:
 *   - 'business' → minAmountUSDBusiness (si existe), si no cae a minAmountUSD
 *   - cualquier otro → minAmountUSD
 *
 * Luego convierte a moneda de origen:
 *   - BOB: Math.ceil(minUSD × tasa live BOB/USD Binance P2P)
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
 * Convierte un monto en moneda origen a su equivalente aproximado en USD.
 * Usa las tasas live (BOB/USD, CLP/USD). USD se devuelve tal cual.
 * Útil para decisiones de enrutamiento por monto (ej. umbral Harbor EU).
 *
 * @param {number} amountOrigin   - Monto en moneda origen
 * @param {string} originCurrency - ISO 4217 (BOB | CLP | USD)
 * @returns {Promise<number>} Monto aproximado en USD
 */
export async function convertOriginToUSD(amountOrigin, originCurrency) {
  const amt = Number(amountOrigin) || 0;
  if (originCurrency === 'USD') return amt;
  if (originCurrency === 'BOB') { const r = await getBOBRate(); return r > 0 ? amt / r : 0; }
  if (originCurrency === 'CLP') { const r = await getCLPRate(); return r > 0 ? amt / r : 0; }
  return amt; // fallback conservador: tratar como USD
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
