/**
 * test-sep-e2e.mjs — Suite e2e de validación SEP contra el anchor Alyto en VIVO.
 *
 * Simula exactamente lo que hace una wallet externa (Lobstr / Vibrant) o un
 * reviewer de SCF: descubre el anchor vía stellar.toml, se autentica con SEP-10
 * usando un keypair efímero (NO custodial), y ejercita SEP-12/24/31.
 *
 * Uso:
 *   node scripts/test-sep-e2e.mjs                 # prod (alyto.app / api.alyto.app)
 *   ANCHOR_BASE=https://api-staging.alyto.app \
 *   TOML_URL=https://staging.alyto.app/.well-known/stellar.toml \
 *     node scripts/test-sep-e2e.mjs              # staging
 *
 * No escribe nada en la base: SEP-24 deposit y SEP-31 create se prueban con un
 * keypair externo, por lo que el anchor responde 400 "requiere cuenta Alyto
 * vinculada" DESPUÉS de validar toda la cadena (corredor, monto, quote). Ese 400
 * es el resultado ESPERADO para una wallet externa y cuenta como PASS.
 */

import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

const TOML_URL    = process.env.TOML_URL    ?? 'https://alyto.app/.well-known/stellar.toml';
const ANCHOR_BASE = process.env.ANCHOR_BASE ?? 'https://api.alyto.app/api/v1/stellar';
const TIMEOUT_MS  = Number(process.env.SEP_TEST_TIMEOUT_MS ?? 20000);

// ─── helpers de presentación ─────────────────────────────────────────────────
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const results = [];
function record(sep, name, ok, detail) {
  results.push({ sep, name, ok });
  const tag = ok ? `${C.g}✓ PASS${C.x}` : `${C.r}✗ FAIL${C.x}`;
  console.log(`  ${tag}  ${C.b}${name}${C.x}${detail ? `  ${C.dim}${detail}${C.x}` : ''}`);
}

