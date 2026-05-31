// src/jobs/ipnQueueConsumer.js
//
// AWS-2B — Consumer de los webhooks IPN bufferizados en SQS.
//
// Diseño: NO duplica la lógica de negocio. Reconstruye un req/res falsos a partir
// del mensaje encolado (body + headers + rawBody) y RE-EJECUTA el handler real
// (handleVitaIPN / handleFintocIPN / handleOwlPayIPN) con `fromSqsConsumer=true`,
// que hace que el handler salte el re-encolado y procese síncronamente.
//
// Durabilidad: el mensaje solo se borra de SQS cuando el handler retorna. Si el
// host se reinicia a mitad del procesamiento, el visibility timeout devuelve el
// mensaje y el consumer lo reprocesa (los handlers son idempotentes vía ipnLog
// y guardas de status). Esto cierra el gap de durabilidad de dispatchPayout
// fire-and-forget. La firma se re-verifica dentro del handler (los headers y el
// rawBody originales viajan en el mensaje), así que solo eventos auténticos
// pasaron el gate de encolado.
//
// No-op si SQS_ENABLED!=true. Meta AWS-2A: migrar este consumer a Lambda.

import { startIpnQueueConsumer, isSqsEnabled } from '../utils/sqsBuffer.js';
import {
  handleVitaIPN,
  handleFintocIPN,
  handleOwlPayIPN,
} from '../controllers/ipnController.js';
import { logger } from '../utils/logger.js';

const HANDLERS = {
  vita: handleVitaIPN,
  fintoc: handleFintocIPN,
  owlpay: handleOwlPayIPN,
};

// Stub de res Express: captura statusCode/json sin enviar nada por red.
function makeFakeRes() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this._json = payload;
      return this;
    },
    send(payload) {
      this._body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

export function startIpnConsumerJob() {
  if (!isSqsEnabled()) return;

  startIpnQueueConsumer(async (provider, event) => {
    const handler = HANDLERS[provider];
    if (!handler) {
      logger.warn('[sqs] provider sin handler registrado', { provider });
      return; // terminal: borra el mensaje (no reintentable)
    }

    const fakeReq = {
      body: event?.body,
      headers: event?.headers || {},
      ip: 'sqs-consumer',
      rawBody: event?.rawBody ? Buffer.from(event.rawBody, 'base64') : undefined,
      fromSqsConsumer: true,
    };
    const fakeRes = makeFakeRes();

    await handler(fakeReq, fakeRes);

    // Los handlers IPN responden 200 (procesado) o 4xx (firma/ping inválidos).
    // 4xx en el consumer = dato no procesable → terminal (no reintentar).
    // Solo lanzamos ante 5xx (no debería ocurrir: los handlers atrapan errores).
    if (fakeRes.statusCode >= 500) {
      throw new Error(`handler ${provider} respondió ${fakeRes.statusCode}`);
    }
  });
}

export default { startIpnConsumerJob };
