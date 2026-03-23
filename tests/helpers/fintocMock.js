/**
 * fintocMock.js — Factories de respuestas mock de Fintoc
 *
 * Genera respuestas y webhooks ficticios que reproducen la estructura
 * de la API de Fintoc, incluyendo la firma HMAC para webhooks.
 *
 * Nota: fintocService.js activa automáticamente el mock de desarrollo
 * cuando FINTOC_SECRET_KEY no está configurado y NODE_ENV !== 'production'.
 * En el entorno de test (NODE_ENV=test), el mock de dev se activa automáticamente.
 * Estos helpers complementan ese comportamiento generando webhooks válidos.
 */

import crypto from 'crypto';

// ─── PaymentIntent mock ───────────────────────────────────────────────────────

/**
 * Respuesta mock de createPaymentIntent de Fintoc (dev mock mode).
 * Estructura compatible con lo que devuelve fintocService.js en modo mock.
 */
export function mockFintocPaymentIntentResponse(overrides = {}) {
  const id = overrides.id ?? `pi_dev_mock_${Date.now()}`;

  return {
    id,
    status:     overrides.status  ?? 'created',
    amount:     overrides.amount  ?? 150000,
    currency:   overrides.currency ?? 'CLP',
    widget_url: overrides.widget_url ?? `https://widget.fintoc.com/?token=${id}`,
    created_at: new Date().toISOString(),
  };
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Genera un body de webhook Fintoc para payment_intent.succeeded.
 */
export function fintocWebhookSucceeded(paymentIntentId, overrides = {}) {
  return {
    type: 'payment_intent.succeeded',
    data: {
      id:       paymentIntentId,
      status:   'succeeded',
      amount:   overrides.amount   ?? 150000,
      currency: overrides.currency ?? 'CLP',
      ...overrides,
    },
  };
}

/**
 * Genera un body de webhook Fintoc para payment_intent.failed.
 */
export function fintocWebhookFailed(paymentIntentId, overrides = {}) {
  return {
    type: 'payment_intent.failed',
    data: {
      id:       paymentIntentId,
      status:   'failed',
      amount:   overrides.amount   ?? 150000,
      currency: overrides.currency ?? 'CLP',
      error:    { message: overrides.errorMessage ?? 'Pago rechazado por el banco.' },
      ...overrides,
    },
  };
}

// ─── Firma de webhook ─────────────────────────────────────────────────────────

/**
 * Genera la firma HMAC-SHA256 para simular un webhook de Fintoc válido.
 *
 * Algoritmo: HMAC-SHA256(FINTOC_WEBHOOK_SECRET, rawBody)
 *
 * @param {string} rawBody — Body del webhook como string JSON
 * @returns {string}       — Hex digest de la firma
 */
export function generateFintocSignature(rawBody) {
  const secret = process.env.FINTOC_WEBHOOK_SECRET ?? 'test_fintoc_webhook_secret';
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Combina body + firma para usar directamente con supertest:
 *
 *   const { rawBody, headers } = fintocWebhookRequest(bodyObj)
 *   await request(app)
 *     .post('/api/v1/payments/webhooks/fintoc')
 *     .set(headers)
 *     .send(rawBody)
 *
 * IMPORTANTE: el body debe enviarse como string (no objeto) para que
 * la firma coincida con rawBody al llegar al handler.
 */
export function fintocWebhookRequest(bodyObj) {
  const rawBody  = JSON.stringify(bodyObj);
  const sig      = generateFintocSignature(rawBody);

  return {
    rawBody,
    headers: {
      'content-type':    'application/json',
      'fintoc-signature': sig,
    },
  };
}
