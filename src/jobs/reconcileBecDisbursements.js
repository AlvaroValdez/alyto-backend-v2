/**
 * reconcileBecDisbursements.js
 *
 * Red de seguridad de la dispersión bancaria. El camino feliz es el webhook de
 * confirmación del proveedor (→ `settleDispatchedWithdrawal`). Este job cubre el
 * webhook perdido: un retiro queda en 'dispatched' —dinero ya ordenado al banco,
 * saldo del usuario todavía reservado— y la confirmación nunca llega.
 *
 * ⚠️ El nombre del archivo dice BEC por historia. Hoy el job es agnóstico y
 * atiende a cualquier proveedor de dispersión. Se mantiene el nombre porque el
 * export está cableado en `app.js`, en `jobRegistry.js` y en una regla de
 * EventBridge; renombrarlo es una tarea aparte con coordinación de despliegue.
 * `reconcileBankDisbursements` es el nombre correcto y ya está disponible.
 *
 * ── Dos comportamientos, según lo que el proveedor sepa responder
 *
 * **Si el adapter expone `getBatchStatus`** (Red Enlace), se le pregunta al banco
 * y el retiro se resuelve con su respuesta: acreditado o rechazado. No es
 * inferencia, es la palabra del banco por el canal saliente autenticado, igual
 * que hace el barrido del cobro por QR con `getQRStatus`.
 *
 * **Si no lo expone** (BANECO, que no documenta consulta de estado de planilla),
 * se alerta al admin y nada más. Nunca se completa una salida de dinero por
 * suposición.
 *
 * ── Qué NO se resuelve solo
 *
 * Los estados intermedios (en proceso, enviado, pendiente de confirmación) se
 * dejan correr: todavía no hay nada que decidir. Y `REVERTIDO` —un retiro ya
 * pagado que volvió— siempre va a un humano: el saldo del usuario ya se debitó
 * y reacreditarlo automáticamente es una decisión de producto que no está tomada.
 *
 * Frecuencia recomendada: cada 30 min. Primera corrida 5 min post-start.
 */

import WalletTransaction from '../models/WalletTransaction.js';
import ProviderReference from '../models/ProviderReference.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

// Tras cuánto tiempo en 'dispatched' sin confirmar lo consideramos atascado.
const STUCK_MS  = Number(process.env.BANK_DISBURSEMENT_STUCK_MIN ?? 60) * 60 * 1000;
const SWEEP_LIMIT = 50;

let _isRunning = false;

/**
 * Intenta resolver un retiro atascado preguntándole al proveedor.
 *
 * @returns {Promise<{resuelto:boolean, detalle:string}>}
 *   `resuelto:false` significa "sigue atascado, alertá al admin".
 */
async function intentarResolver(wtx) {
  const provider = wtx.metadata?.disbursementProvider;
  if (!provider) return { resuelto: false, detalle: 'sin proveedor registrado' };

  const { getDisbursementAdapter } = await import('../services/bank/bankRegistry.js');
  const disbursement = getDisbursementAdapter(provider)?.disbursement;

  if (typeof disbursement?.getBatchStatus !== 'function') {
    return { resuelto: false, detalle: `${provider} no permite consultar estado` };
  }

  // El `processId` se guardó al autorizar el lote: sin él no hay consulta posible.
  const alias = await ProviderReference.findOne({
    provider, kind: 'payout', targetId: wtx.wtxId,
  });
  if (!alias?.meta?.processId) {
    return { resuelto: false, detalle: 'sin processId guardado' };
  }

  let estado;
  try {
    estado = await disbursement.getBatchStatus({
      processId:     alias.meta.processId,
      transaccionId: alias.reference,
    });
  } catch (err) {
    // Un proveedor caído no es motivo para alertar como si el retiro estuviera
    // perdido: se reintenta en la próxima corrida.
    logger.warn('[ReconcileDisbursement] Consulta de estado falló — se reintenta', {
      wtxId: wtx.wtxId, provider, error: err.message,
    });
    return { resuelto: true, detalle: 'consulta fallida, se reintenta' };
  }

  if (!estado) return { resuelto: false, detalle: 'el proveedor no devolvió la transacción' };

  const outcome = disbursement.mapNotifyStatus(estado.estado);

  if (outcome === 'unknown') {
    // Estado intermedio → todavía no hay nada que hacer, y no es un problema.
    // REVERTIDO también cae acá, y ese SÍ necesita a una persona.
    const esReversa = String(estado.estado).toUpperCase() === 'REVERTIDO';
    if (!esReversa) {
      logger.info('[ReconcileDisbursement] En curso en el banco — se espera', {
        wtxId: wtx.wtxId, estado: estado.estado,
      });
      return { resuelto: true, detalle: `en curso (${estado.estado})` };
    }
    return { resuelto: false, detalle: `REVERTIDO: el banco devolvió el pago (${estado.mensaje ?? ''})` };
  }

  // Ante el banco un retiro y una devolución son el mismo débito; cómo se
  // cierran no. El settle del retiro debita la billetera, y aplicado a una
  // devolución le cobraría al usuario el dinero que se le devuelve.
  const settle = wtx.type === 'refund'
    ? (await import('../services/refundService.js')).settleDispatchedRefund
    : (await import('../controllers/walletController.js')).settleDispatchedWithdrawal;

  const r = await settle(wtx.wtxId, {
    accepted:      outcome === 'accepted',
    bankReference: estado.numeroAch,
    reason:        estado.mensaje,
  });

  // Ninguno de los dos settle LANZA ante un fallo: devuelven `{ok:false}`. Dar
  // por resuelto sin mirarlo dejaría la operación colgada, sin reintento y sin
  // alerta, que es la peor combinación posible cuando el dinero ya salió.
  if (!r.ok) {
    return { resuelto: false, detalle: `el banco dijo ${estado.estado} pero la liquidación falló: ${r.reason}` };
  }

  logger.info('[ReconcileDisbursement] Resuelto por consulta al banco', {
    wtxId: wtx.wtxId, tipo: wtx.type, provider, estado: estado.estado, outcome, resultado: r.status ?? r.reason,
  });

  return { resuelto: true, detalle: `${estado.estado} → ${outcome}` };
}

