/**
 * set-eu-product-minimum.mjs
 *
 * Fija el mínimo de PRODUCTO del corredor EU (bo-es, Vita withdrawal['eu']).
 *
 * POR QUÉ NO ALCANZA EL PISO DEL PROVEEDOR: Vita acepta desde $10, pero cobra una
 * fija de 5 EUR sobre el monto destino. En el piso del proveedor esa fija es el
 * 141% de lo que llega al beneficiario — el envío pasa todas las validaciones y
 * aun así es una propuesta indefendible. El guard de corridorMinimums.js protege
 * de que el proveedor RECHACE; esto protege de que la oferta sea mala.
 *
 *   mínimo actual     100 BOB  →  entrega   1.47 EUR   (fija = 340% de la entrega)
 *   piso del proveedor 130 BOB  →  entrega   3.54 EUR   (fija = 141%)
 *   ESTE mínimo       ~1000 BOB →  entrega  63.69 EUR   (fija = 7.9%, costo total 13.9%)
 *
 * SE FIJA EN USD, NO EN BOB: la fija de Vita está en EUR y la tasa BOB/USD se
 * mueve. Un mínimo clavado en BOB dejaría que la economía se degrade sola cuando
 * el boliviano se deprecie. minAmountUSD tiene prioridad en resolveMinAmountOrigin
 * y se convierte a BOB con la tasa viva en cada consulta.
 *
 * Uso:
 *   node scripts/set-eu-product-minimum.mjs           # dry-run
 *   node scripts/set-eu-product-minimum.mjs --apply
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';
import { getBOBRate } from '../src/services/exchangeRateService.js';
import { getPrices } from '../src/services/vitaWalletService.js';

const APPLY        = process.argv.includes('--apply');
const CORRIDOR_ID  = 'bo-es';
const MIN_USD      = 87;      // ≈ Bs 1.000 a la tasa de 2026-08-12 (11.53)

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  const c = await TransactionConfig.findOne({ corridorId: CORRIDOR_ID });
  if (!c) { console.log(`${CORRIDOR_ID} no existe en esta BD.`); await mongoose.disconnect(); return; }

  const bob    = await getBOBRate();
  const prices = await getPrices().catch(() => null);
  const attrs  = prices?.usd?.withdrawal?.prices?.attributes;
  const rate   = Number(attrs?.sell_prices?.eu ?? 0.8525);
  const fija   = Number(attrs?.fixed_cost?.eu ?? 5);

  const entrega = amt => ((amt * (1 - c.alytoCSpread / 100) - c.fixedFee) / bob) * rate - fija;
  const nuevoBob = Math.ceil(MIN_USD * bob);

  console.log(`  tasa viva: BOB/USD ${bob} · EUR/USD ${rate} · fija Vita ${fija} EUR`);
  console.log(`  fees corredor: ${c.alytoCSpread}% + Bs ${c.fixedFee}\n`);
  console.log(`  ANTES  minAmountUSD=${c.minAmountUSD ?? '—'}  minAmountOrigin=${c.minAmountOrigin ?? '—'}`);
  if (c.minAmountOrigin) {
    const e = entrega(c.minAmountOrigin);
    console.log(`         → al mínimo actual (${c.minAmountOrigin} BOB) entrega ${e.toFixed(2)} EUR` +
                `  ·  fija = ${((fija / e) * 100).toFixed(0)}% de lo entregado`);
  }
  const e2 = entrega(nuevoBob);
  console.log(`  DESPUÉS minAmountUSD=${MIN_USD}  → ${nuevoBob} BOB hoy`);
  console.log(`         → entrega ${e2.toFixed(2)} EUR  ·  fija = ${((fija / e2) * 100).toFixed(1)}% de lo entregado`);

  if (!APPLY) { console.log('\nDry-run. Re-ejecutar con --apply.'); await mongoose.disconnect(); return; }

  const nota = `[${new Date().toISOString().slice(0, 10)}] minAmountUSD=${MIN_USD} — mínimo de PRODUCTO. ` +
    `Vita acepta desde $10, pero su fija de ${fija} EUR haría que el beneficiario reciba ` +
    `~3.5 EUR. A este mínimo la fija queda en ~8% de lo entregado (costo total ~14%). ` +
    'Fijado en USD (no en BOB) porque la fija está en EUR: un mínimo en BOB se degrada solo ' +
    'cuando el boliviano se deprecia. Revisar si Vita cambia fixed_cost[eu].';

  c.minAmountUSD = MIN_USD;
  c.adminNotes   = [c.adminNotes?.trim(), nota].filter(Boolean).join('\n');
  await c.save();

  console.log(`\n✓ ${CORRIDOR_ID} actualizado en ${mongoose.connection.name}.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
