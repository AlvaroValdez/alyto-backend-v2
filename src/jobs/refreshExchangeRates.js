/**
 * refreshExchangeRates.js — Job de actualización automática de tasas BOB/USDT
 *
 * Consulta Binance P2P cada 30 min y actualiza MongoDB ExchangeRate con la
 * mediana del mercado, marcando source='binance_p2p_auto'.
 *
 * Esto garantiza que getBOBRate() siempre tenga una tasa fresca aunque el
 * admin no actualice manualmente el panel.
 *
 * El admin puede seguir sobreescribiendo con BOB/USDC para margen USDC específico.
 *
 * Triggers:
 *   - setInterval en server.js cada 30 min (primera corrida 90s post-start)
 */

import ExchangeRate           from '../models/ExchangeRate.js';
import { fetchBOBUSDTRate }   from '../services/binanceP2PService.js';

export async function refreshExchangeRates() {
  console.log('[RefreshRates] Iniciando actualización de tasa BOB/USDT desde Binance P2P…');

  let rate;
  try {
    rate = await fetchBOBUSDTRate();
  } catch (err) {
    console.warn('[RefreshRates] No se pudo obtener tasa live de Binance P2P:', err.message);
    return;
  }

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
    // MongoDB error no cancela el job — siguiente corrida lo reintentará
    console.error('[RefreshRates] Error actualizando MongoDB:', err.message);
  }
}
