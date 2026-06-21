/**
 * verify-sep31-guard.mjs — Verificación no-destructiva del fix SEP-31.
 *
 * Conecta a la DB de staging (MONGODB_URI del .env) e invoca createTransaction
 * directamente con un "sending anchor" externo (user._id = null) sobre un
 * corredor válido. ANTES del fix esto reventaba con 500 (calculateQuote:
 * providerRate must be positive). DESPUÉS debe lanzar un 400 limpio
 * ("requiere una cuenta Alyto vinculada") SIN crear ninguna Transaction.
 *
 * No escribe en la DB: el guard corta antes de Transaction.create.
 *
 *   node --env-file=.env scripts/verify-sep31-guard.mjs
 */

import mongoose from 'mongoose';
import { createTransaction } from '../src/services/sep31Service.js';
import TransactionConfig from '../src/models/TransactionConfig.js';

const C = { g: '\x1b[32m', r: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

await mongoose.connect(process.env.MONGODB_URI);
console.log(`${C.dim}DB: ${mongoose.connection.db.databaseName}${C.x}`);

// Toma un corredor activo real de la DB
const corridor = await TransactionConfig.findOne({ isActive: true }).select('corridorId minAmountUSD').lean();
if (!corridor) { console.error('No hay corredores activos en staging'); process.exit(1); }
const amount = String((corridor.minAmountUSD ?? 10) + 50);
console.log(`${C.dim}Corredor de prueba: ${corridor.corridorId}, monto ${amount}${C.x}\n`);

let ok = true;
try {
  await createTransaction({
    body: { amount, asset_code: 'USDC', fields: { transaction: { corridor_id: corridor.corridorId, type: 'bank_transfer' } } },
    user: { _id: null, stellarAccount: 'GEXTERNALWALLET', isSep10Only: true },
  });
  console.log(`${C.r}✗ FAIL — no lanzó error (debería 400)${C.x}`);
  ok = false;
} catch (err) {
  const is400 = err.status === 400;
  const isLinked = /vinculada/i.test(err.message);
  const isProviderRate500 = /providerRate must be positive/i.test(err.message);
  if (isProviderRate500) {
    console.log(`${C.r}✗ FAIL — sigue el bug 500: ${err.message}${C.x}`);
    ok = false;
  } else if (is400 && isLinked) {
    console.log(`${C.g}✓ PASS — 400 limpio antes de calcular quote:${C.x} "${err.message}"`);
  } else {
    console.log(`${C.r}✗ FAIL — error inesperado (status ${err.status}): ${err.message}${C.x}`);
    ok = false;
  }
}

// Confirma que NO se creó ninguna Transaction de este corredor en el último minuto
const Transaction = mongoose.model('Transaction');
const recent = await Transaction.countDocuments({
  corridorCode: corridor.corridorId,
  status: 'sep31_waiting',
  createdAt: { $gte: new Date(Date.now() - 60_000) },
});
console.log(`${recent === 0 ? C.g + '✓ PASS' : C.r + '✗ FAIL'} — Transactions sep31_waiting creadas en el test: ${recent}${C.x}`);

await mongoose.disconnect();
process.exit(ok && recent === 0 ? 0 : 1);
