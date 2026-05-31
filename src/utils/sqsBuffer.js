// src/utils/sqsBuffer.js
//
// AWS-2B — Buffer durable de webhooks (IPN) sobre Amazon SQS.
//
// Patrón (CLAUDE.md AWS-2B):
//   Provider IPN → Express (200 inmediato) → SQS queue → consumer → procesamiento
//
// Gating: TODO está apagado salvo SQS_ENABLED=true + queue URL del provider.
//   - Apagado (default): no-op. El controlador IPN procesa síncronamente como hoy.
//   - Encendido: el controlador encola y responde 200; el consumer drena la cola.
//
// El SDK se importa de forma perezosa para no requerir el paquete cuando SQS
// está apagado, y usa la cadena de credenciales por defecto (IAM Role / env).

import { logger } from './logger.js';

const SQS_ENABLED = process.env.SQS_ENABLED === 'true';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Mapa provider → Queue URL (env). Provider sin URL = no se encola (fallback síncrono).
const QUEUE_URLS = {
  vita: process.env.SQS_QUEUE_URL_VITA,
  fintoc: process.env.SQS_QUEUE_URL_FINTOC,
  owlpay: process.env.SQS_QUEUE_URL_OWLPAY,
  stripe: process.env.SQS_QUEUE_URL_STRIPE,
};

let _client = null;
let _cmd = null; // { SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand }

async function getClient() {
  if (!SQS_ENABLED) return null;
  if (_client) return _client;
  const mod = await import('@aws-sdk/client-sqs');
  const {
    SQSClient,
    SendMessageCommand,
    ReceiveMessageCommand,
    DeleteMessageCommand,
  } = mod;
  _cmd = { SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand };
  // Sin credentials explícitas → cadena por defecto (IAM Role en prod, env en dev).
  _client = new SQSClient({ region: AWS_REGION });
  return _client;
}

export function isSqsEnabled() {
  return SQS_ENABLED;
}

/**
 * Encola un evento IPN. Devuelve true si se encoló, false si no (apagado, sin URL
 * o error). El controlador usa el booleano para decidir fallback síncrono.
 * NUNCA lanza.
 */
export async function enqueueIpnEvent(provider, event) {
  try {
    if (!SQS_ENABLED) return false;
    const queueUrl = QUEUE_URLS[provider];
    if (!queueUrl) return false;
    const client = await getClient();
    if (!client) return false;
    await client.send(
      new _cmd.SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          provider,
          event,
          enqueuedAt: new Date().toISOString(),
        }),
      })
    );
    return true;
  } catch (err) {
    logger.error('[sqs] enqueue falló', { provider, error: err.message });
    return false;
  }
}

/**
 * Inicia el consumer (long-polling) para cada provider con queue configurada.
 * handler(provider, event) debe ser idempotente. No borra el mensaje si el
 * handler lanza → visibility timeout → reintento → DLQ tras maxReceiveCount.
 */
export function startIpnQueueConsumer(handler) {
  if (!SQS_ENABLED) {
    logger.info('[sqs] Consumer deshabilitado (SQS_ENABLED!=true)');
    return;
  }
  const providers = Object.keys(QUEUE_URLS).filter((p) => QUEUE_URLS[p]);
  if (!providers.length) {
    logger.warn('[sqs] SQS_ENABLED=true pero sin queue URLs configuradas');
    return;
  }
  logger.info('[sqs] Consumer iniciado', { providers });
  for (const provider of providers) {
    pollLoop(provider, handler).catch((err) =>
      logger.error('[sqs] pollLoop terminó inesperadamente', {
        provider,
        error: err.message,
      })
    );
  }
}

async function pollLoop(provider, handler) {
  const queueUrl = QUEUE_URLS[provider];
  const client = await getClient();
  if (!client) return;
  for (;;) {
    try {
      const out = await client.send(
        new _cmd.ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // long polling
          VisibilityTimeout: 60,
        })
      );
      const messages = out.Messages || [];
      for (const msg of messages) {
        try {
          const body = JSON.parse(msg.Body);
          await handler(body.provider, body.event);
          await client.send(
            new _cmd.DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            })
          );
        } catch (err) {
          // No borrar → reintento vía visibility timeout → DLQ.
          logger.error('[sqs] Error procesando mensaje (reintentará)', {
            provider,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.error('[sqs] ReceiveMessage falló', {
        provider,
        error: err.message,
      });
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default { isSqsEnabled, enqueueIpnEvent, startIpnQueueConsumer };
