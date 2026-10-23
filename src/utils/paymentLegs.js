/**
 * paymentLegs.js — Mantenimiento del desglose por etapa de una transacción.
 *
 * `Transaction.paymentLegs` nace con la etapa de payin en 'pending' y nadie la
 * cerraba nunca: en una operación real completada, el registro seguía diciendo
 * que el cobro estaba pendiente. Y la etapa de payout sólo la empujaba el
 * corredor manual de Bolivia (`payoutController`), así que en los rieles Vita y
 * Harbor `providersUsed` listaba `payout:vitaWallet` mientras `paymentLegs` no
 * tenía ninguna entrada de payout. El desglose quedaba a medias y contradecía a
 * los otros dos registros de la misma transacción.
 *
 * Detectado al revisar la operación ALY-C-1791276352443-HD5WWD (2026-10-06):
 * cobro BANECO confirmado por IPN y payout aceptado por Vita, con la etapa de
 * payin en 'pending' y sin etapa de payout.
 *
 * No reemplaza nada: `statusHistory` (sucesión de estados) e `ipnLog` (avisos de
 * proveedor) siguen siendo las fuentes autoritativas. Esto es el resumen por
 * etapa que el panel y el detalle de la transacción muestran, y tiene que decir
 * lo mismo que las otras dos.
 *
 * ⚠️ Estas funciones MUTAN el documento en memoria y NO guardan: el llamador ya
 * está haciendo `save()` por sus propios cambios y se agrega a esa escritura.
 * Así no se duplican guardados ni se pisan versiones.
 */

/**
 * Cierra la etapa de payin: 'pending' → 'completed' + completedAt.
 *
 * Idempotente: si ya estaba cerrada no la toca (un IPN repetido del banco no
 * debe reescribir la fecha del cobro). Si no hay etapa de payin —transacciones
 * viejas o creadas por otro camino— la crea, para que el desglose no mienta por
 * omisión.
 *
 * @param {object} transaction documento Mongoose de Transaction
 * @param {object} [opts]
 * @param {string} [opts.provider]   proveedor del payin, si hay que crear la etapa
 * @param {string} [opts.externalId] referencia externa del cobro
 * @param {Date}   [opts.completedAt] fecha real del cobro (la del banco, no `now`)
 */
export function completePayinLeg(transaction, { provider = null, externalId = null, completedAt = null } = {}) {
  if (!transaction) return;
  if (!Array.isArray(transaction.paymentLegs)) transaction.paymentLegs = [];

  const cuando = completedAt ?? new Date();
  const leg    = transaction.paymentLegs.find(l => l.stage === 'payin');

  if (!leg) {
    transaction.paymentLegs.push({
      stage:       'payin',
      ...(provider ? { provider } : {}),
      status:      'completed',
      ...(externalId ? { externalId: String(externalId) } : {}),
      completedAt: cuando,
    });
    return;
  }

  if (leg.status === 'completed') return;      // idempotencia

  leg.status      = 'completed';
  leg.completedAt = cuando;
  if (externalId && !leg.externalId) leg.externalId = String(externalId);
}

/**
 * Registra la etapa de payout. `status` por defecto 'processing': el payout fue
 * aceptado por el proveedor pero el dinero todavía no está acreditado — se cierra
 * en 'completed' cuando llega el aviso de liquidación.
 *
 * Idempotente por (stage, provider): un reintento de despacho actualiza la
 * entrada existente en vez de apilar duplicados.
 *
 * @param {object} transaction
 * @param {object} p
 * @param {string} p.provider          'vitaWallet' | 'owlPay' | 'anchorBolivia' | …
 * @param {string} [p.status]          'processing' | 'completed' | 'failed'
 * @param {string} [p.externalId]      referencia del payout en el proveedor
 * @param {Date}   [p.completedAt]     sólo si status es terminal
 */
export function recordPayoutLeg(transaction, { provider, status = 'processing', externalId = null, completedAt = null } = {}) {
  if (!transaction || !provider) return;
  if (!Array.isArray(transaction.paymentLegs)) transaction.paymentLegs = [];

  const existente = transaction.paymentLegs.find(l => l.stage === 'payout' && l.provider === provider);
  const datos = {
    status,
    ...(externalId ? { externalId: String(externalId) } : {}),
    ...(completedAt ? { completedAt } : {}),
  };

  if (existente) {
    Object.assign(existente, datos);
    return;
  }

  transaction.paymentLegs.push({ stage: 'payout', provider, ...datos });
}

export default { completePayinLeg, recordPayoutLeg };
