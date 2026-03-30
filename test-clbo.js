/**
 * test-clbo.js — Smoke test del corredor CLP → BOB manual (SpA → anchorBolivia)
 *
 * Flujo:
 *   1. Verificacion matematica pura (Regla de Oro)
 *   2. Verificar corredor cl-bo en MongoDB
 *   3. Verificar SpAConfig en MongoDB
 *   4. GET  /api/v1/admin/spa-config
 *   5. PATCH /api/v1/admin/spa-config — actualizar tasa
 *   6. PATCH /api/v1/admin/spa-config — tasa invalida (validacion)
 *   7. GET  /api/v1/payments/quote — CL→BO
 *   8. Quote con monto bajo minimo
 *   9. Quote con monto sobre maximo
 *  10. POST /api/v1/payments/crossborder — init con bank_data
 *  11. POST /api/v1/payments/crossborder — init con QR imagen
 *  12. Admin confirma payin
 *  13. Admin marca payout completado
 *
 * Uso:
 *   node test-clbo.js
 *   node test-clbo.js --env production
 *
 * Variables requeridas en .env:
 *   TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
 *   TEST_USER_SPA_EMAIL, TEST_USER_SPA_PASSWORD (usuario SpA)
 *   API_URL (default: http://localhost:3000)
 *   MONGODB_URI (para pasos 2-3 de verificacion directa)
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const args = process.argv.slice(2);
const ENV  = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'local';

const BASE_URL = ENV === 'production'
  ? 'https://alyto-backend-v2.onrender.com'
  : (process.env.API_URL ?? 'http://localhost:3000');

const CREDS = {
  admin: {
    email:    process.env.TEST_ADMIN_EMAIL    ?? 'admin@alyto.app',
    password: process.env.TEST_ADMIN_PASSWORD ?? 'Admin1234!',
  },
  user: {
    email:    process.env.TEST_USER_SPA_EMAIL    ?? 'test-spa@avfinance.net',
    password: process.env.TEST_USER_SPA_PASSWORD ?? 'Test1234!',
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
  adminToken:    null,
  userToken:     null,
  transactionId: null,
  paymentRef:    null,
  clpPerBob:     null,
  quoteData:     null,
};

// ── Pasos ─────────────────────────────────────────────────────────────────────

const steps = [

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 1 — Verificacion matematica pura (sin servidor)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step1_mathVerification() {
    logStep(1, 'Verificacion matematica pura — Regla de Oro');

    const round2 = n => Math.round(n * 100) / 100;
    const amount = 100000, spread = 1.5, fixed = 300, profit = 0.5, rate = 99.59;

    const spreadFee         = round2(amount * spread / 100);
    const profitFee         = round2(amount * profit / 100);
    const totalDeductedReal = round2(spreadFee + fixed + profitFee);
    const netCLP            = round2(amount - totalDeductedReal);
    const bob               = round2(netCLP / rate);

    assert(spreadFee         === 1500,  `spreadFee === 1500 — recibido: ${spreadFee}`);
    assert(profitFee         === 500,   `profitFee === 500 — recibido: ${profitFee}`);
    assert(totalDeductedReal === 2300,  `totalDeductedReal === 2300 — recibido: ${totalDeductedReal}`);
    assert(netCLP            === 97700, `netCLP === 97700 — recibido: ${netCLP}`);
    assert(bob               === 981.02, `bob === 981.02 (97700/99.59) — recibido: ${bob}`);

    logInfo('Calculo matematico OK ✅');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 2 — Verificar corredor cl-bo en MongoDB
  // ═══════════════════════════════════════════════════════════════════════════

  async function step2_verifyCorridorMongo() {
    logStep(2, 'Verificar corredor cl-bo en MongoDB');

    if (!process.env.MONGODB_URI) {
      logWarn('MONGODB_URI no definida — saltando verificacion directa de MongoDB.');
      return;
    }

    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGODB_URI);
      }
      const TransactionConfig = (await import('./src/models/TransactionConfig.js')).default;
      const corridor = await TransactionConfig.findOne({ corridorId: 'cl-bo' }).lean();

      assert(!!corridor,                              'Corredor cl-bo existe');
      assert(corridor?.payinMethod === 'manual',      `payinMethod === 'manual' — recibido: ${corridor?.payinMethod}`);
      assert(corridor?.payoutMethod === 'anchorBolivia', `payoutMethod === 'anchorBolivia' — recibido: ${corridor?.payoutMethod}`);
      assert(corridor?.legalEntity === 'SpA',         `legalEntity === 'SpA' — recibido: ${corridor?.legalEntity}`);
      assert(corridor?.originCurrency === 'CLP',      `originCurrency === 'CLP' — recibido: ${corridor?.originCurrency}`);
      assert(corridor?.destinationCurrency === 'BOB', `destinationCurrency === 'BOB' — recibido: ${corridor?.destinationCurrency}`);
      assert(corridor?.alytoCSpread === 1.5,          `alytoCSpread === 1.5 — recibido: ${corridor?.alytoCSpread}`);
      assert(corridor?.profitRetentionPercent === 0.5, `profitRetentionPercent === 0.5 — recibido: ${corridor?.profitRetentionPercent}`);
      assert(corridor?.fixedFee === 300,              `fixedFee === 300 — recibido: ${corridor?.fixedFee}`);
    } catch (err) {
      logFail(`Error conectando a MongoDB: ${err.message}`);
      failed++;
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 3 — Verificar SpAConfig en MongoDB
  // ═══════════════════════════════════════════════════════════════════════════

  async function step3_verifySpAConfig() {
    logStep(3, 'Verificar SpAConfig en MongoDB');

    if (!process.env.MONGODB_URI) {
      logWarn('MONGODB_URI no definida — saltando verificacion directa de MongoDB.');
      return;
    }

    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGODB_URI);
      }
      const SpAConfig = (await import('./src/models/SpAConfig.js')).default;
      let config = await SpAConfig.findOne().lean();

      if (!config) {
        logWarn('SpAConfig no existe — creando con valores de prueba...');
        config = await SpAConfig.create({
          clpPerBob:     99.59,
          minAmountCLP:  10000,
          maxAmountCLP:  5000000,
          bankName:      'Banco Test',
          accountNumber: '00-00000-0',
          rut:           '77.777.777-7',
          accountHolder: 'AV Finance SpA',
        });
        config = config.toObject();
        logOk('SpAConfig creada exitosamente');
        passed++;
      }

      assert(config.clpPerBob > 0,                      `clpPerBob > 0 — valor: ${config.clpPerBob}`);
      assert(config.minAmountCLP > 0,                    `minAmountCLP > 0 — valor: ${config.minAmountCLP}`);
      assert(config.maxAmountCLP > config.minAmountCLP,  `maxAmountCLP > minAmountCLP — ${config.maxAmountCLP} > ${config.minAmountCLP}`);

      state.clpPerBob = config.clpPerBob;
      logInfo(`clpPerBob actual: ${config.clpPerBob}`);
    } catch (err) {
      logFail(`Error verificando SpAConfig: ${err.message}`);
      failed++;
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 4 — GET /api/v1/admin/spa-config (login admin)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step4_getSpAConfig() {
    logStep(4, 'GET /api/v1/admin/spa-config (login admin)');

    // Login admin
    const { status: loginStatus, data: loginData } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(loginStatus === 200, `Login admin exitoso (200) — recibido: ${loginStatus}`);
    if (loginData.token) state.adminToken = loginData.token;

    // GET config
    const { status, data } = await request('GET', '/api/v1/admin/spa-config', {
      token: state.adminToken,
    });
    assert(status === 200, `Status 200 — recibido: ${status}`);
    assert(typeof data.clpPerBob === 'number' && data.clpPerBob > 0, `clpPerBob existe y es positivo: ${data.clpPerBob}`);

    state.clpPerBob = data.clpPerBob;
    logInfo(`Config completa: clpPerBob=${data.clpPerBob}, min=${data.minAmountCLP}, max=${data.maxAmountCLP}, banco=${data.bankName}`);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 5 — PATCH /api/v1/admin/spa-config (actualizar tasa)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step5_updateSpAConfig() {
    logStep(5, 'PATCH /api/v1/admin/spa-config — actualizar tasa');

    const { status, data } = await request('PATCH', '/api/v1/admin/spa-config', {
      token: state.adminToken,
      body:  { clpPerBob: 99.59, minAmountCLP: 10000, maxAmountCLP: 5000000 },
    });
    assert(status === 200,         `Status 200 — recibido: ${status}`);
    assert(data.clpPerBob === 99.59, `clpPerBob === 99.59 — recibido: ${data.clpPerBob}`);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 6 — PATCH con tasa invalida (validacion)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step6_invalidRate() {
    logStep(6, 'PATCH /api/v1/admin/spa-config — tasa invalida');

    const { status } = await request('PATCH', '/api/v1/admin/spa-config', {
      token: state.adminToken,
      body:  { clpPerBob: -5 },
    });
    assert(status === 400, `Status 400 (validacion) — recibido: ${status}`);
    logInfo('Validacion tasa negativa OK ✅');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 7 — GET /api/v1/payments/quote CL→BO (login usuario SpA)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step7_quoteCLBO() {
    logStep(7, 'GET /api/v1/payments/quote — CL→BO 100.000 CLP');

    // Login usuario SpA
    const { status: loginStatus, data: loginData } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.user.email, password: CREDS.user.password },
    });
    assert(loginStatus === 200, `Login usuario exitoso (200) — recibido: ${loginStatus}`);
    if (loginData.token) state.userToken = loginData.token;

    // Quote
    const qs = new URLSearchParams({
      originCountry: 'CL', destinationCountry: 'BO',
      originAmount: '100000',
    });
    const { status, data } = await request('GET', `/api/v1/payments/quote?${qs}`, {
      token: state.userToken,
    });

    assert(status === 200,                        `Status 200 — recibido: ${status}`);
    assert(data.destinationCurrency === 'BOB',    `destinationCurrency === 'BOB' — recibido: ${data.destinationCurrency}`);
    assert(data.payinMethod === 'manual',         `payinMethod === 'manual' — recibido: ${data.payinMethod}`);
    assert(data.isManualCorridor === true,         `isManualCorridor === true — recibido: ${data.isManualCorridor}`);
    assert(data.fees?.totalDeducted === 2300,      `fees.totalDeducted === 2300 — recibido: ${data.fees?.totalDeducted}`);
    assert(data.destinationAmount === 981.02,      `destinationAmount === 981.02 — recibido: ${data.destinationAmount}`);
    assert(!!data.payinInstructions,               'payinInstructions presente');
    assert(!!data.payinInstructions?.bankName,     `bankName: ${data.payinInstructions?.bankName}`);
    assert(!!data.payinInstructions?.accountNumber, `accountNumber: ${data.payinInstructions?.accountNumber}`);
    assert(!!data.payinInstructions?.rut,           `rut: ${data.payinInstructions?.rut}`);
    assert(typeof data.paymentRef === 'string' && data.paymentRef.startsWith('ALY-'), `paymentRef comienza con ALY-: ${data.paymentRef}`);

    state.paymentRef = data.paymentRef;
    state.quoteData  = data;
    logInfo(`Quote completo: ${data.originAmount} CLP → ${data.destinationAmount} BOB @ ${data.exchangeRate} CLP/BOB`);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 8 — Quote con monto bajo limite minimo
  // ═══════════════════════════════════════════════════════════════════════════

  async function step8_quoteUnderMin() {
    logStep(8, 'GET /api/v1/payments/quote — monto bajo minimo (5000 CLP)');

    const qs = new URLSearchParams({
      originCountry: 'CL', destinationCountry: 'BO',
      originAmount: '5000',
    });
    const { status } = await request('GET', `/api/v1/payments/quote?${qs}`, {
      token: state.userToken,
    });
    assert(status === 400, `Status 400 (bajo minimo) — recibido: ${status}`);
    logInfo('Validacion monto minimo OK ✅');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 9 — Quote con monto sobre limite maximo
  // ═══════════════════════════════════════════════════════════════════════════

  async function step9_quoteOverMax() {
    logStep(9, 'GET /api/v1/payments/quote — monto sobre maximo (9.999.999 CLP)');

    const qs = new URLSearchParams({
      originCountry: 'CL', destinationCountry: 'BO',
      originAmount: '9999999',
    });
    const { status } = await request('GET', `/api/v1/payments/quote?${qs}`, {
      token: state.userToken,
    });
    assert(status === 400, `Status 400 (sobre maximo) — recibido: ${status}`);
    logInfo('Validacion monto maximo OK ✅');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 10 — POST /api/v1/payments/crossborder (init con bank_data)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step10_initBankData() {
    logStep(10, 'POST /api/v1/payments/crossborder — init con bank_data');

    const { status, data } = await request('POST', '/api/v1/payments/crossborder', {
      token: state.userToken,
      body: {
        corridorId:    'cl-bo',
        originAmount:  100000,
        paymentRef:    state.paymentRef,
        beneficiaryData: {
          type:          'bank_data',
          firstName:     'ALVARO',
          lastName:      'VALDEZ',
          accountType:   'Caja de Ahorro',
          accountNumber: '1311020168',
          currency:      'BOB',
          bankName:      'Banco Ganadero',
          country:       'BO',
        },
      },
    });

    assert(status === 201,                `Status 201 — recibido: ${status}`);
    assert(data.status === 'payin_pending', `status === 'payin_pending' — recibido: ${data.status}`);
    assert(!!data.alytoTransactionId,      `alytoTransactionId existe: ${data.alytoTransactionId}`);

    if (data.alytoTransactionId) {
      state.transactionId = data.alytoTransactionId;
      logInfo(`transactionId guardado: ${state.transactionId}`);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 11 — POST /api/v1/payments/crossborder (init con QR imagen)
  // ═══════════════════════════════════════════════════════════════════════════

  async function step11_initQRImage() {
    logStep(11, 'POST /api/v1/payments/crossborder — init con QR imagen');

    const { status, data } = await request('POST', '/api/v1/payments/crossborder', {
      token: state.userToken,
      body: {
        corridorId:    'cl-bo',
        originAmount:  100000,
        paymentRef:    'ALY-TEST-QR',
        beneficiaryData: {
          type:            'qr_image',
          qrImageBase64:   'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          qrImageMimetype: 'image/png',
          firstName:       'ALVARO',
          bankName:        'Banco Ganadero',
          country:         'BO',
        },
      },
    });

    assert(status === 201,                `Status 201 — recibido: ${status}`);
    assert(data.status === 'payin_pending', `status === 'payin_pending' — recibido: ${data.status}`);
    logInfo('QR beneficiario OK ✅');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 12 — Admin confirma payin
  // ═══════════════════════════════════════════════════════════════════════════

  async function step12_adminConfirmPayin() {
    logStep(12, 'PATCH /admin/transactions/:id/status — confirmar payin');

    if (!state.transactionId) {
      logFail('transactionId no disponible — paso 10 fallo. Saltando.');
      failed++;
      return;
    }

    const { status, data } = await request('PATCH', `/api/v1/admin/transactions/${state.transactionId}/status`, {
      token: state.adminToken,
      body:  { status: 'payin_confirmed', note: 'Smoke test: transferencia CLP verificada ref BOG-TEST-001' },
    });
    assert(status === 200, `Status 200 — recibido: ${status}`);
    logInfo('Payin confirmado por admin ✅');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 13 — Admin marca payout completado
  // ═══════════════════════════════════════════════════════════════════════════

  async function step13_adminCompletePayout() {
    logStep(13, 'PATCH /admin/transactions/:id/status — payout completado');

    if (!state.transactionId) {
      logFail('transactionId no disponible — saltando.');
      failed++;
      return;
    }

    const { status, data } = await request('PATCH', `/api/v1/admin/transactions/${state.transactionId}/status`, {
      token: state.adminToken,
      body:  { status: 'completed', note: 'Smoke test: transferencia BOB ejecutada ref BOG-TEST-001' },
    });
    assert(status === 200,                 `Status 200 — recibido: ${status}`);
    assert(data.transaction?.status === 'completed', `status === 'completed' — recibido: ${data.transaction?.status}`);
    logInfo('Payout completado ✅');
  },

];

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${colors.bold}╔══════════════════════════════════════════════════╗`);
  console.log(`║   Alyto — CLP → BOB Manual Corridor Smoke Test  ║`);
  console.log(`║   Corredor cl-bo · SpA → anchorBolivia           ║`);
  console.log(`╚══════════════════════════════════════════════════╝${colors.reset}`);
  log(`\n  Entorno  : ${ENV}`, 'cyan');
  log(`  Base URL : ${BASE_URL}`, 'cyan');
  log(`  Admin    : ${CREDS.admin.email}`, 'cyan');
  log(`  Usuario  : ${CREDS.user.email}\n`, 'cyan');

  for (const step of steps) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  // Cerrar conexion MongoDB si fue abierta
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // ── Resumen final ─────────────────────────────────────────────────────────

  const round2 = n => Math.round(n * 100) / 100;
  const mathBob = round2(97700 / 99.59);

  console.log(`\n${colors.bold}── Resumen ──────────────────────────────────────────${colors.reset}`);
  log(`  ✅ Pasaron : ${passed}`, 'green');
  log(`  ❌ Fallaron: ${failed}`, failed > 0 ? 'red' : 'dim');
  log(`  Calculo matematico: spreadFee=1500 fixed=300 profitFee=500 total=2300 net=97700 bob=${mathBob}`, 'cyan');
  log(`  destinationAmount quote: ${state.quoteData?.destinationAmount ?? 'N/A'}`, 'cyan');
  log(`  transactionId: ${state.transactionId ?? 'no generado'}`, 'cyan');
  log(`  clpPerBob configurado: ${state.clpPerBob ?? 'N/A'}`, 'cyan');

  console.log();
  if (failed > 0) {
    log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow');
    process.exit(1);
  } else {
    log('  CLP → BOB corridor smoke test completo sin errores. 🎉\n', 'green');
  }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
