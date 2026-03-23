/**
 * vitaMock.js — Factories de respuestas mock de Vita Wallet
 *
 * Genera respuestas ficticias que reproducen fielmente la estructura
 * de la Vita Business API, para ser usadas con jest.unstable_mockModule.
 *
 * La firma HMAC (generateVitaIPNHeaders) se genera con el mismo algoritmo
 * que usa vitaWalletService.js, usando las variables de entorno de test.
 */

import crypto from 'crypto';

// ─── Vita Prices Response ─────────────────────────────────────────────────────

/**
 * Respuesta mock de GET /prices de Vita.
 * Cubre los pares CLP→BO y CLP→CO para los tests de quote.
 *
 * @param {object} overrides — Sobreescribir tasas específicas
 * @returns {object} Respuesta compatible con extractVitaPricing()
 */
export function mockVitaPricesResponse(overrides = {}) {
  const validUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return {
    withdrawal: {
      prices: {
        attributes: {
          clp_sell: {
            bo: 0.0045,   // 1 CLP = 0.0045 BOB
            co: 4.5,      // 1 CLP ≈ 4.5 COP
            pe: 0.0042,
            ar: 1.2,
            ...((overrides.clp_sell) ?? {}),
          },
          usd_sell: {
            bo: 6.96,
            co: 4200,
            pe: 3.8,
            ...((overrides.usd_sell) ?? {}),
          },
        },
      },
      bo: { fixed_cost: 0 },
      co: { fixed_cost: 200 },
      pe: { fixed_cost: 0 },
    },
    vita_sent:   {},
    valid_until: overrides.valid_until ?? validUntil,
  };
}

// ─── Vita Payin (depósito local LatAm) ───────────────────────────────────────

/**
 * Respuesta mock de POST /business/payins (crear depósito).
 */
export function mockVitaCreatePayinResponse(overrides = {}) {
  return {
    id:          overrides.id          ?? `vita_payin_${Date.now()}`,
    status:      overrides.status      ?? 'pending',
    amount:      overrides.amount      ?? 100000,
    currency:    overrides.currency    ?? 'CLP',
    order:       overrides.order       ?? `ALY-B-${Date.now()}-TEST`,
    redirect_url: overrides.redirect_url ?? 'https://pay.stage.vitawallet.io/redirect/test',
    created_at:  new Date().toISOString(),
  };
}

// ─── Vita Payout (retiro) ─────────────────────────────────────────────────────

/**
 * Respuesta mock de POST /business/withdrawals (crear payout).
 */
export function mockVitaCreateWithdrawalResponse(overrides = {}) {
  return {
    id:          overrides.id          ?? `vita_withdrawal_${Date.now()}`,
    status:      overrides.status      ?? 'pending',
    amount:      overrides.amount      ?? 450,
    currency:    overrides.currency    ?? 'BOB',
    order:       overrides.order       ?? `ALY-B-${Date.now()}-TEST`,
    beneficiary: overrides.beneficiary ?? {
      name:           'Test Beneficiary',
      bank_code:      'BNB',
      account_number: '123456789',
    },
    created_at:  new Date().toISOString(),
  };
}

// ─── IPN Headers de Vita ──────────────────────────────────────────────────────

/**
 * Genera los headers HMAC necesarios para simular un IPN de Vita.
 *
 * Reimplementa el algoritmo V2-HMAC-SHA256 directamente (no importa
 * vitaWalletService para evitar dependencias circulares en tests).
 *
 * Algoritmo:
 *   message = xLogin + xDate + buildSortedBody(body)
 *   sig = HMAC-SHA256(VITA_SECRET, message).hex
 *
 * @param {object} body      — Body del IPN (req.body)
 * @param {string} [xDate]   — ISO8601; si no se pasa, usa Date.now()
 * @returns {{ 'x-login': string, 'x-date': string, 'authorization': string }}
 */
export function generateVitaIPNHeaders(body, xDate = null) {
  const xLogin  = process.env.VITA_LOGIN  ?? 'test_vita_login';
  const secret  = process.env.VITA_SECRET ?? 'test_vita_secret';
  const date    = xDate ?? new Date().toISOString();

  const sortedBody = buildSortedBody(body);
  const message    = xLogin + date + sortedBody;
  const sig        = crypto.createHmac('sha256', secret).update(message).digest('hex');

  return {
    'x-login':       xLogin,
    'x-date':        date,
    'authorization': `V2-HMAC-SHA256, Signature: ${sig}`,
  };
}

/**
 * Cuerpos de IPN de Vita para los distintos eventos del flujo.
 */

/** IPN de payin confirmado (depósito recibido) */
export function vitaPayinSucceededIPN(transactionId, overrides = {}) {
  return {
    event:      'payin.succeeded',
    order:      transactionId,
    status:     'completed',
    amount:     overrides.amount   ?? 100000,
    currency:   overrides.currency ?? 'CLP',
    id:         overrides.id       ?? `vita_payin_${Date.now()}`,
    ...overrides,
  };
}

/** IPN de payout confirmado (retiro enviado) */
export function vitaPayoutSucceededIPN(transactionId, overrides = {}) {
  return {
    event:    'withdrawal.succeeded',
    order:    transactionId,
    status:   'completed',
    amount:   overrides.amount   ?? 450,
    currency: overrides.currency ?? 'BOB',
    id:       overrides.id       ?? `vita_withdrawal_${Date.now()}`,
    ...overrides,
  };
}

/** IPN de payout fallido */
export function vitaPayoutFailedIPN(transactionId, overrides = {}) {
  return {
    event:         'withdrawal.failed',
    order:         transactionId,
    status:        'failed',
    amount:        overrides.amount ?? 450,
    currency:      overrides.currency ?? 'BOB',
    id:            overrides.id ?? `vita_withdrawal_${Date.now()}`,
    error_message: overrides.error_message ?? 'Beneficiary account not found',
    ...overrides,
  };
}

// ─── Helper privado (misma lógica que vitaWalletService.js:buildSortedBody) ──

function buildSortedBody(body = null) {
  if (!body || Object.keys(body).length === 0) return '';

  return Object.keys(body)
    .sort()
    .map((k) => {
      const v = body[k];
      const strVal = (typeof v === 'object' && v !== null)
        ? JSON.stringify(v)
        : String(v);
      return `${k}${strVal}`;
    })
    .join('');
}
