/**
 * update-av-finance-secret.mjs — Actualiza SOLO las vars AV_FINANCE_* en el
 * secret de AWS Secrets Manager, preservando TODAS las demás claves.
 *
 * A diferencia de migrateToSecretsManager.js (que sobrescribe el secret entero
 * con el .env local — riesgoso), este hace MERGE quirúrgico: lee el secret
 * actual, cambia solo las 5 claves AV_FINANCE_* y vuelve a escribirlo.
 *
 * Valores que aplica (datos públicos del emisor, impresos en cada comprobante):
 *   AV_FINANCE_NIT              ← .env (706138025)
 *   AV_FINANCE_ADDRESS          ← .env
 *
 * NO toca los footers ni el logo: el generador de PDF usa cleanEnvValue(), que
 * ignora placeholders (<COMPLETAR>) y usa el texto legal por defecto del código
 * (ya redactado y correcto). Así se preserva cualquier texto válido que el
 * secret pudiera tener, sin riesgo de sobrescribirlo.
 *
 * PREREQUISITOS (mismas credenciales que migrateToSecretsManager.js):
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION / AWS_SECRETS_NAME
 *
 * USO:
 *   node --env-file=.env scripts/update-av-finance-secret.mjs --dry-run
 *   node --env-file=.env scripts/update-av-finance-secret.mjs
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const AWS_REGION   = process.env.AWS_REGION       ?? 'us-east-1';
const SECRETS_NAME = process.env.AWS_SECRETS_NAME ?? 'alyto/production';
const DRY_RUN      = process.argv.includes('--dry-run');

// Solo datos públicos del emisor. Footers/logo NO se tocan (los maneja el código).
const UPDATES = {
  AV_FINANCE_NIT:     process.env.AV_FINANCE_NIT     ?? '706138025',
  AV_FINANCE_ADDRESS: process.env.AV_FINANCE_ADDRESS ?? 'Av. Ramiro Castillo N° 13, La Paz, Bolivia',
};

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║   Alyto — Update AV_FINANCE_* en Secrets Manager (merge) ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');
console.log(`  Secret : ${SECRETS_NAME}`);
console.log(`  Region : ${AWS_REGION}`);
console.log(`  Dry run: ${DRY_RUN ? 'SÍ (no escribe)' : 'NO'}\n`);

const client = new SecretsManagerClient({ region: AWS_REGION });

// ── 1. Leer secret actual ─────────────────────────────────────────────────────
let current = {};
try {
  const res = await client.send(new GetSecretValueCommand({ SecretId: SECRETS_NAME }));
  current = JSON.parse(res.SecretString ?? '{}');
  console.log(`  [AWS] Secret leído — ${Object.keys(current).length} claves existentes.\n`);
} catch (err) {
  console.error(`❌ No se pudo leer el secret: ${err.name} — ${err.message}`);
  if (err.name === 'AccessDeniedException') {
    console.error('   Falta permiso secretsmanager:GetSecretValue');
  }
  process.exit(1);
}

// ── 2. Diff (datos públicos — seguro mostrarlos) ──────────────────────────────
console.log('  Cambios a aplicar:');
for (const [k, v] of Object.entries(UPDATES)) {
  const before = current[k];
  const shownBefore = before === undefined ? '(ausente)' : (before === '' ? '(vacío)' : before);
  const shownAfter  = v === '' ? "(vacío → default de código)" : v;
  const tag = before === v ? '=' : '→';
  console.log(`   ${tag} ${k}`);
  console.log(`        antes : ${shownBefore}`);
  console.log(`        ahora : ${shownAfter}`);
}

// ── 3. Merge + escribir ───────────────────────────────────────────────────────
const merged = { ...current, ...UPDATES };
const unchanged = Object.keys(current).length;
console.log(`\n  Claves totales tras merge: ${Object.keys(merged).length} (preservadas: ${unchanged - Object.keys(UPDATES).filter(k => k in current).length} + tocadas: ${Object.keys(UPDATES).length})`);

if (DRY_RUN) {
  console.log('\n[DRY RUN] No se escribió nada en AWS.');
  process.exit(0);
}

try {
  await client.send(new PutSecretValueCommand({
    SecretId:     SECRETS_NAME,
    SecretString: JSON.stringify(merged, null, 0),
  }));
  console.log(`\n✅ Secret "${SECRETS_NAME}" actualizado (merge quirúrgico AV_FINANCE_*).`);
  console.log('   Reiniciá el backend para que tome los nuevos valores:');
  console.log('   cd ~/alyto-v2 && docker compose up -d --force-recreate alyto-backend\n');
} catch (err) {
  console.error(`\n❌ Error al escribir: ${err.name} — ${err.message}`);
  if (err.name === 'AccessDeniedException') {
    console.error('   Falta permiso secretsmanager:PutSecretValue');
  }
  process.exit(1);
}
