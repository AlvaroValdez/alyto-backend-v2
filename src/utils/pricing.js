/**
 * Helpers de pricing — fuente única de verdad para el cálculo de fees por tier.
 *
 * Mantener todo cálculo de spread business/retail aquí evita drift entre el
 * controlador de quote, el de payin y el de payout (cada uno cobraba diferente).
 */

/**
 * Devuelve el spread efectivo (porcentaje) aplicable a una transacción
 * según el tier del usuario.
 *
 *   - Cuenta business + corredor con businessAlytoCSpread configurado
 *     → tarifa business (descuento).
 *   - Cualquier otro caso → tarifa retail (alytoCSpread) o 0 si no está
 *     configurado.
 *
 * @param {{ alytoCSpread?: number, businessAlytoCSpread?: number }} corridor
 * @param {{ accountType?: string }} [user]
 * @returns {number} Porcentaje de spread (0–100), no decimal — ej. 0.5 = 0.5%.
 */
export function getEffectiveSpreadPct(corridor, user) {
  return (user?.accountType === 'business' && corridor?.businessAlytoCSpread != null)
    ? corridor.businessAlytoCSpread
    : (corridor?.alytoCSpread ?? 0);
}
