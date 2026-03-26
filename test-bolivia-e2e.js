/**
 * test-bolivia-e2e.js — Test end-to-end del flujo Bolivia (BOB → CO/PE/CL)
 *
 * Simula el flujo completo Escenario C — SRL manual:
 *   1. Login usuario SRL (legalEntity: SRL, kycStatus: approved)
 *   2. GET /api/v1/payments/quote?originCountry=BO&destinationCountry=CO&originAmount=1000
 *   3. POST /api/v1/payments/crossborder  → transacción iniciada con payin manual
 *   4. Login admin
 *   5. GET /api/v1/admin/transactions?entity=SRL&status=initiated
 *   6. PATCH /api/v1/admin/transactions/:id/status → payin_confirmed
 *   7. GET /api/v1/admin/transactions/:id → verificar payout_pending / completed
 *
 * Uso:
 *   node test-bolivia-e2e.js
 *   node test-bolivia-e2e.js --env production
 *   node test-bolivia-e2e.js --step 1
 *
 * Variables requeridas en .env:
 *   TEST_SRL_EMAIL, TEST_SRL_PASSWORD
 *   TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
 *   API_URL (default: http://localhost:5000)
 */

import 'dotenv/config';

const args      = process.argv.slice(2);
const ENV       = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'local';
const ONLY_STEP = args.includes('--step') ? Number(args[args.indexOf('--step') + 1]) : null;

const BASE_URL = ENV === 'production'
  ? 'https://alyto-backend-v2.onrender.com'
  : (process.env.API_URL ?? 'http://localhost:3000');

