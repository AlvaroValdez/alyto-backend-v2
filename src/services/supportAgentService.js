// src/services/supportAgentService.js
//
// Agente IA de soporte "Aly" para usuarios de Alyto.
//
// Responde dudas de los usuarios sobre la app (cómo cargar la wallet, estados de
// transacción genéricos, KYC, P2P, etc.) en lenguaje natural. La llamada al
// modelo pasa por el adaptador llmProvider (formato neutro) — el proveedor y el
// modelo se eligen por env var, sin tocar este servicio.
//
// Proveedor por defecto: API directa de Anthropic con Claude Haiku 4.5 (tarea
// acotada + reglas de compliance → right-sizing; ver docs/AWS_ESTADO_GENERAL.md §4
// por el bloqueo de Bedrock que motivó la migración). 'bedrock' queda disponible
// como legado vía SUPPORT_AI_PROVIDER=bedrock.
//
// Gating: TODO apagado salvo SUPPORT_AGENT_ENABLED=true (se acepta el nombre
// legado BEDROCK_SUPPORT_ENABLED=true) → askSupport() devuelve null (no-op) y el
// controller responde con un fallback a soporte humano.
//
// A diferencia del parser de comprobantes, este servicio NO es fire-and-forget:
// el usuario espera la respuesta. Pero igual NUNCA lanza — ante cualquier error
// devuelve null y el controller degrada a un mensaje de soporte humano.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';
import { complete } from './llmProvider.js';

const ENABLED = process.env.SUPPORT_AGENT_ENABLED === 'true'
  || process.env.BEDROCK_SUPPORT_ENABLED === 'true';

const PROVIDER = process.env.SUPPORT_AI_PROVIDER || 'anthropic';

