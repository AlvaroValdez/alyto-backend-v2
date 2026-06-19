// src/services/kybAnalysisService.js
//
// AWS-4 — Análisis IA de expedientes KYB (Bedrock / Claude).
//
// Tercer caso de uso de Bedrock. Cuando un usuario envía su solicitud Business
// (NIT, escritura de constitución, CI del representante, etc.), Claude analiza
// los documentos + los datos declarados y produce una SUGERENCIA estructurada
// para el admin: score de riesgo, acción recomendada, documentos faltantes,
// banderas. NO autoritativo — el admin decide en reviewKYBApplication.
//
// Modelo: Sonnet (BEDROCK_MODEL_SMART) — visión + razonamiento.
// API: Converse (soporta bloques `image` Y `document` PDF, a diferencia de
// InvokeModel que usa el parser de comprobantes).
//
// ── Prompt Management ───────────────────────────────────────────────────────
// Como el análisis adjunta documentos binarios, NO se puede usar el prompt como
// modelId (ese modo no admite attachments). En su lugar, si BEDROCK_KYB_PROMPT_ID
// está configurado, se descarga el texto de instrucciones del prompt gestionado
// (GetPrompt, cacheado) y se compone la llamada Converse con ese system + los
// documentos. Si el SDK bedrock-agent no está o falla → fallback al prompt inline.
//
// Gating: TODO apagado salvo BEDROCK_KYB_ENABLED=true → analyzeKyb() devuelve null.
// Fire-and-forget: el llamador NUNCA bloquea el flujo. Errores → Sentry + null.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

const ENABLED       = process.env.BEDROCK_KYB_ENABLED === 'true';
const REGION        = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
const MODEL_SMART   = process.env.BEDROCK_MODEL_SMART || 'anthropic.claude-sonnet-4-6-20251001-v1:0';
// Identificador (ARN o id) del prompt en Bedrock Prompt Management. Opcional.
const KYB_PROMPT_ID = process.env.BEDROCK_KYB_PROMPT_ID || '';
const MAX_TOKENS    = Number(process.env.BEDROCK_KYB_MAX_TOKENS || 1024);
const MAX_DOCS      = Number(process.env.BEDROCK_KYB_MAX_DOCS || 8);
const MAX_DOC_BYTES = Number(process.env.BEDROCK_KYB_MAX_DOC_BYTES || 4_000_000); // ~4 MB por doc

let _client = null;
let _converseCmd = null;
let _instrCache = null;

export function isKybAnalysisEnabled() {
  return ENABLED;
}

async function getClient() {
  if (!ENABLED) return null;
  if (_client) return _client;
  const mod = await import('@aws-sdk/client-bedrock-runtime');
  const { BedrockRuntimeClient, ConverseCommand } = mod;
  _converseCmd = ConverseCommand;
  _client = new BedrockRuntimeClient({ region: REGION });
  return _client;
}

// Instrucciones INLINE (fallback). En modo Prompt Management se mantiene el
// equivalente en la consola de AWS — conservar ambas alineadas.
const INLINE_INSTRUCTIONS = `Eres un analista de cumplimiento (KYB / Onboarding empresarial) de Alyto, plataforma de pagos transfronterizos operada por AV Finance (LLC/SpA/SRL). Tu jurisdicción principal es Bolivia (ASFI, ETF/PSAV bajo DS 5384).

Recibes los datos declarados de una empresa y los documentos de su expediente (NIT/RUC, escritura de constitución, CI del representante legal, comprobante de domicilio, estados bancarios). Tu tarea es PRE-EVALUAR el expediente para asistir a un revisor humano. NO tomas la decisión final.

Evalúa:
- Consistencia entre los datos declarados (razón social, NIT/taxId, país, representante) y lo que muestran los documentos.
- Legibilidad y aparente integridad/autenticidad de cada documento.
- Documentos faltantes o vencidos para una alta de empresa.
- Señales de riesgo (incoherencias, jurisdicciones de alto riesgo, actividad sensible, datos incompletos).

Reglas:
- NUNCA uses las palabras "remesa", "remesas" ni "remittance".
- NO afirmes con certeza la autenticidad legal de un documento; expresa nivel de confianza.
- Si un documento es ilegible o no se ve, márcalo, no inventes su contenido.
- Sé conservador: ante duda relevante, recomienda "review" o "more_info", no "approve".

Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional, con esta forma:
{
  "riskScore": number,            // 0 (bajo) a 100 (alto)
  "recommendedAction": "approve"|"review"|"more_info"|"reject",
  "summary": string,              // 2-4 frases para el revisor humano
  "flags": string[],              // banderas/alertas (vacío si ninguna)
  "missingDocuments": string[],   // tipos de documento que faltan (vacío si completo)
  "documentChecks": [             // un objeto por documento evaluado
    { "type": string, "legible": boolean, "matches": boolean, "note": string }
  ],
  "confidence": number            // 0..1 — confianza global del análisis
}`;

async function loadInstructions() {
  if (_instrCache) return _instrCache;
  if (KYB_PROMPT_ID) {
    try {
      const mod = await import('@aws-sdk/client-bedrock-agent');
      const { BedrockAgentClient, GetPromptCommand } = mod;
      const client = new BedrockAgentClient({ region: REGION });
      const resp = await client.send(new GetPromptCommand({ promptIdentifier: KYB_PROMPT_ID }));
      const variant = resp?.variants?.[0];
      const text =
        variant?.templateConfiguration?.text?.text ||
        variant?.templateConfiguration?.chat?.system?.[0]?.text;
      if (text) {
        logger.info('[bedrock] Instrucciones KYB cargadas desde Prompt Management');
        _instrCache = text;
        return text;
      }
      logger.warn('[bedrock] Prompt KYB gestionado sin texto utilizable — usando inline');
    } catch (err) {
      logger.warn('[bedrock] No se pudo cargar prompt KYB gestionado — usando inline', { error: err.message });
    }
  }
  _instrCache = INLINE_INSTRUCTIONS;
  return _instrCache;
}

