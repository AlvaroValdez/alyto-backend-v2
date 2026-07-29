// src/services/supportKnowledge.js
//
// Conocimiento operativo vivo para el asistente Aly.
//
// Genera un bloque de texto compacto con los corredores ACTIVOS, sus campos de
// beneficiario, comisiones visibles y riel de pago, más las comisiones/límites
// del P2P USDC — desde las MISMAS fuentes que usa la app:
//   - TransactionConfig (corredores activos, moneda, mínimos, fees visibles)
//   - HARBOR_FORM_FIELDS + SUPPORTED_METHODS_BY_COUNTRY (destinos Harbor)
//   - Reglas Vita en vivo (destinos LatAm vía Vita Wallet)
//   - WalletFeeConfig (comisiones y límites USDC P2P)
// Si mañana cambian fees, campos o corredores desde el admin, Aly lo refleja
// sin tocar código — misma filosofía que el formulario dinámico.
//
// ⚠️ NUNCA incluir aquí: profitRetentionPercent ni fees internas (regla 11 del
// proyecto), revenue acumulada, números de cuenta, direcciones o credenciales.
//
// Cache in-process 1 h. Fail-open: ante cualquier error devuelve '' y Aly
// responde con el prompt base — el chat nunca depende de Vita ni de la DB.

import { logger } from '../utils/logger.js';
import TransactionConfig from '../models/TransactionConfig.js';
import WalletFeeConfig from '../models/WalletFeeConfig.js';
import { HARBOR_FORM_FIELDS, SUPPORTED_METHODS_BY_COUNTRY } from '../utils/harborMethodSupport.js';
import { getWithdrawalRules as getVitaWithdrawalRules, getVitaCountryKey } from './vitaWalletService.js';

const CACHE_TTL_MS        = 60 * 60 * 1000;  // 1 hora
const FAIL_RETRY_MS       = 5 * 60 * 1000;   // tras un fallo, reintentar en 5 min
const MAX_KNOWLEDGE_CHARS = 14000;           // tope duro (~3.5k tokens)

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
 * Comisión VISIBLE al usuario del corredor, en una frase compacta.
 * Solo campos que la app muestra en el desglose — jamás fees internas
 * (profitRetentionPercent queda excluida por diseño; regla 11 del proyecto).
 */
function feeSummary(c) {
  const parts = [];
  if (c.alytoCSpread > 0)    parts.push(`${c.alytoCSpread}% spread`);
  if (c.payinFeePercent > 0) parts.push(`${c.payinFeePercent}% pay-in`);
  if (c.fixedFee > 0)        parts.push(`${c.fixedFee} ${c.originCurrency ?? ''} fija`.trim());
  if (c.payoutFeeFixed > 0)  parts.push(`${c.payoutFeeFixed} ${c.destinationCurrency ?? ''} al pago`.trim());
  if (!parts.length) return '';

  const bizSpread = c.businessAlytoCSpread ?? null;
  const bizFixed  = c.businessFixedFee ?? null;
  const bizParts = [
    bizSpread !== null ? `${bizSpread}% spread` : null,
    bizFixed !== null && bizFixed > 0 ? `${bizFixed} ${c.originCurrency ?? ''} fija`.trim() : null,
  ].filter(Boolean);
  const biz = bizParts.length ? ` (business: ${bizParts.join(' + ')})` : '';

  return ` Comisión referencial: ${parts.join(' + ')}${biz}.`;
}

/** Riel/medio por el que llega el dinero al destino. */
function railSummary(entry) {
  if (entry.method === 'owlPay') {
    const key = EU_COUNTRIES.has(entry.country) ? 'EU' : entry.country;
    const rails = SUPPORTED_METHODS_BY_COUNTRY[key];
    if (rails?.length) return ` Llega vía ${rails.join(' o ')}.`;
  }
  if (entry.method === 'vitaWallet') return ' Llega como depósito bancario local.';
  return '';
}

/**
 * Formatea el catálogo de corredores a texto. Pura (sin I/O) — testeable.
 */
