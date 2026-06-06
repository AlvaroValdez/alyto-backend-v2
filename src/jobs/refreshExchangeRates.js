/**
 * refreshExchangeRates.js — Job de actualización automática de tasas BOB/USDT y BOB/USDC
 *
 * Consulta Binance P2P cada 30 min y actualiza MongoDB ExchangeRate:
 *   - BOB-USDT: mediana de mercado, source='binance_p2p_auto'
 *   - BOB-USDC: BOB-USDT × (1 + spread%), source='binance_p2p_auto'
 *     Solo actualiza BOB-USDC si el documento existente NO tiene source='manual'
 *     (preserva overrides manuales del admin).
 *
 * Triggers:
 *   - setInterval en server.js cada 30 min (primera corrida 90s post-start)
 */

import ExchangeRate           from '../models/ExchangeRate.js';
import { fetchBOBUSDTRate }   from '../services/binanceP2PService.js';

const round6 = n => Math.round(n * 1e6) / 1e6;

export async function refreshExchangeRates() {
  console.log('[RefreshRates] Iniciando actualización de tasa BOB/USDT desde Binance P2P…');

  let rate;
  try {
    rate = await fetchBOBUSDTRate();
  } catch (err) {
    console.warn('[RefreshRates] No se pudo obtener tasa live de Binance P2P:', err.message);
    return;
  }

  // ── BOB-USDT ─────────────────────────────────────────────────────────────────
  try {
    const result = await ExchangeRate.findOneAndUpdate(
      { pair: 'BOB-USDT' },
      {
        $set: {
          rate,
          source:    'binance_p2p_auto',
          updatedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    console.log('[RefreshRates] BOB-USDT actualizado en MongoDB:',
      result.rate, '| par:', result.pair,
      '| source:', result.source);

  } catch (err) {
    console.error('[RefreshRates] Error actualizando BOB-USDT en MongoDB:', err.message);
  }

  // ── BOB-USDC (derivada = BOB-USDT × (1 + spread%)) ───────────────────────────
  // Solo actualiza si no hay un override manual del admin. Los overrides manuales
  // tienen source='manual' y deben permanecer intactos hasta que el admin los borre.
  try {
    const existing = await ExchangeRate.findOne({ pair: 'BOB-USDC' }).lean();
    if (existing?.source === 'manual') {
      console.log('[RefreshRates] BOB-USDC tiene override manual (', existing.rate,
        ') — no se sobreescribe');
    } else {
      const spreadPct     = parseFloat(process.env.USDC_CONVERT_SPREAD_PCT ?? process.env.FX_BUFFER_PCT ?? '2');
      const derivedBOBUSDC = round6(rate * (1 + spreadPct / 100));

      const result = await ExchangeRate.findOneAndUpdate(
        { pair: 'BOB-USDC' },
        {
          $set: {
            rate:      derivedBOBUSDC,
            source:    'binance_p2p_auto',
            updatedAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );

      console.log('[RefreshRates] BOB-USDC actualizado en MongoDB:',
        result.rate, '| spread:', spreadPct + '%',
        '| market:', rate, '| source:', result.source);
    }
  } catch (err) {
    console.error('[RefreshRates] Error actualizando BOB-USDC en MongoDB:', err.message);
  }
}
