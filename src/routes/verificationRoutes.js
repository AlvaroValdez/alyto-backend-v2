/**
 * verificationRoutes.js — Rutas de verificación pública
 *
 * Prefijo registrado en server.js: /api/v1/verify
 *
 * Endpoints:
 *   GET /api/v1/verify/:hash — Verificación pública de comprobante B2B por hash QR
 *
 * NOTA: Estas rutas son públicas (sin auth). Cualquiera que tenga el hash
 * del QR puede verificar la autenticidad del comprobante.
 */

import { Router } from 'express';
import { verifyInvoice } from '../controllers/verificationController.js';

const router = Router();

/**
 * GET /api/v1/verify/:hash
 *
 * Verifica la autenticidad de un Comprobante Oficial de Servicio B2B.
 * El hash (SHA-256, 64 caracteres hex) se obtiene escaneando el QR del PDF.
 *
 * Respuesta exitosa (200):
 *   { valid: true, invoiceNumber, transactionDate, amount, currency, legalEntity, ... }
 *
 * No encontrado (404):
 *   { valid: false, error: '...' }
 */
router.get('/:hash', verifyInvoice);

export default router;
