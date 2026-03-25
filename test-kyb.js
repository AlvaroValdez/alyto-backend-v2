/**
 * test-kyb.js — Test end-to-end del flujo KYB
 *
 * Simula el flujo completo:
 *   1. Login como usuario personal (kycStatus: approved)
 *   2. POST /api/v1/kyb/apply       → kybStatus: pending
 *   3. GET  /api/v1/kyb/status      → verifica estado
 *   4. Login como admin
 *   5. GET  /api/v1/admin/kyb       → lista solicitudes
 *   6. PATCH /api/v1/admin/kyb/:id/review → more_info
 *   7. POST /api/v1/kyb/documents   → usuario sube docs adicionales
 *   8. PATCH /api/v1/admin/kyb/:id/review → approved
 *   9. Verificar estado final
 *
 * Uso:
 *   node test-kyb.js
 *   node test-kyb.js --env production
 *   node test-kyb.js --step 1
 *
 * Variables requeridas en .env:
 *   TEST_USER_EMAIL, TEST_USER_PASSWORD
 *   TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
 *   API_URL (default: http://localhost:5000)
 */

import 'dotenv/config';

const args      = process.argv.slice(2);
const ENV       = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'local';
const ONLY_STEP = args.includes('--step') ? Number(args[args.indexOf('--step') + 1]) : null;

const BASE_URL = ENV === 'production'
  ? 'https://alyto-backend-v2.onrender.com'
  : (process.env.API_URL ?? 'http://localhost:5000');