async function http(method, url, { token, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body  ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// ─── SEP-1: stellar.toml ──────────────────────────────────────────────────────
async function testSep1() {
  console.log(`\n${C.b}SEP-1 — stellar.toml (descubrimiento del anchor)${C.x}`);
  const res = await fetch(TOML_URL, { headers: { Accept: 'text/plain' } });
  const toml = await res.text();
  record('SEP-1', 'GET .well-known/stellar.toml responde 200', res.status === 200, `HTTP ${res.status}`);

  const required = [
    'VERSION', 'NETWORK_PASSPHRASE', 'WEB_AUTH_ENDPOINT', 'SIGNING_KEY',
    'TRANSFER_SERVER_SEP0024', 'DIRECT_PAYMENT_SERVER', 'KYC_SERVER',
  ];
  const missing = required.filter(k => !new RegExp(`^\\s*${k}\\s*=`, 'm').test(toml));
  record('SEP-1', 'Campos SEP requeridos presentes', missing.length === 0,
    missing.length ? `faltan: ${missing.join(', ')}` : required.length + ' campos OK');

  const isMainnet = /Public Global Stellar Network/.test(toml);
  record('SEP-1', 'NETWORK_PASSPHRASE = mainnet', isMainnet, isMainnet ? 'Public Global' : 'NO es mainnet');

  // CORS: el toml DEBE ser accesible cross-origin desde el navegador de una wallet
  // externa (demo-wallet, Lobstr, reviewer SCF). Sin `Access-Control-Allow-Origin`,
  // el browser bloquea el fetch y reporta "TOML not found" → anchor inutilizable.
  // (curl sin Origin no lo detecta; por eso enviamos Origin explícito.)
  const corsRes = await fetch(TOML_URL, { headers: { Origin: 'https://demo-wallet.stellar.org' } });
  const acao = corsRes.headers.get('access-control-allow-origin');
  const corsOk = corsRes.status === 200 && (acao === '*' || acao === 'https://demo-wallet.stellar.org');
  record('SEP-1', 'toml CORS-abierto para wallets externas', corsOk,
    corsOk ? `ACAO=${acao}` : `HTTP ${corsRes.status} ACAO=${acao ?? '(ausente)'}`);

  // CORS dual: la app propia (alyto.app) manda `credentials: include` (cookie). El
  // anchor DEBE reflejar el Origin exacto + Allow-Credentials para ese origen, o el
  // navegador bloquea con "Failed to fetch" (wildcard + credentials está prohibido).
  // Preflight OPTIONS sobre un endpoint del anchor con el Origin de la app.
  const appOrigin = process.env.APP_ORIGIN ?? new URL(TOML_URL).origin;
  const pf = await fetch(`${ANCHOR_BASE}/anchor/transactions/deposit`, {
    method: 'OPTIONS',
    headers: {
      Origin: appOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  const pfAcao = pf.headers.get('access-control-allow-origin');
  const pfCreds = pf.headers.get('access-control-allow-credentials');
  const pfOk = pfAcao === appOrigin && pfCreds === 'true';
  record('SEP-1', 'anchor refleja Origin de la app + credentials (in-app)', pfOk,
    pfOk ? `ACAO=${pfAcao} creds=${pfCreds}` : `ACAO=${pfAcao ?? '(ausente)'} creds=${pfCreds ?? '(ausente)'} (app="${appOrigin}")`);

  // extrae el WEB_AUTH_ENDPOINT real declarado (para coherencia con ANCHOR_BASE)
  const wae = toml.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/)?.[1];
  const signingKey = toml.match(/SIGNING_KEY\s*=\s*"([^"]+)"/)?.[1];
  console.log(`  ${C.dim}WEB_AUTH_ENDPOINT = ${wae}${C.x}`);
  console.log(`  ${C.dim}SIGNING_KEY       = ${signingKey}${C.x}`);
  return { signingKey };
}

// ─── SEP-10: Web Authentication ───────────────────────────────────────────────
async function testSep10() {
  console.log(`\n${C.b}SEP-10 — Web Authentication (keypair efímero, como wallet externa)${C.x}`);
  const kp = Keypair.random();
  console.log(`  ${C.dim}cuenta de prueba: ${kp.publicKey()}${C.x}`);

  // 1) challenge
  const ch = await http('GET', `${ANCHOR_BASE}/auth?account=${kp.publicKey()}`);
  const gotChallenge = ch.status === 200 && !!ch.json?.transaction;
  record('SEP-10', 'GET /auth devuelve challenge XDR', gotChallenge, `HTTP ${ch.status}`);
  if (!gotChallenge) { console.log(`  ${C.r}${ch.text?.slice(0,200)}${C.x}`); return null; }

  const passphrase = ch.json.network_passphrase || Networks.PUBLIC;

  // 2) firmar el challenge con la keypair del cliente
  let signedXdr;
  try {
    const tx = new Transaction(ch.json.transaction, passphrase);
    tx.sign(kp);
    signedXdr = tx.toEnvelope().toXDR('base64');
    record('SEP-10', 'Cliente firma el challenge', true);
  } catch (e) {
    record('SEP-10', 'Cliente firma el challenge', false, e.message);
    return null;
  }

  // 3) verify → JWT
  const vf = await http('POST', `${ANCHOR_BASE}/auth`, { body: { transaction: signedXdr } });
  const gotToken = vf.status === 200 && !!vf.json?.token;
  record('SEP-10', 'POST /auth verifica firma y emite JWT', gotToken, `HTTP ${vf.status}`);
  if (!gotToken) { console.log(`  ${C.r}${vf.text?.slice(0,200)}${C.x}`); return null; }

  // 4) negativo: challenge sin firmar debe ser rechazado
  const neg = await http('POST', `${ANCHOR_BASE}/auth`, { body: { transaction: ch.json.transaction } });
  record('SEP-10', 'Rechaza challenge SIN firmar (negativo)', neg.status === 400, `HTTP ${neg.status}`);

  return { token: vf.json.token, account: kp.publicKey() };
}

// ─── SEP-12: KYC API ──────────────────────────────────────────────────────────
async function testSep12(auth) {
  console.log(`\n${C.b}SEP-12 — KYC API${C.x}`);
  if (!auth) { record('SEP-12', 'GET /customer', false, 'sin token SEP-10'); return; }

  const noTok = await http('GET', `${ANCHOR_BASE}/customer?account=${auth.account}`);
  record('SEP-12', 'GET /customer SIN token → 401 (negativo)', noTok.status === 401, `HTTP ${noTok.status}`);

  const r = await http('GET', `${ANCHOR_BASE}/customer?account=${auth.account}`, { token: auth.token });
  const ok = r.status === 200 && typeof r.json?.status === 'string';
  record('SEP-12', 'GET /customer devuelve estado KYC', ok, ok ? `status="${r.json.status}"` : `HTTP ${r.status}`);
}

// ─── SEP-24: Interactive Anchor ───────────────────────────────────────────────
async function testSep24(auth) {
  console.log(`\n${C.b}SEP-24 — Interactive Anchor (deposit/withdraw)${C.x}`);

  const info = await http('GET', `${ANCHOR_BASE}/anchor/info`);
  const infoOk = info.status === 200 && info.json?.deposit?.USDC?.enabled === true;
  record('SEP-24', 'GET /anchor/info expone USDC deposit+withdraw', infoOk, `HTTP ${info.status}`);

  const fee = await http('GET', `${ANCHOR_BASE}/anchor/fee?asset_code=USDC&operation=withdraw&amount=100`);
  const feeOk = fee.status === 200 && fee.json?.fee === '6.50';
  record('SEP-24', 'GET /anchor/fee calcula 6.5% withdraw', feeOk, feeOk ? 'fee=6.50 sobre 100' : `HTTP ${fee.status} fee=${fee.json?.fee}`);

  if (!auth) { record('SEP-24', 'POST deposit', false, 'sin token'); return; }
  // Wallet externa (sin cuenta Alyto vinculada): el anchor valida auth y rechaza
  // con 400 "requiere cuenta vinculada". Ese es el comportamiento correcto.
  const dep = await http('POST', `${ANCHOR_BASE}/anchor/transactions/deposit`,
    { token: auth.token, body: { asset_code: 'USDC', amount: '50' } });
  const depOk = dep.status === 400 && /vinculada/i.test(dep.json?.error ?? '');
  record('SEP-24', 'POST deposit autentica y exige cuenta vinculada', depOk,
    `HTTP ${dep.status} — ${dep.json?.error ?? ''}`);
}

// ─── SEP-31: Cross-Border Payments ────────────────────────────────────────────
async function testSep31(auth) {
  console.log(`\n${C.b}SEP-31 — Cross-Border Payments (receiving anchor)${C.x}`);

  const info = await http('GET', `${ANCHOR_BASE}/cross-border/info`);
  const corridors = info.json?.corridors?.length ?? 0;
  const infoOk = info.status === 200 && info.json?.receive?.USDC?.enabled === true && corridors > 0;
  record('SEP-31', 'GET /cross-border/info expone USDC + corredores', infoOk, `HTTP ${info.status}, ${corridors} corredores`);

  if (!auth) { record('SEP-31', 'POST create', false, 'sin token'); return; }
  // corredor real bo-us; valida cadena completa (corredor→monto→quote) y luego
  // exige cuenta vinculada (sending anchor real tendría userId). 400 = esperado.
  const create = await http('POST', `${ANCHOR_BASE}/cross-border/transactions`, {
    token: auth.token,
    body: {
      amount: '100', asset_code: 'USDC',
      fields: { transaction: { corridor_id: 'bo-us', type: 'bank_transfer' } },
    },
  });
  const okChain = create.status === 400 && /vinculada/i.test(create.json?.error ?? '');
  record('SEP-31', 'POST create valida corredor+monto y exige cuenta vinculada', okChain,
    `HTTP ${create.status} — ${create.json?.error ?? ''}`);

  // negativo: corredor inexistente
  const bad = await http('POST', `${ANCHOR_BASE}/cross-border/transactions`, {
    token: auth.token,
    body: { amount: '100', asset_code: 'USDC', fields: { transaction: { corridor_id: 'xx-zz' } } },
  });
  record('SEP-31', 'Rechaza corredor inexistente (negativo)', bad.status === 400 && /not found|inactive/i.test(bad.json?.error ?? ''),
    `HTTP ${bad.status} — ${bad.json?.error ?? ''}`);
}

// ─── runner ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`${C.b}═══ Suite e2e SEP — anchor en vivo ═══${C.x}`);
  console.log(`${C.dim}TOML:   ${TOML_URL}${C.x}`);
  console.log(`${C.dim}ANCHOR: ${ANCHOR_BASE}${C.x}`);

  try {
    await testSep1();
    const auth = await testSep10();
    await testSep12(auth);
    await testSep24(auth);
    await testSep31(auth);
  } catch (e) {
    console.error(`\n${C.r}Error fatal en la suite:${C.x}`, e.message);
  }

  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${C.b}═══ Resumen ═══${C.x}`);
  console.log(`  ${C.g}${pass} PASS${C.x}  ${fail ? C.r : C.dim}${fail} FAIL${C.x}  / ${results.length} checks`);
  for (const sep of ['SEP-1', 'SEP-10', 'SEP-12', 'SEP-24', 'SEP-31']) {
    const grp = results.filter(r => r.sep === sep);
    const okN = grp.filter(r => r.ok).length;
    const mark = okN === grp.length ? `${C.g}OK${C.x}` : `${C.r}REVISAR${C.x}`;
    console.log(`    ${sep.padEnd(7)} ${okN}/${grp.length}  ${mark}`);
  }
  process.exit(fail ? 1 : 0);
})();
