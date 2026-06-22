// src/services/supportAgentService.js
//
// AWS-4 — Agente IA de soporte para usuarios (Bedrock / Claude).
//
// Segundo caso de uso de Bedrock (tras el parser de comprobantes). Responde
// dudas de los usuarios sobre Alyto (cómo cargar la wallet, estados de
// transacción genéricos, KYC, P2P, etc.) en lenguaje natural.
//
// Modelo: BEDROCK_MODEL_SUPPORT (fallback BEDROCK_MODEL_SMART). Tarea acotada
// (wallet, envíos cross-border, smart saving) → right-sizing a un modelo simple
// (ej. Haiku 3.5) sin afectar el KYB que comparte BEDROCK_MODEL_SMART.
//
// ── Dos modos de operación ──────────────────────────────────────────────────
//   A) Prompt Management (RECOMENDADO): el system prompt vive en la consola de
//      AWS Bedrock → Prompt Management (versionable, editable SIN redeploy). Se
//      referencia por ARN en BEDROCK_SUPPORT_PROMPT_ARN. En este modo el prompt
//      gestionado define las instrucciones del sistema y recibe variables.
//   B) Inline (FALLBACK): si no hay ARN configurado, usa el system prompt local
//      SYSTEM_PROMPT. Permite probar el agente antes de crear el prompt en AWS.
//
// Gating: TODO apagado salvo BEDROCK_SUPPORT_ENABLED=true → askSupport() devuelve
// null (no-op) y el controller responde con un fallback a soporte humano.
//
// A diferencia del parser, este servicio NO es fire-and-forget: el usuario espera
// la respuesta. Pero igual NUNCA lanza — ante cualquier error devuelve null y el
// controller degrada a un mensaje de soporte humano.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

const ENABLED        = process.env.BEDROCK_SUPPORT_ENABLED === 'true';
const REGION         = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
// Modelo del agente de soporte. Tarea acotada (wallet, envíos cross-border, smart
// saving) → right-sizing a un modelo simple (ej. Haiku 3.5) sin afectar el KYB, que
// comparte BEDROCK_MODEL_SMART y puede querer un modelo más fuerte. Var dedicada con
// fallback a BEDROCK_MODEL_SMART y luego al default.
const MODEL_SUPPORT  = process.env.BEDROCK_MODEL_SUPPORT
  || process.env.BEDROCK_MODEL_SMART
  || 'anthropic.claude-sonnet-4-6-20251001-v1:0';
// ARN del prompt en Bedrock Prompt Management. Si está → modo A (gestionado).
const PROMPT_ARN     = process.env.BEDROCK_SUPPORT_PROMPT_ARN || '';
// Guardrail opcional de Bedrock (filtros de contenido / PII).
const GUARDRAIL_ID   = process.env.BEDROCK_SUPPORT_GUARDRAIL_ID || '';
const GUARDRAIL_VER  = process.env.BEDROCK_SUPPORT_GUARDRAIL_VERSION || 'DRAFT';
const MAX_TOKENS     = Number(process.env.BEDROCK_SUPPORT_MAX_TOKENS || 600);
const TEMPERATURE    = Number(process.env.BEDROCK_SUPPORT_TEMPERATURE || 0.3);

let _client = null;
let _converseCmd = null;

export function isSupportAgentEnabled() {
  return ENABLED;
}

async function getClient() {
  if (!ENABLED) return null;
  if (_client) return _client;
  const mod = await import('@aws-sdk/client-bedrock-runtime');
  const { BedrockRuntimeClient, ConverseCommand } = mod;
  _converseCmd = ConverseCommand;
  // Sin credentials explícitas → cadena por defecto (IAM Role en prod, env en dev).
  _client = new BedrockRuntimeClient({ region: REGION });
  return _client;
}

// System prompt INLINE (modo B / fallback). En modo A (Prompt Management) las
// instrucciones equivalentes se escriben en la consola de Bedrock; mantener
// ambas versiones alineadas. Reglas de compliance NO negociables aquí.
const SYSTEM_PROMPT = `Eres "Aly", el asistente virtual de soporte de Alyto, una billetera digital y plataforma de pagos transfronterizos sobre la red Stellar, operada por AV Finance (LLC EE.UU. / SpA Chile / SRL Bolivia).

Tu rol:
- Ayudar a los usuarios con dudas sobre la app: cómo cargar saldo (wallet BOB), enviar dinero entre usuarios (USDC P2P por alias @usuario), transferencias internacionales, KYC/verificación de identidad, estados generales de transacciones, comisiones y tasas.
- Responder en el MISMO idioma del usuario (por defecto español rioplatense/boliviano neutro). Sé breve, claro y amable.

Reglas estrictas:
1. NUNCA uses las palabras "remesa", "remesas" ni "remittance". Usa "transferencia internacional", "pago transfronterizo", "pay-in/pay-out" o "envío".
2. NUNCA reveles claves privadas, secretos, tokens, ni datos de otros usuarios. Solo conoces el contexto del usuario actual que se te entrega.
3. NO inventes el estado de una transacción concreta ni montos: si el usuario pregunta por una transacción específica, indícale revisar su historial en la app o escalar a soporte humano.
4. NO des asesoría legal, tributaria ni financiera personalizada. Para temas regulatorios (ASFI, IUE/IVA, compliance), reclamos formales (PRILI), bloqueos de cuenta, reembolsos o problemas de KYC, deriva SIEMPRE a soporte humano.
5. Si no estás seguro o la consulta excede tu alcance, dilo con honestidad y deriva a soporte humano: correo {{SUPPORT_EMAIL}} / WhatsApp {{SUPPORT_WHATSAPP}}.
6. No prometas plazos, tasas ni resultados específicos. Las tasas y comisiones son configurables y se muestran en la app al cotizar.

Tono: cercano, profesional, sin tecnicismos innecesarios. Respuestas de 1 a 4 frases salvo que el usuario pida detalle.`;

