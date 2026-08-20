/**
 * migrate-bo-mx-to-vita.mjs — bo-mx pasa de Harbor a Vita.
 *
 * POR QUÉ: Harbor NO cotiza MXN para nuestra cuenta (error 3018 = moneda local
 * no habilitada; solo ofrece USD/WIRE, verificado 2026-08-14 con
 * diagnose-harbor-sepa.mjs --hipotesis). bo-mx estaba publicado pero ningún
 * usuario podía cotizar. Vita SÍ paga MXN nativo: tasa viva, min $1, fija
 * 20 MXN y formulario de 12 campos — y el camino Vita→MX ya está probado en
 * producción por cl-mx y us-mx, que siempre operaron por Vita.
 *
 * QUÉ NO CAMBIA: fees del corredor, mínimo ($30 USD, ahora alcanzable porque el
 * piso de Vita es $1 — con Harbor el guard lo subía a ~Bs 398), formularios de
 * otros corredores. bo-mx-llc (LLC) queda en Harbor tal cual: mismo problema de
 * MXN pero es decisión aparte.
 *
 * La fija de 20 MXN del proveedor fluye por providerFixedFee: se descuenta del
 * monto prometido y el desglose la muestra como "Comisión del banco destino".
 *
 * Reversible: cambiar payoutMethod de vuelta en /admin/corridors.
 *
 * Uso:
 *   node scripts/migrate-bo-mx-to-vita.mjs           # dry-run
 *   node scripts/migrate-bo-mx-to-vita.mjs --apply
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';
import { getPrices, getWithdrawalRules, getVitaCountryKey } from '../src/services/vitaWalletService.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  const c = await TransactionConfig.findOne({ corridorId: 'bo-mx' });
  if (!c) { console.log('bo-mx no existe en esta BD.'); return cerrar(); }

  console.log(`  ANTES: payoutMethod=${c.payoutMethod} · ${c.destinationCountry}/${c.destinationCurrency}` +
              ` · minUSD=${c.minAmountUSD} · activo=${c.isActive}`);

  if (c.payoutMethod === 'vitaWallet') {
    console.log('  Ya está en vitaWallet. Nada que hacer.');
    return cerrar();
  }

  // Precondiciones contra Vita EN VIVO — si Vita no cubre MX hoy, no se migra.
  const [prices, rules] = await Promise.all([getPrices(), getWithdrawalRules()]);
  const k     = getVitaCountryKey('MX', 'MXN');
  const attrs = prices?.usd?.withdrawal?.prices?.attributes;
  const sell  = Number(attrs?.sell_prices?.[k] ?? attrs?.usd_sell?.[k] ?? NaN);
  const fija  = Number(attrs?.fixed_cost?.[k] ?? NaN);
  const form  = rules?.rules?.[k]?.fields?.length ?? 0;

  console.log(`  Vita hoy: tasa ${sell} MXN/USD · fija ${fija} MXN · formulario ${form} campos`);

  if (!isFinite(sell) || sell <= 0 || form === 0) {
    console.log('\n✗ Vita NO está cubriendo MX en este momento — migración abortada.');
    return cerrar();
  }

  if (!APPLY) { console.log('\nDry-run. Re-ejecutar con --apply.'); return cerrar(); }

  const nota = `[${new Date().toISOString().slice(0, 10)}] payoutMethod owlPay→vitaWallet. ` +
    'Harbor no cotiza MXN para nuestra cuenta (3018: moneda local no habilitada; solo USD/WIRE) ' +
    '— el corredor estaba publicado pero ninguna cotización podía completarse. Vita paga MXN ' +
    `nativo (fija ${fija} MXN, descontada del prometido) y ya opera cl-mx/us-mx. ` +
    'Revertir aquí mismo si Harbor habilita SPEI/MXN y conviene.';

  c.payoutMethod = 'vitaWallet';
  c.adminNotes   = [c.adminNotes?.trim(), nota].filter(Boolean).join('\n');
  await c.save();

  console.log(`\n✓ bo-mx → vitaWallet en ${mongoose.connection.name}.`);
  return cerrar();
}

function cerrar() { return mongoose.disconnect(); }

main().catch(err => { console.error(err); process.exit(1); });
