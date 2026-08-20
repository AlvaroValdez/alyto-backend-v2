/**
 * deactivate-corridors-sin-formulario.mjs
 *
 * Desactiva los corredores Vita que NO tienen formulario de beneficiario.
 *
 * POR QUÉ: `GET /payments/withdrawal-rules/:country` construye el formulario con
 * los campos que devuelve Vita (`rules[key].fields`). Si Vita devuelve 0 campos y
 * el país no está en FALLBACK_WITHDRAWAL_RULES (solo CO/PE/CL), el endpoint
 * responde 404 y el usuario se queda SIN dónde escribir los datos del
 * destinatario — después de haber elegido el país y cotizado. El corredor está
 * publicado pero es imposible de completar.
 *
 * NO hardcodea la lista de países: la deriva consultando a Vita en vivo, así que
 * si Vita habilita el formulario más adelante el script deja de marcarlos.
 *
 * Uso:
 *   node scripts/deactivate-corridors-sin-formulario.mjs           # dry-run
 *   node scripts/deactivate-corridors-sin-formulario.mjs --apply   # aplica
 *
 * Reversible: `isActive` vuelve a true desde el admin panel (/admin/corridors).
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';
import { getWithdrawalRules, getVitaCountryKey } from '../src/services/vitaWalletService.js';

const APPLY = process.argv.includes('--apply');

// Espejo de FALLBACK_WITHDRAWAL_RULES en paymentController.js: países que tienen
// formulario propio en el código aunque Vita no responda.
const CON_FALLBACK = new Set(['CO', 'PE', 'CL']);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.name;
  console.log(`BD: ${dbName}${APPLY ? '  · MODO APLICAR' : '  · dry-run (sin cambios)'}\n`);

  const rules = await getWithdrawalRules();
  const corridors = await TransactionConfig.find({ isActive: true, payoutMethod: 'vitaWallet' }).lean();

  const sinFormulario = [];
  for (const c of corridors) {
    const dest = (c.destinationCountry ?? '').toUpperCase();
    if (CON_FALLBACK.has(dest)) continue;
    const key    = getVitaCountryKey(dest, c.destinationCurrency);
    const fields = rules?.rules?.[key]?.fields ?? [];
    if (fields.length === 0) sinFormulario.push({ ...c, vitaKey: key });
  }

  if (sinFormulario.length === 0) {
    console.log('Todos los corredores Vita activos tienen formulario. Nada que hacer.');
    await mongoose.disconnect();
    return;
  }

  console.log(`${sinFormulario.length} corredor(es) SIN formulario de beneficiario:\n`);
  for (const c of sinFormulario) {
    console.log(`  ${c.corridorId.padEnd(14)} ${c.originCountry}→${c.destinationCountry} ` +
                `(${c.destinationCurrency})  clave Vita: '${c.vitaKey}'  → 0 campos`);
  }

  if (!APPLY) {
    console.log('\nDry-run. Re-ejecutar con --apply para desactivarlos.');
    await mongoose.disconnect();
    return;
  }

  const nota = `[${new Date().toISOString().slice(0, 10)}] Desactivado: Vita no expone formulario de ` +
               'beneficiario para este país (0 campos) — el usuario no podía completar el envío. ' +
               'Reactivar cuando Vita publique los campos o se defina un formulario propio.';

  for (const c of sinFormulario) {
    // adminNotes es un String: se preserva lo que hubiera y se anexa la razón.
    const notas = [c.adminNotes?.trim(), nota].filter(Boolean).join('\n');
    await TransactionConfig.updateOne(
      { _id: c._id },
      { $set: { isActive: false, adminNotes: notas } },
    );
    console.log(`  ✓ ${c.corridorId} desactivado`);
  }

  console.log(`\n${sinFormulario.length} corredor(es) desactivado(s) en ${dbName}.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
