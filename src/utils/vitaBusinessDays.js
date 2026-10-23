/**
 * vitaBusinessDays.js — Plazo REAL de liquidación que declara Vita.
 *
 * `business_days_of_payment` viene en la respuesta de precios de Vita, en la misma
 * sección de atributos que `valid_until` y `fixed_cost`:
 *
 *   "Number of business days Vita Wallet Business needs to complete payment on
 *    destination bank account"  (BusinessAPI.txt, sección Currency sections)
 *
 * Hasta ahora se recibía en CADA cotización y se descartaba: el plazo que se le
 * mostraba al usuario salía de un ternario hardcodeado sobre `payinMethod`, que es
 * el método de COBRO y no tiene relación con la velocidad del PAGO.
 *
 * Es función pura y vive aparte del controlador para poder probarse sin levantar
 * toda la cadena de pagos.
 *
 * ⚠️ Por qué NO se persiste por corredor: el dato llega fresco en cada cotización.
 * Cachearlo en `TransactionConfig` solo agregaría un job de sincronización y riesgo
 * de quedar obsoleto. Se lee en vivo y se estampa en la transacción, que es donde
 * importa: el plazo comprometido de ESA operación.
 */

/**
 * Lee los días hábiles declarados por Vita para un destino.
 *
 * Acepta las DOS formas posibles del campo porque no hay una respuesta real de
 * referencia que fije una: por país (como `fixed_cost`) o escalar de la sección
 * (como `valid_until`). Ante la duda no se asume ninguna.
 *
 * @param {object|null|undefined} attrs       `prices.attributes` de la sección
 * @param {string}                countryKey  clave de país que usa Vita ('co', 'causd', …)
 * @returns {number|null}  días hábiles, o null si el dato no viene o no sirve.
 *                         null significa "no sabemos" y el resolver lo marca como
 *                         no verificado. NUNCA se degrada a 0: un 0 diría "pocas
 *                         horas", que es justo la promesa falsa a evitar.
 */
export function extractVitaBusinessDays(attrs, countryKey) {
  if (!attrs) return null;
  const raw = attrs.business_days_of_payment;
  if (raw == null) return null;

  // Objeto = tabla por país. Un array no es una tabla por país válida.
  const v = (typeof raw === 'object')
    ? (Array.isArray(raw) ? undefined : raw[countryKey])
    : raw;

  if (v == null || v === '' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export default { extractVitaBusinessDays };
