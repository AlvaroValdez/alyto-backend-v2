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
 * Crea una orden de on-ramp (fiat → USDC) en Harbor/OwlPay usando el flujo Transfer v2.
 *
 * Flujo de 3 pasos:
 *   1. POST /v2/transfers/quotes    → obtener quote_id y pricing
 *   2. (requirements omitido — schema conocido para Stellar on-ramp desde US)
 *   3. POST /v2/transfers           → crear el transfer con on_behalf_of
 *
 * @param {object} params
 * @param {number} params.amount              - Monto en USD
 * @param {string} params.currency            - ISO 4217, debe ser 'USD'
 * @param {string} params.destinationWallet   - Stellar public key del cliente destino
 * @param {string} params.userId              - ID interno Alyto (metadata y fallback)
 * @param {string} params.alytoTransactionId  - Idempotency key
 * @param {string} [params.memo]              - Memo Stellar (opcional)
 * @param {string} [params.customerUuid]      - UUID del customer en Harbor (on_behalf_of)
 * @param {object} [params.beneficiary]       - Datos del beneficiario para Harbor
 * @returns {Promise<OnRampOrderResult>}
 *
 * @typedef {Object} OnRampOrderResult
 * @property {string}      orderId               - UUID del transfer en Harbor
 * @property {string}      status                - Estado inicial
 * @property {number}      amount                - Monto confirmado en USD
 * @property {string}      currency              - Moneda ('USD')
 * @property {string}      destinationWallet     - Stellar public key destino
 * @property {number|null} estimatedUSDC         - USDC estimado a entregar
 * @property {null}        paymentUrl            - No aplica en Harbor v2
 * @property {object|null} transferInstructions  - Instrucciones wire transfer de Harbor
 */
export async function createOnRampOrder({
  amount,
  currency,
  destinationWallet,
  userId,
  alytoTransactionId,
  memo,
  customerUuid,
  beneficiary = {},
}) {
  if (currency !== 'USD') throw new Error('[Alyto OwlPay] El on-ramp opera en USD.');
  if (!destinationWallet || !/^G[A-Z2-7]{55}$/.test(destinationWallet)) {
    throw new Error('[Alyto OwlPay] destinationWallet debe ser una Stellar public key válida.');
  }
  if (!amount || amount <= 0) throw new Error('[Alyto OwlPay] amount debe ser positivo en USD.');

  // ── PASO 1: Obtener quote ─────────────────────────────────────────────────
  const quotePayload = {
    source: {
      country: 'US',
      asset:   'USD',
      type:    'individual',
    },
    destination: {
      chain:  'stellar',
      asset:  'USDC',
      amount,
      type:   'individual',
    },
    commission: { amount: 0, percentage: 0 },
  };

  const quoteRes = await owlPayRequest('/v2/transfers/quotes', {
    method: 'POST',
    body:   JSON.stringify(quotePayload),
  });

  const quote   = quoteRes.data?.[0] ?? quoteRes.data ?? quoteRes;
  const quoteId = quote.id ?? quote.quote_id;
  if (!quoteId) throw new Error('[Alyto OwlPay] No se obtuvo quote_id de Harbor.');

  console.info('[Alyto OwlPay] Quote obtenido:', {
    quoteId,
    sourceAmount:      quote.source_amount,
    destinationAmount: quote.destination_amount,
    alytoTransactionId,
    walletPrefix:      destinationWallet.substring(0, 8) + '...',
  });

  // ── PASO 2: Requirements (omitido — schema conocido para Stellar on-ramp) ─

  // ── PASO 3: Crear el transfer ─────────────────────────────────────────────
  const transferPayload = {
    on_behalf_of:              customerUuid ?? userId,
    quote_id:                  quoteId,
    application_transfer_uuid: alytoTransactionId,
    destination: {
      beneficiary_info: {
        beneficiary_name:          beneficiary.name        ?? 'AV Finance LLC',
        beneficiary_dob:           beneficiary.dob         ?? '1990-01-01',
        beneficiary_id_doc_number: beneficiary.idDocNumber ?? 'LLC-001',
        beneficiary_address: {
          street:         beneficiary.street  ?? '1201 N Market St',
          city:           beneficiary.city    ?? 'Wilmington',
          state_province: beneficiary.state   ?? 'DE',
          postal_code:    beneficiary.postal  ?? '19801',
          country:        beneficiary.country ?? 'US',
        },
      },
      payout_instrument: {
        address:      destinationWallet,
        address_memo: memo ?? null,
      },
      transfer_purpose:                  'TRANSFER_TO_OWN_ACCOUNT',
      is_self_transfer:                  true,
      beneficiary_receiving_wallet_type: 'businessWallet',
      beneficiary_institution_name:      'Stellar Network',
    },
  };

  const transferRes = await owlPayRequest('/v2/transfers', {
    method: 'POST',
    body:   JSON.stringify(transferPayload),
  });

  const transfer = transferRes.data ?? transferRes;

  return {
    orderId:              transfer.uuid          ?? transfer.id,
    status:               transfer.status        ?? 'pending',
    amount:               Number(transfer.source?.amount)      || amount,
    currency:             transfer.source?.asset               ?? 'USD',
    destinationWallet:    transfer.destination?.payout_instrument?.address ?? destinationWallet,
    estimatedUSDC:        Number(transfer.destination?.amount) || null,
    paymentUrl:           null,
    transferInstructions: transfer.transfer_instructions       ?? null,
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
