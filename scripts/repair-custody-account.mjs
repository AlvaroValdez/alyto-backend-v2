/**
 * repair-custody-account.mjs — Completa cuentas custodiales provisionadas a medias
 *
 * Síntoma que arregla: `monitorUSDCDeposits` loggea cada 30s
 *   "[USDC Monitor] Error vigilando dirección custodial: {addr, error: 'Not Found'}"
 *
 * Causa: `provisionUserKeypair` persiste la publicKey en MongoDB (paso 3) ANTES de
 * fondear la cuenta (paso 5) y de crear la trustline (paso 6), y ninguno de los dos
 * relanza si falla. Si el `createAccount` muere, el usuario queda con una dirección
 * que Horizon responde 404 y nada lo reintenta: el webhook de KYC dispara la provisión
 * fire-and-forget y sólo deja un console.error.
 *
 * Ejecutar DENTRO del container, para heredar el env real (KMS, Stellar, Mongo):
 *
 *   # 1) Diagnóstico — no toca nada, sólo clasifica:
 *   docker compose exec -e REPAIR_DRY_RUN=true alyto-backend \
 *     node scripts/repair-custody-account.mjs
 *
 *   # 2) Reparar una cuenta puntual (email, ObjectId o public key G...):
 *   docker compose exec -e REPAIR_TARGET=GBYUCYGC… alyto-backend \
 *     node scripts/repair-custody-account.mjs
 *
 *   # 3) Reparar todo el backlog detectado:
 *   docker compose exec alyto-backend node scripts/repair-custody-account.mjs
 *
 * ⚠️ MAINNET: cada cuenta creada consume ~1.5 XLM de la channel account
 *    (STELLAR_MASTER). El script informa el saldo del canal antes de empezar y aborta
 *    si no alcanza para el lote — un canal sin XLM es la causa raíz más probable del
 *    fallo original, y reintentar sin fondearlo sólo repite el error.
 *
 * Idempotente: `ensureAccountOnChain` no toca lo que ya está bien.
 */

import 'dotenv/config';
import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

// Secrets ANTES de importar módulos que leen env al cargarse (regla 21 del CLAUDE.md:
// custodyService lee USER_KEYPAIR_KMS_KEY_ID en su top-level).
await loadSecretsIntoEnv();

const { default: mongoose }      = await import('mongoose');
const { default: User }          = await import('../src/models/User.js');
const { ensureAccountOnChain }   = await import('../src/services/custodyService.js');
const { getXLMBalance }          = await import('../src/services/stellarService.js');
const { horizonServer, ASSETS }  = await import('../src/config/stellar.js');
const { isAccountNotFound }      = await import('../src/utils/stellarErrors.js');

const DRY_RUN  = process.env.REPAIR_DRY_RUN === 'true';
const TARGET   = process.env.REPAIR_TARGET?.trim() || null;
const DELAY_MS = Number(process.env.REPAIR_DELAY_MS ?? 2000);
const XLM_PER_ACCOUNT = 1.5;   // startingBalance de fundUserAccount

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await mongoose.connect(process.env.MONGODB_URI);

// ─── Resolver a quién mirar ──────────────────────────────────────────────────

function targetQuery(raw) {
  if (raw.startsWith('G') && raw.length === 56) return { 'stellarAccount.publicKey': raw };
  if (/^[a-f0-9]{24}$/i.test(raw))              return { _id: raw };
  return { email: raw.toLowerCase() };
}

const query = TARGET
  ? targetQuery(TARGET)
  : { 'stellarAccount.publicKey': { $exists: true, $nin: [null, ''] } };

const users = await User.find(query)
  .select('_id email legalEntity stellarAccount.publicKey')
  .lean();

