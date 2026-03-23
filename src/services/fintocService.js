/**
 * fintocService.js — Motor de Recaudación Local Chile (AV Finance SpA)
 *
 * Integración con Fintoc Open Banking para iniciación de pagos A2A
 * (Account-to-Account) desde cuentas bancarias chilenas a AV Finance SpA.
 *
 * Documentación Fintoc: https://docs.fintoc.com/reference
 *
 * Flujo de un payin Fintoc:
 *   1. createPaymentIntent()  → Fintoc devuelve widget_token + payment_id
 *   2. Frontend abre el widget con el widget_token
 *   3. Usuario autoriza el pago en su banco (flujo Open Banking)
 *   4. Fintoc llama al webhook /webhooks/fintoc con status del pago
 *   5. verifyWebhookSignature() valida la firma antes de procesar
 *
 * COMPLIANCE: AV Finance SpA solo opera en la jurisdicción Chile (legalEntity='SpA').
 * La validación de legalEntity se hace en el controlador, no aquí.
 */

import crypto from 'crypto';

// ─── Configuración ────────────────────────────────────────────────────────────

const FINTOC_BASE_URL = 'https://api.fintoc.com/v1';

/**
 * Obtiene la FINTOC_SECRET_KEY de las variables de entorno.
 * Lanza si no está definida — fail fast.
 * @returns {string}
 */
const IS_DEV = process.env.NODE_ENV !== 'production';

function getFintocApiKey() {
  const key = process.env.FINTOC_SECRET_KEY;
  if (!key || key.trim() === '') {
    if (IS_DEV) return '__dev_mock__';
    throw new Error('[Alyto Fintoc] Missing FINTOC_SECRET_KEY. Verificar .env o Secrets Manager.');
  }
  return key;
}

/**
 * Helper interno: ejecuta una llamada a la API de Fintoc con fetch nativo.
 *
 * @param {string} endpoint  - Path relativo (ej. '/payment_intents')
 * @param {object} options   - Opciones de fetch (method, body, etc.)
 * @returns {Promise<object>} Respuesta JSON de Fintoc
 * @throws {Error} Si la respuesta no es 2xx
 */
