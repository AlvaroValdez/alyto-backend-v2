/**
 * IdempotencyKey.js — Replay protection para endpoints de mutación financiera.
 *
 * Los clientes envían `Idempotency-Key: <uuid>` en requests POST críticos
 * (pagos, conversiones, depósitos). Si el mismo (userId, key) se recibe dos
 * veces — por retry de red o doble submit — se devuelve la respuesta cacheada
 * en lugar de crear una transacción duplicada.
 *
 * TTL: 24 horas — ventana suficiente para retries y reconciliación.
 */

import mongoose from 'mongoose';

const idempotencyKeySchema = new mongoose.Schema({
  key: {
    type:     String,
    required: true,
    unique:   true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },
  endpoint: { type: String, required: true },
  responseStatus: { type: Number },
  responseBody:   { type: mongoose.Schema.Types.Mixed },
  createdAt: {
    type:    Date,
    default: Date.now,
    expires: 86400, // TTL — MongoDB borra el doc tras 24 horas
  },
});

export default mongoose.model('IdempotencyKey', idempotencyKeySchema);
