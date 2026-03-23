/**
 * vitaSandboxTest.js — Verificación de integración real con el sandbox de Vita Wallet
 *
 * Uso: npm run vita:sandbox
 *
 * Este script NO es un test de Jest. Hace llamadas reales al sandbox de Vita
 * usando las credenciales de .env (VITA_API_URL debe apuntar al stage).
 *
 * Requisitos en .env:
 *   VITA_API_URL    → https://api.stage.vitawallet.io
 *   VITA_LOGIN      → xLogin del negocio
 *   VITA_TRANS_KEY  → xTransKey del negocio
 *   VITA_SECRET     → Secret para HMAC-SHA256
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  generateVitaSignature,
  getPrices,
  getPaymentMethods,
  getWithdrawalRules,
  createPayin,
  getPayinPrices,
} from '../src/services/vitaWalletService.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR  = path.join(__dirname, 'output');
const ENV_FILE    = path.join(__dirname, '..', '.env');
const BASE_URL    = `${process.env.VITA_API_URL ?? 'https://api.stage.vitawallet.io'}/api/businesses`;

// ─── Resultado acumulado para el resumen final ────────────────────────────────

const results = {
  auth:           null,
  paymentMethods: null,
  withdrawalRules: null,
  masterWallet:   null,
  createPayin:    null,
  getTransaction: null,
  payinPrices:    null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Llamada autenticada a cualquier endpoint de Vita usando HMAC-SHA256 */
async function vitaCall(method, path, body = null) {
  const xDate     = new Date().toISOString();
  const xLogin    = process.env.VITA_LOGIN;
  const xTransKey = process.env.VITA_TRANS_KEY;

  // Para GET /payment_methods/{CC}: el path param actúa como body implícito en la firma
  let signatureBody = body;
  const pmMatch = path.match(/^\/payment_methods\/([A-Z]{2})$/i);
  if (pmMatch) signatureBody = { country_iso_code: pmMatch[1].toUpperCase() };

  const signature = generateVitaSignature(xDate, signatureBody);

  const headers = {
    'Content-Type': 'application/json',
    'x-login':      xLogin,
    'x-trans-key':  xTransKey,
    'x-api-key':    xTransKey,
    'x-date':       xDate,
    'Authorization': `V2-HMAC-SHA256, Signature: ${signature}`,
  };

  const res  = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const rawMsg = data?.message ?? data?.error ?? data?.errors?.[0] ?? `HTTP ${res.status}`;
    const errMsg = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    const err    = new Error(errMsg);
    err.status   = res.status;
    err.data     = data;
    throw err;
  }

  return data;
}

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function sep()     { console.log(''); }

