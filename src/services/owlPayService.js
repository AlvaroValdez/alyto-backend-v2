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
import { BoundedCache } from '../utils/boundedCache.js';

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
 * Resuelve el customerUuid de Harbor.
 *
 * Per MSA firmado 30/03/2026 (Harbor Services Agreement v1.0): hay UN solo
 * Customer en Harbor → **AV Finance LLC** (Delaware). SRL/SpA son entidades
 * operativas internas (Users/Affiliates per Schedule A del MSA), NO Customers
 * separados en Harbor. Todas las transacciones van con el mismo on_behalf_of.
 *
 * Schedule C del MSA cubre off-ramp a: EU / UAE / China / Brazil / Mexico / US.
 * Otros corredores (NG, IN, HK, SG) habilitados via Harbor sandbox expansion.
 * GB / JP requieren amendment al Schedule C para activarse.
 *
 * Variables de entorno (en orden de preferencia):
 *   OWLPAY_CUSTOMER_UUID       — nombre canónico (recomendado)
 *   OWLPAY_CUSTOMER_UUID_LLC   — alias específico (entidad signataria del MSA)
 *   OWLPAY_CUSTOMER_UUID_SRL   — legacy (mal nombrado; contiene el UUID de LLC)
 *
 * @param {string|null} [legalEntity] - Solo para logging interno; no afecta UUID
 * @returns {string|null} Harbor customer UUID, o null si no está configurado
 */
export function getCustomerUuid(legalEntity) {
  const uuid = process.env.OWLPAY_CUSTOMER_UUID
            ?? process.env.OWLPAY_CUSTOMER_UUID_LLC
            ?? process.env.OWLPAY_CUSTOMER_UUID_SRL  // legacy fallback
            ?? null;

  if (!uuid) {
    console.warn('[OwlPay] Customer UUID no configurado en ninguna variable: '
               + 'OWLPAY_CUSTOMER_UUID / OWLPAY_CUSTOMER_UUID_LLC / OWLPAY_CUSTOMER_UUID_SRL');
    return null;
  }

  if (legalEntity) {
    // legalEntity es solo trazabilidad interna — el UUID es siempre el de LLC.
    // (no se usa para resolver el UUID; se loguea en tryOwlPayV2 si es útil)
  }

  return uuid;
}

/**
 * Helper interno: llamada autenticada a Harbor API.
 */
