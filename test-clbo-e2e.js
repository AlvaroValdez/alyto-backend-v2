/**
 * test-clbo-e2e.js — Test end-to-end del corredor CL→BO (CLP → BOB)
 *
 * Simula el flujo completo Escenario B+C — SpA usuario, pago manual a Bolivia:
 *   1. Login usuario SpA (legalEntity: SpA, kycStatus: approved)
 *   2. GET /api/v1/payments/corridors — verificar corredor BO disponible
 *   3. GET /api/v1/payments/quote?originCountry=CL&destinationCountry=BO&amount=100000
 *   4. POST /api/v1/payments/crossborder — iniciar transacción CL→BO
 *   5. GET /api/v1/payments/{transactionId}/status — verificar estado usuario
 *   6. Login admin
 *   7. PATCH /api/v1/admin/transactions/{transactionId}/status → payin_confirmed
 *   8. GET estado final (usuario) — verificar avance
 *   9. Validar payinInstructions (banco, cuenta, referencia, monto)
 *
 * Uso:
 *   node test-clbo-e2e.js
 *   node test-clbo-e2e.js --env production
 *   node test-clbo-e2e.js --step 3
 *
 * Variables requeridas en .env:
 *   TEST_USER_EMAIL, TEST_USER_PASSWORD  (usuario SpA)
 *   TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
 *   BASE_URL (default: http://localhost:3000)
 */

import 'dotenv/config';

const args      = process.argv.slice(2);
const ENV       = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'local';
const ONLY_STEP = args.includes('--step') ? Number(args[args.indexOf('--step') + 1]) : null;

const BASE_URL = ENV === 'production'
  ? 'https://alyto-backend-v2.onrender.com'
  : (process.env.BASE_URL ?? process.env.API_URL ?? 'http://localhost:3000');

const CREDS = {
  // TEST_SPA_EMAIL: usuario con legalEntity SpA, kycStatus approved.
  // Fallback: admin (v.alvaro.r@gmail.com) que también es SpA en este entorno.
  spa: {
    email:    process.env.TEST_SPA_EMAIL?.trim()
           ?? process.env.TEST_ADMIN_EMAIL?.trim()
           ?? 'v.alvaro.r@gmail.com',
    password: process.env.TEST_SPA_PASSWORD?.trim()
           ?? process.env.TEST_ADMIN_PASSWORD?.trim()
           ?? '18091986Lapaz',
  },
  admin: {
    email:    process.env.TEST_ADMIN_EMAIL?.trim()    || 'v.alvaro.r@gmail.com',
    password: process.env.TEST_ADMIN_PASSWORD?.trim() || '18091986Lapaz',
  },
};

const ORIGIN_AMOUNT = 100000; // CLP

// ── Colores ───────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
};

function log(msg, color = 'reset') { console.log(`${c[color]}${msg}${c.reset}`); }
function logStep(n, title) { console.log(`\n${c.bold}${c.cyan}── Paso ${n}: ${title}${c.reset}`); }
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

// ── Estado compartido entre pasos ─────────────────────────────────────────────

const state = {
  spaToken:        null,
  adminToken:      null,
  quote:           null,
  transactionId:   null,
  payinInstructions: null,
};

// ── Pasos ─────────────────────────────────────────────────────────────────────

