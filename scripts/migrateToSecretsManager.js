#!/usr/bin/env node
/**
 * migrateToSecretsManager.js — Migra variables críticas a AWS Secrets Manager
 *
 * Lee process.env (ya cargado desde .env) y crea/actualiza un único secret
 * JSON en AWS Secrets Manager con todas las variables críticas de Alyto.
 *
 * USO (ejecutar en VPS con acceso a AWS configurado):
 *   node scripts/migrateToSecretsManager.js
 *   node scripts/migrateToSecretsManager.js --dry-run   (solo muestra qué haría)
 *   node scripts/migrateToSecretsManager.js --update     (fuerza actualización si ya existe)
 *
 * PREREQUISITOS:
 *   1. AWS CLI configurado (aws configure) con permisos secretsmanager:CreateSecret
 *      y secretsmanager:PutSecretValue
 *   2. Variables en process.env (cargar .env antes con: source .env o dotenv)
 *   3. AWS_REGION definido en env (default: us-east-1)
 *   4. AWS_SECRETS_NAME definido en env (default: alyto/production)
 *
 * SEGURIDAD:
 *   - NUNCA commitear este script con valores hardcodeados
 *   - El script no imprime valores, solo nombres y estadísticas
 *   - Después de migrar exitosamente, las vars del .env del VPS deben mantenerse
 *     solo AWS_REGION y AWS_SECRETS_NAME (el resto viene de Secrets Manager)
 */

import 'dotenv/config';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Configuración ────────────────────────────────────────────────────────────

const AWS_REGION      = process.env.AWS_REGION      ?? 'us-east-1';
const SECRETS_NAME    = process.env.AWS_SECRETS_NAME ?? 'alyto/production';
const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE_UPDATE    = process.argv.includes('--update');

// ─── Variables a migrar ───────────────────────────────────────────────────────
// Lista explícita — NUNCA migrar variables de infraestructura que deben
// permanecer en el entorno del servidor (PORT, NODE_ENV, AWS_REGION, etc.)

