/**
 * test-reclamos.js — Smoke test end-to-end del sistema PRILI (Fase 27)
 *
 * Flujo:
 *   1. Login usuario SpA
 *   2. POST /api/v1/reclamos              → presenta reclamo
 *   3. GET  /api/v1/reclamos              → verifica que aparece en lista
 *   4. GET  /api/v1/reclamos/:reclamoId   → verifica detalle
 *   5. Login admin
 *   6. GET  /api/v1/admin/reclamos        → admin ve la lista
 *   7. GET  /api/v1/admin/reclamos/vencimientos
 *   8. PATCH /api/v1/admin/reclamos/:reclamoId → pone en_revision
 *   9. PATCH /api/v1/admin/reclamos/:reclamoId → resuelve con respuesta
 *  10. GET  /api/v1/reclamos/:reclamoId   → usuario verifica respuesta visible
 *
 * Uso:
 *   node test-reclamos.js
 *   node test-reclamos.js --env production
 *
 * Variables requeridas en .env:
 *   TEST_USER_EMAIL, TEST_USER_PASSWORD
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
  user: {
    email:    process.env.TEST_USER_EMAIL    ?? 'test@alyto.app',
    password: process.env.TEST_USER_PASSWORD ?? 'Test1234!',
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
  userToken:  null,
  adminToken: null,
  reclamoId:  null,
  plazoVence: null,
};

// ── Pasos ─────────────────────────────────────────────────────────────────────

const steps = [

  async function step1_loginUser() {
    logStep(1, 'Login usuario SpA');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.user.email, password: CREDS.user.password },
    });
    assert(status === 200,   `Login exitoso (200) — recibido: ${status}`);
    assert(!!data.token,     'Token recibido');
    if (data.token) state.userToken = data.token;
    logInfo(`legalEntity: ${data.user?.legalEntity ?? '(no disponible)'}`);
  },

  async function step2_crearReclamo() {
    logStep(2, 'POST /api/v1/reclamos — presentar reclamo PRILI');
    const { status, data } = await request('POST', '/api/v1/reclamos', {
      token: state.userToken,
      body: {
        tipo:           'demora',
        descripcion:    'Mi transferencia lleva más de 48 horas sin confirmar y el monto ya fue debitado de mi cuenta bancaria.',
        montoReclamado: 150000,
        currency:       'CLP',
      },
    });
    assert(status === 201,       `Status 201 — recibido: ${status}`);
    assert(!!data.reclamoId,     `reclamoId recibido: ${data.reclamoId}`);
    assert(!!data.plazoVence,    `plazoVence recibido: ${data.plazoVence}`);
    assert(!!data.message,       'message de confirmación recibido');
    if (data.reclamoId) {
      state.reclamoId  = data.reclamoId;
      state.plazoVence = data.plazoVence;
      logInfo(`reclamoId: ${data.reclamoId}`);
      logInfo(`plazoVence (10 días hábiles): ${new Date(data.plazoVence).toLocaleDateString('es-BO')}`);
      logInfo(`message: ${data.message}`);
    }
  },

  async function step3_listarReclamos() {
    logStep(3, 'GET /api/v1/reclamos — verificar que aparece en lista');
    const { status, data } = await request('GET', '/api/v1/reclamos', {
      token: state.userToken,
    });
    assert(status === 200,                          `Status 200 — recibido: ${status}`);
    assert(Array.isArray(data.reclamos),            'Campo reclamos es array');
    assert((data.reclamos?.length ?? 0) >= 1,       `Al menos 1 reclamo en lista — encontrados: ${data.reclamos?.length}`);
    const encontrado = data.reclamos?.some(r => r.reclamoId === state.reclamoId);
    assert(encontrado,                              `Reclamo ${state.reclamoId} aparece en la lista`);
    logInfo(`Total reclamos del usuario: ${data.pagination?.total ?? data.reclamos?.length}`);
  },

  async function step4_detalleReclamo() {
    logStep(4, `GET /api/v1/reclamos/${state.reclamoId} — detalle usuario`);
    if (!state.reclamoId) {
      logFail('reclamoId no disponible — paso 2 falló. Saltando.');
      failed++;
      return;
    }
    const { status, data } = await request('GET', `/api/v1/reclamos/${state.reclamoId}`, {
      token: state.userToken,
    });
    assert(status === 200,           `Status 200 — recibido: ${status}`);
    assert(data.tipo === 'demora',   `tipo === 'demora' — recibido: ${data.tipo}`);
    assert(data.status === 'recibido', `status === 'recibido' — recibido: ${data.status}`);
    assert(!!data.plazoVence,        `plazoVence presente: ${data.plazoVence}`);
    logInfo(`descripcion: ${data.descripcion?.slice(0, 60)}...`);
  },

  async function step5_loginAdmin() {
    logStep(5, 'Login admin');
    const { status, data } = await request('POST', '/api/v1/auth/login', {
      body: { email: CREDS.admin.email, password: CREDS.admin.password },
    });
    assert(status === 200,   `Login admin (200) — recibido: ${status}`);
    assert(!!data.token,     'Token admin recibido');
    if (data.token) state.adminToken = data.token;
    if (data.user?.role !== 'admin') logWarn(`role recibido: "${data.user?.role}" — se espera "admin"`);
    else logOk('role: admin ✓');
  },

  async function step6_adminListarReclamos() {
    logStep(6, 'GET /api/v1/admin/reclamos — admin lista todos los reclamos');
    const { status, data } = await request('GET', '/api/v1/admin/reclamos', {
      token: state.adminToken,
    });
    assert(status === 200,                    `Status 200 — recibido: ${status}`);
    assert(Array.isArray(data.reclamos),      'Campo reclamos es array');
    assert((data.reclamos?.length ?? 0) >= 1, `Al menos 1 reclamo — encontrados: ${data.reclamos?.length}`);
    const encontrado = data.reclamos?.some(r => r.reclamoId === state.reclamoId);
    assert(encontrado,                        `Reclamo ${state.reclamoId} visible para admin`);
    const urgentes = data.reclamos?.filter(r => r.urgente).length ?? 0;
    logInfo(`Reclamos urgentes (<=2 días): ${urgentes}`);
  },

  async function step7_adminVencimientos() {
    logStep(7, 'GET /api/v1/admin/reclamos/vencimientos');
    const { status, data } = await request('GET', '/api/v1/admin/reclamos/vencimientos', {
      token: state.adminToken,
    });
    assert(status === 200,                        `Status 200 — recibido: ${status}`);
    assert(Array.isArray(data.vencimientos),      'Campo vencimientos es array');
    logInfo(`Reclamos próximos a vencer (3 días): ${data.total ?? data.vencimientos?.length}`);
  },

  async function step8_adminEnRevision() {
    logStep(8, `PATCH /api/v1/admin/reclamos/${state.reclamoId} — poner en_revision`);
    if (!state.reclamoId) {
      logFail('reclamoId no disponible — saltando.');
      failed++;
      return;
    }
    const { status, data } = await request('PATCH', `/api/v1/admin/reclamos/${state.reclamoId}`, {
      token: state.adminToken,
      body:  {
        status:       'en_revision',
        internalNote: 'Revisando con el equipo de operaciones.',
      },
    });
    assert(status === 200,                  `Status 200 — recibido: ${status}`);
    assert(data.status === 'en_revision',   `status === 'en_revision' — recibido: ${data.status}`);
    logInfo(`reclamoId: ${data.reclamoId}`);
  },

  async function step9_adminResolver() {
    logStep(9, `PATCH /api/v1/admin/reclamos/${state.reclamoId} — resolver con respuesta`);
    if (!state.reclamoId) {
      logFail('reclamoId no disponible — saltando.');
      failed++;
      return;
    }
    const { status, data } = await request('PATCH', `/api/v1/admin/reclamos/${state.reclamoId}`, {
      token: state.adminToken,
      body:  {
        status:     'resuelto',
        respuesta:  'Hemos verificado tu transferencia. El retraso fue causado por una validación adicional de seguridad. El monto fue procesado exitosamente. Disculpa las molestias.',
        satisfecho: true,
      },
    });
    assert(status === 200,             `Status 200 — recibido: ${status}`);
    assert(data.status === 'resuelto', `status === 'resuelto' — recibido: ${data.status}`);
    assert(!!data.respondidoAt,        `respondidoAt presente: ${data.respondidoAt}`);
    logInfo(`respondidoAt: ${data.respondidoAt}`);
  },

  async function step10_usuarioVerificaRespuesta() {
    logStep(10, `GET /api/v1/reclamos/${state.reclamoId} — usuario verifica respuesta`);
    if (!state.reclamoId) {
      logFail('reclamoId no disponible — saltando.');
      failed++;
      return;
    }
    const { status, data } = await request('GET', `/api/v1/reclamos/${state.reclamoId}`, {
      token: state.userToken,
    });
    assert(status === 200,             `Status 200 — recibido: ${status}`);
    assert(data.status === 'resuelto', `status === 'resuelto' — recibido: ${data.status}`);
    assert(!!data.respuesta,           `respuesta visible al usuario: ${data.respuesta?.slice(0, 60)}...`);
    assert(!!data.respondidoAt,        `respondidoAt presente`);
    logInfo(`Ciclo PRILI completo: recibido → en_revision → resuelto ✓`);
  },

];

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${colors.bold}╔══════════════════════════════════════════╗`);
  console.log(`║   Alyto — PRILI Reclamos Smoke Test      ║`);
  console.log(`║   Fase 27 · ASFI Bolivia · AV Finance    ║`);
  console.log(`╚══════════════════════════════════════════╝${colors.reset}`);
  log(`\n  Entorno  : ${ENV}`, 'cyan');
  log(`  Base URL : ${BASE_URL}`, 'cyan');
  log(`  Usuario  : ${CREDS.user.email}`, 'cyan');
  log(`  Admin    : ${CREDS.admin.email}\n`, 'cyan');

  for (const step of steps) {
    try { await step(); }
    catch (err) { logFail(`Error inesperado en ${step.name}: ${err.message}`); failed++; }
  }

  // ── Resumen final ─────────────────────────────────────────────────────────
  console.log(`\n${colors.bold}── Resumen ──────────────────────────────────${colors.reset}`);
  log(`  ✅ Pasaron : ${passed}`, 'green');
  log(`  ❌ Fallaron: ${failed}`, failed > 0 ? 'red' : 'dim');
  log(`  reclamoId  : ${state.reclamoId  ?? 'no generado'}`, 'cyan');
  log(`  plazoVence : ${state.plazoVence ? new Date(state.plazoVence).toLocaleDateString('es-BO') : 'no disponible'}`, 'cyan');

  console.log();
  if (failed > 0) {
    log('  Algunos pasos fallaron. Revisa los logs arriba.\n', 'yellow');
    process.exit(1);
  } else {
    log('  PRILI smoke test completo sin errores. 🎉\n', 'green');
  }
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
