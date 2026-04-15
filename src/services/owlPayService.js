/**
 * owlPayService.js — Motor de Liquidez OwlPay Harbor (v2)
 *
 * Integración completa con Harbor API v2:
 *   - On-ramp USD→USDC/Stellar (Escenario A, LLC): createOnRampOrder
 *   - Off-ramp USDC→fiat local (Escenario C, SRL / A LLC): flujo de 3 pasos
 *       1. getHarborQuote                     → POST /v2/transfers/quotes
 *       2. getHarborTransferRequirements      → GET  /v2/transfers/quotes/{id}/requirements
 *       3. createHarborTransfer               → POST /v2/transfers
 *     Harbor devuelve una `instruction_address` a la que Alyto debe enviar
 *     los USDC. Una vez recibidos, Harbor convierte y dispersa en moneda local.
 *
 * Docs: https://harbor-developers.owlpay.com/docs/overview
 *
 * COMPLIANCE: Terminología prohibida ausente (remesa/remittances).
 * Usar: crossBorderPayment, payin, onRamp, offRamp, liquidation.
 */

import crypto from 'crypto';

// ─── Configuración ────────────────────────────────────────────────────────────

// Base URL sin versión — cada endpoint incluye /v1/ o /v2/ explícitamente.
const OWLPAY_BASE_URL = (() => {
  let baseUrl = (process.env.OWLPAY_BASE_URL
              ?? process.env.OWLPAY_API_URL
              ?? 'https://harbor-sandbox.owlpay.com/api').trim();

  baseUrl = baseUrl.replace(/\/$/, '');
  baseUrl = baseUrl.replace(/\/v\d+$/, '');
  if (!baseUrl.endsWith('/api')) {
    baseUrl = `${baseUrl}/api`;
  }
  return baseUrl;
})();

export function getOwlPayApiKey() {
  const key = process.env.OWLPAY_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('[Alyto OwlPay] Missing OWLPAY_API_KEY. Verificar .env o AWS Secrets Manager.');
  }
  return key;
}

export function getOwlPayBaseUrl() {
  return OWLPAY_BASE_URL;
}

function isSandbox() {
  return /sandbox/i.test(OWLPAY_BASE_URL);
}

/**
 * Resuelve el customerUuid de Harbor para la entidad legal.
 * Exportado para que los controllers puedan resolverlo sin duplicar lógica.
 * @param {'LLC'|'SpA'|'SRL'} legalEntity
 * @returns {string}
 */
export function getCustomerUuid(legalEntity) {
  const ENTITY_CUSTOMER_UUID = {
    LLC: process.env.OWLPAY_CUSTOMER_UUID_LLC,
    SpA: process.env.OWLPAY_CUSTOMER_UUID_SPA,
    SRL: process.env.OWLPAY_CUSTOMER_UUID_SRL,
  };

  const uuid = ENTITY_CUSTOMER_UUID[legalEntity];
  if (!uuid) {
    throw new Error(
      `[OwlPay] No Harbor customerUuid configured for entity: ${legalEntity}. ` +
      `Set OWLPAY_CUSTOMER_UUID_${(legalEntity ?? '').toUpperCase()} in env.`,
    );
  }
  return uuid;
}

/**
 * Helper interno: llamada autenticada a Harbor API.
 */
