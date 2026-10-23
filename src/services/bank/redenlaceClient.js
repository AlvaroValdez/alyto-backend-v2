/**
 * redenlaceClient.js — Cliente HTTP base para las APIs de ATC S.A. (Red Enlace)
 *
 * Capa de bajo nivel compartida por todos los productos de ATC:
 *   - redenlaceQrService        (QR Simple — cobro, `bankQr/banks/`)
 *   - redenlaceAccountService   (cuentas de comercio y saldos — futuro)
 *   - redenlaceDisbursement     (Pay Out Asíncrono — futuro, pendiente de habilitación)
 *
 * Diferencias con `becClient` que importan al leer este archivo:
 *   - Auth OAuth 2.0 Client Credentials, NO el JWT propietario de BANECO.
 *   - Sin cifrado de payload. ATC no usa AES: todo viaja en claro sobre TLS.
 *   - Los servicios NO usan `Authorization: Bearer`. Usan dos cabeceras propias,
 *     `access_token` (el token crudo, sin prefijo) y `client_id`. Mandar el token
 *     como Bearer devuelve 401 aunque el token sea válido.
 *   - ATC responde HTTP 200 con un código de negocio en el body (`code: "00"` o
 *     `success: true` según el producto). Por eso `apiFetch` NO interpreta el
 *     resultado: solo lanza ante un HTTP no-2xx y devuelve el JSON crudo. Cada
 *     servicio decide qué significa éxito en su propio contrato.
 *
 * Mock mode: activo con REDENLACE_MOCK_ENABLED=true o sin credenciales, igual
 * que el patrón de BANECO. Permite ejercitar el flujo completo sin sandbox.
 *
 * ⚠️ La documentación de QR Simple §7 publica la URL de producción como `http://`
 * mientras el resto del portal la publica como `https://`. Mientras ATC no lo
 * confirme por escrito, `assertSecureBaseUrl()` rechaza una base URL sin TLS en
 * producción: mandar el client_secret por HTTP plano lo expone en la red.
 */

import { logger } from '../../utils/logger.js';

// ── Config ───────────────────────────────────────────────────────────────────
// Regla 21: leído dentro de funciones. Un `const` de módulo capturaría el valor
// previo a la carga de Secrets Manager y caería al sandbox en silencio.
const cfg = {
  baseUrl:      () => process.env.REDENLACE_BASE_URL ?? 'https://atcgwapitest.redenlace.com.bo/sandbox',
  clientId:     () => process.env.REDENLACE_CLIENT_ID,
  clientSecret: () => process.env.REDENLACE_CLIENT_SECRET,
};

/** Normaliza la base URL: el portal la publica a veces con barra final. */
function baseUrl() {
  return String(cfg.baseUrl()).replace(/\/+$/, '');
}

/**
 * Rechaza una base URL sin TLS cuando hay credenciales reales en juego.
 * No basta con confiar en la variable de entorno: un copy/paste del `http://`
 * que figura en la documentación filtraría el Basic auth en texto claro.
 */
function assertSecureBaseUrl() {
  const url = baseUrl();
  if (url.startsWith('https://')) return;
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return;
  throw new Error(
    `Red Enlace: REDENLACE_BASE_URL debe usar https (recibido '${url}'). ` +
    'La doc de QR Simple publica un http:// que ATC todavía no confirmó.',
  );
}

// ── Token cache ──────────────────────────────────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;

/** Solo para tests: descarta el token cacheado. */
export function resetTokenCache() {
  _cachedToken    = null;
  _tokenExpiresAt = 0;
}

async function authenticate() {
  assertSecureBaseUrl();

  const basic = Buffer
    .from(`${cfg.clientId()}:${cfg.clientSecret()}`, 'utf8')
    .toString('base64');

  const res = await fetch(
    `${baseUrl()}/oauth-client-credentials/access-token?grant_type=client_credentials`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      // grant_type viaja en el query string (así lo documenta ATC). El body va
      // vacío, pero el Content-Type sigue siendo obligatorio.
      body: '',
    },
  );

  if (!res.ok) {
    // Nunca incluir el body de la respuesta de auth en el error: ante un 4xx
    // algunos gateways devuelven el request recibido, con el Basic adentro.
    throw new Error(`Red Enlace auth HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data?.access_token) throw new Error('Red Enlace auth: respuesta sin access_token');
  return data;
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) return _cachedToken;

  const data = await authenticate();
  _cachedToken = data.access_token;

  // `expires_in` viene en segundos (ATC documenta 3600). Si falta, asumimos 55
  // min: preferimos renovar de más que operar con un token vencido.
  const ttlSeconds = Number(data.expires_in);
  _tokenExpiresAt = Date.now() + (Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds * 1000
    : 55 * 60 * 1000);

  logger.info('[RedEnlace] Token renovado', { expiresInSeconds: ttlSeconds || null });
  return _cachedToken;
}

// ── HTTP genérico ────────────────────────────────────────────────────────────

/**
 * Llama un endpoint de ATC con las cabeceras de autorización ya puestas.
 *
 * @param {string} path                — ej. '/qr/simple/v2/generate'
 * @param {RequestInit & { headers?: Record<string,string> }} [options]
 * @returns {Promise<any>} JSON crudo. El código de negocio lo interpreta el servicio.
 */
export async function apiFetch(path, options = {}) {
  const token = await getToken();

  const res = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'access_token': token,          // crudo, SIN prefijo Bearer
      'client_id':    cfg.clientId(),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Red Enlace API ${path} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Disponibilidad / mock ────────────────────────────────────────────────────

/** @returns {boolean} true si las credenciales OAuth mínimas están configuradas */
export function isAvailable() {
  return !!(cfg.clientId() && cfg.clientSecret());
}

/** @returns {boolean} true si debe operar en modo simulado (no habla con ATC) */
export function isMockMode() {
  return process.env.REDENLACE_MOCK_ENABLED === 'true' || !isAvailable();
}
