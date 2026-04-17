/**
 * Notification.js — Modelo de notificaciones persistentes.
 *
 * Almacena todas las notificaciones enviadas a cada usuario para
 * alimentar el centro de notificaciones (historial, badge, mark-as-read).
 *
 * TTL configurable vía NOTIFICATION_TTL_DAYS (default 1825 = 5 años) —
 * ver nota de compliance sobre el índice TTL al final del archivo.
 */

import mongoose from 'mongoose';

// COMPLIANCE: ASFI Circular 2/2022 (Bolivia) y UAF Chile exigen conservar
// registros transaccionales por mínimo 5 años (1825 días). NO reducir este
// valor sin revisión legal previa.
const NOTIFICATION_TTL_SECONDS =
  parseInt(process.env.NOTIFICATION_TTL_DAYS ?? '1825', 10) * 86400;

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },

    type: {
      type:     String,
      required: true,
      enum: [
        // ── User-facing ──
        'payin_confirmed',
        'payment_completed',
        'payment_failed',
        'payout_sent',
        'deposit_confirmed',
        'withdrawal_requested',
        'wallet_frozen',
        'wallet_unfrozen',
        'p2p_received',
        'conversion_confirmed',
        'conversion_rejected',
        'qr_payment',
        'kyc',
        'system',
        'general',
        'transfer_initiated',
        // ── Admin-facing ──
        'admin_new_user',
        'admin_new_transaction',
        'admin_deposit_request',
        'admin_withdrawal_request',
        'admin_conversion_request',
        'admin_kyb_submitted',
        'admin_payment_proof',
        'admin_p2p_transfer',
      ],
    },

    title: { type: String, required: true },
    body:  { type: String, required: true },
    data:  { type: mongoose.Schema.Types.Mixed, default: {} },

    read:   { type: Boolean, default: false },
    readAt: { type: Date,    default: null  },
  },
  { timestamps: true },
);

// Consulta principal: notificaciones del usuario, no leídas primero, más recientes primero
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

// TTL — cumplimiento ASFI/UAF (5 años por defecto, configurable vía env).
// ⚠️ Los cambios al TTL no se aplican retroactivamente a documentos existentes.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
);

export default mongoose.model('Notification', notificationSchema);
