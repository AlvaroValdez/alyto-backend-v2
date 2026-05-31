// src/jobs/ipnQueueConsumer.js
//
// AWS-2B — Consumer de los webhooks IPN bufferizados en SQS.
// Reutiliza las funciones puras del ipnController (idempotentes).
// No-op si SQS_ENABLED!=true.
//
// Nota: hoy corre in-process en el VPS. La meta AWS-2A es migrar este consumer
// a Lambda (sobrevive reinicios del host); la cola SQS ya desacopla la recepción.

import {
  startIpnQueueConsumer,
  isSqsEnabled,
} from '../utils/sqsBuffer.js';
import {
  processVitaEvent,
  processFintocEvent,
  processOwlpayEvent,
} from '../controllers/ipnController.js';
import { logger } from '../utils/logger.js';

const ROUTES = {
  vita: processVitaEvent,
  fintoc: processFintocEvent,
  owlpay: processOwlpayEvent,
};

export function startIpnConsumerJob() {
  if (!isSqsEnabled()) return;
  startIpnQueueConsumer(async (provider, event) => {
    const fn = ROUTES[provider];
    if (!fn) {
      logger.warn('[sqs] provider sin handler registrado', { provider });
      return;
    }
    await fn(event);
  });
}

export default { startIpnConsumerJob };
