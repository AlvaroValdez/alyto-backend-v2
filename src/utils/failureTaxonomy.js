/**
 * failureTaxonomy.js — Catálogo canónico de causas de fallo.
 *
 * `Transaction.failureCategory` existía como `String` libre: los mappers de proveedor
 * escribían su propia etiqueta y cinco sitios más inventaban la suya en línea
 * (BANKQR_EXPIRED, STALE_PAYOUT, STALE_TRANSIT, STELLAR_TRANSIT_EXHAUSTED,
 * TRANSIENT_ERROR). Sin catálogo, un error de tipeo crea una categoría nueva en
 * silencio y el conteo por causa deja de cuadrar sin que nadie lo note.
 *
 * Importa porque el Art. 3° inc. a.5 de la Sección 5 exige tratamiento de daños, y el
 * Art. 13° inc. e los hace causal de rechazo: para informar incidencias por causa hay
 * que poder agruparlas, y para agruparlas la etiqueta tiene que ser estable.
 *
 * Este módulo NO cambia lo que los mappers deciden: recoge lo que ya emiten y lo
 * vuelve enumerable y validable.
 *
 * ── Ejes de clasificación ───────────────────────────────────────────────────────
 *
 *   origin      quién causó el fallo — determina quién responde
 *   consumerFix si el consumidor puede corregirlo y reintentar
 *   damageType  supuesto del apdo. 10.4 del informe técnico, cuando aplica
 */

/** Origen del fallo. Determina a quién corresponde la acción correctiva. */
export const FAILURE_ORIGIN = {
  CONSUMER: 'consumer',   // dato mal ingresado por el consumidor
  PROVIDER: 'provider',   // rechazo o indisponibilidad del proveedor
  ENTITY:   'entity',     // configuración, liquidez o defecto propio
  NETWORK:  'network',    // red pública o infraestructura externa
  UNKNOWN:  'unknown',
};

const O = FAILURE_ORIGIN;

/**
 * Catálogo. La clave es la etiqueta persistida en `Transaction.failureCategory`.
 *
 * `damageType` remite al apartado 10.4 del informe técnico:
 *   1 cobro percibido y pago no ejecutado · 2 monto inferior al informado
 *   3 demora superior a la informada     · 4 depósito no acreditado
 * `null` = el fallo no produce daño patrimonial por sí solo.
 */
