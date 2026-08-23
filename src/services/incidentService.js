/**
 * incidentService.js — Apertura, transición y plazos de incidentes.
 *
 * Implementa los apartados 10.6 a 10.11 del informe técnico. Los plazos que el
 * informe compromete ante ASFI se calculan acá, no se recuerdan: un plazo que
 * depende de que alguien lo tenga presente no es un control.
 *
 * Plazos comprometidos (días HÁBILES, apdos. 10.7, 10.8.1 y 10.11):
 *
 *   determinación de alcance y causa ................ 2
 *   devolución íntegra (pago no ejecutado) .......... 3
 *   complemento (monto inferior) .................... 2
 *   acreditación (depósito no acreditado) ........... 1
 *   liberación (restricción indebida) ............... 1
 *   comunicación a ASFI ............................. 2
 */

import Incident, { PATRIMONIAL_TYPES } from '../models/Incident.js';
import { classifyFailure }             from '../utils/failureTaxonomy.js';
import { logger }                      from '../utils/logger.js';

/**
 * Suma días hábiles (lun–vie). Admite valores negativos, que restan: `findOverdue`
 * los usa para preguntar "qué se detectó hace más de dos días hábiles".
 *
 * No contempla feriados. Es deliberado y conservador: al ignorarlos, el plazo
 * calculado vence ANTES que el real, nunca después. Un vencimiento adelantado
 * genera una alerta temprana; uno atrasado incumple un plazo comprometido.
 */
export function addBusinessDays(from, days) {
  const d = new Date(from);
  const paso = days >= 0 ? 1 : -1;
  let restantes = Math.abs(days);
  while (restantes > 0) {
    d.setDate(d.getDate() + paso);
    if (d.getDay() !== 0 && d.getDay() !== 6) restantes--;
  }
  return d;
}

/** Modalidad y plazo de resarcimiento por tipo — apdo. 10.8.1. */
const COMPENSATION_RULES = {
  pago_no_ejecutado:      { modality: 'devolucion_integra', businessDays: 3 },
  monto_inferior:         { modality: 'complemento',        businessDays: 2 },
  deposito_no_acreditado: { modality: 'acreditacion',       businessDays: 1 },
  restriccion_indebida:   { modality: 'liberacion',         businessDays: 1 },
};

/** Tipos que obligan a comunicar a esta Autoridad — apdo. 10.11. */
function requiresAsfiReport(type, isDamage) {
  if (type === 'datos_personales') return true;          // siempre, haya o no daño
  return Boolean(isDamage) && PATRIMONIAL_TYPES.includes(type);
}

export function compensationRuleFor(type) {
  return COMPENSATION_RULES[type] ?? null;
}

/**
 * Abre un incidente. NO afirma que hubo daño: eso se determina después.
 *
 * @param {object} p
 * @param {string} p.type            uno de INCIDENT_TYPES
 * @param {string} p.source          cómo se detectó
 * @param {string} p.description
 * @param {string} [p.severity]
 * @param {string} [p.failureCategory] etiqueta de failureTaxonomy, si viene de un fallo
 * @param {string[]} [p.transactions]  alytoTransactionId afectados
 * @param {string[]} [p.users]         userId afectados
 * @param {string} [p.detectedBy]
 */
export async function openIncident({
  type, source, description, severity = 'media',
  failureCategory = null, transactions = [], users = [], reclamos = [],
  detectedBy = 'system', now = new Date(),
}) {
  const incident = new Incident({
    type, source, description, severity, failureCategory,
    affectedTransactions: transactions,
    affectedUsers:        users,
    affectedReclamos:     reclamos,
    detectedAt:           now,
    detectedBy,
  });

  // El plazo de determinación corre desde la detección, no desde que alguien mira.
  incident.determination.at = null;

  await incident.save();

  logger?.warn?.('[Incidente] Abierto', {
    incidentId: incident.incidentId, type, source, severity,
    transacciones: transactions.length,
  });

  return incident;
}

/**
 * Abre un incidente a partir de una operación fallida, derivando el tipo de la
 * taxonomía de causas. Devuelve `null` cuando el fallo no constituye incidente
 * —dato mal ingresado que el consumidor puede corregir, o expiración sin cobro—,
 * para no inundar el registro con ruido que no exige tratamiento.
 */
