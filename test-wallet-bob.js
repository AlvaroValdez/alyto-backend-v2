/**
 * test-wallet-bob.js — Smoke test end-to-end de la Wallet BOB (Fase 25)
 *
 * Flujo:
 *   1. Login usuario SRL
 *   2. GET  /api/v1/wallet/balance              → verifica currency BOB
 *   3. POST /api/v1/wallet/deposit/initiate     → inicia depósito Bs. 500
 *   4. Login admin
 *   5. POST /api/v1/admin/wallet/deposit/confirm → confirma el depósito
 *   6. GET  /api/v1/wallet/balance              → verifica saldo actualizado
 *   7. GET  /api/v1/admin/wallet/deposits/pending
 *   8. GET  /api/v1/wallet/transactions         → verifica depósito completed
 *
 * Uso:
 *   node test-wallet-bob.js
 *   node test-wallet-bob.js --env production
 *
 * Variables requeridas en .env:
 *   TEST_SRL_EMAIL, TEST_SRL_PASSWORD
 *   TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
 *   API_URL (default: http://localhost:3000)
 */

import 'dotenv/config';

const args = process.argv.slice(2);
const ENV  = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'local';

const BASE_URL = ENV === 'production'
  ? 'https://alyto-backend-v2.onrender.com'
  : (process.env.API_URL ?? 'http://localhost:3000');

const CREDS = {
  srl: {
    email:    process.env.TEST_SRL_EMAIL    ?? 'test-srl@alyto.app',
    password: process.env.TEST_SRL_PASSWORD ?? 'Test1234!',
  },
  admin: {
    email:    process.env.TEST_ADMIN_EMAIL    ?? 'admin@alyto.app',
    password: process.env.TEST_ADMIN_PASSWORD ?? 'Admin1234!',
  },
};

// ── Colores y helpers ─────────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
};

function log(msg, color = 'reset') { console.log(`${colors[color]}${msg}${colors.reset}`); }
function logStep(n, title) { console.log(`\n${colors.bold}${colors.cyan}── Paso ${n}: ${title}${colors.reset}`); }
function logOk(msg)   { log(`  ✅ ${msg}`, 'green');  }
function logFail(msg) { log(`  ❌ ${msg}`, 'red');    }
function logInfo(msg) { log(`  ℹ  ${msg}`, 'dim');    }
function logWarn(msg) { log(`  ⚠️  ${msg}`, 'yellow'); }

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { logOk(msg); passed++; }
  else           { logFail(msg); failed++; }
  return condition;
}

async function request(method, path, { token, body } = {}) {
  const url     = `${BASE_URL}${path}`;
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body)  headers['Content-Type']  = 'application/json';
  const res  = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  logInfo(`${method} ${url} → ${res.status} ${JSON.stringify(data).slice(0, 220)}`);
  return { status: res.status, data };
}

// ── Estado compartido entre pasos ─────────────────────────────────────────────

const state = {
  srlToken:   null,
  adminToken: null,
  walletId:   null,
  wtxId:      null,
  balancePre: 0,
};

// ── Pasos ─────────────────────────────────────────────────────────────────────