const SECRETS_TO_MIGRATE = [
  // ── Stellar ──
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'STELLAR_USDC_ISSUER',
  'STELLAR_MASTER_PUBLIC',
  'STELLAR_MASTER_SECRET',
  'STELLAR_SRL_PUBLIC_KEY',
  'STELLAR_SRL_SECRET_KEY',
  'STELLAR_SPA_PUBLIC_KEY',
  'STELLAR_SPA_SECRET_KEY',
  'STELLAR_LLC_PUBLIC_KEY',
  'STELLAR_LLC_SECRET_KEY',
  'STELLAR_USDC_CODE',
  'STELLAR_PRIORITY_FEE_STROOPS',
  // ── Auth & Core ──
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'MONGODB_URI',
  'QR_HMAC_SECRET',
  'QR_TTL_CHARGE',
  'QR_TTL_P2P',
  'QR_TTL_DEPOSIT',
  // ── Vita Wallet ──
  'VITA_API_URL',
  'VITA_LOGIN',
  'VITA_TRANS_KEY',
  'VITA_SECRET',
  'VITA_BUSINESS_WALLET_UUID',
  'VITA_ENVIRONMENT',
  'VITA_NOTIFY_URL',
  'VITA_CACHE_TTL_MS',
  'VITA_REQUEST_TIMEOUT_MS',
  // ── OwlPay Harbor ──
  'OWLPAY_API_KEY',
  'OWLPAY_BASE_URL',
  'OWLPAY_API_URL',
  'OWLPAY_WEBHOOK_SECRET',
  'OWLPAY_CUSTOMER_UUID_SRL',
  'OWLPAY_CUSTOMER_UUID_LLC',
  'OWLPAY_USDC_SEND_ENABLED',
  'OWLPAY_SOURCE_CHAIN',
  // ── Stripe ──
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_IDENTITY_FLOW_ID',
  // ── Fintoc ──
  'FINTOC_SECRET_KEY',
  'FINTOC_WEBHOOK_SECRET',
  'FINTOC_API_URL',
  'FINTOC_RECIPIENT_ACCOUNT_NUMBER',
  'FINTOC_RECIPIENT_ACCOUNT_TYPE',
  'FINTOC_RECIPIENT_HOLDER_ID',
  // ── SendGrid ──
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_ADMIN_EMAIL',
  'SENDGRID_TEMPLATE_WELCOME',
  'SENDGRID_TEMPLATE_INITIATED',
  'SENDGRID_TEMPLATE_COMPLETED',
  'SENDGRID_TEMPLATE_FAILED',
  'SENDGRID_TEMPLATE_MANUAL_PAYIN',
  'SENDGRID_TEMPLATE_ADMIN_MANUAL_PAYIN',
  'SENDGRID_TEMPLATE_DEPOSIT_CONFIRMED',
  'SENDGRID_TEMPLATE_REQUOTE_NOTIFICATION',
  'SENDGRID_TEMPLATE_ADMIN_BOLIVIA',
  'SENDGRID_TEMPLATE_CLP_BOB_INSTRUCTIONS',
  'SENDGRID_TEMPLATE_ADMIN_CLP_BOB',
  'SENDGRID_TEMPLATE_CLP_BOB_COMPLETED',
  'SENDGRID_TEMPLATE_KYB_RECEIVED',
  'SENDGRID_TEMPLATE_KYB_APPROVED',
  'SENDGRID_TEMPLATE_KYB_REJECTED',
  'SENDGRID_TEMPLATE_KYB_MORE_INFO',
  'SENDGRID_TEMPLATE_ADMIN_KYB',
  'SENDGRID_TEMPLATE_RECLAMO_RECIBIDO',
  'SENDGRID_TEMPLATE_RECLAMO_RESUELTO',
  'SENDGRID_TEMPLATE_ADMIN_RECLAMO',
  // ── Firebase FCM ──
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  // ── Bolivia SRL ──
  'SRL_BANK_NAME',
  'SRL_ACCOUNT_NUMBER',
  'SRL_ACCOUNT_HOLDER',
  'SRL_ACCOUNT_TYPE',
  'SPA_ACCOUNT_HOLDER',
  'AV_FINANCE_NIT',
  'AV_FINANCE_ADDRESS',
  'AV_FINANCE_LOGO_PATH',
  'AV_FINANCE_LEGAL_FOOTER',
  'AV_FINANCE_B2B_LEGAL_FOOTER',
  'ALYTO_VERIFY_BASE_URL',
  // ── Storage S3 (credenciales temporales — reemplazar por IAM Role en AWS-1C) ──
  'S3_BUCKET',
  'S3_REGION',
  'S3_ENDPOINT',
  'S3_PDF_BASE_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  // ── Tasas & Config ──
  'BOB_USD_RATE',
  'CLP_USD_RATE',
  'XLM_USD_RATE',
  'USDC_LOW_BALANCE_THRESHOLD',
  'NOTIFICATION_TTL_DAYS',
  // ── URLs app ──
  'FRONTEND_URL',
  'ALLOWED_ORIGINS',
  'COOKIE_DOMAIN',
  'ADMIN_EMAIL',
  'SUPPORT_EMAIL',
  'SUPPORT_WHATSAPP',
  'APP_ADMIN_URL',
  'SENTRY_DSN',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Alyto — Migración a AWS Secrets Manager                ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`  Secret name : ${SECRETS_NAME}`);
  console.log(`  AWS Region  : ${AWS_REGION}`);
  console.log(`  Dry run     : ${DRY_RUN ? 'SÍ (no se escribirá nada)' : 'NO'}`);
  console.log(`  Force update: ${FORCE_UPDATE}\n`);

  // ── Recolectar valores presentes en env ──────────────────────────────────
  const secretPayload = {};
  const present = [];
  const missing  = [];

  for (const key of SECRETS_TO_MIGRATE) {
    const val = process.env[key];
    if (val?.trim()) {
      secretPayload[key] = val;
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  console.log(`  Variables encontradas : ${present.length}/${SECRETS_TO_MIGRATE.length}`);
  if (missing.length > 0) {
    console.warn(`  Variables faltantes   : ${missing.length}`);
    console.warn(`  → ${missing.join(', ')}\n`);
  }

  if (present.length === 0) {
    console.error('❌ No hay variables para migrar. Asegúrate de cargar el .env antes de correr este script.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Se habrían migrado las siguientes variables (sin valores):');
    present.forEach(k => console.log(`  ✓ ${k}`));
    console.log('\n[DRY RUN] Completado — sin cambios en AWS.');
    return;
  }

  // ── Verificar si el secret ya existe ────────────────────────────────────
  const client = new SecretsManagerClient({ region: AWS_REGION });
  let secretExists = false;

  try {
    await client.send(new DescribeSecretCommand({ SecretId: SECRETS_NAME }));
    secretExists = true;
    console.log(`  [AWS] Secret "${SECRETS_NAME}" ya existe.`);
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      secretExists = false;
      console.log(`  [AWS] Secret "${SECRETS_NAME}" no existe — se creará.`);
    } else {
      console.error(`❌ Error verificando secret: ${err.message}`);
      process.exit(1);
    }
  }

  if (secretExists && !FORCE_UPDATE) {
    console.error(`\n⚠️  El secret ya existe. Para actualizar, corre con --update`);
    console.error(`   node scripts/migrateToSecretsManager.js --update`);
    process.exit(1);
  }

  // ── Crear o actualizar el secret ─────────────────────────────────────────
  const secretString = JSON.stringify(secretPayload, null, 0);

  try {
    if (!secretExists) {
      await client.send(new CreateSecretCommand({
        Name:         SECRETS_NAME,
        SecretString: secretString,
        Description:  'Alyto Backend V2.0 — Variables de entorno críticas (migrado desde .env)',
        Tags: [
          { Key: 'project',     Value: 'alyto' },
          { Key: 'environment', Value: process.env.NODE_ENV ?? 'production' },
          { Key: 'managed-by',  Value: 'alyto-backend-v2' },
        ],
      }));
      console.log(`\n✅ Secret creado exitosamente: "${SECRETS_NAME}"`);
    } else {
      await client.send(new PutSecretValueCommand({
        SecretId:     SECRETS_NAME,
        SecretString: secretString,
      }));
      console.log(`\n✅ Secret actualizado exitosamente: "${SECRETS_NAME}"`);
    }
  } catch (err) {
    if (err.name === 'AccessDeniedException') {
      console.error(`\n❌ Sin permisos para escribir en Secrets Manager.`);
      console.error(`   IAM Policy necesaria: secretsmanager:CreateSecret + secretsmanager:PutSecretValue`);
    } else {
      console.error(`\n❌ Error al escribir secret: ${err.message}`);
    }
    process.exit(1);
  }

  // ── Instrucciones post-migración ─────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   ✅ Migración completada                                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`
  Próximos pasos en el VPS:

  1. Agregar al .env del VPS (solo estas 2 líneas nuevas):
     AWS_REGION=${AWS_REGION}
     AWS_SECRETS_NAME=${SECRETS_NAME}

  2. Verificar que el servidor tiene IAM Role con política:
     secretsmanager:GetSecretValue sobre arn:...:secret:${SECRETS_NAME}*

  3. Reiniciar el container:
     cd ~/alyto-v2 && docker compose up -d --force-recreate alyto-backend

  4. Verificar en los logs que aparece:
     [AWS Secrets] ✅ Cargados: ${present.length} secretos.

  NOTA: El .env del VPS puede mantenerse como respaldo. Las vars del .env
  NO sobreescriben Secrets Manager (el script ignora vars ya en env).
  Para producción hardened, eliminar vars del .env excepto AWS_REGION y
  AWS_SECRETS_NAME después de confirmar que Secrets Manager funciona.
`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  process.exit(1);
});
