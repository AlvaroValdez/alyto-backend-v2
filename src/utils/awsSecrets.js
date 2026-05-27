/**
 * awsSecrets.js — Carga de secretos desde AWS Secrets Manager
 *
 * Estrategia de carga:
 *   1. Si AWS_SECRETS_NAME está definido → carga desde Secrets Manager (producción)
 *   2. Si no → usa process.env tal como está (desarrollo / staging con .env)
 *
 * Los secretos se inyectan en process.env para que todo el código existente
 * (requireEnvSecret, process.env.X) funcione sin cambios — cero breaking changes.
 *
 * Llamar loadSecretsIntoEnv() UNA SOLA VEZ al arrancar el servidor,
 * ANTES de cualquier otro import que lea process.env.
 *
 * NUNCA loguear valores de secretos — solo nombres y metadatos no sensibles.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Configuración ────────────────────────────────────────────────────────────

const AWS_REGION       = process.env.AWS_REGION       ?? 'us-east-1';
const AWS_SECRETS_NAME = process.env.AWS_SECRETS_NAME;   // undefined en dev → skip

// Singleton del cliente — se inicializa solo si AWS está configurado
let _client = null;

function getClient() {
  if (!_client) {
    _client = new SecretsManagerClient({ region: AWS_REGION });
  }
  return _client;
}

// ─── Carga principal ──────────────────────────────────────────────────────────

/**
 * Carga todos los secretos desde AWS Secrets Manager e inyecta en process.env.
 *
 * - En producción: AWS_SECRETS_NAME definido → carga desde Secrets Manager.
 * - En desarrollo: AWS_SECRETS_NAME no definido → no hace nada (usa .env).
 *
 * @returns {Promise<{ loaded: boolean, count: number, source: string }>}
 */
export async function loadSecretsIntoEnv() {
  if (!AWS_SECRETS_NAME) {
    console.info('[AWS Secrets] AWS_SECRETS_NAME no definido — usando variables de entorno locales (.env)');
    return { loaded: false, count: 0, source: 'env' };
  }

  console.info(`[AWS Secrets] Cargando secretos desde: ${AWS_SECRETS_NAME} (region: ${AWS_REGION})`);

  try {
    const command = new GetSecretValueCommand({ SecretId: AWS_SECRETS_NAME });
    const response = await getClient().send(command);

    if (!response.SecretString) {
      throw new Error('[AWS Secrets] SecretString vacío — el secret debe ser tipo JSON string, no binario.');
    }

    let secrets;
    try {
      secrets = JSON.parse(response.SecretString);
    } catch {
      throw new Error('[AWS Secrets] SecretString no es JSON válido. Verificar formato en Secrets Manager.');
    }

    if (typeof secrets !== 'object' || Array.isArray(secrets)) {
      throw new Error('[AWS Secrets] SecretString debe ser un objeto JSON { KEY: "value", ... }');
    }

    // Inyectar en process.env — NO sobreescribir vars que ya existen
    // (permite override local urgente sin tocar Secrets Manager)
    let injected = 0;
    let skipped  = 0;

    for (const [key, value] of Object.entries(secrets)) {
      if (typeof value !== 'string') continue; // ignorar no-strings
      if (process.env[key] !== undefined) {
        skipped++;
        continue; // ya existe en env → no sobreescribir
      }
      process.env[key] = value;
      injected++;
    }

    console.info(`[AWS Secrets] ✅ Cargados: ${injected} secretos. Omitidos (ya en env): ${skipped}.`);
    return { loaded: true, count: injected, source: 'secrets-manager' };

  } catch (err) {
    // Diferenciar entre errores de autenticación/permisos y otros errores
    if (err.name === 'ResourceNotFoundException') {
      console.error(`[AWS Secrets] ❌ Secret no encontrado: "${AWS_SECRETS_NAME}". Verificar nombre y región.`);
    } else if (err.name === 'AccessDeniedException') {
      console.error(`[AWS Secrets] ❌ Sin permisos para leer "${AWS_SECRETS_NAME}". Verificar IAM Role/Policy.`);
    } else if (err.name === 'InvalidRequestException') {
      console.error(`[AWS Secrets] ❌ Request inválida: ${err.message}`);
    } else {
      console.error(`[AWS Secrets] ❌ Error inesperado: ${err.message}`);
    }

    // En producción: fallo en carga de secretos es fatal — el servidor no puede arrancar sin credenciales
    if (process.env.NODE_ENV === 'production') {
      console.error('[AWS Secrets] FATAL: No se pudieron cargar los secretos en producción. Abortando.');
      process.exit(1);
    }

    // En dev/staging: loguear warning y continuar con .env
    console.warn('[AWS Secrets] ⚠️  Continuando con variables de entorno locales (NODE_ENV no es production).');
    return { loaded: false, count: 0, source: 'env-fallback' };
  }
}

// ─── Utilidades de diagnóstico (solo para admin/health) ──────────────────────

/**
 * Verifica si un secreto está disponible en process.env sin revelar su valor.
 * Útil para health checks y diagnósticos.
 *
 * @param {string[]} keys - Lista de nombres de variables a verificar
 * @returns {{ present: string[], missing: string[] }}
 */
export function auditSecrets(keys) {
  const present = [];
  const missing = [];

  for (const key of keys) {
    if (process.env[key]?.trim()) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  return { present, missing };
}

/**
 * Lista de secretos críticos de Alyto — usada en el health check de admin.
 * NUNCA exportar los valores, solo los nombres.
 */
export const CRITICAL_SECRETS = [
  // Stellar
  'STELLAR_MASTER_SECRET',
  'STELLAR_SRL_SECRET_KEY',
  'STELLAR_SPA_SECRET_KEY',
  'STELLAR_LLC_SECRET_KEY',
  // Proveedores de pago
  'VITA_SECRET',
  'VITA_LOGIN',
  'OWLPAY_API_KEY',
  'OWLPAY_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'FINTOC_SECRET_KEY',
  'FINTOC_WEBHOOK_SECRET',
  // Infraestructura
  'JWT_SECRET',
  'MONGODB_URI',
  'SENDGRID_API_KEY',
  'QR_HMAC_SECRET',
];
