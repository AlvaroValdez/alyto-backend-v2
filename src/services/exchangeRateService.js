/**
 * exchangeRateService.js — Utilidades de Tasa de Cambio
 *
 * Centraliza la resolución de tasas de cambio para que tanto
 * paymentController como ipnController usen la misma fuente de verdad.
 *
 * Prioridad de resolución (BOB/USDT):
 *   1. MongoDB (ExchangeRate.findOne) — actualizada por el admin desde el panel
 *   2. process.env.BOB_USD_RATE       — variable de entorno (fallback)
 *   3. 9.31                           — constante hardcodeada (último recurso)
 */

import ExchangeRate from '../models/ExchangeRate.js';

/**
 * Obtiene la tasa BOB/USDC (BOB por 1 USDC) desde MongoDB.
 * Busca los pares 'BOB-USDT' y 'BOB-USD' (orden de preferencia).
 *
 * @returns {Promise<number>} Tasa BOB por 1 USDC
 */
export async function getBOBRate() {
  try {
    const record = await ExchangeRate.findOne({
      pair: { $in: ['BOB-USDT', 'BOB-USD'] },
    }).sort({ updatedAt: -1 });

    if (record) {
      console.log('[getBOBRate] Tasa desde MongoDB:', record.rate,
        '| par:', record.pair,
        '| actualizada:', record.updatedAt.toISOString());
      return record.rate;
    }
  } catch (err) {
    console.warn('[getBOBRate] Error consultando MongoDB, usando fallback .env:', err.message);
  }

  const envRate = parseFloat(process.env.BOB_USD_RATE ?? '9.31');
  console.log('[getBOBRate] Tasa desde .env:', envRate);
  return envRate;
}