export async function openIncidentFromFailure({ transaction, now = new Date() }) {
  const clasificacion = classifyFailure(transaction?.failureCategory);
  const cobroPercibido = Boolean(transaction?.payinConfirmedAt)
    || ['payin_confirmed', 'payin_completed', 'processing', 'in_transit',
        'payout_pending', 'payout_sent'].includes(transaction?.previousStatus);

  // Sin daño posible y corregible por el consumidor → no es incidente.
  if (!clasificacion.damageType && clasificacion.consumerFix) return null;
  // Con daño patrimonial declarado pero sin cobro percibido, no hay recursos
  // comprometidos del consumidor: apdo. 10.2.1.
  if (clasificacion.damageType && !cobroPercibido && clasificacion.consumerFix) return null;

  const TIPO_POR_DANO = { 1: 'pago_no_ejecutado', 2: 'monto_inferior',
                          3: 'demora', 4: 'deposito_no_acreditado' };
  const type = TIPO_POR_DANO[clasificacion.damageType] ?? 'otro';

  return openIncident({
    type,
    source:      'deteccion_propia',
    severity:    clasificacion.origin === 'entity' ? 'alta' : 'media',
    description: `Operación no completada. Causa: ${clasificacion.category}`
               + `${clasificacion.recognized ? '' : ' (categoría no catalogada)'}.`,
    failureCategory: clasificacion.category,
    transactions:    [transaction?.alytoTransactionId].filter(Boolean),
    users:           [transaction?.userId].filter(Boolean),
    now,
  });
}

/**
 * Registra un cambio de estado conservando la sucesión. Único camino admitido:
 * el modelo bloquea toda escritura sobre `statusHistory` por fuera de acá.
 */
export async function transitionIncident({ incident, to, actor = null, reason = '', now = new Date() }) {
  const from = incident.status;
  if (from === to) return incident;

  incident.status = to;
  incident.statusHistory.push({
    from, to, at: now,
    actorId:    actor?._id ?? null,
    actorEmail: actor?.email ?? '',
    reason,
  });
  await incident.save();

  logger?.info?.('[Incidente] Transición', {
    incidentId: incident.incidentId, from, to, actor: actor?.email ?? 'system',
  });
  return incident;
}

/** Contención — apdo. 10.6 paso 2. Precede a la determinación, a propósito. */
export async function containIncident({ incident, action, actor = null, now = new Date() }) {
  incident.containment = { at: now, action };
  return transitionIncident({ incident, to: 'contenido', actor,
                              reason: `Contención: ${action}`, now });
}

/**
 * Determinación — apdo. 10.6 paso 4. Fija, en un solo acto, si hubo daño y con ello
 * los dos plazos que de allí se derivan: el de resarcimiento y el de comunicación.
 */
export async function determineIncident({
  incident, isDamage, cause = '', causeKnown = true, actor = null, now = new Date(),
}) {
  incident.determination = { at: now, isDamage, cause, causeKnown };

  if (isDamage) {
    const regla = compensationRuleFor(incident.type);
    if (regla) {
      incident.compensation.modality = regla.modality;
      incident.compensation.dueAt    = addBusinessDays(now, regla.businessDays);
    }
    // Apdo. 10.8.2: causa no determinada NO difiere la restitución. Se restituye
    // igual y la investigación sigue por cuenta de la entidad.
    if (!causeKnown && !incident.compensation.modality) {
      incident.compensation.modality = 'devolucion_integra';
      incident.compensation.dueAt    = addBusinessDays(now, 3);
    }
  } else if (incident.compensation.modality === null) {
    incident.compensation.modality = 'no_corresponde';
  }

  if (requiresAsfiReport(incident.type, isDamage)) {
    incident.asfiReport.required = true;
    incident.asfiReport.dueAt    = addBusinessDays(now, 2);
  }

  return transitionIncident({
    incident, to: 'determinado', actor, now,
    reason: isDamage ? `Daño determinado. Causa: ${cause || 'no determinada'}`
                     : 'Sin daño a consumidores',
  });
}

/** Casos con plazo vencido o por vencer. Alimenta el seguimiento del apdo. 10.9. */
export async function findOverdue({ now = new Date() } = {}) {
  const [resarcimiento, reporte, determinacion] = await Promise.all([
    Incident.find({ status: { $nin: ['resarcido', 'cerrado', 'descartado'] },
                    'compensation.dueAt': { $ne: null, $lt: now } })
            .select('incidentId type compensation status').lean(),
    Incident.find({ 'asfiReport.required': true, 'asfiReport.reportedAt': null,
                    'asfiReport.dueAt': { $ne: null, $lt: now } })
            .select('incidentId type asfiReport status').lean(),
    Incident.find({ status: { $in: ['abierto', 'contenido', 'en_analisis'] },
                    'determination.at': null,
                    detectedAt: { $lt: addBusinessDays(now, -2) } })
            .select('incidentId type detectedAt status').lean(),
  ]);
  return { resarcimiento, reporte, determinacion };
}

export default {
  addBusinessDays,
  compensationRuleFor,
  openIncident,
  openIncidentFromFailure,
  transitionIncident,
  containIncident,
  determineIncident,
  findOverdue,
};
