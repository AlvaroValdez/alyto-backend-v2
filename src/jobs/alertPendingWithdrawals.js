/**
 * alertPendingWithdrawals.js — Aviso de retiros que llevan demasiado en 'pending'.
 *
 * POR QUÉ EXISTE
 *
 * Un retiro por QR bancario no se completa solo: queda en 'pending' hasta que un
 * administrador transfiere el dinero y lo confirma desde el panel, subiendo el
 * comprobante. Si ese segundo paso no se da, el registro se queda ahí y **nada
 * avisa**.
 *
 * Pasó: WTX-1792430554245-FFJIJV estuvo un día entero en 'pending' con el dinero
 * ya transferido por fuera del sistema. Se descubrió porque el usuario preguntó,
 * no porque el sistema lo dijera.
 *
 * Ya existía red de seguridad para el estado 'dispatched' (dinero ordenado al
 * banco, esperando confirmación), en reconcileBankDisbursements. No había nada
 * para el estado ANTERIOR, que es justo donde hace falta una persona.
 *
 * QUÉ NO HACE
 *
 * No completa, no cancela y no mueve dinero. Solo avisa. Una salida de dinero no
 * se resuelve por inferencia: lo mismo que decide el job hermano.
 *
 * El saldo del usuario sigue reservado mientras tanto, así que un retiro parado
 * no permite gastar dos veces. Lo que se pierde es el tiempo del usuario.
 */

import WalletTransaction from '../models/WalletTransaction.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

/**
 * Horas que puede estar un retiro en 'pending' antes de avisar.
 *
 * 6 h por defecto: el paso que falta es manual y humano, así que el umbral tiene
 * que tolerar una jornada de trabajo sin convertirse en ruido. Más corto avisaría
 * de retiros que alguien está atendiendo ahora mismo.
 */
function horasUmbral() {
  const raw = Number(process.env.WITHDRAWAL_PENDING_ALERT_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

export async function alertPendingWithdrawals() {
  const t0 = Date.now();
  try {
    const limite = new Date(Date.now() - horasUmbral() * 60 * 60 * 1000);

    // `pendingAlertedAt` ausente = todavía no se avisó de este retiro. Una alerta
    // por retiro, no una por corrida: con el job cada 30 min, sin esta condición
    // un solo retiro parado generaría 48 avisos al día y nadie los leería.
    const atascados = await WalletTransaction.find({
      type:      'withdrawal',
      status:    'pending',
      createdAt: { $lt: limite },
      'metadata.pendingAlertedAt': { $exists: false },
    }).limit(50).lean();

    if (atascados.length === 0) {
      return { ok: true, avisados: 0, ms: Date.now() - t0 };
    }

    for (const wtx of atascados) {
      const horas = Math.floor((Date.now() - new Date(wtx.createdAt)) / 3_600_000);

      await notifyAdmins(NOTIFICATIONS.adminWithdrawalPending?.(wtx.amount, wtx.wtxId, horas) ?? {
        title: 'Retiro sin confirmar',
        body:  `El retiro ${wtx.wtxId} (Bs. ${Number(wtx.amount).toFixed(2)}) lleva ${horas} h esperando confirmación. ` +
               `Si ya transferiste el dinero, confírmalo en el panel con el comprobante; el saldo del usuario sigue reservado.`,
        data:  { type: 'admin_withdrawal_pending', wtxId: wtx.wtxId, horas },
      }).catch(() => {});

      await WalletTransaction.updateOne(
        { _id: wtx._id },
        { $set: { 'metadata.pendingAlertedAt': new Date() } },
      ).catch(() => {});

      logger.warn('[RetiroPendiente] Aviso enviado', { wtxId: wtx.wtxId, horas, monto: wtx.amount });
    }

    return { ok: true, avisados: atascados.length, ms: Date.now() - t0 };
  } catch (err) {
    Sentry.captureException(err, { tags: { job: 'alertPendingWithdrawals' } });
    logger.error(`[RetiroPendiente] Error: ${err.message}`);
    return { ok: false, error: err.message, ms: Date.now() - t0 };
  }
}

export default alertPendingWithdrawals;
