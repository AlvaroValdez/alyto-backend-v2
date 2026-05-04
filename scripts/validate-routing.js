/**
 * validate-routing.js — Análisis comparativo de proveedores por corredor SRL
 *
 * Para cada corredor SRL activo, obtiene la tasa real de Vita y Harbor
 * y determina cuál proveedor entrega más al beneficiario para la misma
 * cantidad de USDC puente.
 *
 * Uso:
 *   node --env-file=.env scripts/validate-routing.js
 *   node -r dotenv/config scripts/validate-routing.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import {
  getPrices,
  VITA_SENT_ONLY_COUNTRIES,
  getVitaCountryKey,
} from '../src/services/vitaWalletService.js';
import {
  getOwlPayApiKey,
  getOwlPayBaseUrl,
  getCustomerUuid,
} from '../src/services/owlPayService.js';

// ─── Parámetros del análisis ──────────────────────────────────────────────────

const SAMPLE_BOB    = 1000;
const BOB_PER_USDC  = 9.31;
// 1.5% fee Alyto + 5 BOB fixed fee → monto puente que sale hacia el proveedor
const usdcBridge    = (SAMPLE_BOB - SAMPLE_BOB * 0.015 - 5) / BOB_PER_USDC;

// ─── Bootstrap ────────────────────────────────────────────────────────────────

await mongoose.connect(process.env.MONGODB_URI);

const corridors = await mongoose.connection
  .collection('transaction_configs')
  .find({ legalEntity: 'SRL', isActive: true })
  .sort({ corridorId: 1 })
  .toArray();

console.log('\n══ Routing validation — todos los corredores SRL activos ══\n');
console.log(`Sample: ${SAMPLE_BOB} BOB → ~${usdcBridge.toFixed(2)} USDC bridge\n`);
console.log(`Corredores SRL activos: ${corridors.length}\n`);

// ─── Vita — obtener precios ────────────────────────────────────────────────────

// Suprimir el log HMAC debug (muy verboso) durante el script
const origEnv     = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

let vitaPrices = null;
try {
  vitaPrices = await getPrices();
  console.log('✅ Vita /prices OK');
} catch (e) {
  console.warn(`⚠️  Vita /prices falló: ${e.message}`);
}

process.env.NODE_ENV = origEnv;

/**
 * Calcula el monto destino que Vita entrega dado un monto en USDC (≈ USD).
 * Usa usd_sell para SRL (el pivot es USDC, no CLP).
 *
 * @returns {number|null} monto en moneda destino, o null si no hay cobertura
 */
function getVitaAmount(destCountry, usdcAmount) {
  if (!vitaPrices) return null;

  const country    = destCountry.toUpperCase();
  const isVitaSent = VITA_SENT_ONLY_COUNTRIES.has(country);
  const countryKey = getVitaCountryKey(country);

  // SRL paga desde el balance USD de Vita (fondeo via Binance P2P USDC→USD).
  // La tabla de tasas USD vive en data.usd.withdrawal.prices.attributes.usd_sell,
  // no en data.withdrawal.prices.attributes (que es CLP-based, usado por SpA).
  const usdAttrs = vitaPrices?.usd?.withdrawal?.prices?.attributes ?? {};

  let usdSell;
  if (isVitaSent) {
    // vita_sent no tiene sección usd → usar vita_sent clp_sell con conversión
    // como fallback — si no hay datos, retornar null (sin distorsionar comparación).
    usdSell = null;
  } else {
    usdSell = usdAttrs?.usd_sell?.[countryKey];
  }

  if (!usdSell) return null;

  const rate = parseFloat(usdSell);
  // fixed_cost en data.usd.withdrawal está en moneda destino (misma que en clp section)
  const fixedCost = parseFloat(usdAttrs?.fixed_cost?.[countryKey] ?? 0);

  return usdcAmount * rate - fixedCost;
}

// ─── Harbor — obtener quote por corredor ──────────────────────────────────────

const HARBOR_BASE = getOwlPayBaseUrl();
let   HARBOR_KEY;
try {
  HARBOR_KEY = getOwlPayApiKey();
  console.log('✅ Harbor API key OK');
} catch (e) {
  console.error(`❌ Harbor: ${e.message}`);
  process.exit(1);
}

// Customer UUID: usar SRL (único customer business en sandbox según API Discovery)
let harborCustomerUuid = null;
try {
  harborCustomerUuid = getCustomerUuid('SRL');
  console.log(`✅ Harbor customer UUID (SRL): ${harborCustomerUuid}`);
} catch {
  try {
    harborCustomerUuid = getCustomerUuid('LLC');
    console.log(`⚠️  Harbor: no hay UUID SRL, usando LLC como fallback`);
  } catch {
    console.warn('⚠️  Harbor: sin customer UUID — quotes en modo anónimo');
  }
}

console.log('');

/**
 * @returns {{ amount: number, paymentMethod: string, rate: number }|null}
 */