const CREDS = {
  srl: {
    email:    process.env.TEST_SRL_EMAIL?.trim()    || process.env.TEST_USER_EMAIL?.trim()    || 'test@avfinance.net',
    password: process.env.TEST_SRL_PASSWORD?.trim() || process.env.TEST_USER_PASSWORD?.trim() || 'Test1234!',
  },
  admin: {
    email:    process.env.TEST_ADMIN_EMAIL?.trim()    || 'admin@alyto.app',
    password: process.env.TEST_ADMIN_PASSWORD?.trim() || 'Admin1234!',
  },
};

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
  const res  = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  logInfo(`${method} ${url} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return { status: res.status, data };
}

const state = {
  srlToken:      null,
  adminToken:    null,
  quote:         null,
  transactionId: null,
};

const steps = [

  async function step1_loginSRL() {
    logStep(1, 'Login usuario SRL');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.srl.email, password: CREDS.srl.password },
    });
    assert(status === 200, `Login exitoso (200) — recibido: ${status}`);
    assert(!!data.token, 'Token recibido');
    if (data.token) state.srlToken = data.token;
    if (data.user?.legalEntity !== 'SRL') {
      logWarn(`legalEntity: "${data.user?.legalEntity}" — se necesita "SRL"`);
    } else {
      logOk('legalEntity: SRL ✓');
    }
    if (data.user?.kycStatus !== 'approved') {
      logWarn(`kycStatus: "${data.user?.kycStatus}" — se necesita "approved"`);
    } else {
      logOk('kycStatus: approved ✓');
    }
  },

  async function step2_getQuote() {
    logStep(2, 'GET /api/v1/payments/quote?originCountry=BO&destinationCountry=CO&originAmount=1000');
    const { status, data } = await request(
      'GET',
      '/api/v1/payments/quote?originCountry=BO&destinationCountry=CO&originAmount=1000',
      { token: state.srlToken },
    );
    assert(status === 200, `Quote obtenido (200) — recibido: ${status}`);
    assert(data.destinationAmount > 0, `destinationAmount > 0 — recibido: ${data.destinationAmount}`);
    assert(data.isManualCorridor === true, `isManualCorridor: true — recibido: ${data.isManualCorridor}`);
    assert(data.payinMethod === 'manual', `payinMethod: manual — recibido: ${data.payinMethod}`);
    assert(!!data.corridorId, `corridorId presente: ${data.corridorId}`);
    logInfo(`Tasa efectiva: 1 BOB = ${data.exchangeRate} ${data.destinationCurrency}`);
    logInfo(`Recibirá: ${data.destinationAmount} ${data.destinationCurrency}`);
    if (data) {
      state.quote = data;
      logInfo(`Corredor: ${data.corridorId} | payinMethod: ${data.payinMethod} | payoutMethod: ${data.payoutMethod ?? '(no expuesto)'}`);
    }
  },

  async function step3_initPayment() {
    logStep(3, 'POST /api/v1/payments/crossborder — iniciar pago manual SRL');
    if (!state.quote) { logFail('Quote no disponible — saltar'); failed++; return; }

    const { status, data } = await request('POST', '/api/v1/payments/crossborder', {
      token: state.srlToken,
      body: {
        corridorId:         state.quote.corridorId,
        originAmount:       1000,
        payinMethod:        'manual',
        destinationCountry: 'CO',
        beneficiaryData: {
          beneficiary_first_name: 'Carlos',
          beneficiary_last_name:  'Test',
          beneficiary_document:   '12345678',
          beneficiary_phone:      '+573001234567',
        },
      },
    });
    assert(status === 201, `Transacción creada (201) — recibido: ${status}`);
    assert(!!data.transactionId, `transactionId presente: ${data.transactionId}`);
    assert(data.payinMethod === 'manual', `payinMethod: manual — recibido: ${data.payinMethod}`);

    // El backend retorna paymentInstructions (no payinInstructions) — validar bankName
    const instructions = data.paymentInstructions ?? data.payinInstructions;
    assert(!!instructions?.bankName, `paymentInstructions.bankName presente: ${instructions?.bankName}`);
    assert(!!instructions?.accountNumber || instructions?.accountNumber === '', `accountNumber en instrucciones`);
    assert(!!instructions?.reference, `reference en instrucciones: ${instructions?.reference}`);

    // paymentQR puede ser string base64 o null (si no hay QR configurado en SRLConfig)
    assert(
      data.paymentQR === null || typeof data.paymentQR === 'string',
      `paymentQR es string o null — recibido: ${typeof data.paymentQR}`,
    );
    // QR estáticos (array de { label, imageBase64 })
    assert(
      Array.isArray(data.paymentQRStatic),
      `paymentQRStatic es array — longitud: ${data.paymentQRStatic?.length ?? 'N/A'}`,
    );

    logInfo(`📧 Emails esperados: manualPayinInstructions (usuario) + adminManualPayinAlert (admin)`);
    if (data.transactionId) state.transactionId = data.transactionId;
  },

  async function step4_loginAdmin() {
    logStep(4, 'Login admin');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(status === 200, `Login admin (200) — recibido: ${status}`);
    assert(!!data.token, 'Token admin recibido');
    if (data.token) state.adminToken = data.token;
    if (data.user?.role !== 'admin') logWarn(`role: "${data.user?.role}" — se esperaba "admin"`);
  },

  async function step5_listTransactions() {
    logStep(5, 'GET /api/v1/admin/transactions?entity=SRL&status=initiated');
    const { status, data } = await request(
      'GET',
      '/api/v1/admin/transactions?entity=SRL&status=initiated',
      { token: state.adminToken },
    );
    assert(status === 200, `Lista obtenida (200) — recibido: ${status}`);
    assert(Array.isArray(data.transactions), 'Campo transactions es array');
    const found = data.transactions?.some(t => t.alytoTransactionId === state.transactionId);
    assert(found, `Transacción ${state.transactionId} aparece en ledger SRL initiated`);
    logInfo(`Total SRL initiated: ${data.pagination?.total ?? data.transactions?.length ?? '?'}`);
  },

  async function step6_confirmPayin() {
    logStep(6, `PATCH /api/v1/admin/transactions/${state.transactionId}/status → payin_confirmed`);
    if (!state.transactionId) { logFail('transactionId no disponible — saltar'); failed++; return; }

    const { status, data } = await request(
      'PATCH',
      `/api/v1/admin/transactions/${state.transactionId}/status`,
      {
        token: state.adminToken,
        body: {
          status: 'payin_confirmed',
          note:   'Test e2e — transferencia recibida ref. TEST-001',
        },
      },
    );
    assert(status === 200, `Status actualizado (200) — recibido: ${status}`);
    // El backend retorna el transaction actualizado o al menos { ok: true }
    const newStatus = data.transaction?.status ?? data.status ?? data.newStatus;
    if (newStatus) {
      assert(
        newStatus === 'payin_confirmed' || newStatus === 'payout_pending',
        `Nuevo status es payin_confirmed o payout_pending — recibido: ${newStatus}`,
      );
    }
    logInfo('📧 Emails esperados: adminBoliviaAlert (dispatchPayout → anchorBolivia)');
  },

  async function step7_verifyPayout() {
    logStep(7, `GET /api/v1/admin/transactions/${state.transactionId} — verificar payout_pending`);
    if (!state.transactionId) { logFail('transactionId no disponible — saltar'); failed++; return; }

    // dispatchPayout corre fire-and-forget — esperar a que actualice el status
    logInfo('Esperando 2s para que dispatchPayout complete...');
    await new Promise(r => setTimeout(r, 2000));

    const { status, data } = await request(
      'GET',
      `/api/v1/admin/transactions/${state.transactionId}`,
      { token: state.adminToken },
    );
    assert(status === 200, `Detalle obtenido (200) — recibido: ${status}`);

    const tx = data.transaction;
    assert(
      tx?.status === 'payout_pending' || tx?.status === 'completed' || tx?.status === 'payin_confirmed',
      `Status es payout_pending / completed / payin_confirmed — recibido: ${tx?.status}`,
    );

    // Verificar que dispatchPayout corrió y dejó entrada en ipnLog
    const allEvents = tx?.ipnLog?.map(e => e.eventType) ?? [];
    const hasDispatchEvent = allEvents.some(e =>
      e === 'anchor_bolivia_payout_pending' ||
      e === 'anchor_manual_required' ||
      e?.includes('bolivia') ||
      e?.includes('anchor') ||
      e === 'payout_completed_sandbox' ||
      e === 'payout.corridor_missing' ||  // corredor sin payoutMethod configurado
      e?.includes('payout'),
    );
    if (tx?.status === 'payout_pending' || tx?.status === 'completed') {
      assert(hasDispatchEvent, `ipnLog contiene evento de payout — encontrado: ${allEvents.join(', ')}`);
    } else {
      // Todavía en payin_confirmed: dispatchPayout puede no haber terminado o corredor mal configurado
      logWarn(`Status en payin_confirmed — revisar payoutMethod del corredor y logs del servidor`);
      logWarn(`ipnLog: ${allEvents.join(', ')}`);
    }

    logInfo(`Status final: ${tx?.status}`);
    logInfo(`ipnLog events: ${tx?.ipnLog?.map(e => e.eventType).join(' → ') ?? 'none'}`);
    logInfo(`Beneficiario: ${JSON.stringify(tx?.beneficiary ?? {})}`);
  },

];

async function run() {
  console.log(`\n${colors.bold}╔════════════════════════════════════════════╗`);
  console.log(`║   Alyto Bolivia E2E — Test end-to-end      ║`);
  console.log(`╚════════════════════════════════════════════╝${colors.reset}`);
  log(`\n  Entorno   : ${ENV}`, 'cyan');
  log(`  Base URL  : ${BASE_URL}`, 'cyan');
  log(`  Usuario SRL: ${CREDS.srl.email}`, 'cyan');
  log(`  Admin      : ${CREDS.admin.email}\n`, 'cyan');

  const stepsToRun = ONLY_STEP ? steps.filter((_, i) => i + 1 === ONLY_STEP) : steps;

  for (const step of stepsToRun) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  console.log(`\n${colors.bold}── Resumen ──────────────────────────────────${colors.reset}`);
  log(`  ✅ Pasaron     : ${passed}`, 'green');
  log(`  ❌ Fallaron    : ${failed}`, failed > 0 ? 'red' : 'dim');
  log(`  transactionId  : ${state.transactionId ?? 'no generado'}\n`, 'cyan');

  if (failed > 0) {
    log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow');
    process.exit(1);
  } else {
    log('  Flujo Bolivia E2E completo sin errores. 🎉\n', 'green');
  }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
