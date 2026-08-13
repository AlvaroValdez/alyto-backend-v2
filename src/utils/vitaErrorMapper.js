/**
 * vitaErrorMapper.js — Centraliza la traducción de errores de Vita Wallet
 * (Business API) a mensajes accionables: técnico para el admin/ledger,
 * claro para el usuario final. Espeja la forma de harborErrorMapper.js.
 *
 * Toda nueva categoría de error vista en tests/producción se agrega aquí —
 * UN solo lugar para mantener.
 *
 * Forma del error que lanza vitaWalletService.vitaRequest():
 *   err.message  = "[VitaWallet] <msg o json>"
 *   err.status   = HTTP status (ej. 422)
 *   err.vitaCode = data.code   (ej. 305 = validación de campo)
 *   err.data     = body JSON completo, típicamente:
 *     { code, message, details: { message, message_en, field, type, title, api_parameter } }
 *
 * Ejemplo real (el que motivó este mapper):
 *   { code: 305, message: "account_bank: ... required format",
 *     details: { message: "Solo se permiten números.", field: "account_bank",
 *                api_parameter: "account_bank", title: "Solicitud de transferencia inválida" } }
 */

/**
 * @typedef {object} MappedError
 * @property {string}  category      - Etiqueta interna (VITA_INVALID_FIELD, etc.)
 * @property {string}  adminMessage  - Detalle técnico para admin/logs/Sentry
 * @property {string}  userMessage   - Mensaje claro para el usuario final
 * @property {string}  userAction    - Qué debe hacer el usuario para resolver
 * @property {boolean} retryable     - Si puede simplemente reintentar
 */

// Etiquetas en español de los campos del beneficiario, para mensajes al usuario.
const FIELD_LABELS_ES = {
  account_bank:                'número de cuenta',
  account_number:              'número de cuenta',
  bank_code:                   'código de banco',
  account_type_bank:           'tipo de cuenta',
  beneficiary_document_number: 'número de documento',
  document_number:             'número de documento',
  beneficiary_document_type:   'tipo de documento',
  beneficiary_first_name:      'nombre',
  beneficiary_last_name:       'apellido',
  beneficiary_email:           'correo del beneficiario',
  beneficiary_phone:           'teléfono del beneficiario',
  beneficiary_address:         'dirección del beneficiario',
  phone:                       'teléfono',
};

function fieldLabel(field) {
  if (!field) return 'un dato del beneficiario';
  return FIELD_LABELS_ES[field] ?? field.replace(/_/g, ' ');
}

/**
 * Reúne la data estructurada del error, tolerando que Vita a veces deje el body
 * completo dentro de err.message ("[VitaWallet] {json}") en lugar de err.data.
 */
function extractVitaData(err) {
  let data = (err && typeof err.data === 'object' && err.data) ? { ...err.data } : {};
  if ((!data.details && data.code == null) && typeof err?.message === 'string') {
    const m = err.message.match(/\{[\s\S]*\}/);
    if (m) {
      try { data = { ...JSON.parse(m[0]), ...data }; } catch { /* message no era JSON */ }
    }
  }
  return data;
}

/**
 * @param {Error & { status?, vitaCode?, data?, code?, isTransient? }} err
 * @returns {MappedError}
 */