async function owlPayRequest(endpoint, options = {}) {
  const apiKey = getOwlPayApiKey();
  const url    = `${OWLPAY_BASE_URL}${endpoint}`;

  console.info(`[OwlPay] ${options.method ?? 'GET'} ${url}`);

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
    throw new Error(`[Alyto OwlPay] Error de red: ${networkError.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`[Alyto OwlPay] Respuesta no-JSON de Harbor (status ${response.status})`);
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

// ═════════════════════════════════════════════════════════════════════════════
// ON-RAMP (Escenario A — LLC): USD wire → USDC en wallet Stellar del cliente
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Crea una orden de on-ramp (fiat USD → USDC Stellar) para un cliente institucional LLC.
 * Flujo v2: quote → transfer. Devuelve instrucciones wire transfer para el cliente.
 */
export async function createOnRampOrder({
  amount,
  currency,
  destinationWallet,
  userId,
  alytoTransactionId,
  legalEntity,
  memo,
  customerUuid,
  beneficiary = {},
}) {
  if (currency !== 'USD') throw new Error('[Alyto OwlPay] El on-ramp opera en USD.');
  if (!destinationWallet || !/^G[A-Z2-7]{55}$/.test(destinationWallet)) {
    throw new Error('[Alyto OwlPay] destinationWallet debe ser una Stellar public key válida.');
  }
  if (!amount || amount <= 0) throw new Error('[Alyto OwlPay] amount debe ser positivo en USD.');

  const resolvedCustomerUuid = customerUuid ?? getCustomerUuid(legalEntity);

  const quotePayload = {
    source:      { country: 'US', asset: 'USD', type: 'individual' },
    destination: { chain: 'stellar', asset: 'USDC', amount, type: 'individual' },
    commission:  { amount: 0, percentage: 0 },
  };

  const quoteRes = await owlPayRequest('/v2/transfers/quotes', {
    method: 'POST',
    body:   JSON.stringify(quotePayload),
  });

  const quote   = quoteRes.data?.[0] ?? quoteRes.data ?? quoteRes;
  const quoteId = quote.id ?? quote.quote_id;
  if (!quoteId) throw new Error('[Alyto OwlPay] No se obtuvo quote_id (on-ramp).');

  const transferPayload = {
    on_behalf_of:              resolvedCustomerUuid,
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
    amount:               Number(transfer.source?.amount) || amount,
    currency:             transfer.source?.asset ?? 'USD',
    destinationWallet:    transfer.destination?.payout_instrument?.address ?? destinationWallet,
    estimatedUSDC:        Number(transfer.destination?.amount) || null,
    paymentUrl:           null,
    transferInstructions: transfer.transfer_instructions ?? null,
  };
}

export async function getOnRampOrderStatus(orderId) {
  return owlPayRequest(`/v2/transfers/${orderId}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// OFF-RAMP (Escenarios A y C): USDC Stellar/ETH → fiat local
// Flujo de 3 pasos: quote → requirements → transfer
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PASO 1 — Obtiene una quote de off-ramp.
 *
 * @param {object} params
 * @param {number} params.sourceAmount           USDC amount a enviar
 * @param {string} params.sourceCurrency         'USDC'
 * @param {string} params.sourceChain            'stellar' | 'ethereum' (pendiente Sam)
 * @param {string} params.destCountry            ISO alpha-2 ej 'CN', 'NG'
 * @param {string} params.destCurrency           ISO 4217 ej 'CNY', 'NGN'
 * @param {string} params.customerUuid           Harbor customer UUID
 * @param {number} [params.commissionPercent]    % comisión (default 0.5)
 * @returns {Promise<object>} quote normalizado
 */
export async function getHarborQuote({
  sourceAmount,
  sourceCurrency,
  sourceChain,
  destCountry,
  destCurrency,
  customerUuid,
  commissionPercent,
}) {
  if (!sourceAmount || sourceAmount <= 0) {
    throw new Error('[Harbor] sourceAmount debe ser positivo.');
  }
  if (!sourceCurrency || !sourceChain) {
    throw new Error('[Harbor] sourceCurrency y sourceChain son requeridos.');
  }
  if (!destCountry || !destCurrency) {
    throw new Error('[Harbor] destCountry y destCurrency son requeridos.');
  }

  const payload = {
    source: {
      chain:   sourceChain,
      country: 'US',
      asset:   sourceCurrency,
      amount:  Number(sourceAmount).toFixed(2),
    },
    destination: {
      country: destCountry.toUpperCase(),
      asset:   destCurrency.toUpperCase(),
    },
    commission: {
      percentage: String(commissionPercent ?? 0.5),
      amount:     0,
    },
  };

  if (customerUuid) payload.on_behalf_of = customerUuid;

  const res   = await owlPayRequest('/v2/transfers/quotes', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  // Harbor puede devolver múltiples métodos de pago — tomar el primero (menor fee típicamente).
  const list  = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : [res]);
  const quote = list[0];
  if (!quote?.id && !quote?.quote_id) {
    throw new Error('[Harbor] No se obtuvo quote_id en la respuesta.');
  }

  return {
    quoteId:               quote.id ?? quote.quote_id,
    paymentMethod:         quote.payment_method ?? quote.destination?.payment_method ?? null,
    sourceAmount:          Number(quote.source?.amount   ?? quote.source_amount      ?? sourceAmount),
    sourceCurrency:        quote.source?.asset           ?? quote.source_currency    ?? sourceCurrency,
    destinationAmount:     Number(quote.destination?.amount ?? quote.destination_amount ?? 0),
    destinationCurrency:   quote.destination?.asset      ?? quote.destination_currency ?? destCurrency,
    exchangeRate:          Number(quote.exchange_rate    ?? quote.rate               ?? 0),
    settlementTimeMin:     quote.settlement_time_min     ?? null,
    settlementTimeMax:     quote.settlement_time_max     ?? null,
    settlementTimeUnit:    quote.settlement_time_unit    ?? null,
    quoteExpiresAt:        quote.expires_at              ?? quote.quote_expires_at   ?? null,
    cryptoFundsExpiresAt:  quote.crypto_funds_settlement_expire_date
                          ?? quote.crypto_funds_expires_at ?? null,
    harborFee:             Number(quote.fees?.harbor_fee     ?? quote.harbor_fee     ?? 0),
    commissionFee:         Number(quote.fees?.commission_fee ?? quote.commission_fee ?? 0),
    raw:                   quote,
  };
}

// ── Cache de requirements (JSON Schema) por quote y por país ─────────────────
const requirementsCache = new Map();   // quoteId  → { requirements, cachedAt }
const requirementsByCountryCache = new Map();  // destCountry → { requirements, cachedAt }
const REQUIREMENTS_TTL_MS = 5 * 60 * 1000;

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > REQUIREMENTS_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.requirements;
}

function cacheSet(map, key, requirements) {
  map.set(key, { requirements, cachedAt: Date.now() });
}

/**
 * PASO 2 — Obtiene el JSON Schema de campos requeridos por el beneficiario.
 * Los campos cambian por país y por método de pago. Harbor los entrega dinámicos.
 */
export async function getHarborTransferRequirements({ quoteId, destCountry }) {
  if (!quoteId) throw new Error('[Harbor] quoteId requerido para fetch requirements.');

  const cached = cacheGet(requirementsCache, quoteId);
  if (cached) return cached;

  const res = await owlPayRequest(`/v2/transfers/quotes/${quoteId}/requirements`, {
    method: 'GET',
  });

  const payload = res.data ?? res;
  const normalized = {
    schema:    payload.schema    ?? payload.json_schema ?? payload,
    title:     payload.title     ?? null,
    bankTitle: payload.bank_title ?? payload.bankTitle  ?? null,
    raw:       payload,
  };

  cacheSet(requirementsCache, quoteId, normalized);
  if (destCountry) cacheSet(requirementsByCountryCache, destCountry.toUpperCase(), normalized);

  return normalized;
}

export function getCachedRequirementsByCountry(destCountry) {
  if (!destCountry) return null;
  return cacheGet(requirementsByCountryCache, destCountry.toUpperCase());
}

/**
 * Construye el payout_instrument por país según la firma de Harbor.
 * Lee de beneficiary.dynamicFields (o propiedades top-level como fallback).
 */
export function buildPayoutInstrument(beneficiary, destCountry) {
  const df     = beneficiary?.dynamicFields instanceof Map
               ? Object.fromEntries(beneficiary.dynamicFields.entries())
               : (beneficiary?.dynamicFields ?? {});
  const get    = (key) => df[key] ?? beneficiary?.[key] ?? null;
  const must   = (key, label) => {
    const v = get(key);
    if (!v) throw new Error(`[Harbor] Missing required field for ${destCountry}: ${label ?? key}`);
    return v;
  };

  const country = (destCountry ?? '').toUpperCase();

  switch (country) {
    case 'CN': {
      const unionPay = get('cn_union_pay_card_number');
      if (unionPay) return { cn_union_pay_card_number: unionPay };
      return {
        cn_bank_account_number: must('cn_bank_account_number'),
        cn_cnaps_code:          must('cn_cnaps_code'),
      };
    }
    case 'NG':
      return {
        ng_account_number: must('ng_account_number'),
        ng_bank_code:      must('ng_bank_code'),
      };
    case 'BR': {
      const pix = get('br_pix_key');
      if (pix) return { br_pix_key: pix };
      return {
        br_bank_code:       must('br_bank_code'),
        br_agency:          must('br_agency'),
        br_account_number:  must('br_account_number'),
      };
    }
    case 'MX': {
      const clabe = get('mx_clabe');
      if (clabe) return { mx_clabe: clabe };
      const card = get('mx_debit_card_number');
      if (card) return { mx_debit_card_number: card };
      throw new Error(`[Harbor] Missing required field for MX: mx_clabe o mx_debit_card_number`);
    }
    case 'CO':
      return {
        co_bank_code:     must('co_bank_code'),
        co_account_number: must('co_account_number'),
        co_account_type:  must('co_account_type'),
      };
    case 'HK':
      return {
        account_number:      must('account_number'),
        swift_code:          must('swift_code'),
        bank_name:           must('bank_name'),
        account_holder_name: get('account_holder_name')
                           ?? `${beneficiary?.firstName ?? ''} ${beneficiary?.lastName ?? ''}`.trim(),
      };
    default:
      return {
        account_number:      must('account_number'),
        swift_code:          must('swift_code'),
        bank_name:           must('bank_name'),
        account_holder_name: get('account_holder_name')
                           ?? `${beneficiary?.firstName ?? ''} ${beneficiary?.lastName ?? ''}`.trim(),
      };
  }
}

/**
 * PASO 3 — Crea el transfer en Harbor. Devuelve la instruction_address a la
 * que Alyto debe enviar los USDC para activar el disbursement.
 */
export async function createHarborTransfer({
  quoteId,
  customerUuid,
  alytoTransactionId,
  sourceAddress,
  beneficiary,
  destCountry,
  destCurrency,
}) {
  if (!quoteId)            throw new Error('[Harbor] quoteId requerido.');
  if (!customerUuid)       throw new Error('[Harbor] customerUuid requerido.');
  if (!alytoTransactionId) throw new Error('[Harbor] alytoTransactionId requerido (idempotency).');
  if (!sourceAddress)      throw new Error('[Harbor] sourceAddress (wallet Alyto) requerido.');
  if (!beneficiary)        throw new Error('[Harbor] beneficiary requerido.');
  if (!destCountry)        throw new Error('[Harbor] destCountry requerido.');

  const payoutInstrument = buildPayoutInstrument(beneficiary, destCountry);

  const payload = {
    on_behalf_of:              customerUuid,
    quote_id:                  quoteId,
    application_transfer_uuid: alytoTransactionId,
    source: {
      payment_instrument: { address: sourceAddress },
    },
    destination: {
      beneficiary_info: {
        beneficiary_name:          `${beneficiary.firstName ?? ''} ${beneficiary.lastName ?? ''}`.trim(),
        beneficiary_dob:           beneficiary.dateOfBirth ?? beneficiary.dob ?? '1990-01-01',
        beneficiary_id_doc_number: beneficiary.documentNumber ?? beneficiary.idDocNumber ?? '',
        beneficiary_address: {
          street:  beneficiary.address?.street  ?? beneficiary.address     ?? 'N/A',
          city:    beneficiary.address?.city    ?? 'N/A',
          country: (destCountry ?? '').toUpperCase(),
        },
      },
      payout_instrument:  payoutInstrument,
      transfer_purpose:   'FAMILY_MAINTENANCE',
      is_self_transfer:   false,
    },
  };

  const res      = await owlPayRequest('/v2/transfers', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
  const transfer = res.data ?? res;

  const instructions = transfer.transfer_instructions
                    ?? transfer.source?.transfer_instructions
                    ?? {};
  const instructionAddress = instructions.instruction_address
                          ?? instructions.address
                          ?? transfer.source?.payment_instrument?.address
                          ?? null;
  const instructionMemo    = instructions.instruction_memo
                          ?? instructions.address_memo
                          ?? instructions.memo
                          ?? null;
  const instructionChain   = instructions.chain
                          ?? transfer.source?.chain
                          ?? null;

  return {
    harborTransferId:     transfer.uuid ?? transfer.id,
    status:               transfer.status ?? 'pending_customer_transfer_start',
    instructionAddress,
    instructionMemo,
    instructionChain,
    sourceAmount:         Number(transfer.source?.amount      ?? transfer.source_amount      ?? 0),
    destinationAmount:    Number(transfer.destination?.amount ?? transfer.destination_amount ?? 0),
    destinationCurrency:  transfer.destination?.asset         ?? destCurrency,
    expiresAt:            transfer.crypto_funds_settlement_expire_date
                        ?? transfer.expires_at ?? null,
    raw:                  transfer,
  };
}

export async function getHarborTransferStatus({ harborTransferId }) {
  if (!harborTransferId) throw new Error('[Harbor] harborTransferId requerido.');
  const res      = await owlPayRequest(`/v2/transfers/${harborTransferId}`, { method: 'GET' });
  const transfer = res.data ?? res;
  return {
    status:         transfer.status ?? 'unknown',
    sourceReceived: Number(transfer.source?.received_amount ?? transfer.source_received ?? 0),
    updatedAt:      transfer.updated_at ?? null,
    raw:            transfer,
  };
}

/**
 * Sandbox-only — fuerza una transición de estado en un transfer (testing).
 * Sin efecto en producción.
 */
export async function simulateHarborTransfer({ harborTransferId, status }) {
  if (!isSandbox()) {
    throw new Error('[Harbor] simulateHarborTransfer solo disponible en sandbox.');
  }
  return owlPayRequest(`/v2/transfers/${harborTransferId}/simulate`, {
    method: 'POST',
    body:   JSON.stringify({ status }),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// USDC SEND PLACEHOLDER — paso final del off-ramp
// Pendiente de confirmación de Sam sobre la cadena soportada por Harbor.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Envía USDC desde la wallet de Alyto hacia la instruction_address de Harbor.
 *
 * ⚠️ IMPLEMENTACIÓN PENDIENTE — Sam debe confirmar la cadena que Harbor acepta
 * para off-ramp de moneda local. Docs indican `ethereum`; nuestra infra usa Stellar.
 *
 * Una vez confirmado, implementar:
 *   A) Stellar → stellarService.buildInnerTransaction (USDC) + memo
 *   B) Ethereum → ethers.js / web3 enviando USDC ERC-20
 *
 * Mientras tanto, arroja para garantizar que OWLPAY_USDC_SEND_ENABLED=0 se respeta
 * y que el flujo caiga al email manual al admin.
 */
export async function sendUSDCToHarbor({
  instructionAddress,
  instructionMemo,
  instructionChain,
  amount,
  alytoTransactionId,
}) {
  throw new Error(
    `[OwlPay] sendUSDCToHarbor not yet implemented. ` +
    `Waiting for Harbor chain confirmation (chain: ${instructionChain ?? 'unknown'}). ` +
    `Manual send required for tx: ${alytoTransactionId}`,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK SIGNATURE VERIFICATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Verifica la firma HMAC-SHA256 del webhook de Harbor.
 * Header: 'harbor-signature' con formato "t=<ts>,v1=<hex>"
 * signed_payload = "<timestamp>.<rawBody>"
 */
export function verifyOwlPayWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.OWLPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Alyto OwlPay] OWLPAY_WEBHOOK_SECRET no configurado. Rechazando webhook.');
    return false;
  }
  if (!signatureHeader) return false;

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
    return false;
  }
}
