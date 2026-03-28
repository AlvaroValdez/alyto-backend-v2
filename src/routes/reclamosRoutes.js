/**
 * reclamosRoutes.js — Rutas PRILI (Punto de Reclamo Primera Instancia)
 *
 * Fase 27 — Exigencia ASFI ETF/PSAV AV Finance SRL.
 * Aplica a todos los usuarios (SpA, LLC, SRL).
 *
 * Montado en server.js bajo: /api/v1/reclamos
 * Rutas admin montadas en adminRoutes.js bajo: /api/v1/admin/reclamos
 *
 * Endpoints usuario:
 *   POST  /                    — Presentar reclamo (multipart/form-data)
 *   GET   /                    — Listar mis reclamos
 *   GET   /:reclamoId          — Detalle de un reclamo
 *   POST  /:reclamoId/docs     — Agregar documentos adicionales
 */

import { Router }  from 'express'
import { protect } from '../middlewares/authMiddleware.js'
import multer      from 'multer'
import {
  crearReclamo,
  listarReclamos,
  getReclamo,
  subirDocumentosReclamo,
} from '../controllers/reclamosController.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Solo se permiten archivos JPG, PNG o PDF.'))
  },
})

const router = Router()

// ── Rutas de usuario (todas requieren JWT válido) ─────────────────────────────

router.post('/',                  protect, upload.array('documentos', 3), crearReclamo)
router.get('/',                   protect, listarReclamos)
router.get('/:reclamoId',         protect, getReclamo)
router.post('/:reclamoId/docs',   protect, upload.array('documentos', 3), subirDocumentosReclamo)

export default router
