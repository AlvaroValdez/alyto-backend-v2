/**
 * institutionalRoutes.js — Rutas del Corredor Institucional (AV Finance LLC)
 *
 * Prefijo registrado en server.js: /api/v1/institutional
 *
 * Endpoints disponibles:
 *   POST /api/v1/institutional/onramp/owlpay      — On-ramp B2B vía OwlPay (LLC)
 *   POST /api/v1/institutional/webhooks/owlpay    — Webhook de confirmación OwlPay
 *
 * NOTA DE SEGURIDAD: En producción, /onramp/owlpay debe estar protegido por
 * autenticación JWT con verificación de rol corporativo (RBAC).
 * El endpoint de webhook debe estar en lista blanca con la IP de OwlPay.
 */

import { Router }                                from 'express';
import { initiateCorporateOnRamp, owlPayWebhook } from '../controllers/institutionalController.js';
import { protect, requireEntity }                from '../middlewares/authMiddleware.js';

const router = Router();

// ─── Middleware: captura raw body para verificación de firma HMAC ────────────

function captureRawBody(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end',  ()    => {
    req.rawBody = data;
    try   { req.body = JSON.parse(data); }
    catch { req.body = {}; }
    next();
  });
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/institutional/onramp/owlpay
 *
 * Inicia un on-ramp institucional fiat → USDC para clientes LLC.
 * Requiere: { userId, amount (USD), destinationWallet (Stellar public key) }
 * Devuelve: { owlPayOrderId, paymentUrl, estimatedUSDC, alytoTransactionId }
 */
// Requiere JWT válido + usuario bajo AV Finance LLC (clientes corporativos / EE.UU.)
router.post('/onramp/owlpay', protect, requireEntity(['LLC']), initiateCorporateOnRamp);

/**
 * POST /api/v1/institutional/webhooks/owlpay
 *
 * Endpoint de callback de OwlPay/Harbor — llamado por sus servidores, no por el cliente.
 * Usa captureRawBody para verificar la firma HMAC antes de procesar el evento.
 * El controlador responde 200 antes de procesar (pattern fire-and-process).
 */
router.post('/webhooks/owlpay', captureRawBody, owlPayWebhook);

export default router;
