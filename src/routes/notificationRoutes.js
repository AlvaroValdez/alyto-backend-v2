/**
 * notificationRoutes.js — Rutas del centro de notificaciones.
 *
 * Montado en server.js bajo: /api/v1/notifications
 *
 * Endpoints:
 *   GET   /        — Lista paginada de notificaciones del usuario
 *   GET   /unread  — Conteo de notificaciones no leídas (para badge)
 *   PATCH /read    — Marcar como leídas (individual o todas)
 */

import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
} from '../controllers/notificationController.js';

const router = Router();

router.get('/',       protect, getNotifications);
router.get('/unread', protect, getUnreadCount);
router.patch('/read', protect, markAsRead);

export default router;
