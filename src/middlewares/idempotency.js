/**
 * idempotency.js — Middleware de idempotencia para endpoints financieros.
 *
 * Uso:
 *   router.post('/payments/initiate', protect, requireKycApproved, idempotencyCheck, handler)
 *
 * Semántica:
 *   - El header `Idempotency-Key` es OPCIONAL — sin key no hay dedup.
 *   - Si existe un registro previo para (userId, key), se devuelve la respuesta
 *     cacheada sin ejecutar el handler downstream.
 *   - Si no existe, se intercepta res.json() para persistir la respuesta antes
 *     de enviarla al cliente.
 *   - Fail-open: cualquier error en la capa de idempotencia no bloquea el pago.
 */

import IdempotencyKey from '../models/IdempotencyKey.js';

export const idempotencyCheck = async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // Header opcional — sin key no hay dedup

  if (typeof key !== 'string' || key.length > 128) {
    return res.status(400).json({
      success: false,
      message: 'Idempotency-Key must be 128 characters or less',
    });
  }

  const userId   = req.user?._id;
  const endpoint = `${req.method}:${req.path}`;

  try {
    const existing = await IdempotencyKey.findOne({ key, userId });
    if (existing) {
      // Replay — devolvemos la respuesta cacheada tal cual
      return res.status(existing.responseStatus ?? 200).json(existing.responseBody);
    }

    // Interceptar res.json() para persistir la respuesta antes de enviarla
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      IdempotencyKey.create({
        key,
        userId,
        endpoint,
        responseStatus: res.statusCode,
        responseBody:   body,
      }).catch((err) => {
        // Race condition (otro request guardó primero) — ignorar duplicate key
        if (err?.code !== 11000) {
          console.error('[Idempotency] Save error:', err.message);
        }
      });
      return originalJson(body);
    };

    next();
  } catch (err) {
    console.error('[Idempotency] Middleware error:', err.message);
    next(); // Fail-open — nunca bloquear pagos por fallos del layer de idempotencia
  }
};
