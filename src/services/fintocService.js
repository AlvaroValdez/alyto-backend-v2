/**
 * fintocService.js — Motor de Recaudación Local Chile (AV Finance SpA)
 *
 * Integración con Fintoc Open Banking usando Checkout Sessions.
 * El usuario es redirigido a la URL de Fintoc para autorizar el pago
 * desde su cuenta bancaria chilena.
 *
 * Flujo de un payin Fintoc:
 *   1. createWidgetLink()  → Fintoc devuelve redirect_url + id
 *   2. Frontend redirige al usuario a redirect_url
 *   3. Usuario autoriza el pago en su banco
 *   4. Fintoc llama al webhook /webhooks/fintoc con status del pago
 *   5. verifyWebhookSignature() valida la firma antes de procesar
 *
 * COMPLIANCE: AV Finance SpA solo opera en la jurisdicción Chile (legalEntity='SpA').
 */

import crypto from 'crypto';

// ─── Configuración ────────────────────────────────────────────────────────────

const FINTOC_API_URL = process.env.FINTOC_API_URL || 'https://api.fintoc.com/v1';

/**
 * Helper interno: ejecuta una llamada a la API de Fintoc con fetch nativo.
 * Auth header: solo la key directamente, sin prefijo "Bearer".
 */
async function fintocRequest(endpoint, options = {}) {
  const apiKey = process.env.FINTOC_SECRET_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('[Alyto Fintoc] Missing FINTOC_SECRET_KEY. Verificar .env o Secrets Manager.');
  }

  const url = `${FINTOC_API_URL}${endpoint}`;

  const headers = {
    'Authorization': apiKey,   // Sin "Bearer" — así lo requiere Fintoc
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
    console.error('[Alyto Fintoc] API error:', {
      status:    response.status,
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
 * Crea un Checkout Session en Fintoc y retorna la redirect_url y el id.
 *
 * La redirect_url es la URL a la que se redirige al usuario para que
 * autorice el pago desde su banco chileno.
 *
 * @param {object} params
 * @param {number} params.amount          - Monto en CLP (entero, sin decimales)
 * @param {string} params.currency        - Debe ser 'CLP'
 * @param {object} [params.metadata]      - Metadata personalizada (transactionId, etc.)
 * @param {string} [params.success_url]   - URL de redirección tras pago exitoso
 * @param {string} [params.cancel_url]    - URL de redirección si el usuario cancela
 * @param {string} [params.customer_email] - Email del usuario
 * @returns {Promise<{ id: string, url: string, status: string, amount: number, currency: string, metadata: object, created_at: string }>}
 */
export async function createWidgetLink({ amount, currency = 'CLP', metadata = {}, success_url, cancel_url, customer_email }) {
  if (!amount || amount <= 0) {
    throw new Error('[Alyto Fintoc] El monto debe ser un número positivo en CLP.');
  }

  const payload = {
    amount:   Math.round(amount),
    currency: currency.toUpperCase(),
    metadata,
  };

  if (success_url) {
    payload.success_url = success_url;
    payload.cancel_url  = cancel_url ?? success_url;
  }

  if (customer_email) {
    payload.customer_email = customer_email;
  }

  // Direct Payment: agregar cuenta receptora si está configurada
  if (process.env.FINTOC_RECIPIENT_HOLDER_ID && process.env.FINTOC_RECIPIENT_ACCOUNT_NUMBER) {
    payload.recipient_account = {
      holder_id: process.env.FINTOC_RECIPIENT_HOLDER_ID,
      number:    process.env.FINTOC_RECIPIENT_ACCOUNT_NUMBER,
      type:      process.env.FINTOC_RECIPIENT_ACCOUNT_TYPE || 'checking_account',
    };
  }

  console.info('[Alyto Fintoc] Creando Checkout Session:', {
    amount:         payload.amount,
    currency:       payload.currency,
    customer_email: payload.customer_email,
    success_url:    payload.success_url,
  });

  const data = await fintocRequest('/checkout_sessions', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  console.log('✅ [Alyto Fintoc] Checkout Session creado:', data.id);

  return {
    id:         data.id,
    url:        data.redirect_url,   // Checkout Sessions usan 'redirect_url'
    status:     data.status,
    amount:     data.amount,
    currency:   data.currency,
    metadata:   data.metadata,
    created_at: data.created_at,
  };
}

/**
 * Consulta el estado de un Checkout Session en Fintoc.
 *
 * @param {string} checkoutSessionId - ID retornado por createWidgetLink
 * @returns {Promise<object>}
 */
export async function getPaymentIntent(checkoutSessionId) {
  return fintocRequest(`/checkout_sessions/${checkoutSessionId}`);
}

/**
 * Verifica la firma HMAC-SHA256 del webhook de Fintoc.
 * DEBE llamarse antes de procesar cualquier evento de webhook.
 *
 * @param {string} rawBody         - Body crudo de la request (string, no parseado)
 * @param {string} signatureHeader - Valor del header 'fintoc-signature'
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.FINTOC_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Alyto Fintoc] FINTOC_WEBHOOK_SECRET no configurado. Rechazando webhook.');
    return false;
  }

  // Fintoc envía firma en formato: "t=timestamp,v1=hash"
  let timestamp    = '';
  let signatureHash = signatureHeader ?? '';

  if (signatureHeader?.includes('t=') && signatureHeader?.includes('v1=')) {
    const parts  = signatureHeader.split(',');
    const tPart  = parts.find(p => p.startsWith('t='));
    const v1Part = parts.find(p => p.startsWith('v1='));
    timestamp     = tPart  ? tPart.replace('t=', '')   : '';
    signatureHash = v1Part ? v1Part.replace('v1=', '') : signatureHeader;
  }

  const signedPayload = `${timestamp}.${typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)}`;

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHash,        'hex'),
      Buffer.from(expectedSignature,    'hex'),
    );
  } catch {
    return false;
  }
}

export default { createWidgetLink, getPaymentIntent, verifyWebhookSignature };
