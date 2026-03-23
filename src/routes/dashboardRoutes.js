/**
 * dashboardRoutes.js — Rutas del Dashboard principal
 *
 * Base: /api/v1/dashboard
 */

import { Router }       from 'express';
import { protect }      from '../middlewares/authMiddleware.js';
import { getDashboard } from '../controllers/dashboardController.js';

const router = Router();

// GET /api/v1/dashboard
router.get('/', protect, getDashboard);

export default router;
