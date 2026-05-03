/**
 * rateDisplay.js — Helper para calcular el rate user-facing de una transacción.
 *
 * Fuente única de verdad para displays de tasa en emails, comprobantes y UI.
 * Reemplaza la lectura directa de Transaction.exchangeRate (deprecado, semántica
 * inconsistente entre corredores).
 *
 * Ventajas vs leer un campo guardado:
 *   - Independiente de la dirección semántica de Transaction.exchangeRate
 *     (que en cl-bo guarda CLP/BOB invertido, en bo-* guarda destCurrency/BOB)
 *   - Funciona para todos los corredores sin migración de datos
 *   - Refleja la tasa efectiva real (incluye fees aplicados)
 *
 * Convención de dirección: SIEMPRE devuelve destinationCurrency por unidad de
 * originCurrency. Si necesitás "1 dest = X origin" para display invertido,
 * computar 1/getDisplayRate(tx).
 */

/**
 * @param {{ originalAmount?: number, originAmount?: number, destinationAmount?: number }} transaction
 * @returns {number} rate dest/origin, o 0 si no se puede calcular
 */
export function getDisplayRate(transaction) {
  const origin = transaction?.originalAmount ?? transaction?.originAmount;
  const dest   = transaction?.destinationAmount;
  if (!origin || origin === 0 || !dest) return 0;
  return dest / origin;
}
