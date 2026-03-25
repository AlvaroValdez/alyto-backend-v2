/**
 * kybRoutes.js — Rutas KYB para cuentas Business
 *
 * Prefijo registrado en server.js: /api/v1/kyb
 *
 * Todos los endpoints requieren JWT válido (protect).
 *
 * Endpoints:
 *   POST /api/v1/kyb/apply      — Enviar solicitud KYB (multipart/form-data)
 *   GET  /api/v1/kyb/status     — Estado actual del KYB del usuario
 *   POST /api/v1/kyb/documents  — Documentos adicionales (cuando kybStatus === 'more_info')
 */

import { Router }  from 'express';
import multer      from 'multer';
import { protect } from '../middlewares/authMiddleware.js';
import {
  applyKYB,
  getKYBStatus,
  uploadKYBDocuments,
} from '../controllers/kybController.js';

const router = Router();

/**
 * Configuración de multer — almacenamiento en memoria para conversión a base64.
 * Límite: 10 MB por archivo, máximo 10 archivos por solicitud.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10 MB por archivo
    files:    10,                  // máximo 10 documentos por solicitud
  },
  fileFilter(_req, file, cb) {
    // Solo aceptar PDFs e imágenes
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}. Use PDF, JPG, PNG o WebP.`));
    }
  },
});

/**
 * POST /api/v1/kyb/apply
 *
 * Enviar solicitud de cuenta Business.
 * Requiere KYC personal aprobado.
 *
 * Content-Type: multipart/form-data
 * Campos:
 *   businessData  {string}  — JSON con datos de la empresa
 *   documentos    {File[]}  — Documentos del expediente KYB
 */
router.post(
  '/apply',
  protect,
  upload.array('documentos', 10),
  applyKYB,
);

/**
 * GET /api/v1/kyb/status
 *
 * Estado actual del proceso KYB del usuario autenticado.
 */
router.get('/status', protect, getKYBStatus);

/**
 * POST /api/v1/kyb/documents
 *
 * Subir documentos adicionales cuando el admin solicitó más información.
 * Solo disponible si kybStatus === 'more_info'.
 *
 * Content-Type: multipart/form-data
 * Campos:
 *   documentTypes {string}  — JSON array con los tipos de documento (opcional)
 *   documentos    {File[]}  — Archivos adicionales
 */
router.post(
  '/documents',
  protect,
  upload.array('documentos', 10),
  uploadKYBDocuments,
);

// Manejo de errores de multer (archivo muy grande, tipo no permitido, etc.)
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Archivo demasiado grande. Máximo 10 MB por archivo.' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Demasiados archivos. Máximo 10 documentos por solicitud.' });
  }
  return res.status(400).json({ error: err.message ?? 'Error al procesar los archivos.' });
});

export default router;
