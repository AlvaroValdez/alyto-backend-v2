/**
 * ipn.js — Rutas de IPN (webhooks entrantes)
 *
 * Prefijo registrado en server.js: /api/v1/ipn
 *
 * Endpoints:
 *   POST /api/v1/ipn/vita    — IPN de Vita Wallet (payin + payout confirmations)
 *   POST /api/v1/ipn/fintoc  — IPN de Fintoc (confirmación de payin cross-border)
 *
 * ⚠️  Seguridad de webhooks:
 *   - NO usan JWT (son llamadas server-to-server desde proveedores externos)
 *   - Vita: validación HMAC-SHA256 propia en el handler
 *   - Fintoc: validación por tipo de evento y lookup de transacción
 *   - Los IPs de origen deberían estar en whitelist en el firewall/proxy
 *
 * ⚠️  Raw body:
 *   La firma HMAC de Vita se calcula sobre el body como objeto.
 *   captureRawBody preserva el string original para casos donde sea necesario
 *   comparar byte a byte (logging, debugging). La validación actual usa
 *   req.body (parseado) para reconstruir la firma mediante buildSortedBody.
 */

import { Router }                               from 'express';
import { handleVitaIPN, handleFintocIPN }       from '../controllers/ipnController.js';

const router = Router();

// ─── Middleware: captura raw body antes del parseo JSON ───────────────────────
// Preserva el body original como string en req.rawBody para debugging.
// Necesario antes de que express.json() consuma el stream.

function captureRawBody(req, res, next) {
  // Si express.json() ya consumió el body (ej. en tests), usarlo directamente
  if (req.body !== undefined) {
    if (!req.rawBody) {
      try { req.rawBody = JSON.stringify(req.body); } catch { req.rawBody = ''; }
    }
    return next();
  }
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end',  () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/ipn/vita
 *
 * IPN de Vita Wallet — notificación de cambio de estado en transacciones.
 * Vita reintenta cada 10 min durante 30 días hasta recibir HTTP 200.
 * Registrar URL en el campo url_notify al crear payment_orders y transactions.
 *
 * Evento de payin:  { status: "completed"|"denied", order: alytoTransactionId, wallet: {...} }
 * Evento de payout: mismo formato, cuando el withdrawal bancario se completa/deniega
 */
router.post('/vita', captureRawBody, handleVitaIPN);

/**
 * POST /api/v1/ipn/fintoc
 *
 * Webhook de confirmación de Fintoc para el flujo cross-border.
 * Debe estar registrado en el panel de Fintoc como webhook URL.
 *
 * ⚠️  Distinto al webhook SpA legacy en /api/v1/payments/webhooks/fintoc.
 *     Este handler pertenece al motor cross-border y llama a dispatchPayout().
 */
router.post('/fintoc', captureRawBody, handleFintocIPN);

export default router;