const steps = [

  async function step1_loginSRL() {
    logStep(1, 'Login usuario SRL');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.srl.email, password: CREDS.srl.password },
    });
    assert(status === 200,     `Login exitoso (200) — recibido: ${status}`);
    assert(!!data.token,       'Token recibido');
    assert(data.user?.legalEntity === 'SRL', `legalEntity === 'SRL' — recibido: ${data.user?.legalEntity}`);
    if (data.token) state.srlToken = data.token;
  },

  async function step2_getBalance() {
    logStep(2, 'GET /api/v1/wallet/balance');
    const { status, data } = await request('GET', '/api/v1/wallet/balance', {
      token: state.srlToken,
    });
    assert(status === 200,            `Status 200 — recibido: ${status}`);
    assert(data.currency === 'BOB',   `currency === 'BOB' — recibido: ${data.currency}`);
    assert(data.status === 'active',  `wallet status === 'active' — recibido: ${data.status}`);
    if (data.walletId) state.walletId = data.walletId;
    state.balancePre = data.balance ?? 0;
    logInfo(`Balance previo: Bs. ${state.balancePre}`);
    logInfo(`walletId: ${data.walletId ?? 'no disponible'}`);
  },

  async function step3_initiateDeposit() {
    logStep(3, 'POST /api/v1/wallet/deposit/initiate — Bs. 500');
    const { status, data } = await request('POST', '/api/v1/wallet/deposit/initiate', {
      token: state.srlToken,
      body:  { amount: 500 },
    });
    assert(status === 201,         `Status 201 — recibido: ${status}`);
    assert(!!data.wtxId,           `wtxId recibido: ${data.wtxId}`);
    assert(!!data.bankName,        `bankName recibido: ${data.bankName}`);
    assert(!!data.accountNumber || data.accountNumber === '', 'accountNumber presente en respuesta');
    assert(data.amount === 500,    `amount === 500 — recibido: ${data.amount}`);
    assert(data.currency === 'BOB', `currency === 'BOB' — recibido: ${data.currency}`);
    if (data.wtxId) {
      state.wtxId = data.wtxId;
      logInfo(`wtxId (usar como referencia bancaria): ${data.wtxId}`);
    }
    logInfo(`Instrucciones: banco=${data.bankName}, titular=${data.accountHolder}`);
  },

  async function step4_loginAdmin() {
    logStep(4, 'Login admin');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(status === 200,   `Login admin (200) — recibido: ${status}`);
    assert(!!data.token,     'Token admin recibido');
    if (data.token) state.adminToken = data.token;
    if (data.user?.role !== 'admin') logWarn(`role recibido: "${data.user?.role}" — se espera "admin"`);
    else logOk('role: admin ✓');
  },

  async function step5_confirmDeposit() {
    logStep(5, `POST /api/v1/admin/wallet/deposit/confirm — wtxId: ${state.wtxId}`);
    if (!state.wtxId) {
      logFail('wtxId no disponible — paso 3 falló. Saltando confirmación.');
      failed++;
      return;
    }
    const { status, data } = await request('POST', '/api/v1/admin/wallet/deposit/confirm', {
      token: state.adminToken,
      body:  {
        wtxId:         state.wtxId,
        bankReference: 'TEST-BISA-001',
        note:          'Smoke test fase 25',
      },
    });
    assert(status === 200,        `Status 200 — recibido: ${status}`);
    assert(data.balanceNew > 0,   `balanceNew > 0 — recibido: ${data.balanceNew}`);
    assert(!!data.confirmedAt,    `confirmedAt presente: ${data.confirmedAt}`);
    assert(data.wtxId === state.wtxId, `wtxId coincide: ${data.wtxId}`);
    logInfo(`Balance nuevo tras confirmación: Bs. ${data.balanceNew}`);
  },

  async function step6_verifyBalance() {
    logStep(6, 'GET /api/v1/wallet/balance — verificar saldo actualizado');
    const { status, data } = await request('GET', '/api/v1/wallet/balance', {
      token: state.srlToken,
    });
    assert(status === 200,              `Status 200 — recibido: ${status}`);
    assert(data.balance >= 500,         `balance >= 500 — recibido: Bs. ${data.balance}`);
    assert(data.balance > state.balancePre, `balance aumentó (${state.balancePre} → ${data.balance})`);
    logInfo(`Balance final: Bs. ${data.balance}`);
    logInfo(`Disponible: Bs. ${data.balanceAvailable ?? (data.balance - (data.balanceReserved ?? 0))}`);
  },

  async function step7_listPendingDeposits() {
    logStep(7, 'GET /api/v1/admin/wallet/deposits/pending');
    const { status, data } = await request('GET', '/api/v1/admin/wallet/deposits/pending', {
      token: state.adminToken,
    });
    assert(status === 200, `Status 200 — recibido: ${status}`);
    const list = data.deposits ?? data.transactions ?? [];
    assert(Array.isArray(list), `Respuesta contiene array — campo: ${data.deposits !== undefined ? 'deposits' : 'transactions'}`);
    logInfo(`Depósitos pendientes actualmente: ${list.length}`);
  },

  async function step8_verifyTransactions() {
    logStep(8, 'GET /api/v1/wallet/transactions — verificar depósito en historial');
    const { status, data } = await request('GET', '/api/v1/wallet/transactions?limit=10', {
      token: state.srlToken,
    });
    assert(status === 200,                        `Status 200 — recibido: ${status}`);
    assert(Array.isArray(data.transactions),       'Campo transactions es array');
    assert((data.transactions?.length ?? 0) >= 1, `Al menos 1 transacción en historial — encontradas: ${data.transactions?.length}`);

    // Buscar el depósito confirmado por wtxId
    const depositTx = data.transactions?.find(tx => tx.wtxId === state.wtxId || tx.reference === state.wtxId);
    if (depositTx) {
      assert(depositTx.type === 'deposit',       `type === 'deposit' — recibido: ${depositTx.type}`);
      assert(depositTx.status === 'completed',   `status === 'completed' — recibido: ${depositTx.status}`);
      assert(depositTx.amount === 500,           `amount === 500 — recibido: ${depositTx.amount}`);
      logInfo(`stellarTxId: ${depositTx.stellarTxId ?? '(audit trail pendiente)'}`);
    } else {
      // Fallback: verificar la primera transacción del historial
      const first = data.transactions?.[0]
      logWarn(`wtxId ${state.wtxId} no encontrado directamente — verificando primera tx del historial`);
      assert(first?.type === 'deposit',     `first tx type === 'deposit' — recibido: ${first?.type}`);
      assert(first?.status === 'completed', `first tx status === 'completed' — recibido: ${first?.status}`);
    }
    logInfo(`Total transacciones en historial: ${data.pagination?.total ?? data.transactions?.length}`);
  },

];

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${colors.bold}╔══════════════════════════════════════════╗`);
  console.log(`║   Alyto — Wallet BOB Smoke Test          ║`);
  console.log(`║   Fase 25 · Dual Ledger · AV Finance SRL ║`);
  console.log(`╚══════════════════════════════════════════╝${colors.reset}`);
  log(`\n  Entorno  : ${ENV}`, 'cyan');
  log(`  Base URL : ${BASE_URL}`, 'cyan');
  log(`  SRL user : ${CREDS.srl.email}`, 'cyan');
  log(`  Admin    : ${CREDS.admin.email}\n`, 'cyan');

  for (const step of steps) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  // ── Resumen final ─────────────────────────────────────────────────────────
  console.log(`\n${colors.bold}── Resumen ──────────────────────────────────${colors.reset}`);
  log(`  ✅ Pasaron : ${passed}`, 'green');
  log(`  ❌ Fallaron: ${failed}`, failed > 0 ? 'red' : 'dim');
  log(`  walletId   : ${state.walletId ?? 'no disponible'}`, 'cyan');
  log(`  wtxId test : ${state.wtxId   ?? 'no generado'}`,    'cyan');

  // Obtener balance final para el resumen
  if (state.srlToken) {
    try {
      const { data } = await request('GET', '/api/v1/wallet/balance', { token: state.srlToken });
      log(`  balance final: Bs. ${data.balance ?? '?'}`, 'cyan');
    } catch { /* silencioso */ }
  }

  console.log();
  if (failed > 0) {
    log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow');
    process.exit(1);
  } else {
    log('  Wallet BOB smoke test completo sin errores. 🎉\n', 'green');
  }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