async function fintocRequest(endpoint, options = {}) {
  const apiKey  = getFintocApiKey();
  const url     = `${FINTOC_BASE_URL}${endpoint}`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    ...(options.headers ?? {}),
  };

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (networkError) {
    throw new Error(`[Alyto Fintoc] Error de red al contactar Fintoc: ${networkError.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`[Alyto Fintoc] Respuesta no-JSON de Fintoc (status ${response.status})`);
  }

  if (!response.ok) {
    // Loguear sin exponer el body completo (puede contener datos sensibles)
    console.error('[Alyto Fintoc] API error:', {
      status:   response.status,
      endpoint,
      errorCode: data?.error?.code ?? 'unknown',
      message:   data?.error?.message ?? 'Sin detalle',
    });
    throw new Error(`[Alyto Fintoc] Error ${response.status}: ${data?.error?.message ?? 'Error desconocido'}`);
  }

  return data;
}

// ─── Funciones Exportadas ─────────────────────────────────────────────────────

/**
 * Crea un PaymentIntent en Fintoc y retorna el widget_token y el payment_id.
 *
 * El widget_token es lo que el frontend usa para abrir el widget de Fintoc
 * donde el usuario autoriza la transferencia desde su banco chileno.
 *
 * @param {object} params
 * @param {number} params.amount        - Monto en CLP (entero, sin decimales)
 * @param {string} params.currency      - Debe ser 'CLP'
 * @param {string} params.userId        - ID interno Alyto (para metadata de trazabilidad)
 * @param {string} params.userEmail     - Email del usuario para Fintoc
 * @param {string} params.userName      - Nombre completo del usuario
 * @param {string} [params.description] - Descripción de la operación (aparece en el banco)
 * @returns {Promise<FintocPaymentIntentResult>}
 *
 * @typedef {Object} FintocPaymentIntentResult
 * @property {string} paymentIntentId - ID del PaymentIntent en Fintoc
 * @property {string} widgetToken     - Token para abrir el widget en el frontend
 * @property {string} widgetUrl       - URL directa del widget (alternativa a token)
 * @property {string} status          - Estado inicial ('created')
 * @property {number} amount          - Monto confirmado
 * @property {string} currency        - Moneda confirmada ('CLP')
 */
export async function createPaymentIntent({ amount, currency, userId, userEmail, userName, description }) {
  if (currency !== 'CLP') {
    throw new Error(`[Alyto Fintoc] Fintoc solo soporta CLP. Moneda recibida: ${currency}`);
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('[Alyto Fintoc] El monto debe ser un entero positivo en CLP.');
  }

  // ── Modo desarrollo: retorna respuesta simulada sin llamar a Fintoc ──────────
  if (IS_DEV && getFintocApiKey() === '__dev_mock__') {
    const mockId = `pi_dev_${Date.now()}`;
    console.info('[Alyto Fintoc][DEV] Mock PaymentIntent creado:', { mockId, amount, userId });
    return {
      paymentIntentId: mockId,
      widgetToken:     `wt_dev_${mockId}`,
      widgetUrl:       `${process.env.BACKEND_URL ?? 'http://localhost:3000'}/api/v1/dev/fintoc-success?amount=${amount}&id=${mockId}`,
      status:          'created',
      amount,
      currency,
    };
  }

  const payload = {
    amount,
    currency,
    // Descripción visible para el usuario en su banco (sin terminología prohibida)
    description: description ?? 'Pago Alyto — Transferencia Internacional',
    customer: {
      email: userEmail,
      name:  userName,
    },
    metadata: {
      // Metadata de trazabilidad interna — no aparece en el widget del usuario
      alyto_user_id:    userId,
      legal_entity:     'SpA',
      corridor:         'CL',
      operation_type:   'payin',
    },
    // URL donde Fintoc redirige al usuario tras completar el pago en el widget
    redirect_url: process.env.FINTOC_REDIRECT_URL ?? 'https://app.alyto.com/payin/success',
  };

  console.info('[Alyto Fintoc] Creando PaymentIntent:', {
    amount,
    currency,
    userId,
    // No loguear email ni nombre completo del usuario
  });

  const data = await fintocRequest('/payment_intents', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  // Debug: estructura completa de la respuesta de Fintoc (remover en producción estable)
  console.log('[Fintoc] Respuesta completa crear PI:', JSON.stringify(data, null, 2));
  console.log('[Fintoc] widget_token extraído:', data?.widget_token);
  console.log('[Fintoc] data?.widget_token:', data?.data?.widget_token);

  return {
    paymentIntentId: data.id,
    widgetToken:     data.widget_token,
    widgetUrl:       data.widget_url ?? `https://widget.fintoc.com/?token=${data.widget_token}`,
    status:          data.status,
    amount:          data.amount,
    currency:        data.currency,
  };
}

/**
 * Consulta el estado actual de un PaymentIntent en Fintoc.
 * Útil para reconciliación o reintentos desde el orquestador.
 *
 * @param {string} paymentIntentId - ID retornado por createPaymentIntent
 * @returns {Promise<object>} Objeto PaymentIntent de Fintoc
 */
export async function getPaymentIntent(paymentIntentId) {
  return fintocRequest(`/payment_intents/${paymentIntentId}`);
}

/**
 * Verifica la firma HMAC-SHA256 del webhook de Fintoc.
 * DEBE llamarse antes de procesar cualquier evento de webhook.
 *
 * Fintoc incluye el header 'fintoc-signature' con la firma del payload.
 *
 * @param {string} rawBody        - Body crudo de la request (string, no parseado)
 * @param {string} signatureHeader - Valor del header 'fintoc-signature'
 * @returns {boolean} true si la firma es válida
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.FINTOC_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Alyto Fintoc] FINTOC_WEBHOOK_SECRET no configurado. Rechazando webhook.');
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  // Comparación timing-safe para evitar timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader ?? '', 'hex'),
      Buffer.from(expectedSignature,    'hex'),
    );
  } catch {
    return false;
  }
}
