/**
 * currencyDisplay.js — Cómo se escribe un importe de cara al usuario.
 *
 * Nace de una incoherencia real en el cotizador (2026-10-04): el mínimo de un
 * corredor se anunciaba en USD en un recuadro ("Mínimo requerido: USD 20,07") y en
 * BOB en el mensaje de error de al lado ("el monto mínimo es 241 BOB"), con dos
 * números que además no coincidían. A un usuario boliviano, que paga en bolivianos,
 * verle un precio en dólares le obliga a hacer una conversión mental para saber si
 * puede o no operar, y en un producto financiero eso no es un detalle estético.
 *
 * Regla: **el dinero del usuario se expresa en SU moneda**, con el símbolo local y
 * sin el código ISO al lado. "Bs 246", no "USD 20,07", no "Bs246 BOB". El código ISO
 * se reserva para el importe de DESTINO, donde sí aporta ("17.673 CLP"), porque ahí
 * el usuario necesita saber en qué moneda cobra el beneficiario.
 */

/** Símbolo local por moneda de origen. Sin entrada → se usa el propio código. */
const SIMBOLOS = {
  BOB: 'Bs',
  CLP: '$',
  USD: 'US$',
};

/** Monedas que no se escriben con decimales. */
const SIN_DECIMALES = new Set(['CLP', 'JPY', 'KRW', 'VND', 'PYG', 'COP', 'IDR']);

/**
 * Formatea un importe en la moneda de origen del usuario.
 *
 * @param {number} amount
 * @param {string} currency  código ISO (BOB, CLP, USD…)
 * @returns {string} ej. "Bs 246,00" · "$ 12.500" · "US$ 20,07"
 */
export function formatOriginAmount(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n)) return '—';

  const decimales = SIN_DECIMALES.has(currency) ? 0 : 2;
  const numero    = n.toLocaleString('es-BO', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });

  const simbolo = SIMBOLOS[currency];
  // Sin símbolo conocido se cae al código ISO: preferible a inventar uno.
  return simbolo ? `${simbolo} ${numero}` : `${numero} ${currency}`;
}

export default { formatOriginAmount };