/**
 * Construye el bloque de contexto del usuario (datos NO sensibles) que se
 * inyecta al modelo. Nunca incluir secretos, documentos ni datos de terceros.
 */
function buildContextText(ctx = {}) {
  const lines = [];
  if (ctx.firstName)       lines.push(`Nombre: ${ctx.firstName}`);
  if (ctx.accountType)     lines.push(`Tipo de cuenta: ${ctx.accountType}`);
  if (ctx.legalEntity)     lines.push(`Entidad/corredor: ${ctx.legalEntity}`);
  if (ctx.residenceCountry) lines.push(`País de residencia: ${ctx.residenceCountry}`);
  if (ctx.kycStatus)       lines.push(`Estado KYC: ${ctx.kycStatus}`);
  if (ctx.alytoAlias)      lines.push(`Alias Alyto: @${ctx.alytoAlias}`);
  return lines.length ? lines.join('\n') : 'Sin contexto adicional del usuario.';
}

// Aplana el historial a texto plano (modo A, donde el prompt gestionado recibe
// la conversación como variable).
function historyToText(history = []) {
  if (!history.length) return 'Sin mensajes previos.';
  return history
    .map(m => `${m.role === 'assistant' ? 'Aly' : 'Usuario'}: ${m.text}`)
    .join('\n');
}

// Convierte el historial al formato messages de la Converse API (modo B).
function historyToMessages(history = [], userMessage) {
  const msgs = history.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ text: m.text }],
  }));
  msgs.push({ role: 'user', content: [{ text: userMessage }] });
  return msgs;
}

/**
 * Responde un mensaje de soporte del usuario.
 * @param {object} params
 * @param {string} params.userMessage  mensaje actual del usuario
 * @param {Array<{role:string,text:string}>} [params.history]  turnos previos (ya saneados)
 * @param {object} [params.userContext] datos NO sensibles del usuario para contexto
 * @returns {Promise<{reply:string, usage?:object}|null>} respuesta o null si OFF/error
 */
export async function askSupport({ userMessage, history = [], userContext = {} } = {}) {
  try {
    if (!ENABLED) return null;
    if (!userMessage || !userMessage.trim()) return null;

    const client = await getClient();
    if (!client) return null;

    const guardrailConfig = GUARDRAIL_ID
      ? { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VER }
      : undefined;

    let command;
    if (PROMPT_ARN) {
      // ── Modo A: Prompt Management (system prompt gestionado en AWS) ──────────
      command = new _converseCmd({
        modelId: PROMPT_ARN,
        promptVariables: {
          user_context: { text: buildContextText(userContext) },
          conversation: { text: historyToText(history) },
          user_message: { text: userMessage },
        },
        ...(guardrailConfig ? { guardrailConfig } : {}),
      });
    } else {
      // ── Modo B: inline (fallback antes de configurar Prompt Management) ──────
      const systemText = SYSTEM_PROMPT
        .replace('{{SUPPORT_EMAIL}}', process.env.SUPPORT_EMAIL || 'soporte@alyto.app')
        .replace('{{SUPPORT_WHATSAPP}}', process.env.SUPPORT_WHATSAPP || '');
      command = new _converseCmd({
        modelId: MODEL_SUPPORT,
        system: [
          { text: systemText },
          { text: `Contexto del usuario actual:\n${buildContextText(userContext)}` },
        ],
        messages: historyToMessages(history, userMessage),
        inferenceConfig: { maxTokens: MAX_TOKENS, temperature: TEMPERATURE },
        ...(guardrailConfig ? { guardrailConfig } : {}),
      });
    }

    const resp = await client.send(command);
    const reply = resp?.output?.message?.content?.[0]?.text?.trim();
    if (!reply) {
      logger.warn('[bedrock] askSupport sin texto en la respuesta', { stopReason: resp?.stopReason });
      return null;
    }

    logger.info('[bedrock] askSupport respondido', {
      mode: PROMPT_ARN ? 'prompt-mgmt' : 'inline',
      stopReason: resp?.stopReason,
      inputTokens: resp?.usage?.inputTokens,
      outputTokens: resp?.usage?.outputTokens,
    });

    return { reply, usage: resp?.usage };
  } catch (err) {
    logger.error('[bedrock] askSupport falló', { error: err.message });
    Sentry.captureException(err, { tags: { service: 'supportAgentService', fn: 'askSupport' } });
    return null;
  }
}

export default { isSupportAgentEnabled, askSupport };
