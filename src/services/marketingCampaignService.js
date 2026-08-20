// src/services/marketingCampaignService.js
//
// Pipeline de generación de copy de marketing con IA para Alyto / alyto.io.
//
// Toma un brief (audiencia, objetivo, notas) y produce copy on-brand por canal.
// La llamada al modelo pasa por el adaptador llmProvider (formato neutro) — el
// proveedor y el modelo se eligen por env var, sin tocar este servicio.
//
// Diseño de "pipeline": cada canal es una entrada en CHANNELS (system prompt +
// armado del user prompt + validación de forma). runCampaign() itera sobre los
// canales pedidos; runChannel() ejecuta uno. Hoy el único canal implementado es
// `landing_hero` (titular + subtítulo + CTA en español para la landing). Agregar
// email, hilo X, LinkedIn, etc. = agregar una entrada a CHANNELS, sin tocar el
// motor.
//
// Proveedor por defecto: API directa de Anthropic con Claude Sonnet 4.6 (tarea
// creativa acotada + reglas de compliance → tier "smart" que además acepta
// `temperature`, que el adaptador reenvía). 'bedrock' queda disponible como
// legado vía MARKETING_AI_PROVIDER=bedrock.
//
// Gating: TODO apagado salvo MARKETING_AI_ENABLED=true → las funciones devuelven
// null (no-op). El copy generado por IA NUNCA es autoritativo: es un borrador
// que un humano revisa y aprueba antes de publicar.
//
// Este servicio NUNCA lanza: ante cualquier error devuelve null y registra en
// logger + Sentry.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';
import { complete } from './llmProvider.js';
import { verificarProhibiciones } from './riskClassifier.js';

const ENABLED     = process.env.MARKETING_AI_ENABLED === 'true';
const PROVIDER    = process.env.MARKETING_AI_PROVIDER || 'anthropic';

// Modelo por proveedor. Anthropic: alias vigente de Sonnet 4.6 (tier smart, acepta
// temperature). Bedrock (legado): var dedicada → modelo smart compartido → inference profile.
const MODEL = process.env.MARKETING_AI_MODEL
  || (PROVIDER === 'bedrock'
    ? (process.env.BEDROCK_MODEL_MARKETING
      || process.env.BEDROCK_MODEL_SMART
      || 'us.anthropic.claude-sonnet-4-6-v1:0')
    : 'claude-sonnet-4-6');

const MAX_TOKENS   = Number(process.env.MARKETING_AI_MAX_TOKENS || 1500);
const TEMPERATURE  = Number(process.env.MARKETING_AI_TEMPERATURE || 0.7);
const MAX_VARIANTS = Number(process.env.MARKETING_AI_MAX_VARIANTS || 5);

