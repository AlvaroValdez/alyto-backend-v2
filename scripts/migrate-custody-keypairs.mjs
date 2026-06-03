/**
 * migrate-custody-keypairs.mjs — Provisión retroactiva de keypairs custodiales
 *
 * Provisiona un keypair Stellar (modelo custodial PSAV) a cada usuario con
 * KYC aprobado que aún NO tiene stellarAccount.publicKey. A partir de ahora los
 * KYC nuevos lo provisionan solos (stripeWebhook _approveKyc); este script cubre
 * el backlog de usuarios aprobados ANTES de activar la custodia.
 *
 * Ejecutar DENTRO del container (para heredar todo el env: KMS, Stellar, Mongo):
 *
 *   # 1) Dry-run primero — lista a quién se le provisionaría, sin tocar nada:
 *   docker compose exec -e MIGRATE_DRY_RUN=true alyto-backend \
 *     node scripts/migrate-custody-keypairs.mjs
 *
 *   # 2) Ejecución real:
 *   docker compose exec alyto-backend node scripts/migrate-custody-keypairs.mjs
 *
 * ⚠️ MAINNET: cada provisión consume ~1.5 XLM de reserva desde la channel account
 *    (STELLAR_MASTER). Antes de correrlo masivamente, verificá el saldo XLM del
 *    canal. El script va secuencial con un delay (MIGRATE_DELAY_MS, default 2s)
 *    para no saturar Horizon ni la channel account.
 *
 * Idempotente: provisionUserKeypair salta a quien ya tenga keypair.
 */

import 'dotenv/config';
import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

// Cargar Secrets Manager ANTES de importar módulos que leen env al cargarse
// (custodyService lee USER_KEYPAIR_KMS_KEY_ID en su top-level).
await loadSecretsIntoEnv();

const { default: mongoose }          = await import('mongoose');
const { default: User }              = await import('../src/models/User.js');
const { provisionUserKeypair }       = await import('../src/services/custodyService.js');

const DRY_RUN  = process.env.MIGRATE_DRY_RUN === 'true';
const DELAY_MS = Number(process.env.MIGRATE_DELAY_MS ?? 2000);
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

await mongoose.connect(process.env.MONGODB_URI);

const users = await User.find({
  kycStatus: 'approved',
  $or: [
    { 'stellarAccount.publicKey': { $exists: false } },
    { 'stellarAccount.publicKey': null },
    { 'stellarAccount.publicKey': '' },
  ],
}).select('_id email legalEntity').lean();

console.log(`[migrate-custody] ${users.length} usuario(s) aprobado(s) sin keypair${DRY_RUN ? '  (DRY RUN — no se provisiona nada)' : ''}`);

if (DRY_RUN) {
  users.forEach((u, i) => console.log(`  [${i + 1}] ${u._id} | ${u.email} | ${u.legalEntity}`));
  await mongoose.disconnect();
  process.exit(0);
}

let ok = 0;
let fail = 0;
const failures = [];

for (const [i, u] of users.entries()) {
  try {
    const { publicKey } = await provisionUserKeypair(u._id);
    ok++;
    console.log(`[${i + 1}/${users.length}] ✅ ${u._id} → ${publicKey}`);
  } catch (e) {
    fail++;
    failures.push({ id: String(u._id), err: e.message });
    console.error(`[${i + 1}/${users.length}] ❌ ${u._id}: ${e.message}`);
  }
  if (i < users.length - 1) await sleep(DELAY_MS);
}

console.log(`\n[migrate-custody] Listo. OK=${ok}  FAIL=${fail}`);
if (failures.length) console.log('Fallos:', JSON.stringify(failures, null, 2));

await mongoose.disconnect();
process.exit(fail > 0 ? 1 : 0);
