/**
 * quoteValidation.js — ¿El monto de destino que declara el cliente es el nuestro?
 *
 * `initCrossBorderPayment` recibe `destinationAmount` en el body y lo persiste
 * tal cual. Eso tiene dos consecuencias: un cliente puede declarar el monto de
 * destino que quiera —y queda en el registro y en el Comprobante Oficial—, y si
 * la cotización del frontend se calculó con un riel distinto del que va a
 * debitar el pay-out, el beneficiario recibe algo que no es lo cotizado.
 *
 * Este módulo compara el monto declarado contra el que recalcula el servidor:
 *
 *   dentro de tolerancia → se honra el del cliente. Es lo que el usuario vio y
 *                          aceptó; sobreescribirlo en silencio sería peor.
 *   fuera de tolerancia  → se rechaza y se pide re-cotizar. No pagamos algo
 *                          distinto de lo prometido ni guardamos un comprobante
 *                          que no cuadra.
 *
 * Es complementario a `checkFxDrift` del dispatch: ese cubre las horas entre el
 * cobro manual y la dispersión; este cubre el instante de crear la transacción.
 */

const DEFAULT_TOLERANCE_PCT = 1;

const round2 = n => Math.round(n * 100) / 100;

/**
 * Tolerancia en puntos porcentuales. Se lee dentro de la función y no en ámbito
 * de módulo (regla 21: el valor de Secrets Manager no existe al importar).
 */
export function quoteDriftTolerancePct() {
  const raw = Number(process.env.QUOTE_DEST_TOLERANCE_PCT);
  return isFinite(raw) && raw > 0 ? raw : DEFAULT_TOLERANCE_PCT;
}

/**
 * @param {object}  p
 * @param {number}  p.quoted            destinationAmount declarado por el cliente
 * @param {number}  p.expected          destinationAmount recalculado por el servidor
 * @param {number} [p.tolerancePct]     override explícito (tests)
 * @returns {{ ok, reason, driftPct, tolerancePct, quoted, expected }}
 *
 * reason:
 *   'no_quote'          — el cliente no declaró monto: nada que validar
 *   'no_reference'      — el servidor no pudo recalcular (Vita caído): fail-open
 *   'invalid_quote'     — el cliente declaró un monto no positivo
 *   'within_tolerance'  — coincide
 *   'drift_exceeded'    — difiere más que la tolerancia
 */
export function validateQuotedDestinationAmount({ quoted, expected, tolerancePct = null }) {
  const tol = tolerancePct ?? quoteDriftTolerancePct();
  const q   = Number(quoted);
  const e   = Number(expected);

  // El cliente no mandó cotización: el dispatch calculará el monto. No es un
  // caso de manipulación, así que no bloquea.
  if (quoted == null) {
    return { ok: true, reason: 'no_quote', driftPct: null, tolerancePct: tol, quoted: null, expected: isFinite(e) ? e : null };
  }

  if (!isFinite(q) || q <= 0) {
    return { ok: false, reason: 'invalid_quote', driftPct: null, tolerancePct: tol, quoted, expected: isFinite(e) ? e : null };
  }

  // Sin referencia propia no podemos afirmar que esté mal. Bloquear acá dejaría
  // todos los envíos caídos cuando Vita no responde, y el monto que realmente
  // se despacha lo recalcula el dispatch: la exposición es el registro, no el
  // dinero. Fail-open DELIBERADO — el caller debe loguearlo.
  if (!isFinite(e) || e <= 0) {
    return { ok: true, reason: 'no_reference', driftPct: null, tolerancePct: tol, quoted: q, expected: null };
  }

  const driftPct = ((q - e) / e) * 100;
  const ok       = Math.abs(driftPct) <= tol;

  return {
    ok,
    reason:       ok ? 'within_tolerance' : 'drift_exceeded',
    driftPct:     round2(driftPct),
    tolerancePct: tol,
    quoted:       q,
    expected:     round2(e),
  };
}

export default { validateQuotedDestinationAmount, quoteDriftTolerancePct };
