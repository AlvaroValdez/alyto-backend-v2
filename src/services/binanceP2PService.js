/**
 * binanceP2PService.js — Tasas fiat/USDT live desde Binance P2P
 *
 * Binance P2P es la única fuente con mercado BOB/USDT activo.
 * No hay BOB en exchanges regulares (Binance spot, Coinbase, etc.) —
 * solo en P2P donde traders bolivianos operan directamente.
 *
 * También sirve el lado chileno: usar la MISMA fuente y la misma metodología
 * para las dos puntas es lo que permite derivar CLP↔BOB sin mezclar un precio
 * de mercado con uno de referencia, que es como la tasa del corredor terminó
 * desactualizada cinco meses.
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

// Cache por moneda. Antes era uno solo porque solo se consultaba BOB; con dos
// monedas, una sola ranura haría que cada consulta desalojara a la otra y el
// cache dejaría de servir para algo.
const _cache = new Map(); // fiat → { rate, fetchedAt }

/**
 * Obtiene la tasa {fiat}/USDT live desde Binance P2P.
 * Usa cache en memoria de 20 min para no saturar el endpoint.
 *
 * @param {string} [fiat='BOB'] — 'BOB' | 'CLP'
 * @returns {Promise<number>} unidades de `fiat` por 1 USDT
 * @throws  {Error} si la API falla y el cache está vencido
 */
export async function fetchFiatUSDTRate(fiat = 'BOB') {
  const moneda = String(fiat).toUpperCase();

  // Devolver cache si está vigente
  const hit = _cache.get(moneda);
  if (hit && (Date.now() - hit.fetchedAt) < CACHE_TTL) {
    console.log(`[BinanceP2P] cache hit ${moneda}:`, hit.rate,
      '| age:', Math.round((Date.now() - hit.fetchedAt) / 1000) + 's');
    return hit.rate;
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(P2P_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fiat:          moneda,
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
      throw new Error(`Respuesta inesperada Binance P2P (${moneda}): code=${json.code} items=${json.data?.length}`);
    }

    const prices = json.data
      .map(item => parseFloat(item.adv?.price))
      .filter(p  => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);

    if (prices.length === 0) throw new Error(`No se obtuvieron precios válidos de Binance P2P para ${moneda}`);

    const median = _median(prices);

    _cache.set(moneda, { rate: median, fetchedAt: Date.now() });

    console.log(`[BinanceP2P] tasa ${moneda}/USDT live:`, median,
      '| basada en', prices.length, 'ofertas',
      '| rango:', prices[0], '-', prices[prices.length - 1]);

    return median;

  } finally {
    clearTimeout(timer);
  }
}

/** Alias histórico: es el nombre que usan el job y los controladores ya escritos. */
export const fetchBOBUSDTRate = () => fetchFiatUSDTRate('BOB');

/**
 * Devuelve el valor en cache sin hacer fetch.
 * Útil para saber si ya tenemos un valor aunque esté vencido.
 *
 * @param {string} [fiat='BOB']
 * @returns {{ rate: number, fetchedAt: number } | null}
 */
export function getCachedBOBUSDTRate(fiat = 'BOB') {
  return _cache.get(String(fiat).toUpperCase()) ?? null;
}

/**
 * Invalida el cache (útil en tests o forzar refresh).
 */
export function invalidateCache(fiat) {
  if (fiat) _cache.delete(String(fiat).toUpperCase());
  else _cache.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}
