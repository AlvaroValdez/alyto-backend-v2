/**
 * fintocFees.js — Cálculo dinámico de fees de Fintoc basado en UF
 *
 * Fintoc cobra un fee FIJO por transacción expresado en UF (Unidad de Fomento).
 * La UF es una unidad económica chilena indexada a inflación (~38.000 CLP en 2026).
 * El tier se determina por volumen mensual de transacciones.
 *
 * Ejemplo tier 1, UF = 38.000:
 *   0.0135 UF × 38.000 = 513 CLP fijo por transacción
 *   → para 100.000 CLP = 0.51% efectivo
 *   → para 30.000 CLP  = 1.71% efectivo
 */

/**
 * Tasas de Fintoc por tier (en UF por transacción).
 * Fuente: contrato Fintoc / schedule de precios.
 */
export const FINTOC_TIER_RATES = {
  1: 0.0135, // 0–5.000 txns/mes
  2: 0.0115, // 5.000–25.000 txns/mes
  3: 0.0105, // 25.000–50.000 txns/mes
  4: 0.0097, // 50.000–100.000 txns/mes
  5: 0.0090, // 100.000+ txns/mes
};

/**
 * Calcula el fee de Fintoc para una transacción.
 *
 * @param {number} transactionAmount - Monto en CLP
 * @param {object} fintocConfig - { ufValue, tier } desde TransactionConfig
 * @returns {{ fixedFee: number, percentage: number, tierRate: number, ufValue: number, tier: number }}
 */
export function calculateFintocFee(transactionAmount, fintocConfig = {}) {
  const ufValue  = fintocConfig?.ufValue || 38000;
  const tier     = fintocConfig?.tier    || 1;
  const tierRate = FINTOC_TIER_RATES[tier] || FINTOC_TIER_RATES[1];

  // Fee fijo en CLP = tasa UF × valor UF
  const fixedFee = Math.round(tierRate * ufValue);

  // Porcentaje efectivo para este monto específico
  const percentage = transactionAmount > 0
    ? (fixedFee / transactionAmount) * 100
    : 0;

  return { fixedFee, percentage, tierRate, ufValue, tier };
}

/**
 * Porcentaje efectivo de Fintoc para un monto promedio (estimación conservadora).
 *
 * @param {object} fintocConfig - Config desde TransactionConfig
 * @param {number} [avgAmount=50000] - Monto promedio de referencia
 * @returns {number} Porcentaje efectivo
 */
export function getFintocFeePercent(fintocConfig, avgAmount = 50000) {
  const { percentage } = calculateFintocFee(avgAmount, fintocConfig);
  return percentage;
}