if (!users.length) {
  console.error(`[repair-custody] Sin usuarios para ${TARGET ? `el objetivo "${TARGET}"` : 'revisar'}`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log(`[repair-custody] Revisando ${users.length} cuenta(s) contra Horizon…\n`);

// ─── Clasificar: qué está roto y qué no ──────────────────────────────────────

const usdcCode   = ASSETS.USDC.getCode();
const usdcIssuer = ASSETS.USDC.getIssuer();

const missing    = [];   // cuenta inexistente on-chain (404) → hay que fondear
const noTrust    = [];   // cuenta existe, falta trustline USDC
const healthy    = [];
const unreadable = [];   // Horizon no respondió — NO asumir que está roto

for (const u of users) {
  const publicKey = u.stellarAccount.publicKey;
  try {
    const acct = await horizonServer.loadAccount(publicKey);
    const hasTrustline = acct.balances.some(
      (b) => b.asset_code === usdcCode && b.asset_issuer === usdcIssuer,
    );
    (hasTrustline ? healthy : noTrust).push({ ...u, publicKey });
  } catch (err) {
    if (isAccountNotFound(err)) missing.push({ ...u, publicKey });
    else unreadable.push({ ...u, publicKey, err: err.message });
  }
}

const describe = (label, list) => {
  if (!list.length) return;
  console.log(`${label} (${list.length}):`);
  list.forEach(u => console.log(`   ${u.email}  ${u.publicKey}${u.err ? `  — ${u.err}` : ''}`));
  console.log('');
};

describe('🔴 Sin cuenta on-chain  — Horizon 404, hay que fondear', missing);
describe('🟡 Sin trustline USDC   — existe pero no puede recibir USDC', noTrust);
describe('⚠️  Ilegibles            — error de red, estado desconocido', unreadable);
console.log(`🟢 Sanas: ${healthy.length}\n`);

const toRepair = [...missing, ...noTrust];

if (!toRepair.length) {
  console.log('[repair-custody] Nada que reparar.');
  await mongoose.disconnect();
  process.exit(unreadable.length ? 1 : 0);
}

// ─── Guard de XLM del canal ──────────────────────────────────────────────────
// Sólo las cuentas inexistentes consumen reserva; la trustline va por Fee Bump.

const channelPublic = process.env.STELLAR_MASTER_PUBLIC;
const needed        = missing.length * XLM_PER_ACCOUNT;

if (channelPublic) {
  const channelXLM = await getXLMBalance(channelPublic);
  console.log(`[repair-custody] Canal ${channelPublic}: ${channelXLM.toFixed(2)} XLM  (hacen falta ~${needed.toFixed(2)})`);
  if (missing.length && channelXLM < needed + 2) {
    console.error('\n❌ El canal no tiene XLM suficiente. Fondearlo antes de reparar —');
    console.error('   reintentar sin fondear repite exactamente el fallo original.');
    await mongoose.disconnect();
    process.exit(1);
  }
} else {
  console.warn('[repair-custody] ⚠️ STELLAR_MASTER_PUBLIC sin definir — no se pudo verificar el saldo del canal');
}

if (DRY_RUN) {
  console.log(`\n[repair-custody] DRY RUN — se repararían ${toRepair.length} cuenta(s). Nada fue modificado.`);
  await mongoose.disconnect();
  process.exit(0);
}

// ─── Reparar ─────────────────────────────────────────────────────────────────

console.log(`\n[repair-custody] Reparando ${toRepair.length} cuenta(s)…\n`);

let ok = 0;
let fail = 0;
const failures = [];

for (const [i, u] of toRepair.entries()) {
  const tag = `[${i + 1}/${toRepair.length}]`;
  try {
    const r = await ensureAccountOnChain(u._id);
    ok++;
    const did = [r.funded && 'fondeada', r.trustlineCreated && 'trustline'].filter(Boolean).join(' + ');
    console.log(`${tag} ✅ ${u.email}  ${r.publicKey}  → ${did || 'ya estaba OK'}`);
  } catch (e) {
    fail++;
    failures.push({ email: u.email, publicKey: u.publicKey, err: e.message });
    console.error(`${tag} ❌ ${u.email}  ${u.publicKey}  → ${e.message}`);
  }
  if (i < toRepair.length - 1) await sleep(DELAY_MS);
}

console.log(`\n[repair-custody] Listo. OK=${ok}  FAIL=${fail}`);
if (failures.length) console.log('Fallos:', JSON.stringify(failures, null, 2));

await mongoose.disconnect();
process.exit(fail > 0 ? 1 : 0);
