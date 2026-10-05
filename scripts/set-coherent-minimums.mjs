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
 * ⚠️ OJO ANTES DE RE-CORRERLO (2026-10-05): la premisa de la línea de Harbor es FALSA.
 * «providerMin = $30 confirmado vs API [30,9998]» vale para el TECHO, no para el piso:
 * el piso de Harbor es **por ruta**. `bo-jp` exige 75,02 y `bo-us` 50,11 sobre el neto,
 * o sea 2,4× y 1,7× el supuesto $30. Calcular $40 desde un piso global dejaba esas dos
 * rutas cobrando un payin que el payout no podía ejecutar.
 *
 * Re-correr este script NO rompe la protección —el piso real vive aparte, en
 * `TransactionConfig.providerFloorUSD`, y `providerFloorUSD()` toma el mayor de los
 * dos— pero sí reinstala la creencia equivocada en los `minAmountUSD`. Si se toca
 * esto, actualizar también los pisos por ruta:
 *
 *   node scripts/harbor-route-floors.mjs            # sondea e informa
 *   node scripts/harbor-route-floors.mjs --apply    # escribe providerFloorUSD
 *
 * Y tener presente que esos pisos son valores VIVOS: el de JP se movió de 75,02 a
 * 75,05 entre dos sondeos del mismo día, porque parece ser un mínimo en moneda
 * destino convertido a USD a la tasa del momento.
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
