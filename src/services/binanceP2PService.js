/**
 * binanceP2PService.js — Tasa BOB/USDT live desde Binance P2P
 *
 * Binance P2P es la única fuente con mercado BOB/USDT activo.
 * No hay BOB en exchanges regulares (Binance spot, Coinbase, etc.) —
 * solo en P2P donde traders bolivianos operan directamente.
 *
 * Endpoint: POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search
 * Tipo: BUY (alguien compra USDT pagando en BOB) = precio que pagaríamos
 *
 * Precio calculado: mediana del top-10 de offers activas → representativo
 * del mercado sin ser manipulable por una sola oferta extrema.
 *
 * Cache en memoria: 20 minutos — equilibrio entre frescura y evitar
 * rate-limit del endpoint no oficial de Binance.
 */

const P2P_URL    = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const CACHE_TTL  = 20 * 60 * 1000; // 20 min
const FETCH_ROWS = 20;             // top offers a consultar
const TIMEOUT_MS = 8_000;

let _cache = null; // { rate: number, fetchedAt: number }

/**
 * Obtiene la tasa BOB/USDT live desde Binance P2P.
 * Usa cache en memoria de 20 min para no saturar el endpoint.
 *
 * @returns {Promise<number>} BOB por 1 USDT
 * @throws  {Error} si la API falla y el cache está vencido
 */
export async function fetchBOBUSDTRate() {
  // Devolver cache si está vigente
  if (_cache && (Date.now() - _cache.fetchedAt) < CACHE_TTL) {
    console.log('[BinanceP2P] cache hit:', _cache.rate,
      '| age:', Math.round((Date.now() - _cache.fetchedAt) / 1000) + 's');
    return _cache.rate;
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(P2P_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fiat:          'BOB',
        asset:         'USDT',
        tradeType:     'BUY',       // compramos USDT (pagamos BOB)
        page:          1,
        rows:          FETCH_ROWS,
        payTypes:      [],
        countries:     [],
        publisherType: null,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const json = await resp.json();

    if (json.code !== '000000' || !Array.isArray(json.data) || json.data.length === 0) {
      throw new Error(`Respuesta inesperada Binance P2P: code=${json.code} items=${json.data?.length}`);
    }

    const prices = json.data
      .map(item => parseFloat(item.adv?.price))
      .filter(p  => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);

    if (prices.length === 0) throw new Error('No se obtuvieron precios válidos de Binance P2P');

    const median = _median(prices);

    _cache = { rate: median, fetchedAt: Date.now() };

    console.log('[BinanceP2P] tasa BOB/USDT live:', median,
      '| basada en', prices.length, 'ofertas',
      '| rango:', prices[0], '-', prices[prices.length - 1]);

    return median;

  } finally {
    clearTimeout(timer);
  }
}

/**
 * Devuelve el valor en cache sin hacer fetch.
 * Útil para saber si ya tenemos un valor aunque esté vencido.
 *
 * @returns {{ rate: number, fetchedAt: number } | null}
 */
export function getCachedBOBUSDTRate() {
  return _cache;
}

/**
 * Invalida el cache (útil en tests o forzar refresh).
 */
export function invalidateCache() {
  _cache = null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}
