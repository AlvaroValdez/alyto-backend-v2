/**
 * test-sanctions.js — Smoke test end-to-end del sistema AML Sanciones (Fase 28)
 *
 * Flujo:
 *   1. Login admin
 *   2. GET  /api/v1/admin/sanctions             → lista inicial (puede estar vacía)
 *   3. POST /api/v1/admin/sanctions             → agregar entrada de prueba
 *   4. POST /api/v1/admin/sanctions/screen      → hit por nombre
 *   5. POST /api/v1/admin/sanctions/screen      → hit por documento
 *   6. POST /api/v1/admin/sanctions/screen      → usuario limpio (sin coincidencias)
 *   7. DELETE /api/v1/admin/sanctions/:entryId  → desactivar (baja lógica)
 *   8. POST /api/v1/admin/sanctions/screen      → verificar que ya no bloquea
 *
 * Uso:
 *   node test-sanctions.js
 *   node test-sanctions.js --env production
 *
 * Variables requeridas en .env:
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
  adminToken: null,
  entryId:    null,
};

// ── Pasos ─────────────────────────────────────────────────────────────────────

const steps = [

  async function step1_loginAdmin() {
    logStep(1, 'Login admin');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(status === 200, `Login exitoso (200) — recibido: ${status}`);
    assert(!!data.token,   'Token recibido');
    if (data.token) state.adminToken = data.token;
    if (data.user?.role !== 'admin') logWarn(`role recibido: "${data.user?.role}" — se espera "admin"`);
    else logOk('role: admin ✓');
  },

  async function step2_listaInicial() {
    logStep(2, 'GET /api/v1/admin/sanctions — lista inicial');
    const { status, data } = await request('GET', '/api/v1/admin/sanctions', {
      token: state.adminToken,
    });
    assert(status === 200,               `Status 200 — recibido: ${status}`);
    assert(Array.isArray(data.entries),  'Campo entries es array');
    assert(!!data.pagination,            'Campo pagination presente');
    logInfo(`Entradas activas en lista: ${data.pagination?.total ?? data.entries?.length}`);
  },

  async function step3_agregarEntrada() {
    logStep(3, 'POST /api/v1/admin/sanctions — agregar entrada de prueba');
    const { status, data } = await request('POST', '/api/v1/admin/sanctions', {
      token: state.adminToken,
      body: {
        type:            'individual',
        fullName:        'Juan Carlos Bloqueado Test',
        firstName:       'Juan Carlos',
        lastName:        'Bloqueado Test',
        documentNumbers: ['99999999'],
        listSource:      'custom',
        reason:          'Entrada de prueba para smoke test',
        notes:           'Eliminar después del test',
      },
    });
    assert(status === 201,      `Status 201 — recibido: ${status}`);
    assert(!!data.entryId,      `entryId recibido: ${data.entryId}`);
    assert(!!data.fullName,     `fullName recibido: ${data.fullName}`);
    assert(data.listSource === 'custom', `listSource === 'custom' — recibido: ${data.listSource}`);
    if (data.entryId) {
      state.entryId = data.entryId;
      logInfo(`entryId: ${data.entryId}`);
    }
  },

  async function step4_screenHitPorNombre() {
    logStep(4, 'POST /api/v1/admin/sanctions/screen — hit por nombre');
    const { status, data } = await request('POST', '/api/v1/admin/sanctions/screen', {
      token: state.adminToken,
      body:  { firstName: 'Juan Carlos', lastName: 'Bloqueado Test' },
    });
    assert(status === 200,              `Status 200 — recibido: ${status}`);
    assert(data.isClean === false,      `isClean === false (hit detectado) — recibido: ${data.isClean}`);
    assert((data.hits?.length ?? 0) >= 1, `Al menos 1 hit — encontrados: ${data.hits?.length}`);
    assert(!!data.screenedAt,           `screenedAt presente: ${data.screenedAt}`);
    if (data.hits?.length) {
      logInfo(`Hit: ${data.hits[0].fullName} (${data.hits[0].listSource})`);
    }
  },

  async function step5_screenHitPorDocumento() {
    logStep(5, 'POST /api/v1/admin/sanctions/screen — hit por documento');
    const { status, data } = await request('POST', '/api/v1/admin/sanctions/screen', {
      token: state.adminToken,
      body:  { firstName: 'X', lastName: 'X', documentNumber: '99999999' },
    });
    assert(status === 200,         `Status 200 — recibido: ${status}`);
    assert(data.isClean === false, `isClean === false (hit por documento) — recibido: ${data.isClean}`);
    logInfo(`Hits por documento: ${data.hits?.length ?? 0}`);
  },

  async function step6_screenUsuarioLimpio() {
    logStep(6, 'POST /api/v1/admin/sanctions/screen — usuario limpio');
    const { status, data } = await request('POST', '/api/v1/admin/sanctions/screen', {
      token: state.adminToken,
      body:  { firstName: 'Maria', lastName: 'González López', documentNumber: '12345678' },
    });
    assert(status === 200,        `Status 200 — recibido: ${status}`);
    assert(data.isClean === true, `isClean === true (sin coincidencias) — recibido: ${data.isClean}`);
    assert(data.hits?.length === 0, `hits vacío — recibido: ${data.hits?.length}`);
    logInfo('Usuario limpio: ninguna coincidencia en la lista ✓');
  },

  async function step7_desactivarEntrada() {
    logStep(7, `DELETE /api/v1/admin/sanctions/${state.entryId} — baja lógica`);
    if (!state.entryId) {
      logFail('entryId no disponible — paso 3 falló. Saltando.');
      failed++;
      return;
    }
    const { status, data } = await request('DELETE', `/api/v1/admin/sanctions/${state.entryId}`, {
      token: state.adminToken,
    });
    assert(status === 200,          `Status 200 — recibido: ${status}`);
    assert(data.isActive === false, `isActive === false — recibido: ${data.isActive}`);
    assert(data.entryId === state.entryId, `entryId coincide: ${data.entryId}`);
    logInfo(`message: ${data.message}`);
  },

  async function step8_screenPostBaja() {
    logStep(8, 'POST /api/v1/admin/sanctions/screen — verificar que ya no bloquea (entrada inactiva)');
    if (!state.entryId) {
      logFail('entryId no disponible — saltando.');
      failed++;
      return;
    }
    const { status, data } = await request('POST', '/api/v1/admin/sanctions/screen', {
      token: state.adminToken,
      body:  { firstName: 'Juan Carlos', lastName: 'Bloqueado Test' },
    });
    assert(status === 200,        `Status 200 — recibido: ${status}`);
    assert(data.isClean === true, `isClean === true (entrada desactivada no genera hit) — recibido: ${data.isClean}`);
    logInfo('Baja lógica efectiva: la entrada inactiva no bloquea screening ✓');
  },

];

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${colors.bold}╔══════════════════════════════════════════╗`);
  console.log(`║   Alyto — AML Sanctions Smoke Test       ║`);
  console.log(`║   Fase 28 · ASFI Bolivia · AV Finance    ║`);
  console.log(`╚══════════════════════════════════════════╝${colors.reset}`);
  log(`\n  Entorno  : ${ENV}`, 'cyan');
  log(`  Base URL : ${BASE_URL}`, 'cyan');
  log(`  Admin    : ${CREDS.admin.email}\n`, 'cyan');

  for (const step of steps) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  // ── Resumen final ─────────────────────────────────────────────────────────
  console.log(`\n${colors.bold}── Resumen ──────────────────────────────────${colors.reset}`);
  log(`  ✅ Pasaron : ${passed}`, 'green');
  log(`  ❌ Fallaron: ${failed}`, failed > 0 ? 'red' : 'dim');
  log(`  entryId   : ${state.entryId ?? 'no generado'}`, 'cyan');

  console.log();
  if (failed > 0) {
    log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow');
    process.exit(1);
  } else {
    log('  AML sanctions smoke test completo sin errores. 🎉\n', 'green');
  }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
