/**
 * owlPayService.js — Motor de Liquidez Institucional B2B (AV Finance LLC)
 *
 * Integración con la API Harbor de OwlPay para operaciones de on-ramp
 * fiat → USDC/XLM y liquidación institucional B2B global.
 *
 * Documentación oficial: https://harbor-developers.owlpay.com/docs/overview
 *
 * Flujo del Escenario A (Corredor Institucional):
 *   1. createOnRampOrder()    → OwlPay crea la orden de conversión fiat → cripto
 *   2. OwlPay procesa el pago y envía los fondos a la wallet Stellar de destino
 *   3. owlPayWebhook()        → OwlPay notifica la confirmación con el stellarTxId
 *
 * COMPLIANCE: Terminología prohibida ausente.
 * Usar: crossBorderPayment, payin, onRamp, liquidation, institutionalTransfer.
 *
 * Entidad operadora: AV Finance LLC (Delaware)
 * Jurisdicción: usuarios corporativos (KYB) y clientes con origen EE.UU.
 */

import crypto from 'crypto';

// ─── Configuración ────────────────────────────────────────────────────────────

const OWLPAY_BASE_URL = process.env.OWLPAY_BASE_URL ?? 'https://harbor-api.owlpay.com';

/**
 * Obtiene el OWLPAY_API_KEY desde variables de entorno.
 * Lanza inmediatamente si no está definido — fail fast.
 * @returns {string}
 */
function getOwlPayApiKey() {
  const key = process.env.OWLPAY_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('[Alyto OwlPay] Missing OWLPAY_API_KEY. Verificar .env o AWS Secrets Manager.');
  }
  return key;
}

/**
 * Helper interno: ejecuta una llamada autenticada a la API Harbor de OwlPay.
 *
 * @param {string} endpoint  - Path relativo (ej. '/v1/orders')
 * @param {object} options   - Opciones de fetch (method, body, etc.)
 * @returns {Promise<object>} Respuesta JSON de OwlPay
 * @throws {Error} Si la respuesta no es 2xx
 */
async function owlPayRequest(endpoint, options = {}) {
  const apiKey = getOwlPayApiKey();
  const url    = `${OWLPAY_BASE_URL}${endpoint}`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'X-Client-Id':   'alyto-v2',           // Identificador del cliente en Harbor
    ...(options.headers ?? {}),
  };

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (networkError) {
    throw new Error(`[Alyto OwlPay] Error de red al contactar Harbor API: ${networkError.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`[Alyto OwlPay] Respuesta no-JSON de Harbor API (status ${response.status})`);
  }

  if (!response.ok) {
    console.error('[Alyto OwlPay] API error:', {
      status:    response.status,
      endpoint,
      errorCode: data?.code    ?? data?.error?.code    ?? 'unknown',
      message:   data?.message ?? data?.error?.message ?? 'Sin detalle',
    });
    throw new Error(
      `[Alyto OwlPay] Error ${response.status}: ${data?.message ?? data?.error?.message ?? 'Error desconocido'}`,
    );
  }

  return data;
}

// ─── Funciones Exportadas ─────────────────────────────────────────────────────

/**
 * Crea una orden de on-ramp (fiat → cripto) en Harbor/OwlPay.
 *
 * OwlPay recibe los fondos institucionales en USD y los convierte a USDC,
 * enviándolos directamente a la wallet Stellar de destino.
 *
 * @param {object} params
 * @param {number} params.amount              - Monto en moneda fiat (USD)
 * @param {string} params.currency            - ISO 4217, debe ser 'USD' para Escenario A
 * @param {string} params.destinationWallet   - Stellar public key del cliente destino
 * @param {string} params.userId              - ID interno Alyto (para metadata y trazabilidad)
 * @param {string} params.alytoTransactionId  - ID de transacción Alyto para correlación
 * @param {string} [params.memo]              - Memo para la transacción Stellar (opcional)
 * @returns {Promise<OnRampOrderResult>}
 *
 * @typedef {Object} OnRampOrderResult
 * @property {string} orderId           - ID de la orden en OwlPay/Harbor
 * @property {string} status            - Estado inicial ('pending' | 'processing')
 * @property {number} amount            - Monto confirmado en USD
 * @property {string} currency          - Moneda confirmada
 * @property {string} destinationWallet - Wallet Stellar de destino
 * @property {number} estimatedUSDC     - Estimado de USDC a entregar (informativo)
 * @property {string} [paymentUrl]      - URL para instruir el wire transfer institucional
 */
export async function createOnRampOrder({
  amount,
  currency,
  destinationWallet,
  userId,
  alytoTransactionId,
  memo,
}) {
  if (currency !== 'USD') {
    throw new Error(`[Alyto OwlPay] El on-ramp institucional opera en USD. Moneda recibida: ${currency}`);
  }

  if (!destinationWallet || !/^G[A-Z2-7]{55}$/.test(destinationWallet)) {
    throw new Error('[Alyto OwlPay] destinationWallet debe ser una Stellar public key válida (G...).');
  }

  if (!amount || amount <= 0) {
    throw new Error('[Alyto OwlPay] El monto debe ser un número positivo en USD.');
  }

  const payload = {
    amount,
    source_currency:       currency,
    destination_asset:     'USDC',
    destination_network:   'stellar',
    destination_address:   destinationWallet,
    // Metadata de trazabilidad interna — visible en el panel Harbor
    metadata: {
      alyto_transaction_id: alytoTransactionId,
      alyto_user_id:        userId,
      legal_entity:         'LLC',
      corridor:             'A',
      operation_type:       'institutionalOnRamp',
    },
    ...(memo ? { memo } : {}),
  };

  console.info('[Alyto OwlPay] Creando orden de on-ramp institucional:', {
    amount,
    currency,
    alytoTransactionId,
    // No loguear destinationWallet completa — es dato sensible del cliente
    walletPrefix: destinationWallet.substring(0, 8) + '...',
  });

  const data = await owlPayRequest('/v1/orders', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  return {
    orderId:          data.id,
    status:           data.status,
    amount:           data.source_amount ?? amount,
    currency:         data.source_currency ?? currency,
    destinationWallet: data.destination_address ?? destinationWallet,
    estimatedUSDC:    data.destination_amount ?? null,
    paymentUrl:       data.payment_url ?? null,
  };
}

/**
 * Consulta el estado actual de una orden de on-ramp en OwlPay.
 * Útil para reconciliación y polling desde el orquestador.
 *
 * @param {string} orderId - ID de la orden retornado por createOnRampOrder
 * @returns {Promise<object>} Objeto Order de OwlPay
 */
export async function getOnRampOrderStatus(orderId) {
  return owlPayRequest(`/v1/orders/${orderId}`);
}

/**
 * Verifica la firma HMAC-SHA256 del webhook de OwlPay/Harbor.
 * DEBE llamarse antes de procesar cualquier evento de webhook.
 *
 * @param {string} rawBody         - Body crudo de la request (string, no parseado)
 * @param {string} signatureHeader - Valor del header 'x-owlpay-signature'
 * @returns {boolean} true si la firma es válida
 */
export function verifyOwlPayWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.OWLPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Alyto OwlPay] OWLPAY_WEBHOOK_SECRET no configurado. Rechazando webhook.');
    return false;
  }

  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader ?? '', 'hex'),
      Buffer.from(expectedSig,         'hex'),
    );
  } catch {
    return false;
  }
}
