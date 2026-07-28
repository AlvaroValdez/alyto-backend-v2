// src/services/supportKnowledge.js
//
// Conocimiento operativo vivo para el asistente Aly.
//
// Genera un bloque de texto compacto con los corredores ACTIVOS y los campos
// del formulario de beneficiario por destino, desde las MISMAS fuentes que usa
// el formulario de la app:
//   - TransactionConfig (corredores activos, moneda, mínimos)
//   - HARBOR_FORM_FIELDS (destinos vía OwlPay Harbor — bo-us, bo-br, etc.)
//   - Reglas Vita en vivo (destinos LatAm vía Vita Wallet)
// Si mañana cambian los campos o se activa/desactiva un corredor, Aly lo
// refleja sin tocar código — misma filosofía que el formulario dinámico.
//
// Cache in-process 1 h (mismo TTL que withdrawalRulesCache del controller).
// Fail-open: ante cualquier error devuelve '' y Aly responde con el prompt
// base — el chat de soporte nunca depende de Vita ni de la DB para funcionar.

import { logger } from '../utils/logger.js';
import TransactionConfig from '../models/TransactionConfig.js';
import { HARBOR_FORM_FIELDS } from '../utils/harborMethodSupport.js';
import { getWithdrawalRules as getVitaWithdrawalRules, getVitaCountryKey } from './vitaWalletService.js';

const CACHE_TTL_MS       = 60 * 60 * 1000;  // 1 hora
const FAIL_RETRY_MS      = 5 * 60 * 1000;   // tras un fallo, reintentar en 5 min
const MAX_KNOWLEDGE_CHARS = 14000;          // tope duro (~3.5k tokens)

let _cache = { text: null, at: 0, ttl: CACHE_TTL_MS };

// EU: países de la eurozona que usan los campos WIRE del corredor bo-eu-srl
// (mismo set que getWithdrawalRulesController).
const EU_COUNTRIES = new Set(['DE','FR','IT','NL','BE','PT','AT','PL','SE','CH','NO','DK','FI','IE']);

const COUNTRY_NAMES = {
  AE: 'Emiratos Árabes Unidos', AR: 'Argentina', AU: 'Australia', BO: 'Bolivia',
  BR: 'Brasil', CA: 'Canadá', CL: 'Chile', CN: 'China', CO: 'Colombia',
  CR: 'Costa Rica', DO: 'República Dominicana', EC: 'Ecuador', ES: 'España',
  EU: 'Europa (zona euro)', GB: 'Reino Unido', GT: 'Guatemala', HK: 'Hong Kong',
  HT: 'Haití', IN: 'India', JP: 'Japón', MX: 'México', NG: 'Nigeria',
  PA: 'Panamá', PE: 'Perú', PL: 'Polonia', PY: 'Paraguay', SG: 'Singapur',
  SV: 'El Salvador', US: 'Estados Unidos', UY: 'Uruguay', VE: 'Venezuela',
  ZA: 'Sudáfrica',
};

/**
 * Resume un campo de formulario en "Etiqueta*" (el * marca obligatorio).
 * Los select con muchas opciones no listan las opciones (las muestra la app).
 */
function fieldSummary(f) {
  const label = f.label ?? f.name ?? f.key;
  if (!label) return null;
  const req = f.required !== false ? '*' : '';
  const opts = Array.isArray(f.options) ? f.options : [];
  if (opts.length > 0 && opts.length <= 4) {
    return `${label}${req} (${opts.map(o => o.label ?? o.value ?? o).join('/')})`;
  }
  if (opts.length > 4) return `${label}${req} (elegir de la lista en la app)`;
  return `${label}${req}`;
}

/**
 * Formatea el catálogo a texto. Pura (sin I/O) — testeable con fixtures.
 * @param {Array<{country:string, currency:string, method:string, minUSD:number|null, fields:Array}>} entries
 */