async function getHarborQuote(destCountry, destCurrency, usdcAmount) {
  const payload = {
    source: {
      type:    'individual',
      chain:   process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      country: 'US',
      asset:   'USDC',
      amount:  usdcAmount.toFixed(2),
    },
    destination: {
      type:    'individual',
      country: destCountry.toUpperCase(),
      asset:   destCurrency.toUpperCase(),
    },
    commission: { percentage: '0.5', amount: '0' },
  };
  if (harborCustomerUuid) payload.on_behalf_of = harborCustomerUuid;

  try {
    const res  = await fetch(`${HARBOR_BASE}/v2/transfers/quotes`, {
      method:  'POST',
      headers: { 'X-API-KEY': HARBOR_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    const quotes = Array.isArray(data?.data) ? data.data : (data?.data ? [data.data] : []);
    if (!quotes.length) return null;

    // Tomar el primer quote (mejor rate según Harbor)
    const q = quotes[0];
    const amount = parseFloat(
      q.destination?.amount ?? q.destination_amount ?? 0,
    );
    if (!amount) return null;

    return {
      amount,
      paymentMethod: q.payment_method ?? '—',
      rate:          parseFloat(q.exchange_rate ?? q.rate ?? 0),
    };
  } catch {
    return null;
  }
}

// ─── Análisis por corredor ────────────────────────────────────────────────────

const results = [];

for (const corr of corridors) {
  const country       = corr.destinationCountry;
  const currency      = corr.destinationCurrency;
  const currentMethod = corr.payoutMethod;

  // anchorBolivia y manual no son comparables con Vita/Harbor
  if (currentMethod === 'anchorBolivia' || currentMethod === 'manual') {
    results.push({
      corridor:      corr.corridorId,
      country,
      currency,
      currentMethod,
      vitaAmount:    null,
      harborAmount:  null,
      harborMethod:  '—',
      recommendation: currentMethod,
      match:         true,
      note:          'skip (manual)',
    });
    continue;
  }

  const vitaAmount    = getVitaAmount(country, usdcBridge);
  const harborResult  = await getHarborQuote(country, currency, usdcBridge);
  const harborAmount  = harborResult?.amount   ?? null;
  const harborMethod  = harborResult?.paymentMethod ?? '—';

  let recommendation;
  if (vitaAmount !== null && harborAmount !== null) {
    recommendation = harborAmount > vitaAmount ? 'owlPay' : 'vitaWallet';
  } else if (vitaAmount !== null) {
    recommendation = 'vitaWallet';
  } else if (harborAmount !== null) {
    recommendation = 'owlPay';
  } else {
    recommendation = 'unknown';
  }

  results.push({
    corridor:      corr.corridorId,
    country,
    currency,
    currentMethod,
    vitaAmount,
    harborAmount,
    harborMethod,
    recommendation,
    match:         recommendation === 'unknown' || currentMethod === recommendation,
    note:          '',
  });
}

// ─── Tabla comparativa ────────────────────────────────────────────────────────

console.table(
  results.map(r => ({
    corridor:       r.corridor,
    currency:       r.currency,
    current:        r.currentMethod,
    recommended:    r.recommendation,
    vita:           r.vitaAmount   != null ? r.vitaAmount.toFixed(2)  : '—',
    harbor:         r.harborAmount != null ? r.harborAmount.toFixed(2) : '—',
    harbor_method:  r.harborMethod,
    match:          r.note === 'skip (manual)' ? '—' : (r.match ? '✓' : '⚠️ CAMBIAR'),
  })),
);

// ─── Resumen ejecutivo ────────────────────────────────────────────────────────

const mismatches  = results.filter(r => !r.match && r.note !== 'skip (manual)');
const unknowns    = results.filter(r => r.recommendation === 'unknown' && r.note !== 'skip (manual)');
const harborWins  = results.filter(r => r.recommendation === 'owlPay'    && r.vitaAmount !== null);
const vitaWins    = results.filter(r => r.recommendation === 'vitaWallet' && r.harborAmount !== null);

console.log('\n── Resumen ──────────────────────────────────────────────────────────');
console.log(`Corredores analizados : ${results.length}`);
console.log(`Routing correcto      : ${results.length - mismatches.length - unknowns.length}`);
console.log(`Sin datos (unknown)   : ${unknowns.length}`);
console.log(`Harbor gana vs Vita   : ${harborWins.length} corredores`);
console.log(`Vita gana vs Harbor   : ${vitaWins.length} corredores`);

if (mismatches.length > 0) {
  console.log('\n⚠️  Corredores con routing subóptimo:');
  for (const r of mismatches) {
    let diff = '';
    if (r.vitaAmount != null && r.harborAmount != null) {
      const delta = Math.abs(r.harborAmount - r.vitaAmount);
      const better = r.harborAmount > r.vitaAmount ? 'Harbor' : 'Vita';
      diff = ` (+${delta.toFixed(2)} ${r.currency} con ${better})`;
    }
    console.log(`  ${r.corridor.padEnd(18)} → cambiar de ${r.currentMethod} a ${r.recommendation}${diff}`);
  }
} else if (unknowns.length === 0) {
  console.log('\n✅ Todos los corredores activos usan el proveedor con mejor tasa.');
}

if (unknowns.length > 0) {
  console.log('\n❓ Sin cobertura en ningún proveedor (revisar habilitación):');
  for (const r of unknowns) {
    console.log(`  ${r.corridor} (${r.currency})`);
  }
}

await mongoose.disconnect();