const CREDS = {
  user: {
    email:    process.env.TEST_USER_EMAIL    ?? 'testuser@alyto.app',
    password: process.env.TEST_USER_PASSWORD ?? 'Test1234!',
  },
  admin: {
    email:    process.env.TEST_ADMIN_EMAIL    ?? 'admin@alyto.app',
    password: process.env.TEST_ADMIN_PASSWORD ?? 'Admin1234!',
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

async function request(method, path, { token, body, formData } = {}) {
  const url     = `${BASE_URL}${path}`;
  const headers = {};
  if (token)    headers['Authorization'] = `Bearer ${token}`;
  if (body)     headers['Content-Type']  = 'application/json';
  const res  = await fetch(url, { method, headers, body: formData ? formData : (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  logInfo(`${method} ${url} → ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return { status: res.status, data };
}

function mockBlob(name = 'documento.pdf') {
  const { Blob } = globalThis;
  return { blob: new Blob([`Mock content for ${name}`], { type: 'application/pdf' }), name };
}

const state = { userToken: null, adminToken: null, businessId: null };

const steps = [

  async function step1_loginUser() {
    logStep(1, 'Login usuario personal');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.user.email, password: CREDS.user.password },
    });
    assert(status === 200, `Login exitoso (200) — recibido: ${status}`);
    assert(!!data.token, 'Token recibido');
    if (data.token) state.userToken = data.token;
    if (data.user?.kycStatus !== 'approved') logWarn(`kycStatus: "${data.user?.kycStatus}" — se necesita "approved"`);
    else logOk('kycStatus: approved ✓');
  },

  async function step2_applyKYB() {
    logStep(2, 'POST /api/v1/kyb/apply');
    const { FormData } = globalThis;
    const form = new FormData();
    form.append('businessData', JSON.stringify({
      legalName: 'Test Empresa S.A.', tradeName: 'TestCorp',
      taxId: '76.123.456-7', countryOfIncorporation: 'CL',
      businessType: 'sociedad_anonima', industry: 'fintech',
      website: 'https://testcorp.cl', phone: '+56912345678',
      address: 'Av. Providencia 1234', city: 'Santiago', country: 'CL',
      estimatedMonthlyVolume: '5k_20k', mainCorridors: ['CL-CO', 'CL-PE'],
      businessDescription: 'Empresa de prueba para test KYB.',
      legalRepresentative: { firstName: 'Juan', lastName: 'Test', rut: '12.345.678-9', email: 'juan@testcorp.cl' },
    }));
    const f1 = mockBlob('rut_empresa.pdf');
    const f2 = mockBlob('escritura.pdf');
    form.append('documentos', f1.blob, f1.name);
    form.append('documentos', f2.blob, f2.name);
    const { status, data } = await request('POST', '/api/v1/kyb/apply', { token: state.userToken, formData: form });
    assert(status === 201, `Solicitud creada (201) — recibido: ${status}`);
    assert(data.kybStatus === 'pending', `kybStatus: pending — recibido: ${data.kybStatus}`);
    assert(!!data.businessId, `businessId recibido: ${data.businessId}`);
    if (data.businessId) state.businessId = data.businessId;
    logInfo('📧 Emails esperados: kybReceived (usuario) + adminKybAlert (admin)');
  },

  async function step3_getStatus() {
    logStep(3, 'GET /api/v1/kyb/status');
    const { status, data } = await request('GET', '/api/v1/kyb/status', { token: state.userToken });
    assert(status === 200, `Status obtenido (200) — recibido: ${status}`);
    assert(data.kybStatus === 'pending', `kybStatus: pending — recibido: ${data.kybStatus}`);
    assert(data.businessId === state.businessId, 'businessId coincide');
  },

  async function step4_loginAdmin() {
    logStep(4, 'Login admin');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(status === 200, `Login admin (200) — recibido: ${status}`);
    assert(!!data.token, 'Token admin recibido');
    if (data.token) state.adminToken = data.token;
    if (!data.user?.isAdmin) logWarn('El usuario no tiene flag isAdmin');
  },

  async function step5_listKYB() {
    logStep(5, 'GET /api/v1/admin/kyb?status=pending');
    const { status, data } = await request('GET', '/api/v1/admin/kyb?status=pending', { token: state.adminToken });
    assert(status === 200, `Lista obtenida (200) — recibido: ${status}`);
    assert(Array.isArray(data.applications), 'Campo applications es array');
    const found = data.applications?.some(a => a.businessId === state.businessId);
    assert(found, `businessId ${state.businessId} aparece en la lista`);
    logInfo(`Total pending: ${data.pagination?.total ?? '?'}`);
  },

  async function step6_moreInfo() {
    logStep(6, `PATCH /api/v1/admin/kyb/${state.businessId}/review → more_info`);
    const { status, data } = await request('PATCH', `/api/v1/admin/kyb/${state.businessId}/review`, {
      token: state.adminToken,
      body:  { status: 'more_info', note: 'Adjunta estado de cuenta bancario de los últimos 3 meses.' },
    });
    assert(status === 200, `Review actualizado (200) — recibido: ${status}`);
    assert(data.kybStatus === 'more_info', `kybStatus: more_info — recibido: ${data.kybStatus}`);
    logInfo('📧 Email esperado: kybMoreInfo (usuario)');
  },

  async function step7_uploadDocs() {
    logStep(7, 'POST /api/v1/kyb/documents (respuesta a more_info)');
    const { FormData } = globalThis;
    const form = new FormData();
    form.append('documentTypes', JSON.stringify(['bank_statement']));
    const f = mockBlob('estado_cuenta.pdf');
    form.append('documentos', f.blob, f.name);
    const { status, data } = await request('POST', '/api/v1/kyb/documents', { token: state.userToken, formData: form });
    assert(status === 200, `Documentos subidos (200) — recibido: ${status}`);
    assert(data.kybStatus === 'pending', `kybStatus vuelve a pending — recibido: ${data.kybStatus}`);
    assert(data.documentsAdded >= 1, `Documentos agregados: ${data.documentsAdded}`);
    logInfo('📧 Email esperado: adminKybAlert (admin)');
  },

  async function step8_approve() {
    logStep(8, `PATCH /api/v1/admin/kyb/${state.businessId}/review → approved`);
    const { status, data } = await request('PATCH', `/api/v1/admin/kyb/${state.businessId}/review`, {
      token: state.adminToken,
      body:  {
        status: 'approved',
        note: 'Expediente completo. Cuenta Business activada.',
        transactionLimits: { maxSingleTransaction: 10000, maxMonthlyVolume: 50000 },
      },
    });
    assert(status === 200, `KYB aprobado (200) — recibido: ${status}`);
    assert(data.kybStatus === 'approved', `kybStatus: approved — recibido: ${data.kybStatus}`);
    logInfo('📧 Email esperado: kybApproved (usuario)');
  },

  async function step9_verifyApproved() {
    logStep(9, 'GET /api/v1/kyb/status — verificar aprobación final');
    const { status, data } = await request('GET', '/api/v1/kyb/status', { token: state.userToken });
    assert(status === 200, `Status obtenido (200)`);
    assert(data.kybStatus === 'approved', `kybStatus: approved — recibido: ${data.kybStatus}`);
    assert(!!data.transactionLimits, 'transactionLimits expuestos post-aprobación');
    logInfo(`Límites: ${JSON.stringify(data.transactionLimits)}`);
  },

];

async function run() {
  console.log(`\n${colors.bold}╔══════════════════════════════════════╗`);
  console.log(`║   Alyto KYB — Test end-to-end        ║`);
  console.log(`╚══════════════════════════════════════╝${colors.reset}`);
  log(`\n  Entorno : ${ENV}`, 'cyan');
  log(`  Base URL: ${BASE_URL}`, 'cyan');
  log(`  Usuario : ${CREDS.user.email}`, 'cyan');
  log(`  Admin   : ${CREDS.admin.email}\n`, 'cyan');

  const stepsToRun = ONLY_STEP ? steps.filter((_, i) => i + 1 === ONLY_STEP) : steps;

  for (const step of stepsToRun) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  console.log(`\n${colors.bold}── Resumen ──────────────────────────────${colors.reset}`);
  log(`  ✅ Pasaron : ${passed}`, 'green');
  log(`  ❌ Fallaron: ${failed}`, failed > 0 ? 'red' : 'dim');
  log(`  businessId : ${state.businessId ?? 'no generado'}\n`, 'cyan');
  if (failed > 0) { log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow'); process.exit(1); }
  else            { log('  Flujo KYB completo sin errores. 🎉\n', 'green'); }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