export function formatCorridorKnowledge(entries) {
  if (!entries.length) return '';

  const lines = entries.map(e => {
    const name = COUNTRY_NAMES[e.country] ?? e.country;
    const min  = e.minUSD ? ` Mínimo referencial: $${e.minUSD} USD (el vigente lo muestra la app al cotizar).` : '';
    if (!e.fields?.length) {
      return `- ${name} (${e.country}, ${e.currency}): disponible; la app muestra los datos requeridos del beneficiario.${min}`;
    }
    const fields = e.fields.map(fieldSummary).filter(Boolean).join(', ');
    return `- ${name} (${e.country}, ${e.currency}): datos del beneficiario: ${fields}.${min}`;
  });

  return `Destinos de transferencia internacional ACTIVOS y datos que pide el formulario (el * marca campo obligatorio). Esta lista es la única fuente de verdad: si un país no aparece, HOY no es destino disponible y debes decirlo. No inventes campos ni destinos.

${lines.join('\n')}

Nota: los países de la zona euro (Alemania, Francia, Italia, etc.) usan el destino "Europa (zona euro)".`;
}

/**
 * Devuelve el bloque de conocimiento (cacheado). '' si no se pudo construir.
 */
export async function getSupportKnowledge() {
  if (_cache.text !== null && (Date.now() - _cache.at) < _cache.ttl) return _cache.text;

  try {
    const corridors = await TransactionConfig
      .find({ isActive: true })
      .select('corridorId destinationCountry destinationCurrency payoutMethod minAmountUSD')
      .lean();

    // Reglas Vita en una sola llamada (vitaWalletService cachea internamente).
    // Best-effort: si Vita no responde, los destinos Vita salen sin detalle de campos.
    let vitaRules = null;
    try {
      vitaRules = await getVitaWithdrawalRules();
    } catch (err) {
      logger.warn('[support-knowledge] Vita rules no disponibles (best-effort)', { error: err.message });
    }

    // Un destino puede tener varios corredores (EU auto-ruteado): dedupe por
    // país+moneda quedándose con el primero (sort payoutMethod asc prefiere
    // Harbor, igual que el resolver del controller).
    const seen = new Set();
    const entries = [];
    for (const c of corridors.sort((a, b) => (a.payoutMethod ?? '').localeCompare(b.payoutMethod ?? ''))) {
      const country = (c.destinationCountry ?? '').toUpperCase();
      if (!country) continue;
      const dedupeKey = `${country}:${c.destinationCurrency ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let fields = [];
      if (c.payoutMethod === 'owlPay') {
        const harborKey = EU_COUNTRIES.has(country) ? 'EU' : country;
        fields = HARBOR_FORM_FIELDS[harborKey] ?? [];
      } else if (c.payoutMethod === 'vitaWallet' && vitaRules) {
        const vitaKey = getVitaCountryKey(country, c.destinationCurrency);
        fields = vitaRules?.rules?.[vitaKey]?.fields ?? [];
      }
      // anchorBolivia / manual: sin campos dinámicos — la app guía el flujo.

      entries.push({
        country,
        currency: c.destinationCurrency ?? '',
        method:   c.payoutMethod ?? '',
        minUSD:   c.minAmountUSD ?? null,
        fields,
      });
    }

    entries.sort((a, b) => a.country.localeCompare(b.country));
    let text = formatCorridorKnowledge(entries);

    if (text.length > MAX_KNOWLEDGE_CHARS) {
      logger.warn('[support-knowledge] catálogo excede tope, se trunca', { length: text.length });
      text = `${text.slice(0, MAX_KNOWLEDGE_CHARS)}\n(… catálogo truncado — para otros destinos, indicar al usuario revisar la app.)`;
    }

    _cache = { text, at: Date.now(), ttl: CACHE_TTL_MS };
    logger.info('[support-knowledge] catálogo generado', { corridors: entries.length, chars: text.length });
    return text;
  } catch (err) {
    logger.warn('[support-knowledge] no se pudo construir el catálogo (fail-open)', { error: err.message });
    _cache = { text: '', at: Date.now(), ttl: FAIL_RETRY_MS };
    return '';
  }
}

export default { getSupportKnowledge, formatCorridorKnowledge };
