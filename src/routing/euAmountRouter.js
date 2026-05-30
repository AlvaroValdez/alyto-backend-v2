/**
 * euAmountRouter.js — Selección automática de proveedor para destinos EU/SEPA por monto.
 *
 * Destinos EU/SEPA cubiertos por DOS corredores en paralelo:
 *   - OwlPay Harbor (destinationCountry='EU', ej. bo-eu-srl): mejor FX y más rápido
 *     (SEPA, 0-1 día). Harbor SOLO procesa montos en [30, 9998] USD (límites reales
 *     de la API, confirmados 2026-05-30 contra prod).
 *   - Vita Wallet (destinationCountry específico, ej. bo-es): cubre montos FUERA del
 *     rango Harbor (< $30 o > $9998).
 *
 * Regla: dentro del rango Harbor → Harbor (mejor FX en todo el rango); fuera → Vita.
 * Solo aplica cuando NO se pasó corridorId explícito y existen AMBOS corredores activos.
 *
 * Compartido por el quote REST (paymentController) y el quote WebSocket (quoteSocket)
 * para garantizar la MISMA decisión en ambos paths. Documentado en CLAUDE.md §12.
 */

import TransactionConfig from '../models/TransactionConfig.js';
import { convertOriginToUSD } from '../services/exchangeRateService.js';

export const EU_SEPA_DESTINATIONS = new Set([
  'ES', 'EU', 'DE', 'FR', 'IT', 'NL', 'PT', 'IE', 'AT', 'BE',
  'GR', 'FI', 'LU', 'SK', 'SI', 'EE', 'LV', 'LT', 'CY', 'MT', 'PL',
]);

// Límites reales de Harbor confirmados contra la API: source.amount ∈ [30, 9998] USD.
export const HARBOR_MIN_USD = Number(process.env.HARBOR_MIN_USD ?? 30);
export const HARBOR_MAX_USD = Number(process.env.HARBOR_MAX_USD ?? 9998);

/**
 * ¿El destino es EU/SEPA elegible para ruteo automático por monto?
 * @param {string} dest - ISO alpha-2 destino (o 'EU')
 * @returns {boolean}
 */
export function isEuSepaDestination(dest) {
  return EU_SEPA_DESTINATIONS.has((dest ?? '').toUpperCase());
}

/**
 * Resuelve el corredor EU óptimo por monto.
 * @param {string} origin        - ISO alpha-2 origen (ej. 'BO')
 * @param {string} dest          - ISO alpha-2 destino (ej. 'ES', 'EU')
 * @param {number} amountOrigin  - Monto en moneda origen
 * @returns {Promise<object|null>} corredor TransactionConfig (lean) o null si no aplica
 *   (destino no-EU, falta uno de los dos proveedores, o monto no convertible).
 */
export async function resolveEuCorridorByAmount(origin, dest, amountOrigin) {
  const ORIGIN = (origin ?? '').toUpperCase();
  const DEST   = (dest ?? '').toUpperCase();
  if (!EU_SEPA_DESTINATIONS.has(DEST)) return null;

  const candidates = await TransactionConfig.find({
    originCountry:       ORIGIN,
    destinationCountry:  { $in: [DEST, 'EU'] },
    destinationCurrency: 'EUR',
    isActive:            true,
  }).lean();

  const harbor = candidates.find(c => c.payoutMethod === 'owlPay');
  const vita   = candidates.find(c => c.payoutMethod === 'vitaWallet');
  if (!harbor || !vita) return null;   // sin ambos, no hay decisión por monto

  const amountUSD     = await convertOriginToUSD(amountOrigin, harbor.originCurrency);
  const harborMinUSD  = harbor.minAmountUSD ?? HARBOR_MIN_USD;
  const inHarborRange = amountUSD >= harborMinUSD && amountUSD <= HARBOR_MAX_USD;
  const chosen        = inHarborRange ? harbor : vita;   // Harbor mejor FX en rango; Vita fuera

  console.info('[Alyto Router/EU] Selección por monto', {
    origin: ORIGIN,
    dest:   DEST,
    amountUSD:   Math.round(amountUSD),
    harborRange: `${harborMinUSD}-${HARBOR_MAX_USD}`,
    chosen:      chosen.corridorId,
    payout:      chosen.payoutMethod,
  });
  return chosen;
}