// Mapea mimetype → formato de bloque Converse (image vs document). Devuelve null
// si no es soportado.
function blockFormat(mimetype) {
  switch (mimetype) {
    case 'image/jpeg':
    case 'image/jpg':  return { kind: 'image', format: 'jpeg' };
    case 'image/png':  return { kind: 'image', format: 'png' };
    case 'image/webp': return { kind: 'image', format: 'webp' };
    case 'image/gif':  return { kind: 'image', format: 'gif' };
    case 'application/pdf': return { kind: 'document', format: 'pdf' };
    default: return null;
  }
}

// El nombre de un bloque document en Converse solo admite [a-zA-Z0-9 ()\[\]-].
function safeDocName(filename, idx) {
  const base = String(filename || `documento-${idx}`).replace(/\.[^.]+$/, '');
  const clean = base.replace(/[^a-zA-Z0-9 \-\(\)\[\]]/g, ' ').trim().slice(0, 64);
  return clean || `documento-${idx}`;
}

// Construye los bloques de contenido a partir de los documentos del expediente.
function buildDocumentBlocks(documents = []) {
  const blocks = [];
  let used = 0;
  for (let i = 0; i < documents.length && used < MAX_DOCS; i++) {
    const d = documents[i];
    if (!d?.data) continue;
    const fmt = blockFormat(d.mimetype);
    if (!fmt) continue;
    const bytes = Buffer.from(d.data, 'base64');
    if (bytes.length > MAX_DOC_BYTES) {
      logger.info('[bedrock] Documento KYB omitido por tamaño', { filename: d.filename, bytes: bytes.length });
      continue;
    }
    // Etiqueta el documento con su tipo declarado para que el modelo lo ubique.
    blocks.push({ text: `Documento ${used + 1} — tipo declarado: ${d.type || 'desconocido'}` });
    if (fmt.kind === 'image') {
      blocks.push({ image: { format: fmt.format, source: { bytes } } });
    } else {
      blocks.push({ document: { format: fmt.format, name: safeDocName(d.filename, used + 1), source: { bytes } } });
    }
    used++;
  }
  return { blocks, used };
}

function businessSummary(business = {}) {
  const rep = business.legalRepresentative || {};
  const repName = rep.name || [rep.firstName, rep.lastName].filter(Boolean).join(' ');
  const lines = [
    `Razón social: ${business.legalName ?? '—'}`,
    `Nombre comercial: ${business.tradeName ?? '—'}`,
    `NIT / Tax ID: ${business.taxId ?? '—'}`,
    `País de constitución: ${business.countryOfIncorporation ?? '—'}`,
    `Tipo societario: ${business.businessType ?? '—'}`,
    `Industria: ${business.industry ?? '—'}`,
    `Domicilio: ${[business.address, business.city, business.country].filter(Boolean).join(', ') || '—'}`,
    `Representante legal: ${repName || '—'}`,
    `Volumen mensual estimado: ${business.estimatedMonthlyVolume ?? '—'}`,
    `Descripción: ${business.businessDescription ?? '—'}`,
  ];
  return lines.join('\n');
}

/**
 * Analiza un expediente KYB y devuelve una sugerencia estructurada.
 * @param {object} params
 * @param {object} params.business    datos declarados de la empresa
 * @param {Array}  params.documents   [{ type, filename, data(base64), mimetype }]
 * @returns {Promise<object|null>}    { riskScore, recommendedAction, ... } o null
 */
export async function analyzeKyb({ business = {}, documents = [] } = {}) {
  try {
    if (!ENABLED) return null;

    const { blocks, used } = buildDocumentBlocks(documents);
    if (!used) {
      logger.info('[bedrock] KYB sin documentos analizables — análisis omitido');
      return null;
    }

    const client = await getClient();
    if (!client) return null;

    const instructions = await loadInstructions();

    const content = [
      { text: `Datos declarados de la empresa:\n${businessSummary(business)}\n\nAnaliza los ${used} documento(s) adjuntos y devuelve el JSON solicitado.` },
      ...blocks,
    ];

    const resp = await client.send(new _converseCmd({
      modelId: MODEL_SMART,
      system: [{ text: instructions }],
      messages: [{ role: 'user', content }],
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0.2 },
    }));

    const text = resp?.output?.message?.content?.[0]?.text ?? '';
    const parsed = extractJson(text);
    if (!parsed) {
      logger.warn('[bedrock] analyzeKyb sin JSON parseable', { stopReason: resp?.stopReason });
      return null;
    }

    logger.info('[bedrock] Expediente KYB analizado', {
      docs: used,
      riskScore: parsed.riskScore,
      recommendedAction: parsed.recommendedAction,
      confidence: parsed.confidence,
    });

    return {
      ...parsed,
      model: PromptModelTag(),
      analyzedAt: new Date(),
    };
  } catch (err) {
    logger.error('[bedrock] analyzeKyb falló', { error: err.message });
    Sentry.captureException(err, { tags: { service: 'kybAnalysisService', fn: 'analyzeKyb' } });
    return null;
  }
}

function PromptModelTag() {
  return KYB_PROMPT_ID ? 'bedrock:prompt-mgmt' : `bedrock:${MODEL_SMART.split('.').pop()}`;
}

// Extrae el primer objeto JSON de un texto (Claude a veces lo envuelve en ```json).
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

export default { isKybAnalysisEnabled, analyzeKyb };
