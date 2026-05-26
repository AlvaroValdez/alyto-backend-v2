/**
 * set-minimum-amounts.js
 *
 * Configura los mínimos por tipo de usuario en todos los corredores Vita y Harbor:
 *
 *   Vita Wallet  → retail $30 USD / business $100 USD
 *   OwlPay Harbor → retail $30 USD / business $150 USD
 *
 * El campo minAmountOrigin se deja en 1 porque resolveMinAmountOrigin()
 * siempre usa minAmountUSD cuando está presente; el estático solo actúa
 * como fallback si el servicio de tasas falla.
 *
 * Uso: node --env-file=.env scripts/set-minimum-amounts.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';

await mongoose.connect(process.env.MONGODB_URI);
console.log('[set-minimum-amounts] Conectado a MongoDB\n');

// ── 1. Vita Wallet ─────────────────────────────────────────────────────────────
const vita = await TransactionConfig.updateMany(
  { payoutMethod: 'vitaWallet' },
  { $set: { minAmountUSD: 30, minAmountUSDBusiness: 100, minAmountOrigin: 1 } },
);
console.log(`[Vita] ${vita.modifiedCount} corredores actualizados → retail $30 / business $100`);

const vitaDocs = await TransactionConfig
  .find({ payoutMethod: 'vitaWallet' })
  .select('corridorId originCurrency minAmountUSD minAmountUSDBusiness isActive')
  .sort({ corridorId: 1 })
  .lean();

for (const d of vitaDocs) {
  const flag = d.isActive ? '🟢' : '🔴';
  console.log(`  ${flag} ${d.corridorId.padEnd(20)} ${d.originCurrency}  retail=$${d.minAmountUSD}  business=$${d.minAmountUSDBusiness}`);
}

// ── 2. OwlPay Harbor ───────────────────────────────────────────────────────────
const harbor = await TransactionConfig.updateMany(
  { payoutMethod: 'owlPay' },
  { $set: { minAmountUSD: 30, minAmountUSDBusiness: 150, minAmountOrigin: 1 } },
);
console.log(`\n[Harbor] ${harbor.modifiedCount} corredores actualizados → retail $30 / business $150`);

const harborDocs = await TransactionConfig
  .find({ payoutMethod: 'owlPay' })
  .select('corridorId originCurrency minAmountUSD minAmountUSDBusiness isActive')
  .sort({ corridorId: 1 })
  .lean();

for (const d of harborDocs) {
  const flag = d.isActive ? '🟢' : '🔴';
  console.log(`  ${flag} ${d.corridorId.padEnd(20)} ${d.originCurrency}  retail=$${d.minAmountUSD}  business=$${d.minAmountUSDBusiness}`);
}

console.log('\n✅ set-minimum-amounts completado.');
await mongoose.disconnect();
