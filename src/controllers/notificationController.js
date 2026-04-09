/**
 * notificationController.js — CRUD de notificaciones para el usuario.
 *
 * Endpoints:
 *  GET  /             → Lista paginada de notificaciones
 *  GET  /unread       → Conteo de no leídas (para badge)
 *  PATCH /read        → Marcar como leídas (individual o bulk)
 */

import Notification from '../models/Notification.js';

// ─── getNotifications ──────────────────────────────────────────��─────────────

export async function getNotifications(req, res) {
  try {
    const userId = req.user._id;
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip   = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      Notification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId }),
    ]);

    return res.json({
      notifications,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Notifications] Error fetching:', err.message);
    return res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
}

// ─── getUnreadCount ──────────────────────────────────────────────────────────

export async function getUnreadCount(req, res) {
  try {
    const unreadCount = await Notification.countDocuments({
      userId: req.user._id,
      read:   false,
    });
    return res.json({ unreadCount });
  } catch (err) {
    console.error('[Notifications] Error counting unread:', err.message);
    return res.status(500).json({ error: 'Error al contar notificaciones' });
  }
}

// ─── markAsRead ──────────────────────────────────────────────────────────────

export async function markAsRead(req, res) {
  try {
    const userId          = req.user._id;
    const { notificationIds } = req.body ?? {};
    const now             = new Date();

    let filter;
    if (Array.isArray(notificationIds) && notificationIds.length > 0) {
      // Marcar IDs específicos
      filter = { _id: { $in: notificationIds }, userId, read: false };
    } else {
      // Marcar todas las no leídas del usuario
      filter = { userId, read: false };
    }

    const result = await Notification.updateMany(filter, {
      $set: { read: true, readAt: now },
    });

    return res.json({ modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error('[Notifications] Error marking as read:', err.message);
    return res.status(500).json({ error: 'Error al marcar notificaciones' });
  }
}
