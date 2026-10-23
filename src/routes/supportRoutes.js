// src/routes/supportRoutes.js
//
// AWS-4 — Agente IA de soporte para usuarios (Bedrock / Claude).
// Montado en /api/v1/support (ver server.js).

import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { supportChatLimiter, supportReportLimiter } from '../config/rateLimiters.js';
import { chatSupport, reportAiContent } from '../controllers/supportController.js';

const router = express.Router();

// Chat con el asistente "Aly". Requiere sesión; rate-limit propio (IA = costo).
router.post('/chat', protect, supportChatLimiter, chatSupport);

// Denuncia de una respuesta de Aly. Exigido por la politica de IA generativa de
// Google Play: tiene que poder hacerse sin salir de la app.
router.post('/report', protect, supportReportLimiter, reportAiContent);

export default router;
