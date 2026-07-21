// src/services/llmProvider.js
//
// Adaptador de proveedor LLM — punto único donde el backend habla con un modelo
// de IA conversacional. Los servicios (soporte, y a futuro parser/KYB) arman el
// prompt y los mensajes en un formato neutro; este módulo traduce al SDK del
// proveedor activo. Cambiar de proveedor = cambiar env vars, no reescribir
// servicios.
//
// Formato neutro:
//   complete({ provider, model, system, messages, maxTokens, temperature, providerOptions })
//     system   → string (instrucciones completas, ya interpoladas)
//     messages → [{ role: 'user'|'assistant', text: string }]  (alternancia ya saneada)
//   → { text, stopReason, usage: { inputTokens, outputTokens } }
//
// Proveedores:
//   'anthropic' (default) — API directa de Anthropic. Requiere ANTHROPIC_API_KEY
//     (Secrets Manager en prod). Elegido tras el bloqueo de Bedrock: la cuenta
//     AWS no tiene provisionada cuota on-demand (ver docs/AWS_ESTADO_GENERAL.md §4).
//   'bedrock' — legado AWS Bedrock Converse. Se conserva para poder volver si
//     AWS provisiona la cuenta; providerOptions.guardrailConfig pasa directo.
//
// Este módulo LANZA en caso de error — el manejo (degradar a fallback, Sentry)
// es responsabilidad del servicio llamador. SDKs importados de forma perezosa.

let _anthropic = null;
let _bedrock = null;
let _converseCmd = null;

async function completeAnthropic({ model, system, messages, maxTokens, temperature }) {
  if (!_anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _anthropic = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno
  }
  const resp = await _anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: messages.map(m => ({ role: m.role, content: m.text })),
  });
  return {
    text: resp.content?.find(b => b.type === 'text')?.text?.trim() || '',
    stopReason: resp.stop_reason,
    usage: {
      inputTokens: resp.usage?.input_tokens,
      outputTokens: resp.usage?.output_tokens,
    },
  };
}

async function completeBedrock({ model, system, messages, maxTokens, temperature, providerOptions = {} }) {
  if (!_bedrock) {
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    _converseCmd = ConverseCommand;
    // Sin credentials explícitas → cadena por defecto (IAM en prod, env en dev).
    _bedrock = new BedrockRuntimeClient({
      region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1',
    });
  }
  const resp = await _bedrock.send(new _converseCmd({
    modelId: model,
    system: [{ text: system }],
    messages: messages.map(m => ({ role: m.role, content: [{ text: m.text }] })),
    inferenceConfig: { maxTokens, temperature },
    ...(providerOptions.guardrailConfig ? { guardrailConfig: providerOptions.guardrailConfig } : {}),
  }));
  return {
    text: resp?.output?.message?.content?.[0]?.text?.trim() || '',
    stopReason: resp?.stopReason,
    usage: {
      inputTokens: resp?.usage?.inputTokens,
      outputTokens: resp?.usage?.outputTokens,
    },
  };
}

export async function complete({ provider = 'anthropic', ...params }) {
  switch (provider) {
    case 'anthropic':
      return completeAnthropic(params);
    case 'bedrock':
      return completeBedrock(params);
    default:
      throw new Error(`Proveedor LLM desconocido: ${provider}`);
  }
}

export default { complete };
