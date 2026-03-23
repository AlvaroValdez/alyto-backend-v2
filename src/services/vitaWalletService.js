/**
 * vitaWalletService.js — Cliente HTTP Vita Wallet Business API
 *
 * Autenticación: HMAC-SHA256 estricta según especificación Vita Business API.
 * Cada petición inyecta automáticamente los headers obligatorios:
 *   x-login, x-api-key, x-date, Authorization: V2-HMAC-SHA256, Signature:{sig}
 *
 * Firma (V2-HMAC-SHA256):
 *   message  = xLogin + xDate + sortedRequestBody
 *   sortedRequestBody = claves del body ordenadas alfabéticamente,
 *                       concatenadas sin separadores (key+value+key+value...)
 *   Si el body es null/undefined → sortedRequestBody = ''
 *
 * Ejemplo:
 *   body = { order: "xyz", amount: 400 }
 *   sorted = "amount400orderxyz"
 *   message = "<xLogin><xDate>amount400orderxyz"
 *
 * Variables de entorno requeridas:
 *   VITA_API_URL     — https://api.stage.vitawallet.io (stage) / https://api.vitawallet.io (prod)
 *   VITA_LOGIN       — xLogin del negocio en Vita
 *   VITA_TRANS_KEY   — xTransKey del negocio en Vita
 *   VITA_SECRET      — Secret Key para generar la firma HMAC
 *   VITA_BUSINESS_WALLET_UUID — UUID de la master wallet de AV Finance en Vita
 *   VITA_NOTIFY_URL  — URL de webhook para notificaciones IPN
 */

import crypto from 'crypto';

// ─── Configuración ────────────────────────────────────────────────────────────

const VITA_BASE_URL = `${process.env.VITA_API_URL ?? 'https://api.stage.vitawallet.io'}/api/businesses`;

// ─── HMAC-SHA256 — Generación de firma (portado de V1.5 vitaClient.js) ────────

/**
 * Elimina claves con valores null o undefined recursivamente.
 * Vita rechaza la firma si se incluyen nulls en el cálculo.
 * Portado de deepClean() del V1.5.
 */
function deepClean(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(deepClean).filter(v => v !== undefined);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = deepClean(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/**
 * Serializa valores en formato Ruby-like según la especificación de firma de Vita.
 * Vita es un backend Ruby on Rails — su spec espera este formato para objetos anidados.
 *
 * Ejemplo: { bank_id: "test", amount: 100 }
 *   → '{:amount=>100, :bank_id=>"test"}'     (claves ordenadas, coma+espacio)
 *
 * Portado de stableStringify() del V1.5.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object' && value.constructor === Object) {
    const keys = Object.keys(value).sort();
    const entries = keys.map(k => {
      const v = value[k];
      if (typeof v === 'string')  return `:${k}=>"${v}"`;
      if (typeof v === 'number')  return `:${k}=>${v}`;
      if (typeof v === 'object')  return `:${k}=>${stableStringify(v)}`;
      return `:${k}=>${v}`;
    });
    // IMPORTANTE: coma + espacio, igual que Ruby's .inspect
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Construye el string del body ordenado para la firma Vita V2-HMAC-SHA256.
 *
 * Reglas (portadas de buildSortedRequestBodyLegacy del V1.5):
 *  1. Ordenar claves alfabéticamente
 *  2. Saltar valores null o undefined (no incluirlos en la firma)
 *  3. Para valores primitivos: String(v) sin comillas
 *  4. Para objetos anidados: formato Ruby-like via stableStringify()
 *
 * Ejemplo: { order: "xyz", amount: 400 } → "amount400orderxyz"
 *
 * @param {object|null} body
 * @returns {string}
 */
function buildSortedBody(body = null) {
  if (!body || typeof body !== 'object') return '';
  const keys = Object.keys(body).sort();
  let out = '';
  for (const k of keys) {
    const v = body[k];
    // Saltar null y undefined — igual que V1.5; incluirlos altera la firma
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      out += `${k}${stableStringify(v)}`;
    } else {
      out += `${k}${String(v)}`;
    }
  }
  return out;
}

/**
 * Genera la firma HMAC-SHA256 según el protocolo V2 de Vita Wallet.
 *
 * message = xLogin + xDate + sortedRequestBody
 *
 * El body se limpia con deepClean() antes de firmar — igual que V1.5 —
 * para asegurar que ningún null/undefined altere la firma.
 *
 * @param {string} xDate        — ISO8601 datetime (mismo valor enviado en el header)
 * @param {object|null} body    — Body de la petición (null para GET sin body)
 * @returns {string}            — Hex digest de la firma
 */
export function generateVitaSignature(xDate, body = null) {
  const xLogin    = process.env.VITA_LOGIN;
  const secretKey = process.env.VITA_SECRET;

  if (!xLogin || !secretKey) {
    throw new Error('[VitaWallet] VITA_LOGIN y VITA_SECRET son obligatorios en .env');
  }

  const cleanBody  = body ? (deepClean(body) ?? {}) : null;
  const sortedBody = buildSortedBody(cleanBody);
  const message    = `${xLogin}${xDate}${sortedBody}`;

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message, 'utf8')
    .digest('hex');

  if (process.env.NODE_ENV !== 'production') {
    console.log('[VitaWallet HMAC-SHA256]', {
      xLogin,
      xDate,
      sortedBody:    sortedBody || '(vacío — GET sin body)',
      messageLength: message.length,
      signature,
    });
  }

  return signature;
}