async function owlPayRequest(endpoint, options = {}) {
  const apiKey    = getOwlPayApiKey();
  const url       = `${OWLPAY_BASE_URL}${endpoint}`;
  const method    = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 10000;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt  = Date.now();

  const headers = {
    'X-API-KEY':    apiKey,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    ...(options.headers ?? {}),
  };

  try {
    let response;
    try {
      response = await fetch(url, { ...options, headers, signal: controller.signal });
    } catch (networkError) {
      if (networkError.name === 'AbortError') {
        const err = new Error(`OwlPay API timeout after ${timeoutMs}ms for ${method} ${endpoint}`);
        err.code        = 'OWLPAY_TIMEOUT';
        err.isTransient = true;
        throw err;
      }
      const err = new Error(`[Alyto OwlPay] Error de red: ${networkError.message}`);
      err.isTransient = true;
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    console.info(`[OwlPay] ${method} ${endpoint} → ${response.status} (${latencyMs}ms)`);

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
      const err = new Error(
        `[Alyto OwlPay] Error ${response.status}: ${data?.message ?? data?.error?.message ?? 'Error desconocido'}`,
      );
      err.status      = response.status;
      err.data        = data;
      err.isTransient = response.status >= 500;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(timeoutId);
  }
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
  returnAll = false,
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
      type:    'individual',
      chain:   sourceChain,
      country: 'US',
      asset:   sourceCurrency,
      amount:  Number(sourceAmount).toFixed(2),
    },
    destination: {
      type:    'individual',
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

  // Harbor puede devolver múltiples métodos de pago. Por default tomamos el primero
  // (mejor rate típicamente). Pasar returnAll: true para recibir el array completo
  // (útil cuando el caller necesita elegir por payment_method, ej. CIPS vs WIRE).
  const list  = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : [res]);
  if (!list.length || (!list[0]?.id && !list[0]?.quote_id)) {
    throw new Error('[Harbor] No se obtuvo quote_id en la respuesta.');
  }

  const normalize = (q) => ({
    quoteId:               q.id ?? q.quote_id,
    paymentMethod:         q.payment_method ?? q.destination?.payment_method ?? null,
    paymentMethodLabel:    q.payment_method_label ?? q.payment_method ?? null,
    sourceAmount:          Number(q.source?.amount   ?? q.source_amount      ?? sourceAmount),
    sourceCurrency:        q.source?.asset           ?? q.source_currency    ?? sourceCurrency,
    destinationAmount:     Number(q.destination?.amount ?? q.destination_amount ?? 0),
    destinationCurrency:   q.destination?.asset      ?? q.destination_currency ?? destCurrency,
    exchangeRate:          Number(q.exchange_rate    ?? q.rate               ?? 0),
    settlementTimeMin:     q.settlement_time_min     ?? q.fiat_settlement_time_min ?? null,
    settlementTimeMax:     q.settlement_time_max     ?? q.fiat_settlement_time_max ?? null,
    settlementTimeUnit:    q.settlement_time_unit    ?? q.fiat_settlement_time_unit ?? null,
    quoteExpiresAt:        q.expires_at              ?? q.quote_expires_at   ?? q.quote_expire_date ?? null,
    cryptoFundsExpiresAt:  q.crypto_funds_settlement_expire_date
                          ?? q.crypto_funds_expires_at ?? null,
    harborFee:             Number(q.fees?.harbor_fee     ?? q.harbor_fee     ?? 0),
    commissionFee:         Number(q.fees?.commission_fee ?? q.commission_fee ?? 0),
    raw:                   q,
  });

  return returnAll ? list.map(normalize) : normalize(list[0]);
}

// ── Cache de requirements (JSON Schema) por quote y por país ─────────────────
// BoundedCache: max 500 entries, 5-min TTL → previene crecimiento ilimitado por quoteId.
const REQUIREMENTS_TTL_MS = 5 * 60 * 1000;
const requirementsCache          = new BoundedCache(500, REQUIREMENTS_TTL_MS);  // quoteId    → requirements
const requirementsByCountryCache = new BoundedCache(50,  REQUIREMENTS_TTL_MS);  // destCountry → requirements

function cacheGet(cache, key) {
  const v = cache.get(key);
  return v === undefined ? null : v;
}

