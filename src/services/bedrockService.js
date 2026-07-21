// src/services/bedrockService.js
//
// IA — parser de comprobantes bancarios BOB (visión).
//
// El admin sube/recibe la imagen del comprobante y Claude extrae monto,
// referencia y banco para pre-rellenar la confirmación manual (NO autoritativo —
// el admin decide). La llamada al modelo pasa por el adaptador llmProvider
// (formato neutro con bloques de imagen) — el proveedor y el modelo se eligen
// por env var, sin tocar este servicio.
//
// Proveedor por defecto: API directa de Anthropic con Claude Haiku 4.5 (la
// cuenta AWS no tiene cuota Bedrock on-demand — ver docs/AWS_ESTADO_GENERAL.md §4).
// 'bedrock' queda disponible como legado vía COMPROBANTE_AI_PROVIDER=bedrock.
//
// Gating: TODO apagado salvo COMPROBANTE_AI_ENABLED=true (se acepta el nombre
// legado BEDROCK_ENABLED=true). Si está OFF, parseComprobante() devuelve null
// inmediatamente (no-op).
//
// Fire-and-forget: el llamador NUNCA debe bloquear el flujo principal esperando
// esto (regla 13/17 de CLAUDE.md). Errores → Sentry + null, nunca lanzan.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';
import { complete } from './llmProvider.js';

const ENABLED = process.env.COMPROBANTE_AI_ENABLED === 'true'
  || process.env.BEDROCK_ENABLED === 'true';

const PROVIDER = process.env.COMPROBANTE_AI_PROVIDER || 'anthropic';

// Modelo por proveedor. Anthropic: alias vigente de Haiku 4.5 (rápido/barato,
// tarea acotada de extracción). Bedrock (legado): var histórica.
const MODEL = process.env.COMPROBANTE_AI_MODEL
  || (PROVIDER === 'bedrock'
    ? (process.env.BEDROCK_MODEL_FAST || 'anthropic.claude-haiku-4-5-20251001-v1:0')
    : 'claude-haiku-4-5');

const MAX_TOKENS = Number(process.env.COMPROBANTE_AI_MAX_TOKENS || 512);

export function isBedrockEnabled() {
  return ENABLED;
}

// Mapea mimetype a los media types que acepta la visión de Claude.
function imageMediaType(mimetype) {
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') return 'image/jpeg';
  if (mimetype === 'image/png') return 'image/png';
  if (mimetype === 'image/webp') return 'image/webp';
  if (mimetype === 'image/gif') return 'image/gif';
  return null; // PDFs y otros no soportados por el parser de comprobantes
}

const PARSE_PROMPT = `Eres un asistente que extrae datos de comprobantes bancarios bolivianos (transferencias, depósitos QR, Banco Económico / BNB / otros).
Analiza la imagen del comprobante y devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional, con esta forma:
{
  "amount": number|null,        // monto en BOB (solo el número, sin símbolo)
  "currency": "BOB"|null,
  "reference": string|null,     // número de operación / referencia / glosa
  "bank": string|null,          // banco emisor si es legible
  "date": string|null,          // fecha del comprobante en formato YYYY-MM-DD si es legible
  "senderName": string|null,    // nombre del ordenante si aparece
  "confidence": number          // 0..1 — qué tan seguro estás de los datos extraídos
}
Si la imagen no es un comprobante bancario legible, devuelve todos los campos en null y confidence 0.
NO inventes datos. Si un campo no se ve claramente, ponlo en null.`;

/**
 * Extrae datos estructurados de un comprobante bancario.
 * @param {string} base64Data  contenido del archivo en base64
 * @param {string} mimetype    'image/jpeg' | 'image/png' | ...
 * @returns {Promise<object|null>}  { amount, currency, reference, bank, date, senderName, confidence } o null
 */
export async function parseComprobante(base64Data, mimetype) {
  try {
    if (!ENABLED) return null;
    if (!base64Data) return null;

    const mediaType = imageMediaType(mimetype);
    if (!mediaType) {
      logger.info('[comprobante-ai] Comprobante no es imagen soportada — parser omitido', { mimetype });
      return null;
    }

    const resp = await complete({
      provider: PROVIDER,
      model: MODEL,
      maxTokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType, data: base64Data },
            { type: 'text', text: PARSE_PROMPT },
          ],
        },
      ],
    });

    const parsed = extractJson(resp.text);
    if (!parsed) {
      logger.warn('[comprobante-ai] Respuesta sin JSON parseable', {
        provider: PROVIDER, model: MODEL, stopReason: resp.stopReason,
      });
      return null;
    }
    logger.info('[comprobante-ai] Comprobante parseado', {
      provider: PROVIDER,
      model: MODEL,
      amount: parsed.amount,
      confidence: parsed.confidence,
    });
    return parsed;
  } catch (err) {
    logger.error('[comprobante-ai] parseComprobante falló', { provider: PROVIDER, error: err.message });
    Sentry.captureException(err, { tags: { service: 'bedrockService', fn: 'parseComprobante' } });
    return null;
  }
}

// Extrae el primer objeto JSON de un texto (Claude a veces envuelve en ```json).
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default { isBedrockEnabled, parseComprobante };
