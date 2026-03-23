/**
 * identityRoutes.js — Rutas de Verificación de Identidad (Stripe Identity)
 *
 * POST /api/v1/identity/verify
 *   Crea una VerificationSession biométrica. Requiere JWT válido.
 *   El frontend recibe la client_secret y abre el modal nativo de Stripe.
 */

import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { createVerificationSession } from '../controllers/identityController.js';

const router = Router();

// Protegida: solo usuarios autenticados pueden iniciar su propia verificación
router.post('/verify', protect, createVerificationSession);

export default router;