export async function reconcileBankDisbursements() {
  if (_isRunning) {
    logger.warn('[ReconcileDisbursement] Corrida previa aún en curso — omitiendo');
    return;
  }
  _isRunning = true;

  try {
    const cutoff = new Date(Date.now() - STUCK_MS);

    // Salidas enviadas al banco hace más de STUCK_MS, aún sin confirmar, no alertadas.
    //
    // Incluye devoluciones por transferencia, y no por simetría: el webhook de
    // dispersión de ATC sigue en revisión en certificación, y el de payout de
    // Vita nunca se disparó en producción. Sin esta red una devolución ordenada
    // se quedaría en 'dispatched' para siempre, con el pasivo correctamente
    // reconocido y nadie mirándolo.
    const stuck = await WalletTransaction.find({
      type:      { $in: ['withdrawal', 'refund'] },
      status:    'dispatched',
      'metadata.dispatchedAt':          { $lte: cutoff },
      'metadata.disbursementAlertedAt': { $exists: false },
    }).sort({ createdAt: 1 }).limit(SWEEP_LIMIT);

    if (stuck.length === 0) {
      logger.info('[ReconcileDisbursement] Sin retiros dispersados atascados');
      return;
    }

    logger.warn(`[ReconcileDisbursement] ${stuck.length} salida(s) dispersada(s) sin confirmación`);

    for (const wtx of stuck) {
      let resultado;
      try {
        resultado = await intentarResolver(wtx);
      } catch (err) {
        Sentry.captureException(err, { tags: { job: 'reconcileBankDisbursements' }, extra: { wtxId: wtx.wtxId } });
        resultado = { resuelto: false, detalle: `error resolviendo: ${err.message}` };
      }

      if (resultado.resuelto) continue;   // resuelto o en curso: no se molesta a nadie

      const provider = wtx.metadata?.disbursementProvider ?? 'desconocido';
      // Al admin le cambia qué hacer: un retiro atascado deja saldo reservado
      // al usuario; una devolución atascada deja un pasivo sin restituir.
      const etiqueta = wtx.type === 'refund' ? 'La devolución' : 'El retiro';

      Sentry.captureMessage('Dispersión atascada sin confirmación', {
        level: 'warning',
        extra: {
          wtxId:        wtx.wtxId,
          tipo:         wtx.type,
          amount:       wtx.amount,
          provider,
          refundFor:    wtx.metadata?.refundFor,
          motivo:       resultado.detalle,
          bankBatchId:  wtx.metadata?.bankBatchId,
          dispatchedAt: wtx.metadata?.dispatchedAt,
        },
      });

      await notifyAdmins(NOTIFICATIONS.adminDisbursementStuck?.(wtx.amount, wtx.wtxId) ?? {
        title: 'Dispersión sin confirmar',
        body:  `${etiqueta} ${wtx.wtxId} (Bs. ${Number(wtx.amount).toFixed(2)}) fue enviada a ${provider} pero no llegó la confirmación. ${resultado.detalle}. Verificar en el banco y liquidar.`,
        data:  { type: 'admin_disbursement_stuck', wtxId: wtx.wtxId, provider, kind: wtx.type },
      }).catch(() => {});

      // Marcar alertado para no spamear en cada corrida (una alerta por retiro).
      await WalletTransaction.updateOne(
        { _id: wtx._id },
        { $set: { 'metadata.disbursementAlertedAt': new Date(), 'metadata.disbursementStuckReason': resultado.detalle } },
      ).catch(() => {});
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { job: 'reconcileBankDisbursements' } });
    logger.error(`[ReconcileDisbursement] Error: ${err.message}`);
  } finally {
    _isRunning = false;
  }
}

/** Alias histórico — es el nombre cableado en app.js, jobRegistry.js y EventBridge. */
export const reconcileBecDisbursements = reconcileBankDisbursements;

export default reconcileBankDisbursements;
