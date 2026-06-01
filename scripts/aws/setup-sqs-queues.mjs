// scripts/aws/setup-sqs-queues.mjs
//
// AWS-2B — Crea las colas SQS de buffer de webhooks IPN + una DLQ común.
// Versión Node (NO requiere aws CLI; usa @aws-sdk/client-sqs ya instalado).
//
// Colas: alyto-ipn-vita, alyto-ipn-fintoc, alyto-ipn-owlpay, alyto-ipn-stripe
// DLQ:   alyto-ipn-dlq  (redrive maxReceiveCount=3)
//
// CREDENCIALES: necesita llaves AWS *admin* con permisos SQS (CreateQueue,
//   GetQueueAttributes, SetQueueAttributes). Pasar por env, NO en el código.
//
// USO (con .env.admin gitignored que contenga las llaves admin):
//   node --env-file=.env.admin scripts/aws/setup-sqs-queues.mjs --dry-run
//   node --env-file=.env.admin scripts/aws/setup-sqs-queues.mjs
//
// .env.admin:
//   AWS_ACCESS_KEY_ID=AKIA...        (admin, NO las runtime)
//   AWS_SECRET_ACCESS_KEY=...
//   SQS_REGION=us-east-1             (opcional, default us-east-1)
//   SQS_MAX_RECEIVE=3                (opcional)
//
// Al terminar imprime las líneas SQS_QUEUE_URL_* para Secrets Manager / .env.

import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const REGION = process.env.SQS_REGION || process.env.AWS_REGION || 'us-east-1';
const MAX_RECEIVE = String(process.env.SQS_MAX_RECEIVE || '3');
const DRY_RUN = process.argv.includes('--dry-run');

const DLQ_NAME = 'alyto-ipn-dlq';
// Mapa: nombre de cola → sufijo de la env var que espera sqsBuffer.js
const QUEUES = [
  { name: 'alyto-ipn-vita', env: 'SQS_QUEUE_URL_VITA' },
  { name: 'alyto-ipn-fintoc', env: 'SQS_QUEUE_URL_FINTOC' },
  { name: 'alyto-ipn-owlpay', env: 'SQS_QUEUE_URL_OWLPAY' },
  { name: 'alyto-ipn-stripe', env: 'SQS_QUEUE_URL_STRIPE' },
];

function fail(m) { console.error('❌ ' + m); process.exit(1); }
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  fail('Faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (admin). Usar node --env-file=.env.admin ...');
}

const sqs = new SQSClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

console.log(`\n=== AWS-2B colas SQS (region ${REGION}) ===`);
console.log(`  DLQ: ${DLQ_NAME} | maxReceiveCount=${MAX_RECEIVE}`);
console.log(`  Colas: ${QUEUES.map((q) => q.name).join(', ')}`);
console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN (no crea)' : 'CREAR'}\n`);

async function getUrl(name) {
  try {
    const r = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    return r.QueueUrl;
  } catch { return null; }
}

async function getArn(url) {
  const r = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: url, AttributeNames: ['QueueArn'],
  }));
  return r.Attributes.QueueArn;
}

async function ensureQueue(name, attributes) {
  // Idempotente: si ya existe, devuelve su URL (y aplica attributes si se pasan).
  const existing = await getUrl(name);
  if (existing) {
    console.log(`  = ${name} ya existe`);
    if (attributes && !DRY_RUN) {
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: existing, Attributes: attributes }));
    }
    return existing;
  }
  if (DRY_RUN) { console.log(`  [DRY] crearía ${name}`); return `dry://${name}`; }
  await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  const url = await getUrl(name);
  console.log(`  ✓ ${name} creada`);
  return url;
}

async function main() {
  // 1) DLQ (retención 14 días).
  const dlqUrl = await ensureQueue(DLQ_NAME, { MessageRetentionPeriod: '1209600' });
  let dlqArn = 'dry://arn';
  if (!DRY_RUN) {
    dlqArn = await getArn(dlqUrl);
    console.log(`  DLQ ARN: ${dlqArn}`);
  }

  // 2) Colas principales con redrive → DLQ.
  const redrive = JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_RECEIVE });
  const envLines = [];
  for (const q of QUEUES) {
    const attrs = {
      VisibilityTimeout: '60',
      MessageRetentionPeriod: '345600', // 4 días
      ...(DRY_RUN ? {} : { RedrivePolicy: redrive }),
    };
    const url = await ensureQueue(q.name, attrs);
    envLines.push(`${q.env}=${url}`);
  }

  console.log(`\n=== Configurar en Secrets Manager / .env (Paso siguiente) ===`);
  console.log(`  SQS_ENABLED=true`);
  console.log(`  AWS_REGION=${REGION}`);
  envLines.forEach((l) => console.log('  ' + l));
  console.log(`\n⚠️ El IAM del runtime necesita sobre alyto-ipn-* + DLQ:`);
  console.log(`   sqs:SendMessage, sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes`);
  console.log(`⚠️ Activar SQS_ENABLED=true SOLO tras verificar el consumer (idealmente staging primero).`);
}

main().catch((e) => fail(`${e.name}: ${e.message}`));