export function mapVitaError(err) {
  const data    = extractVitaData(err);
  const status  = err?.status ?? data.status ?? null;
  const code    = err?.vitaCode ?? data.code ?? null;
  const details = (data.details && typeof data.details === 'object') ? data.details : {};
  const field   = details.field ?? details.api_parameter ?? null;
  // details.message de Vita suele ser un texto claro en español ("Solo se permiten números.")
  const vitaMsgEs = (typeof details.message === 'string' && details.message.trim()) ? details.message.trim() : null;
  const message   = String(data.message ?? err?.message ?? 'Error desconocido');
  const haystack  = `${vitaMsgEs ?? ''} ${message}`;

  // ─── Precios caducados — transitorio (Vita exige GET /prices justo antes) ──
  if (/precios?\s+caducaron|prices?\s+expired|caduc/i.test(haystack)) {
    return {
      category:     'VITA_PRICES_EXPIRED',
      adminMessage: `Vita: precios caducados al crear el payout — ${message}`,
      userMessage:  'Hubo un problema temporal con el tipo de cambio.',
      userAction:   'Reintentaremos automáticamente. Si persiste, contacta soporte.',
      retryable:    true,
    };
  }

  // ─── Saldo insuficiente en la wallet maestra Vita (interno, no del usuario) ──
  if (/saldo\s+insuficiente|fondos\s+insuficientes|insufficient\s+(funds|balance)/i.test(haystack)) {
    return {
      category:     'VITA_INSUFFICIENT_BALANCE',
      adminMessage: `Vita rechazó por saldo insuficiente en la wallet maestra: ${message}`,
      userMessage:  'Estamos procesando tu pago. Te avisaremos cuando se complete.',
      userAction:   'Sin acción necesaria — el equipo está fondeando la cuenta.',
      retryable:    false,
    };
  }

  // ─── Validación de campo (code 305 / 422 con details.field) ───────────────
  if (field || code === 305 || status === 422) {
    const label       = fieldLabel(field);
    const numericOnly = /solo\s+se\s+permiten\s+n[uú]meros|only\s+numbers|numeric|required\s+format|does\s+not\s+match/i.test(haystack);

    let userMessage;
    if (field && numericOnly) {
      userMessage = `El ${label} solo admite dígitos (sin espacios ni símbolos). Verifícalo con el beneficiario.`;
    } else if (field && vitaMsgEs) {
      userMessage = `Revisa el ${label}: ${vitaMsgEs}`;
    } else if (field) {
      userMessage = `El ${label} del beneficiario tiene un formato inválido.`;
    } else if (vitaMsgEs) {
      userMessage = `Datos del beneficiario inválidos: ${vitaMsgEs}`;
    } else {
      userMessage = 'Algunos datos del beneficiario tienen un formato inválido.';
    }

    return {
      category:     'VITA_INVALID_FIELD',
      adminMessage: `Vita rechazó el campo "${field ?? '?'}" (code=${code ?? status ?? '?'}): ${vitaMsgEs ?? message}`,
      userMessage,
      userAction:   `Corrige el ${field ? label : 'dato del beneficiario'} y vuelve a intentar.`,
      retryable:    true,
    };
  }

  // ─── Auth / credenciales ──────────────────────────────────────────────────
  if (status === 401 || status === 403) {
    return {
      category:     'VITA_AUTH_ERROR',
      adminMessage: `Vita auth falló (${status}). Verificar VITA_LOGIN / VITA_SECRET / VITA_TRANS_KEY. ${message}`,
      userMessage:  'Hubo un problema interno procesando tu pago. Nuestro equipo ya fue notificado.',
      userAction:   'Intenta de nuevo en unos minutos.',
      retryable:    false,
    };
  }

  // ─── 5xx / red / timeout — transitorio ────────────────────────────────────
  if (err?.isTransient || err?.code === 'VITA_TIMEOUT' ||
      (typeof status === 'number' && status >= 500 && status < 600) ||
      /timeout|abort|network|fetch\s+failed|ECONN/i.test(message)) {
    return {
      category:     'VITA_TRANSIENT',
      adminMessage: `Error transitorio Vita (reintentable): ${message}`,
      userMessage:  'Hubo un problema temporal procesando tu transferencia.',
      userAction:   'Intentaremos de nuevo automáticamente. Si persiste, contacta soporte.',
      retryable:    true,
    };
  }

  // ─── Fallback genérico ────────────────────────────────────────────────────
  return {
    category:     'VITA_UNKNOWN',
    adminMessage: `Vita error no clasificado: code=${code} status=${status} msg="${message}"`,
    userMessage:  'No pudimos completar tu transferencia con los datos ingresados.',
    userAction:   'Verifica los datos del beneficiario o contacta a soporte.',
    retryable:    true,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * RECHAZOS QUE LLEGAN POR IPN (no por la respuesta HTTP del dispatch)
 *
 * Vita puede aceptar el payout (200 al crearlo) y rechazarlo DESPUÉS, avisando
 * por webhook. Ese camino perdía el motivo: el handler solo reconocía 'denied' y
 * escribía un string fijo, descartando el body; cualquier otra palabra
 * ('rejected', 'failed', …) no hacía absolutamente nada y la transacción quedaba
 * en payout_sent sin estado, sin razón y sin aviso a nadie.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Estados de IPN que significan "esto ya no se va a completar". */
export const VITA_IPN_FAILURE_STATUSES = new Set([
  'denied', 'rejected', 'failed', 'failure', 'error', 'canceled', 'cancelled',
  'declined', 'returned', 'reversed', 'refunded', 'expired',
]);

/** Estados de IPN intermedios: informativos, se espera otro IPN después. */
export const VITA_IPN_PROGRESS_STATUSES = new Set([
  'pending', 'processing', 'in_process', 'in_progress', 'created', 'initiated',
  'sent', 'approved', 'accepted',
]);

/**
 * @param {string} status estado crudo del IPN
 * @returns {'success'|'failure'|'progress'|'unknown'}
 */
export function classifyVitaIpnStatus(status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (s === 'completed' || s === 'complete') return 'success';
  if (VITA_IPN_FAILURE_STATUSES.has(s))      return 'failure';
  if (VITA_IPN_PROGRESS_STATUSES.has(s))     return 'progress';
  return 'unknown';
}

// Claves donde Vita (o cualquier pasarela) suele poner el motivo. Orden = prioridad.
const REASON_KEYS = [
  'rejection_reason', 'denial_reason', 'reject_reason', 'failure_reason',
  'status_detail', 'status_description', 'reason', 'motivo',
  'observation', 'observacion', 'error_message', 'error_description',
  'description', 'detail', 'message', 'error',
];

const CODE_KEYS = ['rejection_code', 'error_code', 'status_code', 'code'];

/** Primera clave con contenido, hasta 3 niveles de anidación (el motivo suele venir anidado). */
function pickByKeys(body, keys, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 3) return null;
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object') {
      const found = pickByKeys(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Último recurso: el body crudo acotado. Guardar JSON feo es mejor que perder el motivo. */
function compactBody(body, max = 400) {
  let json;
  try { json = JSON.stringify(body); } catch { return '(body no serializable)'; }
  if (!json || json === '{}') return '(Vita no envió motivo)';
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/**
 * Traduce un IPN de rechazo de Vita a la misma forma que mapVitaError, para que
 * el admin vea el motivo REAL y el usuario un mensaje accionable.
 *
 * Delega la clasificación en mapVitaError: si el IPN trae `details.field` o un
 * texto reconocible, el usuario recibe exactamente el mismo mensaje que si el
 * rechazo hubiera ocurrido en el dispatch — un solo lugar que mantener.
 *
 * @param {object} body   cuerpo del IPN tal cual lo mandó Vita
 * @param {{stage?: 'payin'|'payout'}} [opts]
 * @returns {MappedError & { vitaStatus: string, vitaCode: string|null, reason: string|null }}
 */
export function mapVitaIpnFailure(body, { stage = 'payout' } = {}) {
  const rawStatus = String(body?.status ?? 'desconocido');
  const reason    = pickByKeys(body, REASON_KEYS);
  const code      = pickByKeys(body, CODE_KEYS);
  const etapa     = stage === 'payin' ? 'Payin' : 'Payout';

  const base = mapVitaError({ message: reason ?? '', data: { ...(body ?? {}) } });

  const detalle = reason ?? compactBody(body);
  const adminMessage =
    `${etapa} rechazado por Vita (status="${rawStatus}"` +
    `${code != null ? `, code=${code}` : ''}): ${detalle}`;

  return {
    ...base,
    // Si no se pudo clasificar, la categoría al menos nombra el estado real de Vita.
    category: base.category === 'VITA_UNKNOWN'
      ? `VITA_IPN_${rawStatus.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
      : base.category,
    adminMessage,
    vitaStatus: rawStatus,
    vitaCode:   code ?? null,
    reason:     reason ?? null,
  };
}