/** Guarda un archivo JSON en scripts/output/ */
function saveJson(filename, data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

/**
 * Actualiza VITA_MASTER_WALLET_UUID en .env si aún está vacío.
 * Solo modifica la línea exacta — no toca el resto del archivo.
 */
function patchEnvWalletUuid(uuid) {
  if (!fs.existsSync(ENV_FILE)) return false;
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  // Buscar la variable — si ya tiene valor, no tocar
  if (/^VITA_BUSINESS_WALLET_UUID=.+$/m.test(content)) return false;
  const updated = content.replace(
    /^VITA_BUSINESS_WALLET_UUID=.*$/m,
    `VITA_BUSINESS_WALLET_UUID=${uuid}`,
  );
  if (updated === content) return false;   // línea no encontrada
  fs.writeFileSync(ENV_FILE, updated, 'utf8');
  return true;
}

// ─── Verificación de variables de entorno ────────────────────────────────────

function checkEnv() {
  const required = ['VITA_API_URL', 'VITA_LOGIN', 'VITA_TRANS_KEY', 'VITA_SECRET'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('\n❌ Variables de entorno faltantes en .env:');
    missing.forEach(k => console.error(`   - ${k}`));
    console.error('\nConfigura estas variables y vuelve a ejecutar.\n');
    process.exit(1);
  }
}

// ─── PRUEBA 1: Autenticación y precios ───────────────────────────────────────

async function test1_auth() {
  console.log('━━━ PRUEBA 1: Autenticación y precios ━━━');
  const data = await getPrices();

  const attrs    = data?.withdrawal?.prices?.attributes ?? data?.prices?.attributes ?? {};
  const clpSell  = attrs?.clp_sell ?? {};
  // valid_until puede no estar presente en el sandbox — no es fatal
  const validUntil = data?.valid_until ?? data?.withdrawal?.valid_until ?? null;

  if (Object.keys(clpSell).length === 0) {
    throw new Error('Respuesta de /prices no contiene clp_sell');
  }

  ok('Autenticación HMAC-SHA256 OK');
  if (clpSell.co) ok(`Tasa CLP→CO: 1 CLP = ${clpSell.co} COP`);
  if (clpSell.pe) ok(`Tasa CLP→PE: 1 CLP = ${clpSell.pe} PEN`);
  if (clpSell.bo) ok(`Tasa CLP→BO: 1 CLP = ${clpSell.bo} BOB`);
  if (clpSell.ar) ok(`Tasa CLP→AR: 1 CLP = ${clpSell.ar} ARS`);
  if (validUntil && new Date(validUntil) > new Date()) {
    ok(`Precios válidos hasta: ${new Date(validUntil).toLocaleString('es-CL')}`);
  } else if (validUntil) {
    console.log(`  ℹ️  valid_until recibido pero ya expiró: ${validUntil}`);
  } else {
    console.log('  ℹ️  valid_until no presente en respuesta sandbox (normal en stage)');
  }

  results.auth = data;
  sep();
}

// ─── PRUEBA 2: Métodos de pago disponibles ────────────────────────────────────

async function test2_paymentMethods() {
  console.log('━━━ PRUEBA 2: Métodos de pago disponibles ━━━');

  const [dataCL, dataCO] = await Promise.all([
    getPaymentMethods('CL'),
    getPaymentMethods('CO'),
  ]);

  const methodNames = (arr) => {
    if (!Array.isArray(arr)) return JSON.stringify(arr);
    return arr.map(m => m?.name ?? m?.payment_method ?? m?.type ?? JSON.stringify(m)).join(', ');
  };

  const clNames = methodNames(dataCL);
  const coNames = methodNames(dataCO);

  ok(`Métodos CL: ${clNames || '(ninguno)'}`);
  ok(`Métodos CO: ${coNames || '(ninguno)'}`);

  const hasFintoc = clNames.toLowerCase().includes('fintoc') ||
                    JSON.stringify(dataCL).toLowerCase().includes('fintoc');
  hasFintoc ? ok('Fintoc disponible en CL ✓') : fail('Fintoc NO encontrado en CL');

  results.paymentMethods = { CL: dataCL, CO: dataCO };
  sep();
}

// ─── PRUEBA 3: Reglas de retiro por país ──────────────────────────────────────

async function test3_withdrawalRules() {
  console.log('━━━ PRUEBA 3: Reglas de retiro por país ━━━');

  const data = await getWithdrawalRules();

  // La respuesta puede ser un array de países o un objeto indexado por código
  const rules = Array.isArray(data) ? data : Object.values(data);

  const extractFields = (countryCode) => {
    const entry = rules.find(r =>
      (r?.country_iso_code ?? r?.country ?? r?.code ?? '').toUpperCase() === countryCode.toUpperCase()
    );
    if (!entry) return null;
    const fields = entry?.fields ?? entry?.required_fields ?? entry?.withdrawal_rules ?? [];
    if (Array.isArray(fields)) {
      return fields.map(f => f?.name ?? f?.key ?? f?.field ?? JSON.stringify(f));
    }
    return Object.keys(fields);
  };

  const fieldsCO = extractFields('CO');
  const fieldsPE = extractFields('PE');

  if (fieldsCO) {
    ok(`Campos requeridos CO: ${fieldsCO.join(', ')}`);
  } else {
    console.log('  ℹ️  CO no encontrado en withdrawal_rules (puede ser normal si no está soportado aún)');
  }

  if (fieldsPE) {
    ok(`Campos requeridos PE: ${fieldsPE.join(', ')}`);
  } else {
    console.log('  ℹ️  PE no encontrado en withdrawal_rules');
  }

  const savedPath = saveJson('withdrawalRules.json', data);
  ok(`Reglas guardadas en: ${path.relative(process.cwd(), savedPath)}`);

  results.withdrawalRules = data;
  sep();
}

// ─── PRUEBA 4: Master wallet ──────────────────────────────────────────────────

async function test4_masterWallet() {
  console.log('━━━ PRUEBA 4: Wallet master ━━━');

  const data   = await vitaCall('GET', '/wallets?page=1&count=10');
  const wallets = data?.wallets ?? data?.data ?? (Array.isArray(data) ? data : []);

  // La API anida los datos bajo wallet.attributes en el sandbox
  const isMaster = (w) =>
    w?.is_master === true || w?.is_master === 'true' ||
    w?.attributes?.is_master === true || w?.attributes?.is_master === 'true' ||
    w?.attributes?.token === 'master';

  const getUuid = (w) => w?.uuid ?? w?.attributes?.uuid ?? w?.id ?? null;
  const getBalances = (w) => w?.balances ?? w?.attributes?.balances ?? {};

  const master = wallets.find(isMaster);

  if (!master) {
    console.log('  ℹ️  No se encontró wallet con is_master: true');
    console.log('  ℹ️  Wallets disponibles:', wallets.length);
    if (wallets.length > 0) {
      const firstUuid = getUuid(wallets[0]);
      ok(`Primera wallet UUID: ${firstUuid ?? '(sin UUID)'}`);
      console.log('  Balances:', JSON.stringify(getBalances(wallets[0]), null, 4));
      // Guardar en .env si hay una wallet y UUID está vacío
      if (firstUuid && patchEnvWalletUuid(firstUuid)) {
        ok(`VITA_BUSINESS_WALLET_UUID guardado en .env (primera wallet) ✍️`);
      }
    }
  } else {
    const uuid = getUuid(master);
    ok(`Master wallet UUID: ${uuid}`);
    ok(`Balances: ${JSON.stringify(getBalances(master))}`);

    // Guardar en .env si aún está vacío
    if (uuid && patchEnvWalletUuid(uuid)) {
      ok(`VITA_BUSINESS_WALLET_UUID guardado en .env ✍️`);
    } else {
      console.log('  ℹ️  VITA_BUSINESS_WALLET_UUID ya estaba configurado en .env');
    }
  }

  results.masterWallet = data;
  sep();
}

// ─── PRUEBA 5: Crear payin de prueba ─────────────────────────────────────────

async function test5_createPayin() {
  console.log('━━━ PRUEBA 5: Crear payin de prueba ━━━');

  const payload = {
    amount:              10000,
    country_iso_code:    'CL',
    issue:               'Alyto sandbox test - puedes ignorar',
    success_redirect_url: 'https://alyto.io/success',
  };

  const data = await createPayin(payload);

  const id     = data?.id ?? data?.payment_order?.id ?? data?.data?.id;
  const url    = data?.url ?? data?.payment_order?.url ?? data?.payment_url ?? data?.data?.url;
  const status = data?.status ?? data?.payment_order?.status ?? data?.data?.status ?? '(sin status)';

  ok(`Payin creado: ${id}`);
  ok(`URL de pago: ${url ?? '(no disponible en sandbox)'}`);
  ok(`Status inicial: ${status}`);

  results.createPayin = { id, url, status, raw: data };
  sep();
  return id;
}

// ─── PRUEBA 6: Consultar transacción creada ───────────────────────────────────

async function test6_getTransaction(payinId) {
  console.log('━━━ PRUEBA 6: Consultar transacciones recientes ━━━');

  // ℹ️  Nota: el ID de payment_order (payin) NO es un ID de /transactions.
  //    Una transacción se crea en Vita solo cuando el pago es completado.
  //    En sandbox sin pago real, consultamos el listado general de transacciones.
  console.log(`  ℹ️  Payment order ${payinId} creada — la transacción asociada`);
  console.log('  ℹ️  solo existe en Vita tras el pago efectivo del cliente.');

  const data = await vitaCall('GET', '/transactions?page=1&count=5');

  // La respuesta puede ser: { transactions: [...] } o array directo
  const txList = data?.transactions ?? data?.data ?? (Array.isArray(data) ? data : []);

  ok(`Endpoint /transactions responde correctamente`);
  ok(`Transacciones encontradas: ${txList.length}`);

  if (txList.length > 0) {
    const latest = txList[0];
    const latestId     = latest?.id ?? latest?.attributes?.id ?? '?';
    const latestStatus = latest?.status ?? latest?.attributes?.status ?? '?';
    const latestType   = latest?.transactions_type ?? latest?.attributes?.transactions_type ?? '?';
    ok(`Última transacción: id=${latestId} status=${latestStatus} type=${latestType}`);
  }

  results.getTransaction = data;
  sep();
}

// ─── PRUEBA 7: Precios de payin ───────────────────────────────────────────────

async function test7_payinPrices() {
  console.log('━━━ PRUEBA 7: Precios de payin ━━━');

  const data = await getPayinPrices();

  ok('Precios de payin obtenidos');

  // payins_prices responde con estructura por país: { cl: { source_currency, destinations: { clp: [...], co: [...] } } }
  // Cada destino es un array de métodos con sell_price y fixed_cost

  const clData = data?.cl ?? data?.CL ?? null;
  if (clData) {
    ok(`País CL source_currency: ${clData.source_currency ?? '?'}`);
    const destKeys = Object.keys(clData.destinations ?? {});
    ok(`Destinos disponibles desde CL: ${destKeys.join(', ') || '(ninguno)'}`);

    // Mostrar ejemplo CLP→CO vía Fintoc si existe
    const coDestinations = clData.destinations?.co ?? [];
    const fintocEntry = Array.isArray(coDestinations)
      ? coDestinations.find(d => d.payment_method?.toLowerCase().includes('fintoc'))
      : null;
    const exampleEntry = fintocEntry ?? (Array.isArray(coDestinations) ? coDestinations[0] : null);

    if (exampleEntry) {
      const sellPrice = parseFloat(exampleEntry.sell_price ?? 0);
      const fixedCost = parseFloat(exampleEntry.fixed_cost ?? 0);
      const originAmount = 100_000;
      const finalAmount = Math.round((originAmount * sellPrice) - fixedCost);
      console.log('');
      console.log(`  Fórmula: finalAmount = (amount × sell_price) − fixed_cost`);
      console.log(`  Ejemplo 100.000 CLP → CO (${exampleEntry.payment_method ?? 'método'}):`);
      console.log(`    = (100.000 × ${sellPrice}) − ${fixedCost}`);
      console.log(`    = ${finalAmount.toLocaleString('es-CL')} COP`);
    } else if (destKeys.length > 0) {
      console.log('  ℹ️  No hay rutas CO disponibles desde CL en sandbox');
    }
  } else {
    console.log('  ℹ️  No se encontró entrada CL en payins_prices');
    console.log('  Claves en respuesta:', Object.keys(data ?? {}).slice(0, 10).join(', '));
  }

  results.payinPrices = data;
  sep();
}

// ─── RESUMEN FINAL ────────────────────────────────────────────────────────────

function printSummary(errors) {
  const icon = (key) => errors[key] ? '❌' : '✅';
  const allOk = Object.values(errors).every(e => !e);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Vita Sandbox — Resultados               ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Autenticación HMAC-SHA256    ${icon('auth')}         ║`);
  console.log(`║  Precios en tiempo real       ${icon('auth')}         ║`);
  console.log(`║  Métodos de pago por país     ${icon('paymentMethods')}         ║`);
  console.log(`║  Reglas de retiro             ${icon('withdrawalRules')}         ║`);
  console.log(`║  Master wallet encontrada     ${icon('masterWallet')}         ║`);
  console.log(`║  Crear payin                  ${icon('createPayin')}         ║`);
  console.log(`║  Consultar transacción        ${icon('getTransaction')}         ║`);
  console.log(`║  Precios payin                ${icon('payinPrices')}         ║`);
  console.log('╠══════════════════════════════════════════╣');
  if (allOk) {
    console.log('║  Estado: ✅ LISTO PARA PRUEBA MANUAL      ║');
  } else {
    console.log('║  Estado: ❌ REVISAR ERRORES ARRIBA         ║');
  }
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

// ─── Runner principal ─────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('🔬 Alyto — Vita Sandbox Integration Test');
  console.log(`   API: ${process.env.VITA_API_URL}`);
  console.log(`   Login: ${process.env.VITA_LOGIN}`);
  console.log('');

  checkEnv();

  // Deshabilitar el log de firma HMAC para que la salida sea legible
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  const errors = {
    auth:            false,
    paymentMethods:  false,
    withdrawalRules: false,
    masterWallet:    false,
    createPayin:     false,
    getTransaction:  false,
    payinPrices:     false,
  };

  let payinId = null;

  const run1 = async () => { await test1_auth();            };
  const run2 = async () => { await test2_paymentMethods();  };
  const run3 = async () => { await test3_withdrawalRules(); };
  const run4 = async () => { await test4_masterWallet();    };
  const run5 = async () => { payinId = await test5_createPayin(); };
  const run6 = async () => { await test6_getTransaction(payinId); };
  const run7 = async () => { await test7_payinPrices();     };

  const tests = [
    ['auth',            run1],
    ['paymentMethods',  run2],
    ['withdrawalRules', run3],
    ['masterWallet',    run4],
    ['createPayin',     run5],
    ['getTransaction',  run6],
    ['payinPrices',     run7],
  ];

  for (const [key, fn] of tests) {
    try {
      await fn();
    } catch (err) {
      errors[key] = true;
      fail(`Prueba falló: ${err.message}`);
      if (err.data) console.error('  Respuesta Vita:', JSON.stringify(err.data, null, 2));
      sep();
      // Continuar con las siguientes pruebas (no detener el runner)
    }
  }

  process.env.NODE_ENV = originalEnv;
  printSummary(errors);
}

run().catch(err => {
  console.error('\n[vitaSandboxTest] Error fatal:', err.message);
  process.exit(1);
});
