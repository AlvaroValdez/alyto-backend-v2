// src/routes/supportRoutes.js
//
// AWS-4 — Agente IA de soporte para usuarios (Bedrock / Claude).
// Montado en /api/v1/support (ver server.js).

import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { supportChatLimiter } from '../config/rateLimiters.js';
import { chatSupport } from '../controllers/supportController.js';

const router = express.Router();

// Chat con el asistente "Aly". Requiere sesión; rate-limit propio (IA = costo).
router.post('/chat', protect, supportChatLimiter, chatSupport);

export default router;
