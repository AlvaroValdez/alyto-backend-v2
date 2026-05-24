/**
 * vita-coverage-diagnostic.js
 *
 * Diagnóstico de cobertura real del sandbox de Vita Wallet.
 * Responde dos preguntas concretas:
 *
 *  1. ¿China (CN) está soportada como destino de withdrawal?
 *  2. ¿Los países EU tienen formularios individuales o comparten uno solo ('eu')?
 *
 * Uso:
 *   node --env-file=.env scripts/vita-coverage-diagnostic.js
 *
 * Requiere en .env:
 *   VITA_API_URL, VITA_LOGIN, VITA_TRANS_KEY, VITA_SECRET
 *
 * Salida:
 *   - Reporte en consola con respuesta directa a cada pregunta
 *   - scripts/output/vita-withdrawal-rules-raw.json  — respuesta cruda completa
 *   - scripts/output/vita-prices-raw.json            — precios completos
 *   - scripts/output/vita-coverage-summary.json      — resumen estructurado
 */

import crypto from 'crypto';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

// ─── Validar entorno ──────────────────────────────────────────────────────────

const required = ['VITA_API_URL', 'VITA_LOGIN', 'VITA_TRANS_KEY', 'VITA_SECRET'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Variables faltantes en .env:', missing.join(', '));
  process.exit(1);
}

const BASE_URL = `${process.env.VITA_API_URL}/api/businesses`;

// ─── Cliente HMAC-SHA256 (portado de vitaWalletService.js) ───────────────────

function deepClean(v) {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(deepClean).filter(x => x !== undefined);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const c = deepClean(val);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return v;
}

function stableStringify(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys    = Object.keys(v).sort();
    const entries = keys.map(k => {
      const val = v[k];
      if (typeof val === 'string') return `:${k}=>"${val}"`;
      if (typeof val === 'number') return `:${k}=>${val}`;
      if (typeof val === 'object') return `:${k}=>${stableStringify(val)}`;
      return `:${k}=>${val}`;
    });
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(v);
}

function buildSortedBody(body) {
  if (!body || typeof body !== 'object') return '';
  const keys = Object.keys(body).sort();
  let out = '';
  for (const k of keys) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    out += typeof v === 'object' ? `${k}${stableStringify(v)}` : `${k}${String(v)}`;
  }
  return out;
}

function sign(xDate, body = null) {
  const clean  = body ? (deepClean(body) ?? {}) : null;
  const sorted = buildSortedBody(clean);
  const msg    = `${process.env.VITA_LOGIN}${xDate}${sorted}`;
  return crypto.createHmac('sha256', process.env.VITA_SECRET).update(msg, 'utf8').digest('hex');
}

async function vitaCall(method, endpoint, body = null) {
  const xDate = new Date().toISOString();
  const sig   = sign(xDate, body);

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-login':      process.env.VITA_LOGIN,
      'x-trans-key':  process.env.VITA_TRANS_KEY,
      'x-api-key':    process.env.VITA_TRANS_KEY,
      'x-date':       xDate,
      'Authorization': `V2-HMAC-SHA256, Signature: ${sig}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? `HTTP ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}

// ─── Helpers de salida ────────────────────────────────────────────────────────

const ok   = msg => console.log(`  ✅ ${msg}`);
const fail = msg => console.log(`  ❌ ${msg}`);
const info = msg => console.log(`  ℹ️  ${msg}`);
const sep  = ()  => console.log('');

function saveJson(filename, data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const p = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return path.relative(process.cwd(), p);
}

// ─── Países EU conocidos ──────────────────────────────────────────────────────

const EU_COUNTRIES = new Set([
  'AT','BE','CY','DE','EE','ES','FI','FR','GR','IE',
  'IT','LT','LU','LV','MT','NL','PT','SI','SK','PL',
]);

// ─── ANÁLISIS 1: withdrawal_rules ────────────────────────────────────────────

