/**
 * auditWalletReserves.js — Vigila el saldo reservado de las billeteras BOB.
 *
 * POR QUÉ EXISTE
 *
 * El mecanismo para liberar una reserva está completo desde hace tiempo: hay
 * confirmar y rechazar para retiros y para las dos direcciones de conversión,
 * con guard atómico, auditoría y aviso al usuario. **Lo que no había era quién
 * mirara.**
 *
 * Encontrado el 2026-10-21 revisando producción:
 *
 *   3 conversiones BOB→USDC en 'pending' desde el 2026-08-20, reteniendo 150 Bs
 *   de un usuario durante 62 días. Su saldo USDC seguía en 0: nunca se entregó
 *   nada, y nadie se enteró.
 *
 * Un retiro parado se nota porque el usuario reclama su dinero. Una conversión
 * parada no: el usuario ve el saldo "reservado" y supone que está en proceso.
 *
 * DOS COMPROBACIONES
 *
 * 1. Operaciones vivas que llevan demasiado tiempo paradas.
 * 2. Que `balanceReserved` CUADRE con la suma de esas operaciones. Si no cuadra,
 *    hay una reserva fantasma (dinero del usuario bloqueado sin motivo) o una
 *    reserva perdida (el usuario puede gastar lo que ya está comprometido).
 *
 * NO RESUELVE NADA. Avisa. Confirmar o rechazar exige saber si el dinero se
 * entregó, y eso solo lo sabe una persona mirando el banco o la cadena. Las dos
 * decisiones son opuestas y equivocarse cuesta dinero en ambos sentidos.
 */

import WalletTransaction from '../models/WalletTransaction.js';
import WalletBOB from '../models/WalletBOB.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

/**
 * Estados y tipos que RETIENEN reserva: el dinero está comprometido pero todavía
 * no salió. Esta lista es la definición de "cuánto debería estar reservado"; si
 * se añade un tipo que reserve y no se añade aquí, la comprobación de cuadre
 * empezará a dar falsos positivos.
 */
export const RETIENEN_RESERVA = [
  { type: 'withdrawal',  status: ['pending', 'dispatched'] },
  { type: 'bob_to_usdc', status: ['pending'] },
];

/** Días que puede llevar parada una operación antes de avisar. */
function diasUmbral() {
  const raw = Number(process.env.WALLET_STUCK_ALERT_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

/** Filtro de Mongo que describe todas las operaciones que retienen reserva. */
function filtroVivas() {
  return { $or: RETIENEN_RESERVA.map(r => ({ type: r.type, status: { $in: r.status } })) };
}

export async function auditWalletReserves() {
  const t0 = Date.now();
  try {
    const limite = new Date(Date.now() - diasUmbral() * 24 * 60 * 60 * 1000);

    // ── 1. Operaciones paradas ───────────────────────────────────────────────
    // Los retiros los cubre alertPendingWithdrawals con su propio umbral en
    // horas, porque ahí el dinero ya puede haber salido del banco. Aquí se
    // vigila lo demás, que es lo que nadie miraba.
    const paradas = await WalletTransaction.find({
      type:      'bob_to_usdc',
      status:    'pending',
      createdAt: { $lt: limite },
      'metadata.stuckAlertedAt': { $exists: false },
    }).limit(50).lean();

    for (const wtx of paradas) {
      const dias = Math.floor((Date.now() - new Date(wtx.createdAt)) / 86_400_000);
      await notifyAdmins(NOTIFICATIONS.adminWalletOpStuck?.(wtx.amount, wtx.wtxId, dias) ?? {
        title: 'Conversión detenida',
        body:  `La conversión ${wtx.wtxId} (Bs. ${Number(wtx.amount).toFixed(2)}) lleva ${dias} días en pendiente ` +
               `y mantiene ese saldo reservado al usuario. Confírmala o recházala: rechazar le devuelve el saldo.`,
        data:  { type: 'admin_wallet_op_stuck', wtxId: wtx.wtxId, dias },
      }).catch(() => {});

      await WalletTransaction.updateOne(
        { _id: wtx._id },
        { $set: { 'metadata.stuckAlertedAt': new Date() } },
      ).catch(() => {});

      logger.warn('[ReservaAudit] Conversión detenida', { wtxId: wtx.wtxId, dias, monto: wtx.amount });
    }

    // ── 2. Cuadre de la reserva ──────────────────────────────────────────────
    const comprometido = await WalletTransaction.aggregate([
      { $match: filtroVivas() },
      { $group: { _id: '$walletId', total: { $sum: '$amount' } } },
    ]);
    const esperadoPor = new Map(comprometido.map(x => [String(x._id), x.total]));

    const wallets = await WalletBOB.find({}).select('_id balanceReserved').lean();
    const descuadradas = [];
    for (const w of wallets) {
      const esperado = esperadoPor.get(String(w._id)) ?? 0;
      const real     = w.balanceReserved ?? 0;
      if (real !== esperado) descuadradas.push({ walletId: String(w._id), real, esperado });
    }

    if (descuadradas.length > 0) {
      logger.error('[ReservaAudit] Reservas descuadradas', { total: descuadradas.length, detalle: descuadradas });
      await notifyAdmins(NOTIFICATIONS.adminReserveMismatch?.(descuadradas.length) ?? {
        title: 'Reservas descuadradas',
        body:  `${descuadradas.length} billetera(s) tienen un saldo reservado que no corresponde a ninguna operación viva. ` +
               `Puede ser saldo bloqueado al usuario sin motivo, o saldo comprometido que el usuario puede gastar.`,
        data:  { type: 'admin_reserve_mismatch', total: descuadradas.length },
      }).catch(() => {});
    }

    const stats = {
      ok: true,
      paradasAvisadas: paradas.length,
      descuadradas:    descuadradas.length,
      ms: Date.now() - t0,
    };
    logger.info('[ReservaAudit] Revisión completada', stats);
    return stats;
  } catch (err) {
    Sentry.captureException(err, { tags: { job: 'auditWalletReserves' } });
    logger.error(`[ReservaAudit] Error: ${err.message}`);
    return { ok: false, error: err.message, ms: Date.now() - t0 };
  }
}

export default auditWalletReserves;
