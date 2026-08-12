/**
 * euAmountRouter.js — Resolución de proveedor para destinos EU/SEPA.
 *
 * DECISIÓN 2026-08-12 — **EU va SIEMPRE por Vita** (rail vita_sent, ver
 * VITA_SENT_ONLY_COUNTRIES). Ya no se elige proveedor por monto.
 *
 * Por qué (medido en vivo contra Vita prod + Harbor, 18.24 USDC / 236 BOB):
 *   - Vita vita_sent['es'] : tasa 0.8676, fija 0     → 15.83 EUR   ← mejor en TODO el rango
 *   - Harbor SEPA          : tasa 0.8650, fee ~0.3%  → 15.4x EUR   (DESHABILITADO: bug SWIFT_CODE)
 *   - Harbor WIRE          : tasa 0.8650, fija ~17.5 → 9.36 EUR    (único rail Harbor operativo hoy)
 *   - Vita withdrawal['eu']: tasa 0.8524, fija 5 EUR → 10.55 EUR   (rail anterior, peor)
 * Además Harbor RECHAZA montos < 31 USD ("source.amount must be between 31 and 9998"),
 * dejando fuera el ticket retail típico de Bolivia.
 *
 * La regla vive en CÓDIGO (no en un toggle de admin) para que no dependa de que
 * alguien desactive el corredor Harbor: mientras exista un corredor Vita EUR para
 * el origen, ese gana. Si NO hay Vita (ej. us-eu, cl-eu que son Harbor-only), se
 * devuelve null y el lookup normal resuelve como siempre.
 *
 * Compartido por el quote REST (paymentController) y el WebSocket (quoteSocket)
 * para garantizar la MISMA decisión en ambos paths. Documentado en CLAUDE.md §12.
 */

import TransactionConfig from '../models/TransactionConfig.js';

export const EU_SEPA_DESTINATIONS = new Set([
  'ES', 'EU', 'DE', 'FR', 'IT', 'NL', 'PT', 'IE', 'AT', 'BE',
  'GR', 'FI', 'LU', 'SK', 'SI', 'EE', 'LV', 'LT', 'CY', 'MT', 'PL',
]);

// Límites reales de Harbor confirmados contra la API: source.amount ∈ [31, 9998] USD.
// Ya NO se usan para elegir proveedor en EU (Vita siempre gana); siguen vigentes como
// guard de ejecución en dispatchPayout para los corredores que SÍ usan Harbor.
export const HARBOR_MIN_USD = Number(process.env.HARBOR_MIN_USD ?? 31);
export const HARBOR_MAX_USD = Number(process.env.HARBOR_MAX_USD ?? 9998);

/**
 * ¿El destino es EU/SEPA (elegible para la regla "EU → Vita")?
 * @param {string} dest - ISO alpha-2 destino (o 'EU')
 * @returns {boolean}
 */
export function isEuSepaDestination(dest) {
  return EU_SEPA_DESTINATIONS.has((dest ?? '').toUpperCase());
}

/**
 * Resuelve el corredor EU: Vita si existe para ese origen, si no null.
 *
 * @param {string} origin - ISO alpha-2 origen (ej. 'BO')
 * @param {string} dest   - ISO alpha-2 destino (ej. 'ES', 'EU')
 * @returns {Promise<object|null>} corredor Vita (lean) o null si el destino no es
 *   EU/SEPA o no hay corredor Vita EUR para ese origen (→ lookup normal).
 */
export async function resolveEuCorridor(origin, dest) {
  const ORIGIN = (origin ?? '').toUpperCase();
  const DEST   = (dest ?? '').toUpperCase();
  if (!EU_SEPA_DESTINATIONS.has(DEST)) return null;

  const vita = await TransactionConfig.findOne({
    originCountry:       ORIGIN,
    destinationCountry:  { $in: [DEST, 'EU'] },
    destinationCurrency: 'EUR',
    payoutMethod:        'vitaWallet',
    isActive:            true,
  }).lean();

  if (!vita) return null;   // sin corredor Vita (ej. us-eu/cl-eu) → lookup normal (Harbor)

  console.info('[Alyto Router/EU] EU → Vita (regla fija, sin ruteo por monto)', {
    origin: ORIGIN, dest: DEST, chosen: vita.corridorId,
  });
  return vita;
}