async function analyzeWithdrawalRules() {
  console.log('━━━ ANÁLISIS 1: withdrawal_rules — cobertura real de países ━━━');

  const raw = await vitaCall('GET', '/withdrawal_rules');

  // Vita puede responder como array [ { country: 'AR', fields: [...] } ]
  // o como objeto { ar: { fields: [...] }, co: {...} }
  // o como { rules: { ... } }
  const unwrapped = raw?.rules ?? raw;
  let entries = [];

  if (Array.isArray(unwrapped)) {
    entries = unwrapped;
  } else if (unwrapped && typeof unwrapped === 'object') {
    entries = Object.entries(unwrapped).map(([key, val]) => ({
      _vitaKey: key,
      ...(typeof val === 'object' ? val : { raw: val }),
    }));
  }

  info(`Total de entradas en withdrawal_rules: ${entries.length}`);
  sep();

  // Extraer clave de país de cada entrada
  const allKeys = entries.map(e =>
    e._vitaKey ?? e.country_iso_code ?? e.country ?? e.code ?? '?'
  ).map(k => String(k).toLowerCase());

  console.log('  Claves de países disponibles:');
  console.log(`  → ${allKeys.join(', ') || '(ninguna)'}`);
  sep();

  // ── Pregunta 1: ¿Está CN? ────────────────────────────────────────────────
  console.log('  [Pregunta 1] ¿China (CN) está en withdrawal_rules?');
  const cnEntry = entries.find(e => {
    const k = (e._vitaKey ?? e.country_iso_code ?? e.country ?? e.code ?? '').toLowerCase();
    return k === 'cn' || k === 'china';
  });

  if (cnEntry) {
    ok('CN encontrado en withdrawal_rules');
    const fields = cnEntry.fields ?? cnEntry.required_fields ?? [];
    ok(`Campos CN: ${Array.isArray(fields) ? fields.map(f => f.key ?? f.name ?? JSON.stringify(f)).join(', ') : JSON.stringify(fields)}`);
  } else {
    fail('CN NO encontrado en withdrawal_rules');
    info('Confirma directamente con Vita antes de implementar el corredor');
  }
  sep();

  // ── Pregunta 2: ¿EU tiene una sola entrada o entradas por país? ──────────
  console.log('  [Pregunta 2] Estructura EU en withdrawal_rules');

  const euEntry = entries.find(e => {
    const k = (e._vitaKey ?? e.country_iso_code ?? e.country ?? '').toLowerCase();
    return k === 'eu';
  });

  const individualEuEntries = entries.filter(e => {
    const k = (e._vitaKey ?? e.country_iso_code ?? e.country ?? '').toUpperCase();
    return EU_COUNTRIES.has(k);
  });

  if (euEntry) {
    ok(`Vita usa una entrada ÚNICA 'eu' para toda la Eurozona`);
    const fields = euEntry.fields ?? euEntry.required_fields ?? [];
    if (Array.isArray(fields) && fields.length > 0) {
      ok(`Campos del formulario 'eu':`);
      for (const f of fields) {
        const type    = f.type ?? '?';
        const key     = f.key ?? f.name ?? '?';
        const label   = f.label ?? '';
        const options = f.options ? ` [${f.options.length} opciones]` : '';
        const when    = f.when ? ` (condicional: cuando ${f.when.key}=${JSON.stringify(f.when.value)})` : '';
        console.log(`    • ${key} [${type}]${label ? ' — ' + label : ''}${options}${when}`);
      }
    }
  } else {
    info(`No hay entrada genérica 'eu'`);
  }

  if (individualEuEntries.length > 0) {
    ok(`Entradas individuales EU encontradas: ${individualEuEntries.map(e =>
      (e._vitaKey ?? e.country_iso_code ?? e.country ?? '?').toUpperCase()
    ).join(', ')}`);
    info('Cada país EU tiene su propia forma → puedes listarlos individualmente');

    // Comparar campos entre países EU para detectar diferencias
    const fieldSets = individualEuEntries.map(e => {
      const fields = e.fields ?? e.required_fields ?? [];
      const keys   = Array.isArray(fields)
        ? fields.map(f => f.key ?? f.name ?? '?').sort().join('|')
        : '?';
      return {
        country: (e._vitaKey ?? e.country_iso_code ?? e.country ?? '?').toUpperCase(),
        fieldSet: keys,
      };
    });

    const uniqueSets = [...new Set(fieldSets.map(f => f.fieldSet))];
    if (uniqueSets.length === 1) {
      ok('Todos los países EU comparten EXACTAMENTE los mismos campos de formulario');
      info('→ Un solo componente de formulario sirve para todos los países EU');
    } else {
      info(`Los países EU tienen ${uniqueSets.length} variantes de formulario distintas:`);
      for (const set of uniqueSets) {
        const countries = fieldSets.filter(f => f.fieldSet === set).map(f => f.country);
        console.log(`    ${countries.join(', ')}: ${set.replace(/\|/g, ', ')}`);
      }
    }
  } else {
    info('No hay entradas individuales por país EU — todos comparten la clave "eu"');
    info('→ Para listar países EU individualmente en la UI, el formulario es el mismo para todos');
  }

  sep();
  const savedPath = saveJson('vita-withdrawal-rules-raw.json', raw);
  ok(`JSON completo guardado → ${savedPath}`);
  sep();

  return { raw, allKeys, cnFound: !!cnEntry, euEntry, individualEuEntries };
}

