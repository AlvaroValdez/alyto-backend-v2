/**
 * checkEnv.js — Verificador de variables de entorno críticas
 *
 * Imprime un warning claro por cada variable crítica que falte.
 * No lanza excepción — permite que el servidor arranque para que
 * los endpoints no críticos (healthcheck, auth) sigan funcionando,
 * pero advierte sobre las funcionalidades que quedarán degradadas.
 *
 * Uso standalone: node scripts/checkEnv.js
 * Uso desde server.js: import { checkEnv } from '../scripts/checkEnv.js'
 *
 * Agregar "check:env": "node scripts/checkEnv.js" en package.json.
 */

import 'dotenv/config';

// ─── Variables agrupadas por criticidad ──────────────────────────────────────

/**
 * CRÍTICAS — el servidor NO debe arrancar sin ellas en producción.
 * En desarrollo se emite warning y se continúa.
 */
const CRITICAL = [
  { name: 'MONGODB_URI',               desc: 'URI de conexión a MongoDB' },
  { name: 'JWT_SECRET',                desc: 'Secreto para firmar tokens JWT' },
  { name: 'VITA_API_URL',              desc: 'URL base de Vita Wallet API' },
  { name: 'VITA_LOGIN',                desc: 'x-login de autenticación Vita (xLogin)' },
  { name: 'VITA_TRANS_KEY',            desc: 'x-trans-key de autenticación Vita' },
  { name: 'VITA_SECRET',               desc: 'Clave HMAC-SHA256 para firmar requests Vita' },
  { name: 'VITA_BUSINESS_WALLET_UUID', desc: 'UUID de la master wallet AV Finance en Vita' },
];

/**
 * IMPORTANTES — funcionalidades degradadas sin ellas, pero el servidor arranca.
 */
const IMPORTANT = [
  { name: 'STRIPE_SECRET_KEY',      desc: 'Stripe — KYC Identity y cobros LLC' },
  { name: 'STRIPE_WEBHOOK_SECRET',  desc: 'Stripe — verificación de webhooks' },
  { name: 'FINTOC_SECRET_KEY',      desc: 'Fintoc — payin Open Banking Chile (SpA)' },
  { name: 'FINTOC_WEBHOOK_SECRET',  desc: 'Fintoc — verificación de webhooks' },
  { name: 'VITA_NOTIFY_URL',        desc: 'URL pública donde Vita envía los IPN (/api/v1/ipn/vita)' },
  { name: 'SENDGRID_API_KEY',       desc: 'SendGrid — emails de notificación al admin' },
  { name: 'SENDGRID_FROM_EMAIL',    desc: 'SendGrid — dirección de origen de emails' },
  { name: 'ADMIN_EMAIL',            desc: 'Email del admin para notificaciones de payout manual' },
];

/**
 * OPCIONALES — solo necesarias en producción o para features específicas.
 */
const OPTIONAL = [
  { name: 'STELLAR_LLC_SECRET_KEY',  desc: 'Stellar — clave secreta cuenta LLC' },
  { name: 'STELLAR_SPA_SECRET_KEY',  desc: 'Stellar — clave secreta cuenta SpA' },
  { name: 'STELLAR_SRL_SECRET_KEY',  desc: 'Stellar — clave secreta cuenta SRL' },
  { name: 'STELLAR_CHANNEL_SECRET',  desc: 'Stellar — channelAccount para Fee Bump' },
  { name: 'OWLPAY_API_KEY',          desc: 'OwlPay — on-ramp institucional Escenario A' },
  { name: 'FIREBASE_PROJECT_ID',     desc: 'Firebase — notificaciones push (Fase 19)' },
  { name: 'FIREBASE_CLIENT_EMAIL',   desc: 'Firebase — service account' },
  { name: 'FIREBASE_PRIVATE_KEY',    desc: 'Firebase — service account private key' },
];

// ─── Función de verificación ──────────────────────────────────────────────────

/**
 * Verifica las variables de entorno y reporta las faltantes.
 *
 * @param {{ fatal?: boolean }} options
 *   fatal: true → process.exit(1) si hay variables críticas faltantes en producción
 * @returns {{ missing: string[], warnings: string[] }}
 */
export function checkEnv({ fatal = false } = {}) {
  const isProd    = process.env.NODE_ENV === 'production';
  const missing   = [];
  const warnings  = [];
  let   hasErrors = false;

  console.log('[Alyto Env] Verificando variables de entorno...\n');

  // ── Críticas ────────────────────────────────────────────────────────────
  const missingCritical = CRITICAL.filter(v => !process.env[v.name]);
  if (missingCritical.length) {
    hasErrors = true;
    console.error('  ❌  Variables CRÍTICAS faltantes:');
    for (const v of missingCritical) {
      console.error(`      ⚠  ${v.name.padEnd(30)} — ${v.desc}`);
      missing.push(v.name);
    }
    console.log('');
  } else {
    console.log('  ✅  Variables críticas: todas presentes');
  }

  // ── Importantes ─────────────────────────────────────────────────────────
  const missingImportant = IMPORTANT.filter(v => !process.env[v.name]);
  if (missingImportant.length) {
    console.warn('  ⚠   Variables IMPORTANTES faltantes (funcionalidad degradada):');
    for (const v of missingImportant) {
      console.warn(`      ⚠  ${v.name.padEnd(30)} — ${v.desc}`);
      warnings.push(v.name);
    }
    console.log('');
  } else {
    console.log('  ✅  Variables importantes: todas presentes');
  }

  // ── Opcionales ──────────────────────────────────────────────────────────
  const missingOptional = OPTIONAL.filter(v => !process.env[v.name]);
  if (missingOptional.length && !isProd) {
    // Solo mostrar opcionales faltantes en desarrollo para no saturar logs en prod
    console.info(`  ℹ   Variables opcionales faltantes (${missingOptional.length}):`);
    for (const v of missingOptional) {
      console.info(`      -  ${v.name.padEnd(30)} — ${v.desc}`);
    }
    console.log('');
  }

  // ── Resumen ─────────────────────────────────────────────────────────────
  const totalMissing = missing.length + warnings.length;
  if (totalMissing === 0) {
    console.log('  ✅  Verificación completada — todas las variables relevantes están configuradas.\n');
  } else {
    console.log(`  Resumen: ${missing.length} críticas faltantes, ${warnings.length} importantes faltantes.\n`);
  }

  // En producción, abortar si faltan variables críticas
  if (isProd && hasErrors) {
    if (fatal) {
      console.error('[Alyto Env] FATAL: variables críticas faltantes en producción. Abortando.');
      process.exit(1);
    } else {
      console.error('[Alyto Env] ADVERTENCIA GRAVE: variables críticas faltantes en producción.');
    }
  }

  return { missing, warnings };
}

// ─── Ejecución standalone ─────────────────────────────────────────────────────
// Cuando se corre directamente (node scripts/checkEnv.js), ejecutar y salir

const isMain = process.argv[1]?.endsWith('checkEnv.js');
if (isMain) {
  checkEnv({ fatal: false });
}