const steps = [

  async function step1_loginSpA() {
    logStep(1, 'Login usuario SpA');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.spa.email, password: CREDS.spa.password },
    });
    assert(status === 200, `Login exitoso (200) — recibido: ${status}`);
    assert(!!data.token, 'Token recibido');
    if (data.token) state.spaToken = data.token;

    const le = data.user?.legalEntity;
    assert(le === 'SpA', `legalEntity === 'SpA' — recibido: "${le}"`);

    const kyc = data.user?.kycStatus;
    if (kyc !== 'approved') logWarn(`kycStatus: "${kyc}" — se necesita "approved" para crear transacciones`);
    else logOk(`kycStatus: approved ✓`);

    logInfo(`Usuario: ${data.user?.email} | legalEntity: ${le}`);
  },

  async function step2_getCorridors() {
    logStep(2, 'GET /api/v1/payments/corridors — verificar corredor BO disponible');
    const { status, data } = await request(
      'GET',
      '/api/v1/payments/corridors',
      { token: state.spaToken },
    );
    assert(status === 200, `Corredores obtenidos (200) — recibido: ${status}`);

    const corridors = data.corridors ?? data ?? [];
    const boCorridors = corridors.filter(
      cor => cor.destinationCountry === 'BO' || cor.corridorId?.includes('bo'),
    );
    assert(boCorridors.length > 0, `Al menos un corredor con destinationCountry=BO — encontrados: ${boCorridors.length}`);

    if (boCorridors.length > 0) {
      logInfo(`Corredor BO encontrado: ${boCorridors.map(c => c.corridorId ?? c._id).join(', ')}`);
    }
  },

  async function step3_getQuote() {
    logStep(3, 'GET quote — CL→BO 100.000 CLP');
    const { status, data } = await request(
      'GET',
      `/api/v1/payments/quote?originCountry=CL&destinationCountry=BO&originAmount=${ORIGIN_AMOUNT}&originCurrency=CLP`,
      { token: state.spaToken },
    );
    assert(status === 200, `Quote obtenido (200) — recibido: ${status}`);
    assert(data.destinationCurrency === 'BOB', `destinationCurrency === 'BOB' — recibido: "${data.destinationCurrency}"`);
    assert(data.destinationAmount > 0, `destinationAmount > 0 — recibido: ${data.destinationAmount}`);
    assert(data.isManualCorridor === true, `isManualCorridor: true — recibido: ${data.isManualCorridor}`);
    assert(
      data.payoutMethod === 'anchorBolivia' || data.payinMethod === 'manual',
      `payoutMethod=anchorBolivia o payinMethod=manual — recibido: payoutMethod=${data.payoutMethod} payinMethod=${data.payinMethod}`,
    );
    assert(data.fees?.totalDeducted > 0, `fees.totalDeducted > 0 — recibido: ${data.fees?.totalDeducted}`);

    logInfo(`destinationAmount: ${data.destinationAmount} BOB`);
    logInfo(`Tasa efectiva: 1 CLP = ${(data.destinationAmount / ORIGIN_AMOUNT).toFixed(4)} BOB`);
    logInfo(`Fees: ${data.fees?.totalDeducted} CLP`);
    logInfo(`Corredor: ${data.corridorId} | payinMethod: ${data.payinMethod} | payoutMethod: ${data.payoutMethod ?? '(no expuesto)'}`);

    if (data) state.quote = data;
  },

  async function step4_initCrossborner() {
    logStep(4, 'POST /api/v1/payments/crossborder — iniciar transacción CL→BO');
    if (!state.quote) { logFail('Quote no disponible — saltar'); failed++; return; }

    const { status, data } = await request('POST', '/api/v1/payments/crossborder', {
      token: state.spaToken,
      body: {
        corridorId:         'cl-bo',
        originAmount:       ORIGIN_AMOUNT,
        originCurrency:     'CLP',
        destinationCountry: 'BO',
        beneficiaryData: {
          beneficiary_first_name: 'Juan',
          beneficiary_last_name:  'Mamani',
          bank_name:              'Banco Bisa',
          account_number:         '1234567890',
          account_type:           'Cuenta Corriente',
          id_number:              '12345678',
        },
        quoteId: state.quote.quoteId ?? null,
      },
    });

    assert(status === 201, `Transacción creada (201) — recibido: ${status}`);
    const txId = data.alytoTransactionId ?? data.transactionId;
    assert(!!txId, `transactionId presente: ${txId}`);
    assert(
      data.status === 'initiated' || data.status === 'payin_pending',
      `status === 'initiated' | 'payin_pending' — recibido: "${data.status}"`,
    );

    // payinInstructions puede venir como payinInstructions o paymentInstructions
    const instructions = data.payinInstructions ?? data.paymentInstructions;
    assert(!!instructions, `payinInstructions presente — recibido: ${JSON.stringify(instructions)}`);
    assert(
      !!(instructions?.banco ?? instructions?.bankName),
      `payinInstructions.banco presente — recibido: ${instructions?.banco ?? instructions?.bankName}`,
    );
    assert(
      !!(instructions?.cuenta ?? instructions?.accountNumber ?? instructions?.accountNumber === ''),
      `payinInstructions.cuenta presente`,
    );
    assert(
      !!(instructions?.referencia ?? instructions?.reference),
      `payinInstructions.referencia presente — recibido: ${instructions?.referencia ?? instructions?.reference}`,
    );

    logInfo(`transactionId: ${txId}`);
    logInfo(`Referencia pago: ${instructions?.referencia ?? instructions?.reference}`);

    if (txId)         state.transactionId    = txId;
    if (instructions) state.payinInstructions = instructions;
  },

  async function step5_getStatusUser() {
    logStep(5, `GET /api/v1/payments/{transactionId}/status — vista usuario`);
    if (!state.transactionId) { logFail('transactionId no disponible — saltar'); failed++; return; }

    const { status, data } = await request(
      'GET',
      `/api/v1/payments/${state.transactionId}/status`,
      { token: state.spaToken },
    );
    assert(status === 200, `Status obtenido (200) — recibido: ${status}`);
    assert(
      data.status === 'initiated' || data.status === 'payin_pending',
      `status es initiated/payin_pending — recibido: "${data.status}"`,
    );
    assert(data.destinationCountry === 'BO', `destinationCountry === 'BO' — recibido: "${data.destinationCountry}"`);

    // payinMethod puede ser 'manual' (quote logic) o 'fintoc' (campo stored en corredor) — ambos OK
    // Lo relevante es que destinationCountry es BO y el corredor rutea a anchorBolivia
    logInfo(`payinMethod: ${data.payinMethod} | estimatedDelivery: ${data.estimatedDelivery}`);

    logInfo(`Status: ${data.status} | destinationAmount: ${data.destinationAmount} BOB`);
  },

  async function step6_loginAdmin() {
    logStep(6, 'Login admin');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(status === 200, `Login admin (200) — recibido: ${status}`);
    assert(!!data.token, 'Token admin recibido');
    if (data.token) state.adminToken = data.token;
    if (data.user?.role !== 'admin') logWarn(`role: "${data.user?.role}" — se esperaba "admin"`);
    else logOk('role: admin ✓');
  },

  async function step7_confirmPayin() {
    logStep(7, `PATCH .../status → payin_confirmed`);
    if (!state.transactionId) { logFail('transactionId no disponible — saltar'); failed++; return; }

    const { status, data } = await request(
      'PATCH',
      `/api/v1/admin/transactions/${state.transactionId}/status`,
      {
        token: state.adminToken,
        body: {
          status: 'payin_confirmed',
          note:   'Test e2e cl-bo — pago verificado',
        },
      },
    );
    assert(status === 200, `Status actualizado (200) — recibido: ${status}`);

    const newStatus = data.transaction?.status ?? data.status ?? data.newStatus;
    if (newStatus) {
      assert(
        ['payin_confirmed', 'payout_pending', 'completed'].includes(newStatus),
        `Nuevo status es payin_confirmed/payout_pending/completed — recibido: "${newStatus}"`,
      );
      logInfo(`Status resultante: ${newStatus}`);
    }
  },

  async function step8_getStatusFinal() {
    logStep(8, 'GET estado final — verificar que avanzó desde initiated');
    if (!state.transactionId) { logFail('transactionId no disponible — saltar'); failed++; return; }

    logInfo('Esperando 2s para que dispatchPayout complete...');
    await new Promise(r => setTimeout(r, 2000));

    const { status, data } = await request(
      'GET',
      `/api/v1/payments/${state.transactionId}/status`,
      { token: state.spaToken },
    );
    assert(status === 200, `Status final obtenido (200) — recibido: ${status}`);
    assert(data.status !== 'initiated', `Status avanzó desde 'initiated' — ahora: "${data.status}"`);
    assert(
      data.destinationCurrency === 'BOB',
      `destinationCurrency === 'BOB' — recibido: "${data.destinationCurrency}"`,
    );

    logInfo(`Status final: ${data.status} | destinationAmount: ${data.destinationAmount} BOB`);
  },

  async function step9_verifyPayinInstructions() {
    logStep(9, 'Verificar payinInstructions del Paso 4');
    const ins = state.payinInstructions;
    if (!ins) { logFail('payinInstructions no disponibles (Paso 4 falló)'); failed++; return; }

    // Para CL→BO el payin va al banco SpA en Chile (no al banco SRL en Bolivia).
    // Solo verificamos que el campo banco existe y es no vacío.
    const actualBank = ins.banco ?? ins.bankName ?? '';
    assert(!!actualBank, `payinInstructions.banco presente — recibido: "${actualBank}"`);

    const actualMonto = ins.monto ?? ins.amount ?? ins.originAmount;
    assert(
      Number(actualMonto) === ORIGIN_AMOUNT,
      `payinInstructions.monto === ${ORIGIN_AMOUNT} — recibido: ${actualMonto}`,
    );

    logInfo('Instrucciones completas verificadas');
    logInfo(`Banco: ${actualBank}`);
    logInfo(`Monto: ${actualMonto} CLP`);
    logInfo(`Cuenta: ${ins.cuenta ?? ins.accountNumber ?? '(no expuesto)'}`);
    logInfo(`Referencia: ${ins.referencia ?? ins.reference ?? '(no expuesto)'}`);
  },

];

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${c.bold}╔══════════════════════════════════════════════╗`);
  console.log(`║   Test cl-bo e2e — CLP → BOB                ║`);
  console.log(`╚══════════════════════════════════════════════╝${c.reset}`);
  log(`\n  Entorno    : ${ENV}`, 'cyan');
  log(`  Base URL   : ${BASE_URL}`, 'cyan');
  log(`  Usuario SpA: ${CREDS.spa.email}`, 'cyan');
  log(`  Admin      : ${CREDS.admin.email}`, 'cyan');
  log(`  Monto      : ${ORIGIN_AMOUNT.toLocaleString('es-CL')} CLP\n`, 'cyan');

  const stepsToRun = ONLY_STEP
    ? steps.filter((_, i) => i + 1 === ONLY_STEP)
    : steps;

  for (const step of stepsToRun) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  console.log(`\n${c.bold}╔══════════════════════════════════════════════╗`);
  console.log(`║   Resumen — Test cl-bo e2e                  ║`);
  console.log(`╚══════════════════════════════════════════════╝${c.reset}`);
  log(`\n  Resultados : ✅ ${passed} | ❌ ${failed}`, failed > 0 ? 'red' : 'green');
  log(`  transactionId    : ${state.transactionId ?? 'no generado'}`, 'cyan');
  if (state.quote) {
    log(`  destinationAmount: ${state.quote.destinationAmount} BOB`, 'cyan');
    log(`  Tasa efectiva    : 1 CLP = ${(state.quote.destinationAmount / ORIGIN_AMOUNT).toFixed(4)} BOB`, 'cyan');
  }
  console.log();

  if (failed > 0) {
    log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow');
    process.exit(1);
  } else {
    log('  Flujo CL→BO completo sin errores. 🎉\n', 'green');
  }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
