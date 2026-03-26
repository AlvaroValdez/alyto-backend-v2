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

const OWLPAY_BASE_URL =
  process.env.OWLPAY_BASE_URL ??
  process.env.OWLPAY_API_URL  ??
  'https://harbor-sandbox.owlpay.com/api/v1';

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
    'X-API-KEY':    apiKey,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
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

  // Harbor Transfer v2 — POST /transfers
  const payload = {
    type: 'on_ramp',
    source: {
      asset:          currency,      // 'USD'
      amount,
      payment_method: 'wire',        // método institucional por defecto
    },
    destination: {
      asset:   'USDC',
      chain:   'stellar',
      address: destinationWallet,
      ...(memo ? { memo } : {}),
    },
    // Idempotency key — Harbor idempotentiza por application_transfer_uuid
    application_transfer_uuid: alytoTransactionId,
    // customer_uuid del cliente en Harbor (si ya está onboarded)
    ...(userId ? { customer_uuid: String(userId) } : {}),
  };

  console.info('[Alyto OwlPay] Creando orden de on-ramp institucional:', {
    amount,
    currency,
    alytoTransactionId,
    // No loguear destinationWallet completa — es dato sensible del cliente
    walletPrefix: destinationWallet.substring(0, 8) + '...',
  });

  const data = await owlPayRequest('/transfers', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  return {
    orderId:           data.uuid          ?? data.id,
    status:            data.status        ?? 'pending',
    amount:            data.source?.amount ?? amount,
    currency:          data.source?.asset  ?? currency,
    destinationWallet: data.destination?.address ?? destinationWallet,
    estimatedUSDC:     data.destination?.amount  ?? null,
    paymentUrl:        data.payment_url ?? data.transfer_instructions?.url ?? null,
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
  return owlPayRequest(`/transfers/${orderId}`);
}

/**
 * Crea un desembolso (off-ramp) B2B a cuenta bancaria local vía Harbor/OwlPay.
 *
 * OwlPay recibe USD institucionales y los dispersa a una cuenta bancaria
 * en el país de destino. Ideal como proveedor primario o fallback de Vita
 * para los corredores SRL Bolivia → LatAm.
 *
 * Flujo:
 *   1. AV Finance SRL/LLC tiene fondos en USD en la cuenta Harbor
 *   2. createDisbursement() instruye a OwlPay a debitar esos fondos
 *   3. OwlPay convierte USD → moneda local y acredita en la cuenta del beneficiario
 *   4. OwlPay notifica vía webhook cuando el desembolso se completa
 *
 * @param {object} params
 * @param {number} params.amount                - Monto en USD (ya convertido de BOB si aplica)
 * @param {string} params.destinationCountry    - ISO alpha-2 (ej. 'CO', 'PE', 'AR')
 * @param {string} params.destinationCurrency   - ISO 4217 (ej. 'COP', 'PEN', 'ARS')
 * @param {object} params.beneficiary           - Datos del destinatario
 * @param {string} params.beneficiary.firstName
 * @param {string} params.beneficiary.lastName
 * @param {string} params.beneficiary.email
 * @param {string} params.beneficiary.documentType
 * @param {string} params.beneficiary.documentNumber
 * @param {string} params.beneficiary.bankCode          - Código del banco destino
 * @param {string} params.beneficiary.accountNumber     - Número de cuenta
 * @param {string} params.beneficiary.accountType       - 'checking' | 'savings'
 * @param {string} [params.beneficiary.address]
 * @param {object} [params.beneficiary.dynamicFields]   - Campos adicionales por país
 * @param {string} params.alytoTransactionId   - ID Alyto para correlación y auditoría
 * @param {string} params.userId               - ID del usuario Alyto
 * @returns {Promise<DisbursementResult>}
 *
 * @typedef {Object} DisbursementResult
 * @property {string}  disbursementId   - ID del desembolso en OwlPay
 * @property {string}  status           - Estado inicial ('pending' | 'processing')
 * @property {number}  amount           - Monto en USD confirmado
 * @property {string}  currency         - 'USD'
 * @property {string|null} trackingUrl  - URL de seguimiento Harbor (si disponible)
 */
export async function createDisbursement({
  amount,
  destinationCountry,
  destinationCurrency,
  beneficiary,
  alytoTransactionId,
  userId,
}) {
  if (!amount || amount <= 0) {
    throw new Error('[Alyto OwlPay] createDisbursement: amount debe ser un número positivo en USD.');
  }
  if (!destinationCountry || !destinationCurrency) {
    throw new Error('[Alyto OwlPay] createDisbursement: destinationCountry y destinationCurrency son requeridos.');
  }
  if (!beneficiary?.firstName || !beneficiary?.accountNumber) {
    throw new Error('[Alyto OwlPay] createDisbursement: beneficiary.firstName y accountNumber son requeridos.');
  }

  const ben = beneficiary;

  // Merge dynamicFields (campos específicos por país: clabe, pix_key, etc.)
  const extraFields = {};
  if (ben.dynamicFields instanceof Map) {
    for (const [k, v] of ben.dynamicFields.entries()) extraFields[k] = v;
  } else if (ben.dynamicFields && typeof ben.dynamicFields === 'object') {
    Object.assign(extraFields, ben.dynamicFields);
  }

  const payload = {
    source_currency:      'USD',
    source_amount:        amount,
    destination_country:  destinationCountry.toUpperCase(),
    destination_currency: destinationCurrency.toUpperCase(),
    beneficiary: {
      first_name:      ben.firstName ?? ben.beneficiary_first_name ?? '',
      last_name:       ben.lastName  ?? ben.beneficiary_last_name  ?? '',
      email:           ben.email     ?? ben.beneficiary_email       ?? '',
      document_type:   ben.documentType   ?? ben.beneficiary_document_type   ?? 'dni',
      document_number: ben.documentNumber ?? ben.beneficiary_document_number ?? '',
      bank_code:       ben.bankCode   ?? ben.bank_code    ?? '',
      account_number:  ben.accountNumber ?? ben.account_bank ?? '',
      account_type:    ben.accountType   ?? ben.account_type_bank ?? 'savings',
      ...(ben.address ? { address: ben.address } : {}),
      ...extraFields,
    },
    metadata: {
      alyto_transaction_id: alytoTransactionId,
      alyto_user_id:        String(userId ?? ''),
      legal_entity:         'SRL',
      corridor:             'C',
      operation_type:       'manualPayinPayout',
    },
  };

  console.info('[Alyto OwlPay] Creando desembolso:', {
    amount,
    destinationCountry,
    destinationCurrency,
    alytoTransactionId,
    beneficiaryName: `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim(),
  });

  const data = await owlPayRequest('/v1/disbursements', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  return {
    disbursementId: data.id ?? data.disbursement_id,
    status:         data.status   ?? 'pending',
    amount:         data.source_amount ?? amount,
    currency:       'USD',
    trackingUrl:    data.tracking_url ?? null,
  };
}

/**
 * Consulta el estado de un desembolso en OwlPay.
 *
 * @param {string} disbursementId
 * @returns {Promise<object>} Objeto Disbursement de OwlPay
 */
export async function getDisbursementStatus(disbursementId) {
  return owlPayRequest(`/v1/disbursements/${disbursementId}`);
}

/**
 * Verifica la firma HMAC-SHA256 del webhook de Harbor/OwlPay.
 * DEBE llamarse antes de procesar cualquier evento de webhook.
 *
 * Harbor envía el header 'harbor-signature' con el formato:
 *   "t=1689066169,v1=e997b87453fb8923..."
 *
 * El signed_payload es: "<timestamp>.<rawBody>"
 *
 * @param {string} rawBody         - Body crudo de la request (string, no parseado)
 * @param {string} signatureHeader - Valor del header 'harbor-signature'
 * @returns {boolean} true si la firma es válida
 */
export function verifyOwlPayWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.OWLPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Alyto OwlPay] OWLPAY_WEBHOOK_SECRET no configurado. Rechazando webhook.');
    return false;
  }

  if (!signatureHeader) return false;

  // Parsear: "t=1689066169,v1=e997b87453fb8923..."
  const parts = {};
  signatureHeader.split(',').forEach(part => {
    const [key, ...rest] = part.trim().split('=');
    parts[key] = rest.join('=');
  });

  const timestamp = parts['t'];
  const signature = parts['v1'];

  if (!timestamp || !signature) {
    console.warn('[Alyto OwlPay] Formato de harbor-signature inválido:', signatureHeader);
    return false;
  }

  // signed_payload = "timestamp.rawBody"
  const signedPayload = `${timestamp}.${rawBody}`;

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,  'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    // timingSafeEqual lanza si los buffers no tienen el mismo tamaño
    return false;
  }
}