// ─── Cliente HTTP base ────────────────────────────────────────────────────────

/**
 * Realiza una petición autenticada a la Vita Wallet Business API.
 * Inyecta automáticamente todos los headers de autenticación HMAC-SHA256.
 *
 * Notas críticas de implementación (extraídas del V1.5 funcional):
 *   - El header debe ser `x-trans-key` (además de `x-api-key` para redirect)
 *   - Authorization tiene ESPACIO tras el colon: "Signature: {sig}"
 *   - GET /payment_methods/{country}: el path param se incluye en la firma
 *     como si fuera un campo del body: "country_iso_code{CODE}"
 *
 * @param {string}           method  — 'GET' | 'POST'
 * @param {string}           path    — Ruta relativa (ej. '/withdrawal_rules')
 * @param {object|null}      body    — Payload JSON (null para GET)
 * @returns {Promise<object>}        — Respuesta JSON de la API
 */
async function vitaRequest(method, path, body = null) {
  const xDate     = new Date().toISOString();
  const xLogin    = process.env.VITA_LOGIN;
  const xTransKey = process.env.VITA_TRANS_KEY;

  if (!xLogin || !xTransKey) {
    throw new Error('[VitaWallet] VITA_LOGIN y VITA_TRANS_KEY son requeridos.');
  }

  // ── Construcción del body de firma ──────────────────────────────────────
  // Para GET /payment_methods/{country}: el path param actúa como body implícito
  let signatureBody = body;
  const pmMatch = path.match(/^\/payment_methods\/([A-Z]{2})$/i);
  if (pmMatch) {
    signatureBody = { country_iso_code: pmMatch[1].toUpperCase() };
  }

  const signature = generateVitaSignature(xDate, signatureBody);

  const headers = {
    'Content-Type':  'application/json',
    'x-login':       xLogin,
    'x-trans-key':   xTransKey,   // Header estricto requerido por Vita
    'x-api-key':     xTransKey,   // Requerido para algunos endpoints (payment orders)
    'x-date':        xDate,
    // ⚠️ ESPACIO obligatorio después de "Signature:" — V2 protocol spec
    'Authorization': `V2-HMAC-SHA256, Signature: ${signature}`,
  };

  const options = {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const url = `${VITA_BASE_URL}${path}`;
  console.info(`[VitaWallet] ${method} ${url}`);

  const res = await fetch(url, options);

  // Vita devuelve 422 para errores de negocio con body JSON
  const data = await res.json().catch(() => ({}));

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[VitaWallet] Respuesta ${res.status}:`, JSON.stringify(data));
  }

  if (!res.ok) {
    // Normalizar mensaje de error — puede ser string, objeto o array
    const rawMsg = data?.message ?? data?.error ?? data?.errors?.[0] ?? `HTTP ${res.status}`;
    const errMsg = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    const err    = new Error(`[VitaWallet] ${errMsg}`);
    err.status   = res.status;
    err.vitaCode = data?.code ?? null;
    err.data     = data;
    throw err;
  }

  return data;
}

// ─── Endpoints de Consulta ────────────────────────────────────────────────────

/**
 * getWithdrawalRules()
 * GET /api/businesses/withdrawal_rules
 *
 * Obtiene los campos de formulario dinámicos requeridos para hacer un payout
 * (withdrawal) en cada país soportado. Los campos pueden ser de tipo:
 *   - text   → input libre con min/max de caracteres
 *   - select → dropdown con options (algunas condicionadas por otros campos via `when`)
 *   - email  → input de correo electrónico
 *
 * Los campos con `when` solo son requeridos cuando el campo referenciado
 * tiene el valor especificado.
 *
 * @returns {Promise<Array>} Array de reglas por país
 */
export function getWithdrawalRules() {
  return vitaRequest('GET', '/withdrawal_rules');
}

/**
 * getPaymentMethods(countryIso)
 * GET /api/businesses/payment_methods/{country_iso_code}
 *
 * Retorna los métodos de pago disponibles para un país específico y sus
 * campos requeridos para habilitar pagos directos (sin redirección).
 *
 * Países soportados: AR, CL, CO, MX, BR
 *
 * Métodos por país:
 *   🇦🇷 AR → Khipu, Bind, Bind QR
 *   🇨🇱 CL → Khipu, Webpay, Fintoc
 *   🇨🇴 CO → PSE, Nequi, Daviplata, Bancolombia, TDC, BNPL
 *   🇲🇽 MX → Bitso One-time CLABE
 *   🇧🇷 BR → PIX QR
 *
 * @param {string} countryIso — ISO 3166-1 alpha-2 (ej. 'CO', 'BR')
 * @returns {Promise<Array>}  — Array de métodos con sus campos requeridos
 */
export function getPaymentMethods(countryIso) {
  if (!countryIso) throw new Error('[VitaWallet] countryIso es requerido.');
  return vitaRequest('GET', `/payment_methods/${countryIso.toUpperCase()}`);
}

// ─── Endpoints Transaccionales ────────────────────────────────────────────────

/**
 * createPayout(payload)
 * POST /api/businesses/transactions (transactions_type: "withdrawal")
 *
 * Crea una transacción de retiro bancario (off-ramp) desde la master wallet
 * de AV Finance hacia la cuenta bancaria del beneficiario en el país de destino.
 *
 * ⚠️  Los campos dinámicos del payload (bank_code, account_bank, etc.) varían
 *     por país — deben obtenerse previamente con getWithdrawalRules().
 *
 * @param {object} payload
 * @param {string} payload.country                   — ISO code (ej. 'AR', 'BO')
 * @param {string} payload.currency                  — Moneda origen (ej. 'clp', 'usd')
 * @param {number} payload.amount                    — Monto en moneda origen
 * @param {string} payload.order                     — ID único de orden (nuestro transactionId)
 * @param {string} payload.beneficiary_first_name
 * @param {string} payload.beneficiary_last_name
 * @param {string} payload.beneficiary_email
 * @param {string} payload.beneficiary_address
 * @param {string} payload.beneficiary_document_type
 * @param {string} payload.beneficiary_document_number
 * @param {string} payload.purpose                   — Código de propósito (ej. 'ISSAVG')
 * @param {string} [payload.purpose_comentary]       — Comentario del propósito
 * @param {*}      ...rest                            — Campos dinámicos del país destino
 * @returns {Promise<object>} — Transacción creada con su ID y estado
 */
export function createPayout(payload) {
  const walletUuid = process.env.VITA_BUSINESS_WALLET_UUID;
  if (!walletUuid) {
    throw new Error('[VitaWallet] VITA_BUSINESS_WALLET_UUID es requerido en .env.');
  }

  const fullPayload = {
    ...payload,
    transactions_type: 'withdrawal',
    wallet:            walletUuid,
    url_notify:        process.env.VITA_NOTIFY_URL ?? '',
  };

  return vitaRequest('POST', '/transactions', fullPayload);
}

/**
 * createPayin(payload)
 * POST /api/businesses/payment_orders
 *
 * Crea una orden de pago (on-ramp / pay-in) para que el cliente pague
 * en su moneda local. Retorna una URL de pago o los datos para
 * procesar el pago directamente (direct_payment).
 *
 * @param {object} payload
 * @param {number} payload.amount            — Monto en moneda local del país
 * @param {string} payload.country_iso_code  — ISO code del país del pagador (AR/CL/CO/MX/BR)
 * @param {string} payload.issue             — Descripción de la orden
 * @param {string} [payload.currency_destiny] — Moneda destino en la que AV Finance recibe (ej. 'USD')
 * @param {boolean} [payload.is_receive]     — Si true: amount es lo que AV Finance recibe
 * @param {string} [payload.success_redirect_url]
 * @returns {Promise<object>} — Orden creada con URL de pago y datos de la transacción
 */
export function createPayin(payload) {
  return vitaRequest('POST', '/payment_orders', payload);
}

/**
 * getPrices()
 * GET /api/businesses/prices
 *
 * Precios en tiempo real para calcular montos finales de withdrawals (off-ramp).
 * Este endpoint "congela" el precio para una operación — usar getPayinPrices()
 * para consultas de payin que no deben afectar el rate lock de withdrawals.
 *
 * Estructura de respuesta:
 * {
 *   withdrawal: {
 *     prices: { attributes: { "clp_sell": { "co": rate, ... }, "usd_sell": { ... } } },
 *     "co": { fixed_cost: 200 },
 *     ...
 *   },
 *   vita_sent: { ... },
 *   valid_until: "ISO8601"
 * }
 *
 * @returns {Promise<object>}
 */
export function getPrices() {
  return vitaRequest('GET', '/prices');
}

/**
 * getPayinPrices()
 * GET /api/businesses/payins_prices
 *
 * Precios en tiempo real para calcular cotizaciones de pay-in (on-ramp).
 * A diferencia de /prices, este endpoint no tiene rate limit y no congela
 * el precio para operaciones de withdrawal — se puede llamar libremente para
 * mostrar cotizaciones al usuario sin efectos secundarios.
 *
 * @returns {Promise<object>}
 */
export function getPayinPrices() {
  return vitaRequest('GET', '/payins_prices');
}