export function isMarketingCampaignEnabled() {
  return ENABLED;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reglas de compliance NO negociables. Se inyectan en TODOS los system prompts y
// además se aplican como guard determinista tras generar (defensa en profundidad:
// si una regla se filtra pese al prompt, la variante se descarta).
// ─────────────────────────────────────────────────────────────────────────────
const COMPLIANCE_RULES = `Reglas de compliance ESTRICTAS (Alyto / AV Finance):
1. Está PROHIBIDO usar "remesa", "remesas" o "remittance". Usá "transferencia internacional", "pago transfronterizo", "pay-in/pay-out" o "envío".
2. NO hagas afirmaciones legales o de certificación que Alyto no posea: nada de "FDIC", "SOC 2", "FinCEN", "asegurado", "garantizado por el banco".
3. Tono regulatorio NEUTRO. AV Finance SRL opera dentro del Entorno Controlado de Pruebas de ASFI; la licencia plena ETF/PSAV aún NO fue emitida. NO afirmes estar "licenciados", "regulados por ASFI", "autorizados por ASFI" ni "aprobados por ASFI". Podés decir "operamos bajo el marco de ASFI" o "en entorno controlado de ASFI".
4. Si mencionás a "Aly", es la MASCOTA de la marca (un personaje). NUNCA la describas como inteligencia artificial, bot, chatbot ni asistente virtual.
5. NO prometas tasas, plazos, rendimientos ni resultados específicos. Las tasas y comisiones se muestran en la app al cotizar.
6. Escribe SIEMPRE en español neutro. Concretamente: usa las formas de "tú" (guarda, envía, recibe, maneja, tienes, necesitas) o construcciones impersonales e infinitivas. NUNCA uses voseo ("vos", "guardá", "enviá", "recibí", "tenés", "necesitás") ni formas peninsulares ("vosotros", "coger"). Evita modismos y regionalismos. No mezcles inglés salvo nombres propios.`;

/**
 * Revisa un texto contra las prohibiciones absolutas de compliance.
 *
 * ⚠️ La deny-list ya NO vive acá. Vive en services/riskClassifier.js, que es la
 * fuente única para todo el grupo. Antes había dos listas paralelas — esta y la
 * del agente de marketing — que vetaban cosas distintas: esta cubría FDIC / SOC 2
 * / FinCEN y el clasificador no, así que una pieza social que dijera "asegurado
 * por FDIC" se autopublicaba sin revisión. Dos listas de compliance divergentes
 * es exactamente el tipo de cosa que falla en silencio.
 *
 * Diferencia de política, no de vocabulario: acá el veredicto es binario (se
 * descarta la variante); en el agente de marketing la misma señal manda la pieza
 * a revisión humana. Mismo lexicón, distinto qué se hace con él.
 *
 * Nota: al unificar, este guard pasó a cubrir también "exchange" para describir
 * a Alyto, que la lista vieja no tenía.
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function checkCompliance(text) {
  const veredicto = verificarProhibiciones(text);
  if (veredicto.ok) return { ok: true };
  return { ok: false, reason: `${veredicto.motivo} ("${veredicto.coincidencia}")` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registro de canales. Un canal define: system prompt, cómo se arma el user
// prompt desde el brief, y cómo se valida/normaliza la forma de cada ítem.
// ─────────────────────────────────────────────────────────────────────────────
const CHANNELS = {
  landing_hero: {
    label: 'Hero de landing (alyto.io)',
    system: `Eres un copywriter senior de fintech, especializado en landing pages de billeteras cripto/pagos transfronterizos. Escribes para Alyto (alyto.io), la billetera de AV Finance sobre la red Stellar: wallet con saldo en BOB y en USDC, pagos transfronterizos, foco LatAm (Bolivia).

Tu tarea: generar variantes de HERO para la landing. Cada variante es:
- "titular": headline principal, potente y concreto, máx ~9 palabras.
- "subtitulo": una frase de apoyo que explique el valor, máx ~22 palabras.
- "cta": texto del botón de llamada a la acción, 2 a 4 palabras (ej. "Crear mi wallet", "Empezar gratis").

Buenas prácticas: claridad sobre ingenio, beneficio concreto para el usuario (guardar BOB y USDC, enviar y recibir sin fricción), evitar clichés de "AI slop", nada de jerga innecesaria.

${COMPLIANCE_RULES}

FORMATO DE SALIDA: respondé ÚNICAMENTE con un array JSON válido, sin texto antes ni después y sin bloques de código markdown. Cada elemento: {"titular": "...", "subtitulo": "...", "cta": "..."}.`,
    buildUserPrompt(brief = {}) {
      const {
        audiencia = 'usuarios retail en Bolivia que reciben y envían dinero',
        objetivo  = 'que creen su wallet Alyto',
        notas     = '',
        variantes = 3,
      } = brief;
      const n = Math.max(1, Math.min(MAX_VARIANTS, Number(variantes) || 3));
      const lines = [
        `Genera ${n} variante(s) de hero.`,
        `Audiencia: ${audiencia}.`,
        `Objetivo de conversión: ${objetivo}.`,
      ];
      if (notas) lines.push(`Notas / ángulo a resaltar: ${notas}.`);
      lines.push('Devuelve exactamente ese número de variantes en el array JSON.');
      return lines.join('\n');
    },
    // Normaliza y valida forma de un ítem del array devuelto por el modelo.
    normalizeItem(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const titular   = typeof raw.titular === 'string' ? raw.titular.trim() : '';
      const subtitulo = typeof raw.subtitulo === 'string' ? raw.subtitulo.trim() : '';
      const cta       = typeof raw.cta === 'string' ? raw.cta.trim() : '';
      if (!titular || !subtitulo || !cta) return null;
      return { titular, subtitulo, cta };
    },
    // Texto plano de un ítem, para pasarlo por el guard de compliance.
    itemText(item) {
      return `${item.titular} ${item.subtitulo} ${item.cta}`;
    },
  },
};

export function listChannels() {
  return Object.keys(CHANNELS);
}

// Extrae y parsea el array JSON de la respuesta del modelo, tolerando fences ```json.
function parseJsonArray(text) {
  if (!text) return null;
  let s = text.trim();
  // Quitar fences markdown si el modelo los agregó pese a la instrucción.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Recortar al primer '[' y último ']' por si hay texto envolvente.
  const start = s.indexOf('[');
  const end   = s.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ejecuta un canal del pipeline.
 * @param {string} channelKey  clave en CHANNELS (ej. 'landing_hero')
 * @param {object} brief       { audiencia, objetivo, notas, variantes }
 * @returns {Promise<{channel:string, items:Array, dropped:Array, usage?:object}|null>}
 */
export async function runChannel(channelKey, brief = {}) {
  try {
    if (!ENABLED) return null;

    const channel = CHANNELS[channelKey];
    if (!channel) {
      logger.warn('[marketing-ai] canal desconocido', { channelKey });
      return null;
    }

    const resp = await complete({
      provider: PROVIDER,
      model: MODEL,
      system: channel.system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: channel.buildUserPrompt(brief) }] },
      ],
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });

    const rawArray = parseJsonArray(resp.text);
    if (!rawArray) {
      logger.warn('[marketing-ai] respuesta no parseable como JSON', {
        channel: channelKey, provider: PROVIDER, model: MODEL, stopReason: resp.stopReason,
      });
      return null;
    }

    // Normalizar forma + aplicar guard de compliance determinista.
    const items = [];
    const dropped = [];
    for (const raw of rawArray) {
      const item = channel.normalizeItem(raw);
      if (!item) { dropped.push({ raw, reason: 'forma inválida' }); continue; }
      const verdict = checkCompliance(channel.itemText(item));
      if (!verdict.ok) { dropped.push({ item, reason: verdict.reason }); continue; }
      items.push(item);
    }

    if (dropped.length) {
      logger.warn('[marketing-ai] variantes descartadas por guard', {
        channel: channelKey, dropped: dropped.length, reasons: dropped.map(d => d.reason),
      });
    }

    if (!items.length) {
      logger.warn('[marketing-ai] runChannel sin variantes válidas', {
        channel: channelKey, provider: PROVIDER, model: MODEL,
      });
      return null;
    }

    logger.info('[marketing-ai] runChannel ok', {
      channel: channelKey, provider: PROVIDER, model: MODEL,
      items: items.length, dropped: dropped.length,
      inputTokens: resp.usage?.inputTokens, outputTokens: resp.usage?.outputTokens,
    });

    return { channel: channelKey, items, dropped, usage: resp.usage };
  } catch (err) {
    logger.error('[marketing-ai] runChannel falló', {
      channel: channelKey, provider: PROVIDER, error: err.message,
    });
    Sentry.captureException(err, { tags: { service: 'marketingCampaignService', channel: channelKey } });
    return null;
  }
}

/**
 * Pipeline: ejecuta varios canales para un mismo brief.
 * @param {object} params
 * @param {string[]} [params.channels]  canales a generar (default: todos los disponibles)
 * @param {object}   [params.brief]     brief compartido
 * @returns {Promise<Object<string, object|null>>}  mapa canal → resultado (o null)
 */
export async function runCampaign({ channels = listChannels(), brief = {} } = {}) {
  if (!ENABLED) return null;
  const results = await Promise.allSettled(channels.map(c => runChannel(c, brief)));
  const out = {};
  channels.forEach((c, i) => {
    const r = results[i];
    out[c] = r.status === 'fulfilled' ? r.value : null;
  });
  return out;
}

/**
 * Atajo para el único canal implementado hoy: hero de landing en español.
 * @param {object} brief  { audiencia, objetivo, notas, variantes }
 * @returns {Promise<{channel:string, items:Array, dropped:Array, usage?:object}|null>}
 */
export function generateLandingHero(brief = {}) {
  return runChannel('landing_hero', brief);
}

export default {
  isMarketingCampaignEnabled,
  listChannels,
  runChannel,
  runCampaign,
  generateLandingHero,
};