export function formatCorridorKnowledge(entries) {
  if (!entries.length) return '';

  const lines = entries.map(e => {
    const name = COUNTRY_NAMES[e.country] ?? e.country;
    const min  = e.minUSD ? ` Mínimo referencial: $${e.minUSD} USD.` : '';
    const rail = railSummary(e);
    const fee  = e.feeText ?? '';
    if (!e.fields?.length) {
      return `- ${name} (${e.country}, ${e.currency}): disponible; la app muestra los datos requeridos del beneficiario.${rail}${min}${fee}`;
    }
    const fields = e.fields.map(fieldSummary).filter(Boolean).join(', ');
    return `- ${name} (${e.country}, ${e.currency}): datos del beneficiario: ${fields}.${rail}${min}${fee}`;
  });

  return `Destinos de transferencia internacional ACTIVOS y datos que pide el formulario (el * marca campo obligatorio). Esta lista es la única fuente de verdad: si un país no aparece, HOY no es destino disponible y debes decirlo. No inventes campos, comisiones ni destinos. Comisiones y mínimos son referenciales: el desglose y la tasa exactos SIEMPRE los muestra la app al cotizar.

${lines.join('\n')}

Nota: los países de la zona euro (Alemania, Francia, Italia, etc.) usan el destino "Europa (zona euro)".`;
}

/**
 * Sección P2P USDC (comisiones y límites vigentes). Pura — testeable.
 */
export function formatP2pKnowledge(fc) {
  if (!fc) return '';
  const feeParts = fc.usdcP2pEnabled
    ? [
        fc.usdcP2pFeePercent > 0 ? `${fc.usdcP2pFeePercent}%` : null,
        fc.usdcP2pFeeFixed > 0 ? `${fc.usdcP2pFeeFixed} USDC fija` : null,
      ].filter(Boolean)
    : [];
  const fee = feeParts.length ? `comisión ${feeParts.join(' + ')}` : 'sin comisión actualmente';
  const free = (fc.usdcP2pEnabled && fc.usdcP2pFreeBelow > 0)
    ? ` Envíos menores a ${fc.usdcP2pFreeBelow} USDC: gratis.` : '';
  const lims = `Límites: mínimo ${fc.usdcP2pMinPerTx} USDC por envío, máximo ${fc.usdcP2pMaxPerTx || 'sin límite'} USDC por envío y ${fc.usdcP2pMaxDaily || 'sin límite'} USDC por día (business: ${fc.businessUsdcP2pMaxPerTx || 'sin límite'} por envío / ${fc.businessUsdcP2pMaxDaily || 'sin límite'} por día).`;

  return `Envíos P2P USDC entre usuarios Alyto (por alias @usuario, instantáneos): ${fee}.${free} ${lims}`;
}

/**
 * Devuelve el bloque de conocimiento (cacheado). '' si no se pudo construir.
 */
export async function getSupportKnowledge() {
  if (_cache.text !== null && (Date.now() - _cache.at) < _cache.ttl) return _cache.text;

  try {
    const corridors = await TransactionConfig
      .find({ isActive: true })
      .select('corridorId originCountry originCurrency destinationCountry destinationCurrency payoutMethod minAmountUSD alytoCSpread businessAlytoCSpread fixedFee businessFixedFee payinFeePercent payoutFeeFixed')
      .lean();

    // Reglas Vita en una sola llamada (vitaWalletService cachea internamente).
    // Best-effort: si Vita no responde, los destinos Vita salen sin detalle de campos.
    let vitaRules = null;
    try {
      vitaRules = await getVitaWithdrawalRules();
    } catch (err) {
      logger.warn('[support-knowledge] Vita rules no disponibles (best-effort)', { error: err.message });
    }

    // Un destino puede tener varios corredores: dedupe por país+moneda. Orden de
    // preferencia: origen BO primero (base principal de usuarios del chat) y,
    // dentro del origen, payoutMethod asc (Harbor antes que Vita — mismo criterio
    // que el resolver del controller para destinos auto-ruteados como EU).
    const sorted = [...corridors].sort((a, b) =>
      ((a.originCountry === 'BO' ? 0 : 1) - (b.originCountry === 'BO' ? 0 : 1))
      || (a.payoutMethod ?? '').localeCompare(b.payoutMethod ?? ''));

    const seen = new Set();
    const entries = [];
    for (const c of sorted) {
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
        feeText:  feeSummary(c),
        fields,
      });
    }

    entries.sort((a, b) => a.country.localeCompare(b.country));

    // Comisiones/límites P2P USDC (singleton, editable desde admin).
    let p2pText = '';
    try {
      const fc = await WalletFeeConfig.getSingleton();
      p2pText = formatP2pKnowledge(fc?.toObject ? fc.toObject() : fc);
    } catch (err) {
      logger.warn('[support-knowledge] WalletFeeConfig no disponible (best-effort)', { error: err.message });
    }

    let text = formatCorridorKnowledge(entries) + (p2pText ? `\n\n${p2pText}` : '');

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

export default { getSupportKnowledge, formatCorridorKnowledge, formatP2pKnowledge };
