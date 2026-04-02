/**
 * userRoutes.js — Rutas de usuario
 *
 * Base: /api/v1/user
 *
 *   GET    /profile         — Obtener perfil propio
 *   PATCH  /profile         — Actualizar campos permitidos del perfil
 *   POST   /change-password — Cambiar contraseña
 *   DELETE /fcm-token       — Desvincular token FCM de un dispositivo
 *   GET    /sessions        — Sesiones activas (info básica)
 *   POST   /kyc             — Subir documentos KYC
 */

import { Router } from 'express';
import multer     from 'multer';
import { protect } from '../middlewares/authMiddleware.js';
import {
  getProfile,
  updateProfile,
  changePassword,
  deleteFcmToken,
  getSessions,
  processKyc,
  uploadAvatar,
} from '../controllers/userController.js';

const router = Router();

// ─── Multer — solo para KYC (memoria; reemplazar por multer-s3 en producción) ─

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },   // 10 MB por archivo
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
  },
});

const kycUpload = upload.fields([
  { name: 'documentFront', maxCount: 1 },
  { name: 'documentBack',  maxCount: 1 },
  { name: 'selfie',        maxCount: 1 },
]);

const avatarUpload = upload.single('avatar');

// ─── Rutas ────────────────────────────────────────────────────────────────────

// GET  /api/v1/user/profile
router.get('/profile', protect, getProfile);

// PATCH /api/v1/user/profile
router.patch('/profile', protect, updateProfile);

// POST /api/v1/user/change-password
router.post('/change-password', protect, changePassword);

// DELETE /api/v1/user/fcm-token
router.delete('/fcm-token', protect, deleteFcmToken);

// GET /api/v1/user/sessions
router.get('/sessions', protect, getSessions);

// PATCH /api/v1/user/avatar
router.patch('/avatar', protect, avatarUpload, uploadAvatar);

// POST /api/v1/user/kyc
router.post('/kyc', protect, kycUpload, processKyc);

export default router;
