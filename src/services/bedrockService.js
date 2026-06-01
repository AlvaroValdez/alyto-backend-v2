// src/services/bedrockService.js
//
// AWS-4 — Integración con AWS Bedrock (Claude) para features de IA.
//
// Primer caso de uso: parser de comprobantes bancarios BOB. El admin sube/recibe
// la imagen del comprobante y Claude extrae monto, referencia y banco para
// pre-rellenar la confirmación manual (NO autoritativo — el admin decide).
//
// Gating: TODO apagado salvo BEDROCK_ENABLED=true. Si está OFF, parseComprobante()
// devuelve null inmediatamente (no-op). El SDK se importa de forma perezosa y el
// cliente usa la cadena de credenciales por defecto (IAM Role en prod / env).
//
// Fire-and-forget: el llamador NUNCA debe bloquear el flujo principal esperando
// esto (regla 13/17 de CLAUDE.md). Errores → Sentry + null, nunca lanzan.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

const BEDROCK_ENABLED = process.env.BEDROCK_ENABLED === 'true';
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
// Haiku para parser (rápido/barato); ver CLAUDE.md AWS-4.
const MODEL_FAST = process.env.BEDROCK_MODEL_FAST || 'anthropic.claude-haiku-4-5-20251001-v1:0';

let _client = null;
let _invokeCmd = null;

export function isBedrockEnabled() {
  return BEDROCK_ENABLED;
}

async function getClient() {
  if (!BEDROCK_ENABLED) return null;
  if (_client) return _client;
  const mod = await import('@aws-sdk/client-bedrock-runtime');
  const { BedrockRuntimeClient, InvokeModelCommand } = mod;
  _invokeCmd = InvokeModelCommand;
  // Sin credentials explícitas → cadena por defecto (IAM Role en prod, env en dev).
  _client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
  return _client;
}

// Mapea mimetype a los media types que acepta la API de mensajes de Claude.
function imageMediaType(mimetype) {
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') return 'image/jpeg';
  if (mimetype === 'image/png') return 'image/png';
  if (mimetype === 'image/webp') return 'image/webp';
  if (mimetype === 'image/gif') return 'image/gif';
  return null; // PDFs y otros no soportados por la visión de Claude vía Bedrock InvokeModel
}

const PARSE_PROMPT = `Eres un asistente que extrae datos de comprobantes bancarios bolivianos (transferencias, depósitos QR, Banco Bisa / BNB / otros).
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
    if (!BEDROCK_ENABLED) return null;
    if (!base64Data) return null;

    const mediaType = imageMediaType(mimetype);
    if (!mediaType) {
      logger.info('[bedrock] Comprobante no es imagen soportada — parser omitido', { mimetype });
      return null;
    }

    const client = await getClient();
    if (!client) return null;

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: PARSE_PROMPT },
          ],
        },
      ],
    };

    const resp = await client.send(
      new _invokeCmd({
        modelId: MODEL_FAST,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      })
    );

    const decoded = JSON.parse(new TextDecoder().decode(resp.body));
    const text = decoded?.content?.[0]?.text ?? '';
    const parsed = extractJson(text);
    if (!parsed) {
      logger.warn('[bedrock] Respuesta sin JSON parseable');
      return null;
    }
    logger.info('[bedrock] Comprobante parseado', {
      amount: parsed.amount, confidence: parsed.confidence,
    });
    return parsed;
  } catch (err) {
    logger.error('[bedrock] parseComprobante falló', { error: err.message });
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