function cacheSet(cache, key, requirements) {
  cache.set(key, requirements);
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
 * Mapea 'EU' a un país SEPA concreto para Harbor.
 * Si se proporciona un IBAN, extrae el país de los primeros 2 chars (ISO-2).
 * Fallback: 'DE' (proxy para quote cuando no hay IBAN todavía).
 * Harbor no acepta 'EU' como country code — necesita un ISO-2 real.
 */
export function resolveHarborCountry(destCountry, ibanOrAccount) {
  if ((destCountry ?? '').toUpperCase() !== 'EU') return destCountry;
  if (ibanOrAccount && /^[A-Z]{2}\d/i.test(String(ibanOrAccount).trim())) {
    return String(ibanOrAccount).trim().slice(0, 2).toUpperCase();
  }
  return 'DE';
}

/**
 * Construye el payout_instrument por país/método según el schema oficial Harbor.
 *
 * TODOS los schemas validados via GET /v2/transfers/quotes/:id/requirements
 * (ver scripts/inspect-harbor-all-schemas.js). Todos usan
 * additionalProperties: false — cualquier campo extra produce error 2005.
 *
 * @param {object}      beneficiary    - rawBeneficiary con dynamicFields
 * @param {string}      destCountry    - ISO alpha-2 país destino
 * @param {string|null} paymentMethod  - método Harbor (SEPA/WIRE/CIPS/CHATS/...)
 */
export function buildPayoutInstrument(beneficiary, destCountry, paymentMethod = null) {
  const df = beneficiary?.dynamicFields instanceof Map
           ? Object.fromEntries(beneficiary.dynamicFields.entries())
           : (beneficiary?.dynamicFields ?? {});
  const get  = (key) => df[key] ?? beneficiary?.[key] ?? null;
  const must = (key, label) => {
    const v = get(key);
    if (!v) throw new Error(`[Harbor] Missing required field for ${destCountry}: ${label ?? key}`);
    return v;
  };
  const fallbackHolder = `${beneficiary?.firstName ?? ''} ${beneficiary?.lastName ?? ''}`.trim();
  const holder = () => get('account_holder_name') || fallbackHolder || must('account_holder_name');

  const country = (destCountry ?? '').toUpperCase();
  const method  = (paymentMethod ?? '').toUpperCase();

  switch (country) {
    // ── CN: CIPS, WIRE — mismo schema ────────────────────────────────────────
    // required: account_holder_name, bank_name, account_number, swift_code
    case 'CN': {
      return {
        account_holder_name: holder(),
        bank_name:           must('bank_name'),
        account_number:      must('account_number'),
        swift_code:          must('swift_code'),
      };
    }

    // ── NG: BANK-TRANSFER ─────────────────────────────────────────────────────
    // required: account_holder_name, bank_name, account_number
    case 'NG': {
      return {
        account_holder_name: holder(),
        bank_name:           must('bank_name'),
        account_number:      get('account_number') ?? must('ng_account_number'),
      };
    }

    // ── BR: PIX ──────────────────────────────────────────────────────────────
    // Schema dice: required br_cpf only (^\d{11}$), oneOf phone/email/br_pix_evp.
    // Implementación REAL verificada end-to-end (scripts/audit-harbor-end-to-end.js):
    //   - br_cpf debe pasar validación mod-11 brasileña (no CPFs ficticios)
    //   - DEBE incluir EXACTAMENTE UNO de: phone_number, email, br_pix_evp
    //     (PIX key del beneficiario). Solo br_cpf falla con 2005 missing.
    case 'BR': {
      const cpf   = must('br_cpf');
      const phone = get('phone_number');
      const email = get('email');
      const evp   = get('br_pix_evp');
      const altKeys = [phone, email, evp].filter(Boolean);
      if (altKeys.length === 0) {
        throw new Error(
          '[Harbor] BR PIX requiere una chave PIX adicional al CPF: ' +
          'phone_number (+5511...), email, o br_pix_evp (UUID)'
        );
      }
      if (altKeys.length > 1) {
        throw new Error(
          '[Harbor] BR PIX acepta solo UNA chave alternativa: ' +
          'elegir entre phone_number, email o br_pix_evp (no múltiples)'
        );
      }
      const result = { br_cpf: cpf };
      if (phone) result.phone_number = phone;
      if (email) result.email        = email;
      if (evp)   result.br_pix_evp   = evp;
      return result;
    }

    // ── MX: SPEI ─────────────────────────────────────────────────────────────
    // required: mx_clabe (^[0-9]{18}$) — UNICO campo permitido
    case 'MX': {
      const clabe = must('mx_clabe');
      if (!/^[0-9]{18}$/.test(clabe)) {
        throw new Error('[Harbor] mx_clabe debe ser exactamente 18 dígitos');
      }
      return { mx_clabe: clabe };
    }

    // ── CO: Harbor inactivo — CL→CO/BO→CO usa Vita ───────────────────────────
    case 'CO':
      return {
        co_bank_code:      must('co_bank_code'),
        co_account_number: must('co_account_number'),
        co_account_type:   must('co_account_type'),
      };

    // ── HK: CHATS (+ bank_code) / WIRE ────────────────────────────────────────
    // CHATS required: account_holder_name, bank_name, account_number, swift_code, bank_code
    // WIRE  required: account_holder_name, bank_name, account_number, swift_code
    case 'HK': {
      const base = {
        account_holder_name: holder(),
        bank_name:           must('bank_name'),
        account_number:      must('account_number'),
        swift_code:          must('swift_code'),
      };
      if (method === 'CHATS') {
        base.bank_code = must('bank_code'); // ^\d{3}$
      }
      return base;
    }

    // ── IN: IMPS ─────────────────────────────────────────────────────────────
    // required: bank_code (IFSC ^[A-Z]{4}0[A-Z0-9]{6}$), account_number
    // No incluye account_holder_name en payout_instrument
    case 'IN': {
      return {
        bank_code:      must('bank_code'),
        account_number: must('account_number'),
      };
    }

    // ── EU SEPA/WIRE ─────────────────────────────────────────────────────────
    // SEPA required: account_holder_name, account_number (IBAN)
    // WIRE required: account_holder_name, bank_name, account_number, swift_code
    case 'EU':
    case 'DE': case 'FR': case 'ES': case 'IT': case 'NL':
    case 'BE': case 'PT': case 'AT': case 'PL': case 'SE':
    case 'CH': case 'NO': case 'DK': case 'FI': case 'IE': {
      const iban = get('iban') ?? get('account_number');
      if (method === 'WIRE') {
        return {
          account_holder_name: holder(),
          bank_name:           must('bank_name'),
          account_number:      iban ?? must('iban', 'IBAN'),
          swift_code:          get('bic') ?? must('swift_code', 'BIC/SWIFT'),
        };
      }
      // SEPA default
      return {
        account_holder_name: holder(),
        account_number:      iban ?? must('iban', 'IBAN'),
      };
    }

    // ── GB: FPS ──────────────────────────────────────────────────────────────
    // Corredor SRL no activo en sandbox — esperando LLC.
    // Schema asumido basado en UK Faster Payments standard.
    case 'GB':
      return {
        account_holder_name: holder(),
        account_number:      must('account_number'),
        sort_code:           must('sort_code'),
      };

    // ── US: ACH_PUSH, DOMESTIC_WIRE, FEDWIRE, WIRE — todos mismo schema ──────
    // required: account_holder_name, bank_name, account_number, routing_number (^[0-9]{9}$)
    case 'US':
      return {
        account_holder_name: holder(),
        bank_name:           must('bank_name'),
        account_number:      must('account_number'),
        routing_number:      must('routing_number'),
      };

    // ── AE: FTS, AANI, BANK-TRANSFER — mismo schema ──────────────────────────
    // required: account_holder_name, phone_number (^\+971[0-9]{8,9}$),
    //           swift_code, account_number (IBAN ^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$)
    // NOTA: NO incluye bank_name
    case 'AE': {
      return {
        account_holder_name: holder(),
        phone_number:        must('phone_number'),
        swift_code:          must('swift_code'),
        account_number:      get('iban') ?? must('account_number'),
      };
    }

    // ── SG: BANK-TRANSFER ────────────────────────────────────────────────────
    // required: account_holder_name, bank_name, account_number, swift_code
    case 'SG':
      return {
        account_holder_name: holder(),
        bank_name:           must('bank_name'),
        account_number:      must('account_number'),
        swift_code:          must('swift_code'),
      };

    // ── JP: BANK-TRANSFER ────────────────────────────────────────────────────
    // Corredor SRL no activo en sandbox — esperando LLC.
    // Schema asumido similar a SG (BANK-TRANSFER estándar).
    case 'JP':
      return {
        account_holder_name: holder(),
        bank_name:           must('bank_name'),
        account_number:      must('account_number'),
        swift_code:          must('swift_code'),
      };

    default:
      throw new Error(`[Harbor] País destino no soportado en buildPayoutInstrument: ${country}`);
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

  // EU no es válido para Harbor — resolveHarborCountry extrae el país del IBAN si disponible
  const df         = beneficiary?.dynamicFields instanceof Map
                   ? Object.fromEntries(beneficiary.dynamicFields.entries())
                   : (beneficiary?.dynamicFields ?? {});
  const iban       = df.iban ?? df.account_number ?? beneficiary?.iban ?? beneficiary?.account_number ?? null;
  const resolvedCountry = resolveHarborCountry(destCountry, iban);

  const payoutInstrument = buildPayoutInstrument(beneficiary, resolvedCountry);

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
          country: resolvedCountry,
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

/**
 * Sandbox only — triggers the full transfer.completed webhook lifecycle.
 * Per Sam (OwlPay) 2026-04-23: POST /v1/transfers/{uuid}/simulate-completed
 * Docs: https://harbor-developers.owlpay.com/docs/simulate-transfer-status-apis
 *
 * @param {string} transferId — Harbor transfer UUID (from createHarborTransfer response)
 */
export async function simulateTransferCompleted(transferId) {
  if (!isSandbox()) {
    throw new Error('[Harbor] simulateTransferCompleted is sandbox-only');
  }
  if (!transferId) throw new Error('[Harbor] simulateTransferCompleted: transferId required');

  console.log('[OwlPay Sandbox] Simulating transfer.completed for:', transferId);

  return owlPayRequest(`/v1/transfers/${transferId}/simulate-completed`, {
    method:    'POST',
    timeoutMs: 15000,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// USDC SEND — delegated to stellarService (implemented in Prompt 1 Phase 4)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Envía USDC desde la wallet SRL de Alyto hacia la instruction_address de Harbor.
 * Implementación real en stellarService.sendUSDCToHarbor.
 * Este wrapper mantiene la API surface en owlPayService para compatibilidad.
 */
export async function sendUSDCToHarbor({
  instructionAddress,
  instructionMemo,
  instructionChain,
  amount,
  alytoTransactionId,
}) {
  const { sendUSDCToHarbor: stellarSend } = await import('./stellarService.js');
  return stellarSend({
    destinationAddress: instructionAddress,
    amount,
    memo:              instructionMemo ?? alytoTransactionId?.slice(0, 28),
    transactionId:     alytoTransactionId,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK SIGNATURE VERIFICATION
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// CLEAN v2 EXPORTS — thin wrappers for orchestration layer (Prompt 2)
// Simpler signatures that map 1:1 to Harbor API v2 endpoints.
// ═════════════════════════════════════════════════════════════════════════════

// Cache for requirements schemas — stable per quote_id
const requirementsSchemaCache = new BoundedCache(500, 5 * 60 * 1000);

/**
 * Create an off-ramp quote (USDC → local fiat).
 * Simple wrapper around POST /v2/transfers/quotes.
 */
export async function createQuote({
  source_amount,
  destination_country,
  destination_currency,
  destination_payment_method = 'bank_transfer',
  source_chain = process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
  customer_uuid,
  customer_type = 'business',
}) {
  if (!source_amount || source_amount <= 0) throw new Error('source_amount must be positive');
  if (!destination_country || !destination_currency) {
    throw new Error('destination_country and destination_currency required');
  }
  if (!customer_uuid) throw new Error('customer_uuid required');

  return owlPayRequest('/v2/transfers/quotes', {
    method: 'POST',
    body:   JSON.stringify({
      source: {
        type:    customer_type,  // 'business' = AV Finance SRL (fuente del USDC)
        chain:   source_chain,
        country: 'US',
        asset:   'USDC',
        amount:  Number(source_amount).toFixed(2),
      },
      destination: {
        type:    'individual',   // siempre individual — Harbor off-ramp va a personas
        country: destination_country,
        asset:   destination_currency,
      },
      commission: {
        percentage: '0.5',
        amount:     0,
      },
      on_behalf_of: customer_uuid,
    }),
    timeoutMs: 10000,
  });
}

/**
 * Get transfer requirements schema for a quote (cached per quote_id).
 */
export async function getRequirementsSchema(quoteId) {
  if (!quoteId) throw new Error('quoteId required');

  const cached = requirementsSchemaCache.get(quoteId);
  if (cached) return cached;

  const schema = await owlPayRequest(
    `/v2/transfers/quotes/${quoteId}/requirements`,
    { method: 'GET', timeoutMs: 10000 },
  );

  requirementsSchemaCache.set(quoteId, schema);
  return schema;
}

/**
 * Create a transfer in Harbor. Returns the full Harbor response (instruction_address inside).
 *
 * @param {object} params
 * @param {string} params.quote_id                   - Harbor quote ID
 * @param {string} params.on_behalf_of               - Harbor customer UUID
 * @param {string} params.application_transfer_uuid  - Alyto tx ID (idempotency key)
 * @param {string} params.source_address             - Stellar wallet sending USDC
 * @param {object} params.beneficiary_info           - Harbor beneficiary_info object
 * @param {object} params.payout_instrument          - Harbor payout_instrument object
 * @param {string} [params.transfer_purpose]         - Harbor enum, default FAMILY_MAINTENANCE
 * @param {boolean} [params.is_self_transfer]        - default false
 */
export async function createTransfer({
  quote_id,
  on_behalf_of,
  application_transfer_uuid,
  source_address,
  beneficiary_info,
  payout_instrument,
  transfer_purpose  = 'FAMILY_MAINTENANCE',
  is_self_transfer  = false,
}) {
  if (!quote_id)                  throw new Error('quote_id required');
  if (!on_behalf_of)              throw new Error('on_behalf_of required');
  if (!application_transfer_uuid) throw new Error('application_transfer_uuid required');
  if (!source_address)            throw new Error('source_address required');
  if (!beneficiary_info)          throw new Error('beneficiary_info required');
  if (!payout_instrument)         throw new Error('payout_instrument required');

  const payload = {
    quote_id,
    on_behalf_of,
    application_transfer_uuid,
    source: {
      payment_instrument: { address: source_address },
    },
    destination: {
      beneficiary_info,
      payout_instrument,
      transfer_purpose,
      is_self_transfer,
    },
  };

  console.log('[OwlPay DEBUG] createTransfer payload:', JSON.stringify(payload, null, 2));

  return owlPayRequest('/v2/transfers', {
    method: 'POST',
    body:   JSON.stringify(payload),
    timeoutMs: 20000,
  });
}

/**
 * Get transfer status by Harbor transfer ID.
 */
export async function getTransferStatus(transferId) {
  if (!transferId) throw new Error('transferId required');
  return owlPayRequest(`/v2/transfers/${transferId}`, { method: 'GET', timeoutMs: 10000 });
}

// ─── Harbor webhook signature verification ───────────────────────────────────

/**
 * Verify Harbor webhook HMAC-SHA256.
 *
 * Header format: "harbor-signature: t=<unix_ts>,v1=<hmac_hex>"
 * signed_payload: "<timestamp>.<rawBody>"
 *
 * Source: https://harbor-developers.owlpay.com/docs/verifying-requests-from-harbor
 *
 * @param {Buffer|string} rawPayloadBuffer — raw request body
 * @param {string}        harborSignatureHeader — value of 'harbor-signature' header
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawPayloadBuffer, harborSignatureHeader) {
  const secret = process.env.OWLPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[OwlPay] OWLPAY_WEBHOOK_SECRET not set — rejecting webhook');
    return false;
  }
  if (!harborSignatureHeader || typeof harborSignatureHeader !== 'string') return false;

  // Parse "t=<ts>,v1=<hex>"
  const parts = harborSignatureHeader.split(',').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    acc[key] = rest.join('=');
    return acc;
  }, {});

  const timestamp         = parts['t'];
  const receivedSignature = parts['v1'];
  if (!timestamp || !receivedSignature) {
    console.warn('[OwlPay] harbor-signature missing t= or v1=');
    return false;
  }

  // Reject webhooks with timestamps older than 5 minutes (replay attack prevention)
  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 300) {
    console.warn('[OwlPay] Webhook timestamp out of tolerance:', timestamp, 'now:', now);
    return false;
  }

  const rawBody     = Buffer.isBuffer(rawPayloadBuffer)
    ? rawPayloadBuffer.toString('utf8')
    : String(rawPayloadBuffer);
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected      = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const expectedBuf  = Buffer.from(expected, 'hex');
  let   receivedBuf;
  try {
    receivedBuf = Buffer.from(receivedSignature, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// ═════════════════════════════════════════════════════════════════════════════
// FRONTEND HELPER — descubrir métodos + schemas para construir formularios
// ═════════════════════════════════════════════════════════════════════════════

const harborMethodsCache = new BoundedCache(50, 5 * 60 * 1000);

/**
 * Para un corredor (destCountry + destCurrency), devuelve TODOS los métodos
 * de pago disponibles en Harbor con su tasa, settlement time y JSON Schema
 * de campos requeridos. Permite al frontend renderizar formularios dinámicos
 * sin hardcodear campos por país.
 *
 * El schema NO depende del monto; las tasas devueltas son indicativas y se
 * recotizan al momento de crear el transfer real.
 *
 * Cacheado 5 min por (destCountry, destCurrency, customerUuid).
 *
 * @param {object} params
 * @param {string}  params.destCountry   - ISO-2 (CN, NG, MX, …)
 * @param {string}  params.destCurrency  - ISO-3 (CNY, NGN, MXN, …)
 * @param {string}  [params.amountUSDC]  - default '100'
 * @param {string}  [params.customerUuid] - mejora precisión de tasa cuando se conoce la entidad
 */
export async function getHarborMethodsWithSchemas({
  destCountry,
  destCurrency,
  amountUSDC   = '100',
  customerUuid = null,
}) {
  if (!destCountry || !destCurrency) {
    throw new Error('[Harbor] destCountry y destCurrency son requeridos.');
  }
  const country  = destCountry.toUpperCase();
  const currency = destCurrency.toUpperCase();
  const cacheKey = `${country}|${currency}|${customerUuid ?? 'anon'}`;

  const cached = harborMethodsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const payload = {
    source:      { type: 'individual', chain: 'stellar', country: 'US', asset: 'USDC', amount: String(amountUSDC) },
    destination: { type: 'individual', country, asset: currency },
    commission:  { percentage: '0.5', amount: '0' },
  };
  if (customerUuid) payload.on_behalf_of = customerUuid;

  const quotesRes = await owlPayRequest('/v2/transfers/quotes', {
    method: 'POST',
    body:   JSON.stringify(payload),
    timeoutMs: 10000,
  });

  const quotes = Array.isArray(quotesRes?.data) ? quotesRes.data : [];
  if (quotes.length === 0) {
    throw new Error(`[Harbor] No hay métodos disponibles para ${country}/${currency}.`);
  }

  const methods = await Promise.all(quotes.map(async (q) => {
    const req = await getHarborTransferRequirements({ quoteId: q.id, destCountry: country });
    return {
      paymentMethod:       q.payment_method,
      paymentMethodLabel:  q.payment_method_label ?? q.payment_method,
      exchangeRate:        Number(q.exchange_rate ?? 0),
      exchangePair:        q.exchange_pair ?? `USDC/${currency}`,
      settlementTimeMin:   q.fiat_settlement_time_min ?? null,
      settlementTimeMax:   q.fiat_settlement_time_max ?? null,
      settlementTimeUnit:  q.fiat_settlement_time_unit ?? null,
      schema:              req.schema,
      title:               req.title,
    };
  }));

  harborMethodsCache.set(cacheKey, methods);
  return methods;
}