// Modelo por proveedor. Anthropic: alias vigente de Haiku 4.5. Bedrock (legado):
// cadena original — var dedicada → modelo smart compartido → inference profile us.*.
const MODEL = process.env.SUPPORT_AI_MODEL
  || (PROVIDER === 'bedrock'
    ? (process.env.BEDROCK_MODEL_SUPPORT
      || process.env.BEDROCK_MODEL_SMART
      || 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
    : 'claude-haiku-4-5');

const MAX_TOKENS  = Number(process.env.SUPPORT_AI_MAX_TOKENS || process.env.BEDROCK_SUPPORT_MAX_TOKENS || 600);
const TEMPERATURE = Number(process.env.SUPPORT_AI_TEMPERATURE || process.env.BEDROCK_SUPPORT_TEMPERATURE || 0.3);

// Guardrail opcional de Bedrock (solo aplica con SUPPORT_AI_PROVIDER=bedrock).
const GUARDRAIL_ID  = process.env.BEDROCK_SUPPORT_GUARDRAIL_ID || '';
const GUARDRAIL_VER = process.env.BEDROCK_SUPPORT_GUARDRAIL_VERSION || 'DRAFT';

export function isSupportAgentEnabled() {
  return ENABLED;
}

// System prompt del asistente. Reglas de compliance NO negociables aquí.
const SYSTEM_PROMPT = `Eres "Aly", el asistente virtual de soporte de Alyto, una billetera digital y plataforma de pagos transfronterizos sobre la red Stellar, operada por AV Finance (LLC EE.UU. / SpA Chile / SRL Bolivia).

Tu rol:
- Ayudar a los usuarios con dudas sobre la app: cómo cargar saldo (wallet BOB), enviar dinero entre usuarios (USDC P2P por alias @usuario), transferencias internacionales, KYC/verificación de identidad, estados generales de transacciones, comisiones y tasas.
- Responder en el MISMO idioma del usuario (por defecto español rioplatense/boliviano neutro). Sé breve, claro y amable.

Operaciones disponibles (única fuente de verdad — si algo NO está en esta lista, NO existe en Alyto):
- Cargar saldo (wallet BOB, Bolivia): ÚNICAMENTE por transferencia bancaria o pago de QR bancario. La app muestra los datos o el QR al elegir "Cargar saldo".
- Transferencias internacionales: desde la app hacia cuentas bancarias de beneficiarios en los países habilitados; la tasa y comisión exactas se muestran al cotizar.
- Envíos P2P entre usuarios Alyto: BOB o USDC, por alias @usuario, instantáneos.
- Depósito de USDC: por la red Stellar, a la dirección que la app muestra en "Depositar".
- Los métodos disponibles pueden variar según el país del usuario; la app siempre muestra los que aplican.

Reglas estrictas:
1. NUNCA uses las palabras "remesa", "remesas" ni "remittance". Usa "transferencia internacional", "pago transfronterizo", "pay-in/pay-out" o "envío".
2. NUNCA reveles claves privadas, secretos, tokens, ni datos de otros usuarios. Solo conoces el contexto del usuario actual que se te entrega.
3. NO inventes el estado de una transacción concreta ni montos: si el usuario pregunta por una transacción específica, indícale revisar su historial en la app o escalar a soporte humano.
4. NO des asesoría legal, tributaria ni financiera personalizada. Para temas regulatorios (ASFI, IUE/IVA, compliance), reclamos formales (PRILI), bloqueos de cuenta, reembolsos o problemas de KYC, deriva SIEMPRE a soporte humano.
5. Si no estás seguro o la consulta excede tu alcance, dilo con honestidad y deriva a soporte humano: correo {{SUPPORT_EMAIL}} / WhatsApp {{SUPPORT_WHATSAPP}}.
6. No prometas plazos, tasas ni resultados específicos. Las tasas y comisiones son configurables y se muestran en la app al cotizar.
7. Alyto es 100% digital y trazable: NO acepta ni entrega EFECTIVO en NINGÚN caso. No existen puntos de depósito en efectivo, cajeros, agentes ni corresponsales. Si el usuario pregunta por efectivo, acláralo explícitamente y ofrecé la alternativa real (transferencia o QR bancario).
8. NO inventes métodos de pago, canales, productos ni funcionalidades. Si algo no figura en "Operaciones disponibles", respondé que no está disponible y sugerí la alternativa real más cercana.

Tono: cercano, profesional, sin tecnicismos innecesarios. Respuestas de 1 a 4 frases salvo que el usuario pida detalle.`;

/**
 * Construye el bloque de contexto del usuario (datos NO sensibles) que se
 * inyecta al modelo. Nunca incluir secretos, documentos ni datos de terceros.
 */
function buildContextText(ctx = {}) {
  const lines = [];
  if (ctx.firstName)        lines.push(`Nombre: ${ctx.firstName}`);
  if (ctx.accountType)      lines.push(`Tipo de cuenta: ${ctx.accountType}`);
  if (ctx.legalEntity)      lines.push(`Entidad/corredor: ${ctx.legalEntity}`);
  if (ctx.residenceCountry) lines.push(`País de residencia: ${ctx.residenceCountry}`);
  if (ctx.kycStatus)        lines.push(`Estado KYC: ${ctx.kycStatus}`);
  if (ctx.alytoAlias)       lines.push(`Alias Alyto: @${ctx.alytoAlias}`);
  return lines.length ? lines.join('\n') : 'Sin contexto adicional del usuario.';
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

    const system = SYSTEM_PROMPT
      .replace('{{SUPPORT_EMAIL}}', process.env.SUPPORT_EMAIL || 'soporte@alyto.app')
      .replace('{{SUPPORT_WHATSAPP}}', process.env.SUPPORT_WHATSAPP || '')
      + `\n\nContexto del usuario actual:\n${buildContextText(userContext)}`;

    const messages = history
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }))
      .concat([{ role: 'user', text: userMessage }]);

    const providerOptions = (PROVIDER === 'bedrock' && GUARDRAIL_ID)
      ? { guardrailConfig: { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VER } }
      : {};

    const resp = await complete({
      provider: PROVIDER,
      model: MODEL,
      system,
      messages,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      providerOptions,
    });

    if (!resp.text) {
      logger.warn('[support-ai] askSupport sin texto en la respuesta', {
        provider: PROVIDER, model: MODEL, stopReason: resp.stopReason,
      });
      return null;
    }

    logger.info('[support-ai] askSupport respondido', {
      provider: PROVIDER,
      model: MODEL,
      stopReason: resp.stopReason,
      inputTokens: resp.usage?.inputTokens,
      outputTokens: resp.usage?.outputTokens,
    });

    return { reply: resp.text, usage: resp.usage };
  } catch (err) {
    logger.error('[support-ai] askSupport falló', { provider: PROVIDER, error: err.message });
    Sentry.captureException(err, { tags: { service: 'supportAgentService', fn: 'askSupport' } });
    return null;
  }
}

export default { isSupportAgentEnabled, askSupport };
