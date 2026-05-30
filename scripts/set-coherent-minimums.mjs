#!/usr/bin/env node
/**
 * set-coherent-minimums.mjs — Alinea los mínimos de Alyto con los mínimos reales
 * de cada proveedor + un colchón (buffer) que cubre los fees de Alyto + margen.
 *
 * LÓGICA (decisión 2026-05-30):
 *   alytoMinRetailUSD = providerMinUSD × 1.35   (redondeado a múltiplo de $5)
 *   alytoMinBusinessUSD = 300                    (política B2B, ambos proveedores)
 *
 * RAZÓN: el mínimo del proveedor aplica al NETO que Alyto le envía (después de fees).
 * Si Alyto cobrara el mismo mínimo que el proveedor, el neto caería por debajo y el
 * proveedor rechazaría. El colchón de 35% sobre el mínimo del proveedor garantiza que
 * net = input × (1 − fee%) − feeFija ≥ providerMin con margen (fee retail ~7%).
 *
 *   - Harbor (owlPay):  providerMin = $30 (source.amount, confirmado vs API [30,9998])
 *                       → retail $40,  business $300
 *   - Vita (vitaWallet): sin mínimo duro (fee fija por corredor)
 *                       → retail $20 (piso de producto),  business $300
 *
 * El EU auto-router (euAmountRouter.js) usa harbor.minAmountUSD para su rango, así que
 * al fijar Harbor en $40 el ruteo queda: Harbor [40, 9998] USD / Vita fuera del rango.
 *
 * USO: node --env-file=.env scripts/set-coherent-minimums.mjs   (solo lectura DB salvo updateMany)
 */

import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
const col = mongoose.connection.collection('transaction_configs');

// ── Harbor (owlPay): retail $40, business $300 ────────────────────────────────
const rHarbor = await col.updateMany(
  { payoutMethod: 'owlPay' },
  { $set: { minAmountUSD: 40, minAmountUSDBusiness: 300 } },
);
console.log(`[Harbor owlPay] ${rHarbor.modifiedCount} corredores → minUSD=40, minBiz=300`);

// ── Vita (vitaWallet): retail $20, business $300 ──────────────────────────────
const rVita = await col.updateMany(
  { payoutMethod: 'vitaWallet' },
  { $set: { minAmountUSD: 20, minAmountUSDBusiness: 300 } },
);
console.log(`[Vita vitaWallet] ${rVita.modifiedCount} corredores → minUSD=20, minBiz=300`);

// ── Verificación ──────────────────────────────────────────────────────────────
const sample = await col.find({ payoutMethod: { $in: ['owlPay', 'vitaWallet'] }, isActive: true })
  .project({ corridorId: 1, payoutMethod: 1, minAmountUSD: 1, minAmountUSDBusiness: 1 })
  .sort({ payoutMethod: 1, corridorId: 1 }).toArray();
console.log('\nMuestra:');
for (const c of sample.slice(0, 6)) {
  console.log(`  ${c.corridorId.padEnd(14)} ${c.payoutMethod.padEnd(11)} retail=$${c.minAmountUSD} biz=$${c.minAmountUSDBusiness}`);
}
console.log(`  ... (${sample.length} corredores activos en total)`);

await mongoose.disconnect();
console.log('\n✅ Mínimos coherentes aplicados.');