export const FAILURE_CATALOG = {
  // ── Datos del beneficiario: el consumidor puede corregir y reintentar ────────
  INVALID_POSTAL_CODE:   { origin: O.CONSUMER, consumerFix: true,  damageType: null },
  INVALID_CPF:           { origin: O.CONSUMER, consumerFix: true,  damageType: null },
  INVALID_ACCOUNT_FORMAT:{ origin: O.CONSUMER, consumerFix: true,  damageType: null },
  INVALID_SWIFT:         { origin: O.CONSUMER, consumerFix: true,  damageType: null },
  INVALID_PHONE:         { origin: O.CONSUMER, consumerFix: true,  damageType: null },
  VITA_INVALID_FIELD:    { origin: O.CONSUMER, consumerFix: true,  damageType: null },
  VALIDATION_ERROR:      { origin: O.CONSUMER, consumerFix: true,  damageType: null },

  // ── Rechazo del proveedor: cobro percibido, pago no ejecutado ───────────────
  WITHDRAWAL_REJECTED:   { origin: O.PROVIDER, consumerFix: false, damageType: 1 },
  CORRIDOR_NOT_ENABLED:  { origin: O.PROVIDER, consumerFix: false, damageType: 1 },
  HARBOR_BUG_SEPA:       { origin: O.PROVIDER, consumerFix: false, damageType: 1 },
  DUPLICATE_TRANSFER:    { origin: O.PROVIDER, consumerFix: false, damageType: null },
  VITA_PRICES_EXPIRED:   { origin: O.PROVIDER, consumerFix: false, damageType: null },

  // ── Indisponibilidad transitoria: se reintenta, no se resarce de inmediato ──
  TRANSIENT_ERROR:       { origin: O.PROVIDER, consumerFix: false, damageType: 3 },
  VITA_TRANSIENT:        { origin: O.PROVIDER, consumerFix: false, damageType: 3 },

  // ── Responsabilidad de la entidad ───────────────────────────────────────────
  AUTH_ERROR:            { origin: O.ENTITY,   consumerFix: false, damageType: 1 },
  VITA_AUTH_ERROR:       { origin: O.ENTITY,   consumerFix: false, damageType: 1 },
  INVALID_CUSTOMER_UUID: { origin: O.ENTITY,   consumerFix: false, damageType: 1 },
  INSUFFICIENT_LIQUIDITY:{ origin: O.ENTITY,   consumerFix: false, damageType: 3 },
  VITA_INSUFFICIENT_BALANCE:{ origin: O.ENTITY, consumerFix: false, damageType: 3 },
  STALE_PAYOUT:          { origin: O.ENTITY,   consumerFix: false, damageType: 1 },
  STALE_TRANSIT:         { origin: O.ENTITY,   consumerFix: false, damageType: 1 },

  // ── Red pública ─────────────────────────────────────────────────────────────
  STELLAR_TRANSIT_EXHAUSTED:{ origin: O.NETWORK, consumerFix: false, damageType: 1 },

  // ── Expiración sin pago: no hubo cobro, no hay daño patrimonial ─────────────
  BANKQR_EXPIRED:        { origin: O.CONSUMER, consumerFix: true,  damageType: null },
  PAYIN_ABANDONED:       { origin: O.CONSUMER, consumerFix: true,  damageType: null },

  // ── Límites regulatorios del Entorno Controlado ─────────────────────────────
  ECP_LIMIT_EXCEEDED:    { origin: O.ENTITY,   consumerFix: false, damageType: null },

  // ── Sin clasificar. Su presencia es una señal, no un estado aceptable ───────
  UNKNOWN:               { origin: O.UNKNOWN,  consumerFix: false, damageType: 1 },
  VITA_UNKNOWN:          { origin: O.UNKNOWN,  consumerFix: false, damageType: 1 },
};

/** Etiquetas válidas — para el enum del modelo. */
export const FAILURE_CATEGORIES = Object.keys(FAILURE_CATALOG);

export function isKnownFailureCategory(cat) {
  return Object.prototype.hasOwnProperty.call(FAILURE_CATALOG, cat);
}

/**
 * Clasifica una etiqueta. Una desconocida NO lanza: devuelve el registro de
 * `UNKNOWN` marcado con `recognized:false`. Un fallo de clasificación no puede
 * impedir que se registre el fallo original — sería perder la causa por no saber
 * nombrarla.
 */
export function classifyFailure(cat) {
  if (isKnownFailureCategory(cat)) {
    return { category: cat, recognized: true, ...FAILURE_CATALOG[cat] };
  }
  return { category: 'UNKNOWN', recognized: false, ...FAILURE_CATALOG.UNKNOWN };
}

/**
 * ¿El fallo constituye un daño patrimonial que exige resarcimiento?
 *
 * Sólo si tiene `damageType` Y el cobro fue efectivamente percibido: sin cobro no
 * hay recursos del consumidor comprometidos. Es la traducción a código del apartado
 * 10.2.1 del informe — la superficie de daño se limita a fondos ya recibidos.
 */
export function isCompensableDamage({ category, payinConfirmed }) {
  const c = classifyFailure(category);
  return Boolean(c.damageType) && Boolean(payinConfirmed);
}

/** Agrupa categorías por origen. Para el informe mensual de incidencias a ASFI. */
export function groupByOrigin(categories = []) {
  const out = {};
  for (const cat of categories) {
    const { origin } = classifyFailure(cat);
    (out[origin] ??= []).push(cat);
  }
  return out;
}

export default {
  FAILURE_ORIGIN,
  FAILURE_CATALOG,
  FAILURE_CATEGORIES,
  isKnownFailureCategory,
  classifyFailure,
  isCompensableDamage,
  groupByOrigin,
};
