/**
 * fix-corridors-jp-usd-in-off.mjs — bo-jp pasa a USD · bo-in se desactiva.
 *
 * CONTEXTO (matriz Harbor 2026-08-14, diagnose-harbor-sepa.mjs --hipotesis):
 * Harbor devuelve 3018 para la moneda local de JP e IN en nuestra cuenta — solo
 * paga USD vía WIRE en esos destinos. Ambos corredores estaban publicados pero
 * ninguna cotización podía completarse.
 *
 * bo-jp → destinationCurrency USD:
 *   - Jolin (OwlPay, 3/7): "For Spain, Japan and Canada we just support payout
 *     in USD" — el corredor pedía JPY, contra lo que el proveedor ofrece.
 *   - JP→USD cotiza ✓ (WIRE) en producción. Vita NO cubre Japón (sin clave 'jp'),
 *     así que no hay alternativa de moneda local.
 *   - El formulario Harbor de JP (SWIFT + cuenta) es agnóstico a la moneda.
 *   - El beneficiario recibe DÓLARES en su banco japonés — mismo modelo que
 *     Ecuador/Panamá/Venezuela, el selector del FE muestra la moneda del corredor.
 *
 * bo-in → isActive false:
 *   - INR da 3018 y Vita no cubre India (0 campos, sin tasa). La única vía sería
 *     Harbor en USD; se decidió desactivar hasta que Harbor habilite INR/IMPS.
 *
 * Reversible: ambos desde /admin/corridors.
 *
 * Uso:
 *   node scripts/fix-corridors-jp-usd-in-off.mjs           # dry-run
 *   node scripts/fix-corridors-jp-usd-in-off.mjs --apply
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';

const APPLY = process.argv.includes('--apply');
const HOY   = new Date().toISOString().slice(0, 10);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  // ── bo-jp: JPY → USD ────────────────────────────────────────────────────────
  const jp = await TransactionConfig.findOne({ corridorId: 'bo-jp' });
  if (!jp) {
    console.log('bo-jp: no existe en esta BD.');
  } else if (jp.destinationCurrency === 'USD') {
    console.log('bo-jp: ya está en USD. Sin cambios.');
  } else {
    console.log(`bo-jp: ${jp.destinationCurrency} → USD  (método ${jp.payoutMethod}, minUSD ${jp.minAmountUSD}, activo ${jp.isActive})`);
    if (APPLY) {
      const nota = `[${HOY}] destinationCurrency JPY→USD. Harbor solo paga USD en Japón ` +
        '(JPY da 3018 "moneda local no habilitada"; confirmado por Jolin/OwlPay el 3/7). ' +
        'Vita no cubre JP. El beneficiario recibe USD en su banco japonés — mismo modelo ' +
        'que EC/PA/VE. Revertir si Harbor habilita JPY.';
      jp.destinationCurrency = 'USD';
      jp.adminNotes = [jp.adminNotes?.trim(), nota].filter(Boolean).join('\n');
      await jp.save();
      console.log('  ✓ aplicado');
    }
  }

  // ── bo-in: desactivar ───────────────────────────────────────────────────────
  const inC = await TransactionConfig.findOne({ corridorId: 'bo-in' });
  if (!inC) {
    console.log('bo-in: no existe en esta BD.');
  } else if (!inC.isActive) {
    console.log('bo-in: ya está inactivo. Sin cambios.');
  } else {
    console.log(`bo-in: activo → INACTIVO  (método ${inC.payoutMethod}, ${inC.destinationCurrency})`);
    if (APPLY) {
      const nota = `[${HOY}] Desactivado. Harbor devuelve 3018 para INR (moneda local no ` +
        'habilitada en nuestra cuenta; solo ofrece USD/WIRE) y Vita no cubre India (sin tasa, ' +
        '0 campos de formulario). Ninguna cotización podía completarse. Reactivar cuando ' +
        'Harbor habilite INR/IMPS — pedido pendiente con Jolin.';
      inC.isActive   = false;
      inC.adminNotes = [inC.adminNotes?.trim(), nota].filter(Boolean).join('\n');
      await inC.save();
      console.log('  ✓ aplicado');
    }
  }

  if (!APPLY) console.log('\nDry-run. Re-ejecutar con --apply.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