// ─── ANÁLISIS 2: precios — ¿qué países aparecen en usd_sell? ────────────────

async function analyzePrices() {
  console.log('━━━ ANÁLISIS 2: /prices — claves de países en USD sell ━━━');

  const raw = await vitaCall('GET', '/prices');

  // Estructura esperada: raw.withdrawal.prices.attributes.usd_sell = { co: rate, pe: rate, ... }
  // o raw.usd.withdrawal.prices.attributes.usd_sell
  const attrs    = raw?.withdrawal?.prices?.attributes
                ?? raw?.usd?.withdrawal?.prices?.attributes
                ?? raw?.prices?.attributes
                ?? {};

  const usdSell  = attrs?.usd_sell ?? {};
  const clpSell  = attrs?.clp_sell ?? {};

  const usdKeys  = Object.keys(usdSell).sort();
  const clpKeys  = Object.keys(clpSell).sort();

  info(`Destinos con precio USD sell (${usdKeys.length}): ${usdKeys.join(', ') || '(ninguno)'}`);
  sep();
  info(`Destinos con precio CLP sell (${clpKeys.length}): ${clpKeys.join(', ') || '(ninguno)'}`);
  sep();

  // ¿Aparece CN en los precios?
  console.log('  [Pregunta 1] ¿CN aparece en usd_sell de /prices?');
  if (usdSell.cn !== undefined) {
    ok(`CN encontrado en usd_sell: 1 USD = ${usdSell.cn} (moneda destino)`);
  } else {
    fail('CN NO encontrado en usd_sell de /prices');
  }
  sep();

  // ¿Aparecen países EU individualmente?
  console.log('  [Pregunta 2] ¿Países EU aparecen individualmente en usd_sell?');
  const euKeysInPrices = usdKeys.filter(k => {
    const upper = k.toUpperCase();
    return EU_COUNTRIES.has(upper) || k === 'eu';
  });

  if (euKeysInPrices.length > 0) {
    ok(`Claves EU en usd_sell: ${euKeysInPrices.join(', ')}`);
    if (euKeysInPrices.includes('eu')) {
      info('Vita consolida todos los países EU bajo la clave "eu" en precios también');
    } else {
      info('Los países EU aparecen con claves individuales en precios');
    }
  } else {
    info('Ninguna clave EU encontrada en usd_sell');
    info('Verifica si EU aparece en clp_sell o en otra sección');
  }
  sep();

  const savedPath = saveJson('vita-prices-raw.json', raw);
  ok(`JSON completo guardado → ${savedPath}`);
  sep();

  return { raw, usdKeys, clpKeys, cnInPrices: !!usdSell.cn };
}

// ─── ANÁLISIS 3: vita_sent prices — ¿qué países cubre? ─────────────────────

