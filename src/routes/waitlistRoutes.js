// src/routes/waitlistRoutes.js
//
// Lista de espera del lanzamiento de alyto.io.
//
// Ruta pública (sin authMiddleware): la consume el formulario de la landing
// estática, servida desde otro dominio. Para que funcione en producción, el
// origen de la landing debe estar en ALLOWED_ORIGINS.

import express from 'express';
import { waitlistLimiter } from '../config/rateLimiters.js';
import { protect } from '../middlewares/authMiddleware.js';
import { checkAdmin } from '../middlewares/checkAdmin.js';
import { subscribe, listEntries, exportCsv } from '../controllers/waitlistController.js';

const router = express.Router();

// POST /api/v1/waitlist — alta en la lista de espera. Público.
router.post('/', waitlistLimiter, subscribe);

// Lectura de la lista — solo admin.
// GET /api/v1/waitlist/entries — resumen + registros paginados.
router.get('/entries', protect, checkAdmin, listEntries);
// GET /api/v1/waitlist/export — descarga CSV.
router.get('/export', protect, checkAdmin, exportCsv);

export default router;
