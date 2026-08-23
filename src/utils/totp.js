/**
 * totp.js — Contraseña de un solo uso basada en tiempo (RFC 6238 sobre RFC 4226).
 *
 * Implementación propia, deliberadamente. Son cuarenta líneas de HMAC y aritmética
 * de enteros: incorporar una dependencia externa para esto agregaría una pieza de
 * cadena de suministro a la ruta de autenticación privilegiada sin ahorrar nada.
 * A cambio, la corrección se acredita contra los vectores de prueba publicados en
 * el Apéndice B del propio RFC 6238 — evidencia más fuerte ante un supervisor que
 * la sola declaración de haber usado una biblioteca.
 *
 * Parámetros fijados:
 *   - Algoritmo   HMAC-SHA1, que es lo que interoperan las aplicaciones de
 *                 autenticación de uso corriente (Google Authenticator, Authy,
 *                 1Password, Aegis). SHA-256 está en el RFC pero varias de ellas
 *                 lo ignoran y calculan SHA1 igual, produciendo códigos que no
 *                 validan.
 *   - Dígitos     6
 *   - Paso        30 segundos
 *
 * El secreto se maneja SIEMPRE en base32 (RFC 4648, sin relleno), que es el
 * formato que consumen tanto el URI `otpauth://` como el ingreso manual.
 *
 * ⚠️ Este módulo es puro: no lee entorno, no toca base de datos y no registra
 * nada. El secreto nunca sale de aquí por un canal que no sea el retorno de la
 * función que lo generó.
 */

import crypto from 'node:crypto';

/** Duración de un paso de tiempo, en segundos (RFC 6238 §4, valor recomendado). */
export const TOTP_STEP_SECONDS = 30;

/** Cantidad de dígitos del código. */
export const TOTP_DIGITS = 6;

/**
 * Ventana de tolerancia: un paso hacia atrás y uno hacia adelante.
 *
 * Se documenta el valor porque es la decisión que define cuánto dura un código:
 * con paso de 30 s y tolerancia 1, un código es aceptable durante un intervalo de
 * entre 30 y 90 segundos según el momento en que se generó. Es el mínimo que
 * absorbe el desfase de reloj del teléfono y el tiempo que tarda una persona en
 * teclear; subirlo a 2 duplicaría la ventana de utilidad de un código sustraído
 * sin resolver ningún problema real.
 */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ─── Base32 (RFC 4648) ────────────────────────────────────────────────────────

/**
 * Codifica bytes a base32 sin relleno.
 * @param {Buffer} buf
 * @returns {string}
 */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decodifica base32 a bytes. Tolera minúsculas, espacios y relleno '=' porque es
 * lo que llega cuando alguien copia el secreto a mano desde la pantalla de alta.
 *
 * @param {string} str
 * @returns {Buffer}
 * @throws {Error} si aparece un carácter fuera del alfabeto
 */
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Secreto TOTP inválido: carácter fuera del alfabeto base32.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── Generación del secreto ───────────────────────────────────────────────────

/**
 * Genera un secreto TOTP aleatorio en base32.
 *
 * 20 bytes (160 bits) es el tamaño de bloque de SHA-1 y el que recomienda el
 * RFC 4226 §4 R6. Un secreto más corto se estira internamente y no agrega
 * entropía; uno más largo se comprime y tampoco.
 *
 * @returns {string} secreto en base32, 32 caracteres
 */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// ─── HOTP / TOTP ──────────────────────────────────────────────────────────────

/**
 * HOTP (RFC 4226 §5.3): trunca dinámicamente el HMAC-SHA1 del contador.
 *
 * @param {Buffer} key
 * @param {number} counter
 * @param {number} [digits]
 * @returns {string} código con relleno de ceros a la izquierda
 */
function hotp(key, counter, digits = TOTP_DIGITS) {
  // Contador de 8 bytes big-endian. BigInt evita el techo de 2^31 de las
  // operaciones de bits de JavaScript — los vectores del RFC llegan a T=20000000000,
  // que con aritmética de 32 bits daría un contador equivocado.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac   = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Paso de tiempo correspondiente a un instante.
 *
 * @param {Date|number} [at]  — Date o epoch en milisegundos
 * @returns {number}
 */
export function timeStep(at = Date.now()) {
  const ms = at instanceof Date ? at.getTime() : Number(at);
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Calcula el código TOTP de un paso de tiempo determinado.
 *
 * @param {string} secretBase32
 * @param {object} [opts]
 * @param {number} [opts.step]    — paso de tiempo; por defecto el actual
 * @param {number} [opts.digits]
 * @returns {string}
 */
export function generateTotp(secretBase32, { step = timeStep(), digits = TOTP_DIGITS } = {}) {
  return hotp(base32Decode(secretBase32), step, digits);
}

/**
 * Verifica un código dentro de la ventana de tolerancia.
 *
 * Devuelve el paso de tiempo con el que coincidió, para que quien llama pueda
 * dejarlo asentado e impedir que ese mismo código se vuelva a usar mientras siga
 * vigente. Devolver sólo un booleano haría imposible la prevención de reutilización.
 *
 * La comparación es de tiempo constante: un código de seis dígitos tiene poca
 * entropía y no conviene regalar información por el tiempo de respuesta.
 *
 * @param {string} secretBase32
 * @param {string} code
 * @param {object} [opts]
 * @param {number} [opts.step]    — paso central; por defecto el actual
 * @param {number} [opts.window]  — pasos de tolerancia a cada lado
 * @param {number} [opts.digits]
 * @returns {number|null} paso de tiempo coincidente, o null si ninguno coincide
 */
export function verifyTotp(secretBase32, code, { step = timeStep(), window = TOTP_WINDOW, digits = TOTP_DIGITS } = {}) {
  const candidate = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;

  let matched = null;
  for (let delta = -window; delta <= window; delta++) {
    const expected = generateTotp(secretBase32, { step: step + delta, digits });
    // No se corta el bucle al encontrar la coincidencia: recorrer siempre la
    // ventana completa evita que el tiempo de respuesta revele cuál fue el paso.
    if (timingSafeEqualStr(expected, candidate) && matched === null) matched = step + delta;
  }
  return matched;
}

/** Compara dos cadenas de igual longitud sin filtrar información por tiempo. */
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── URI de aprovisionamiento ─────────────────────────────────────────────────

/**
 * Construye el URI `otpauth://` que la aplicación de autenticación lee del código
 * QR. Formato de Key Uri (de facto, originado en Google Authenticator).
 *
 * @param {object} p
 * @param {string} p.secret     — secreto en base32
 * @param {string} p.account    — identificador de la cuenta (correo del operador)
 * @param {string} [p.issuer]   — nombre que muestra la aplicación
 * @returns {string}
 */
export function otpauthUri({ secret, account, issuer = 'Alyto' }) {
  const label  = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits:    String(TOTP_DIGITS),
    period:    String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Agrupa el secreto en bloques de cuatro para el ingreso manual. Una cadena de
 * 32 caracteres corridos se transcribe mal; en bloques, no.
 *
 * @param {string} secret
 * @returns {string}
 */
export function formatSecretForManualEntry(secret) {
  return String(secret).replace(/(.{4})/g, '$1 ').trim();
}