async function analyzeVitaSentPrices() {
  console.log('━━━ ANÁLISIS 3: vita_sent prices — cobertura adicional ━━━');

  const raw = await vitaCall('GET', '/prices');

  const vitaSentAttrs = raw?.vita_sent?.prices?.attributes ?? {};
  const clpSent       = vitaSentAttrs?.clp_sell ?? {};
  const usdSent       = vitaSentAttrs?.usd_sell ?? {};

  const sentKeysClp = Object.keys(clpSent).sort();
  const sentKeysUsd = Object.keys(usdSent).sort();

  if (sentKeysClp.length > 0) {
    info(`vita_sent destinos CLP (${sentKeysClp.length}): ${sentKeysClp.join(', ')}`);
  }
  if (sentKeysUsd.length > 0) {
    info(`vita_sent destinos USD (${sentKeysUsd.length}): ${sentKeysUsd.join(', ')}`);
  }
  if (sentKeysClp.length === 0 && sentKeysUsd.length === 0) {
    info('No se encontraron precios vita_sent (puede ser normal en sandbox)');
  }

  // ¿CN aparece en vita_sent?
  sep();
  console.log('  ¿CN aparece en vita_sent prices?');
  const cnInVitaSent = clpSent.cn !== undefined || usdSent.cn !== undefined;
  cnInVitaSent
    ? ok('CN encontrado en vita_sent prices')
    : fail('CN NO encontrado en vita_sent prices');

  sep();
}

// ─── RESUMEN FINAL ────────────────────────────────────────────────────────────

function printSummary({ cnRules, cnPrices, euStructure }) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              VITA COVERAGE DIAGNOSTIC — RESUMEN             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║                                                              ║');

  // China
  const cnStatus = (cnRules && cnPrices) ? '🟢 SOPORTADO' : cnRules ? '🟡 EN RULES, NO EN PRICES' : '🔴 NO SOPORTADO';
  console.log(`║  China (CN) withdrawal support:  ${cnStatus.padEnd(29)}║`);
  console.log('║                                                              ║');

  // EU
  const euLabel = euStructure === 'shared'     ? '🔵 Clave única "eu" para todos'
                : euStructure === 'individual'  ? '🟢 Entradas individuales por país'
                : '⚠️  Mixto — ver detalle arriba';
  console.log(`║  EU country structure:                                       ║`);
  console.log(`║    ${euLabel.padEnd(58)}║`);
  console.log('║                                                              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');

  if (!cnRules && !cnPrices) {
    console.log('║  ACCIÓN: Contactar Vita (empresas@vitawallet.io)             ║');
    console.log('║  para confirmar soporte CN. No implementar sin certeza.      ║');
  } else if (cnRules && cnPrices) {
    console.log('║  ACCIÓN: China verificada. Planificar corredor bo-cn-usd     ║');
    console.log('║  vía Vita. Ver scripts/output/ para campos de formulario.    ║');
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Archivos generados:                                         ║');
  console.log('║    scripts/output/vita-withdrawal-rules-raw.json             ║');
  console.log('║    scripts/output/vita-prices-raw.json                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('🔬 Vita Coverage Diagnostic');
  console.log(`   API: ${process.env.VITA_API_URL}`);
  console.log('');

  const summary = { cnRules: false, cnPrices: false, euStructure: 'unknown' };

  try {
    const r1 = await analyzeWithdrawalRules();
    summary.cnRules = r1.cnFound;

    if (r1.individualEuEntries.length > 0 && !r1.euEntry) {
      summary.euStructure = 'individual';
    } else if (r1.euEntry && r1.individualEuEntries.length === 0) {
      summary.euStructure = 'shared';
    } else if (r1.euEntry && r1.individualEuEntries.length > 0) {
      summary.euStructure = 'mixed';
    }
  } catch (err) {
    fail(`withdrawal_rules: ${err.message}`);
    if (err.data) console.error('  Respuesta Vita:', JSON.stringify(err.data, null, 2));
    sep();
  }

  try {
    const r2 = await analyzePrices();
    summary.cnPrices = r2.cnInPrices;
  } catch (err) {
    fail(`prices: ${err.message}`);
    if (err.data) console.error('  Respuesta Vita:', JSON.stringify(err.data, null, 2));
    sep();
  }

  try {
    await analyzeVitaSentPrices();
  } catch (err) {
    fail(`vita_sent prices: ${err.message}`);
    sep();
  }

  saveJson('vita-coverage-summary.json', summary);
  printSummary(summary);
}

run().catch(err => {
  console.error('\n[vita-coverage-diagnostic] Error fatal:', err.message);
  process.exit(1);
});
