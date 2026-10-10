/**
 * sondeo-harbor-unit.mjs — ¿qué unidad usa Harbor en settlement_time_unit?
 *
 * SOLO LECTURA: pide cotizaciones (POST /v2/transfers/quotes). Una cotización no
 * crea transferencia ni mueve dinero. Contra SANDBOX, nunca producción.
 *
 * Existe porque el repo no tiene ninguna respuesta real de Harbor guardada, y la
 * conversión de su plazo a días hábiles depende de conocer la unidad: leer "48"
 * como días cuando son horas es un error de dos órdenes de magnitud.
 *
 * No imprime credenciales.
 */
// Lee el .env a mano para no depender de dotenv: el script vive fuera del repo.
import { readFileSync } from 'node:fs';

const env = {};
for (const linea of readFileSync('/home/avf/Desarrollo/alyto-backend-v2/.env', 'utf8').split('\n')) {
  const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const BASE = env.OWLPAY_BASE_URL ?? env.OWLPAY_API_URL;
const KEY  = env.OWLPAY_API_KEY;
const UUID = env.OWLPAY_CUSTOMER_UUID_LLC ?? env.OWLPAY_CUSTOMER_UUID_SRL;

if (!BASE || !KEY) { console.error('✗ Falta OWLPAY_BASE_URL u OWLPAY_API_KEY'); process.exit(1); }
if (!/sandbox/i.test(BASE)) {
  console.error(`✗ ABORTA: la URL no es de sandbox (${BASE}). Este sondeo no corre contra producción.`);
  process.exit(1);
}
console.log(`entorno: ${BASE}\n`);

// Rieles distintos a propósito: BANK-TRANSFER, ACH_PUSH y WIRE pueden declarar
// unidades o plazos distintos.
const RUTAS = [
  { country: 'US', currency: 'USD', nota: 'ACH_PUSH / WIRE' },
  { country: 'GB', currency: 'GBP', nota: 'BANK-TRANSFER' },
  { country: 'SG', currency: 'SGD', nota: 'BANK-TRANSFER' },
  { country: 'NG', currency: 'NGN', nota: 'BANK-TRANSFER' },
  { country: 'BR', currency: 'USD', nota: 'WIRE' },
];

const unidades = new Set();

for (const { country, currency, nota } of RUTAS) {
  const payload = {
    // Shape exacto de getHarborQuote() en owlPayService.js, que ya funciona.
    source: {
      type:    'individual',
      chain:   env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      country: 'US',
      asset:   'USDC',
      amount:  '150.00',
    },
    destination: { type: 'individual', country, asset: currency },
    commission:  { percentage: '0.5', amount: 0 },
    ...(UUID ? { on_behalf_of: UUID } : {}),
  };

  try {
    const res = await fetch(`${BASE}/v2/transfers/quotes`, {
      method:  'POST',
      headers: { 'X-API-KEY': KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      console.log(`${country}/${currency} (${nota}) → HTTP ${res.status}: ${body?.message ?? body?.error?.message ?? 'sin detalle'}`);
      continue;
    }

    const quotes = Array.isArray(body?.data) ? body.data : [];
    if (quotes.length === 0) { console.log(`${country}/${currency} (${nota}) → 0 cotizaciones`); continue; }

    console.log(`${country}/${currency} (${nota}) → ${quotes.length} cotización(es)`);
    for (const q of quotes) {
      // Toda clave que huela a plazo, sin asumir el nombre.
      const temporales = Object.keys(q).filter(k => /time|settle|day|hour|eta|duration|arriv/i.test(k));
      const metodo = q.payment_method_label ?? q.payment_method ?? '?';
      console.log(`   método: ${metodo}`);
      if (temporales.length === 0) {
        console.log('     ⚠️ ninguna clave temporal en esta cotización');
      } else {
        for (const k of temporales) console.log(`     ${k} = ${JSON.stringify(q[k])}`);
        const u = q.settlement_time_unit ?? q.fiat_settlement_time_unit;
        if (u != null) unidades.add(String(u));
      }
    }
  } catch (err) {
    console.log(`${country}/${currency} (${nota}) → error: ${err.message}`);
  }
  console.log();
}

console.log('── UNIDADES OBSERVADAS ──');
console.log(unidades.size ? [...unidades].map(u => `  "${u}"`).join('\n') : '  ninguna');
