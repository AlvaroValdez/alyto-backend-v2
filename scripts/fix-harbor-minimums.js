/**
 * fix-harbor-minimums.js
 *
 * Alinea minAmountUSD / minAmountOrigin de todos los corredores OwlPay Harbor
 * con los mínimos reales que Harbor impone:
 *
 *   - SRL retail (BOB origin):  minAmountUSD = 30   (≈279 BOB a tasa 9.31)
 *   - LLC institucional (USD):  minAmountUSD = 500  (Harbor End User Model)
 *   - SpA CLP:                  minAmountUSD = 500  + minAmountOrigin = 483000 CLP
 *
 * El campo `minimumAmount` que usaba seedCorredoresGlobales.js no existe en
 * el schema de TransactionConfig — era silenciosamente ignorado por Mongoose.
 * Este script corrige los documentos que quedaron con minAmountOrigin = 1.
 *
 * Uso:
 *   node --env-file=.env scripts/fix-harbor-minimums.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';

await mongoose.connect(process.env.MONGODB_URI);
console.log('[fix-harbor-minimums] Conectado a MongoDB\n');

// ── 1. Todos los corredores SRL+LLC/BOB via Harbor — mínimo $30 USD ───────────
// Aplica a cualquier corredor owlPay con origen BOB, sin excepción.
// Harbor confirma $30 USD como mínimo retail para todos los corredores BOB.
const r1 = await TransactionConfig.updateMany(
  { payoutMethod: 'owlPay', originCurrency: 'BOB' },
  { $set: { minAmountUSD: 30, minAmountOrigin: 1 } },
);
console.log(`[SRL+LLC/BOB Harbor] ${r1.modifiedCount} corredores actualizados → minAmountUSD: 30`);
const bobDocs = await TransactionConfig.find({ payoutMethod: 'owlPay', originCurrency: 'BOB' })
  .select('corridorId minAmountUSD minAmountOrigin isActive').sort({ corridorId: 1 }).lean();
for (const doc of bobDocs) {
  console.log(`  ${doc.isActive ? '🟢' : '🔴'} ${doc.corridorId.padEnd(18)} minAmountUSD=${doc.minAmountUSD}  minAmountOrigin=${doc.minAmountOrigin}`);
}

// ── 2. Todos los corredores LLC/USD via Harbor — mínimo $500 USD ──────────────
// Harbor End User Model: $500 mínimo para todos los corredores USD institucionales.
const r2 = await TransactionConfig.updateMany(
  { payoutMethod: 'owlPay', originCurrency: 'USD' },
  { $set: { minAmountUSD: 500, minAmountOrigin: 500 } },
);
console.log(`\n[LLC/USD Harbor]   ${r2.modifiedCount} corredores actualizados → minAmountUSD: 500`);
const usdDocs = await TransactionConfig.find({ payoutMethod: 'owlPay', originCurrency: 'USD' })
  .select('corridorId minAmountUSD minAmountOrigin isActive').sort({ corridorId: 1 }).lean();
for (const doc of usdDocs) {
  console.log(`  ${doc.isActive ? '🟢' : '🔴'} ${doc.corridorId.padEnd(15)} minAmountUSD=${doc.minAmountUSD}  minAmountOrigin=${doc.minAmountOrigin}`);
}

// ── 3. Corredores SpA/CLP via Harbor — mínimo $500 USD ────────────────────────
// 500 USD × 966 CLP/USD = 483 000 CLP
// minAmountOrigin = fallback estático; resolveMinAmountOrigin usará minAmountUSD dinámicamente
const spaCLPCorridors = ['cl-eu', 'cl-cn', 'cl-ae', 'cl-gb', 'cl-au'];

const r3 = await TransactionConfig.updateMany(
  { corridorId: { $in: spaCLPCorridors } },
  { $set: { minAmountUSD: 500, minAmountOrigin: 483000 } },
);
console.log(`\n[SpA/CLP Harbor]   ${r3.modifiedCount}/${r3.matchedCount} corredores actualizados → minAmountUSD: 500, minAmountOrigin: 483000`);
for (const id of spaCLPCorridors) {
  const doc = await TransactionConfig.findOne({ corridorId: id }).select('corridorId minAmountUSD minAmountOrigin isActive').lean();
  if (doc) {
    console.log(`  ${doc.isActive ? '🟢' : '🔴'} ${doc.corridorId.padEnd(15)} minAmountUSD=${doc.minAmountUSD}  minAmountOrigin=${doc.minAmountOrigin}`);
  } else {
    console.log(`  ⚠️  ${id} — no encontrado en DB`);
  }
}

console.log('\n✅ fix-harbor-minimums completado.');
await mongoose.disconnect();
