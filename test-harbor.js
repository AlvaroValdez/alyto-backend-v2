/**
 * test-harbor.js — Smoke test para Harbor API (OwlPay sandbox)
 *
 * Verifica que:
 *   1. La autenticación con X-API-KEY funciona (GET /customers → 200, no 401)
 *   2. Se puede crear un customer de prueba (POST /customers → 201 o 409)
 *
 * Uso:
 *   node test-harbor.js
 *
 * Variables requeridas en .env:
 *   OWLPAY_API_KEY     — API key del portal Harbor
 *   OWLPAY_BASE_URL    — https://harbor-sandbox.owlpay.com/api/v1 (default)
 */

import 'dotenv/config';

const HARBOR_BASE =
  process.env.OWLPAY_BASE_URL ??
  process.env.OWLPAY_API_URL  ??
  'https://harbor-sandbox.owlpay.com/api/v1';

const API_KEY = process.env.OWLPAY_API_KEY || '';

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

async function harborRequest(method, path, body) {
  const url = `${HARBOR_BASE}${path}`;
  const headers = {
    'X-API-KEY':    API_KEY,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    logFail(`Error de red: ${err.message}`);
    return { status: 0, data: {} };
  }

  const data = await res.json().catch(() => ({}));
  logInfo(`${method} ${url} → ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  return { status: res.status, data };
}

async function run() {
  console.log(`\n${colors.bold}${colors.cyan}╔══════════════════════════════════════╗`);
  console.log(`║   Harbor API — Smoke Test            ║`);
  console.log(`╚══════════════════════════════════════╝${colors.reset}`);

  log(`\nBase URL: ${HARBOR_BASE}`, 'dim');
  log(`API Key:  ${API_KEY ? API_KEY.slice(0, 20) + '...' : '⚠️  NO CONFIGURADA'}`, 'dim');

  if (!API_KEY) {
    logFail('OWLPAY_API_KEY no configurada en .env — abortando.');
    process.exit(1);
  }

  // ── Paso 1: Verificar autenticación ────────────────────────────────────────
  logStep(1, 'Autenticación Harbor (GET /customers)');

  const { status: s1, data: d1 } = await harborRequest('GET', '/customers');

  const authOk = assert(s1 === 200, `Autenticación correcta (status ${s1})`);
  assert(s1 !== 401, 'API key aceptada por Harbor (no 401 Unauthorized)');

  if (!authOk) {
    logWarn('Autenticación fallida — omitiendo Paso 2.');
    logWarn('Verificar OWLPAY_API_KEY en .env y que sea una key sandbox válida.');
    printSummary();
    return;
  }

  // ── Paso 2: Crear customer de prueba ───────────────────────────────────────
  logStep(2, 'Crear customer de prueba (POST /customers)');

  const { status: s2, data: d2 } = await harborRequest('POST', '/customers', {
    type:                        'individual',
    first_name:                  'Test',
    last_name:                   'Alyto',
    email:                       'test@alyto.app',
    application_customer_uuid:   'test-alyto-harbor-001',
  });

  assert(
    s2 === 201 || s2 === 409,
    `Customer creado o ya existe (status ${s2}) — ${
      s2 === 201 ? 'creado nuevo' : s2 === 409 ? 'ya existía (OK)' : 'inesperado'
    }`,
  );

  if (s2 === 201) {
    logInfo(`customer_uuid: ${d2.uuid ?? d2.id ?? '—'}`);
  }

  printSummary();
}

function printSummary() {
  const total = passed + failed;
  console.log(`\n${colors.bold}──────────────────────────────────────${colors.reset}`);
  if (failed === 0) {
    log(`✅  ${passed}/${total} assertions pasaron.`, 'green');
  } else {
    log(`❌  ${failed}/${total} assertions fallaron.`, 'red');
  }
  console.log();
}

run().catch(err => {
  logFail(`Error inesperado: ${err.message}`);
  process.exit(1);
});
