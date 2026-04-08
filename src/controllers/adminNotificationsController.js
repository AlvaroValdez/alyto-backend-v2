/**
 * adminNotificationsController.js — Envío manual de push notifications desde admin.
 *
 * POST /api/v1/admin/notifications/send
 * Permite al admin triggerear cualquier tipo de notificación predefinida
 * para un usuario específico, sin necesidad de que ocurra la transacción real.
 */

import User from '../models/User.js';
import { sendPushNotification, NOTIFICATIONS } from '../services/notifications.js';

// ─── Esquema de parámetros por tipo ──────────────────────────────────────────
// Cada entrada define qué campos del `metadata` son necesarios para construir
// la notificación. Se usa para validación y para llamar NOTIFICATIONS[type].

const NOTIFICATION_SCHEMAS = {
  payinConfirmed: {
    required: ['amount', 'currency'],
    build: (m) => NOTIFICATIONS.payinConfirmed(m.amount, m.currency),
  },
  paymentCompleted: {
    required: ['amount', 'currency', 'destinationAmount', 'destinationCurrency'],
    build: (m) => NOTIFICATIONS.paymentCompleted(m.amount, m.currency, m.destinationAmount, m.destinationCurrency),
  },
  paymentFailed: {
    required: ['amount', 'currency'],
    build: (m) => NOTIFICATIONS.paymentFailed(m.amount, m.currency),
  },
  payoutSent: {
    required: ['destinationCountry'],
    build: (m) => NOTIFICATIONS.payoutSent(m.destinationCountry),
  },
};

export const VALID_NOTIFICATION_TYPES = Object.keys(NOTIFICATION_SCHEMAS);

// ─── sendNotification ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/notifications/send
 *
 * Body:
 *   userId           {string}  — ID del usuario destinatario
 *   notificationType {string}  — Uno de: payinConfirmed, paymentCompleted, paymentFailed, payoutSent
 *   metadata         {object}  — Parámetros requeridos según el tipo (ver NOTIFICATION_SCHEMAS)
 *
 * Respuesta: { success: boolean, message: string }
 */
export async function sendNotification(req, res) {
  const { userId, notificationType, metadata = {} } = req.body;

  // ── 1. Validación de campos obligatorios ────────────────────────────────
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ success: false, message: 'userId es requerido.' });
  }

  if (!notificationType || !VALID_NOTIFICATION_TYPES.includes(notificationType)) {
    return res.status(400).json({
      success: false,
      message: `notificationType inválido. Tipos válidos: ${VALID_NOTIFICATION_TYPES.join(', ')}.`,
    });
  }

  const schema = NOTIFICATION_SCHEMAS[notificationType];

  // ── 2. Validar campos requeridos en metadata ─────────────────────────────
  const missing = schema.required.filter((field) => metadata[field] === undefined || metadata[field] === null || metadata[field] === '');
  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Campos faltantes en metadata para ${notificationType}: ${missing.join(', ')}.`,
    });
  }

  // ── 3. Verificar que el usuario existe ───────────────────────────────────
  let user;
  try {
    user = await User.findById(userId.trim()).select('_id email firstName fcmTokens').lean();
  } catch {
    return res.status(400).json({ success: false, message: 'userId con formato inválido.' });
  }

  if (!user) {
    return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
  }

  // ── 4. Construir la notificación con el template ─────────────────────────
  let notification;
  try {
    notification = schema.build(metadata);
  } catch (err) {
    return res.status(400).json({ success: false, message: `Error construyendo notificación: ${err.message}` });
  }

  // ── 5. Loguear el trigger manual ─────────────────────────────────────────
  console.info('[Admin Notifications] Trigger manual.', {
    triggeredBy:      req.user._id.toString(),
    triggeredByEmail: req.user.email,
    targetUserId:     userId.trim(),
    targetEmail:      user.email,
    notificationType,
    metadata,
    timestamp:        new Date().toISOString(),
    hasTokens:        (user.fcmTokens?.length ?? 0) > 0,
  });

  // ── 6. Enviar ─────────────────────────────────────────────────────────────
  try {
    await sendPushNotification(userId.trim(), notification);
  } catch (err) {
    console.error('[Admin Notifications] Error enviando notificación:', err.message);
    return res.status(500).json({ success: false, message: 'Error al enviar la notificación.' });
  }

  return res.json({
    success: true,
    message: `Notificación "${notificationType}" enviada a ${user.email} (${user.fcmTokens?.length ?? 0} dispositivo${(user.fcmTokens?.length ?? 0) !== 1 ? 's' : ''}).`,
  });
}
