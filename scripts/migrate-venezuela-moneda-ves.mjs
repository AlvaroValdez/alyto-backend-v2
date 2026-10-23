/**
 * migrate-venezuela-moneda-ves.mjs — los corredores a Venezuela pagan en VES, no en USD.
 *
 * POR QUÉ: los tres corredores a Venezuela (bo-ve, cl-ve, us-ve) se sembraron con
 * destinationCurrency 'USD'. Venezuela NO está dolarizada: Vita entrega bolívares.
 * El error viene de copiar la configuración de Ecuador, cuyo comentario en el seed
 * dice "Destino dolarizado (USD)" y es cierto allí, pero no aquí.
 *
 * VERIFICADO contra la API de Vita en producción (2026-10-17), tasas desde 1 CLP:
 *
 *     clp_sell.us = 0.00100324   → 1 USD ≈ 997 CLP
 *     clp_sell.ec = 0.00100019   → Ecuador, dolarizado de verdad: idéntico a EE.UU.
 *     clp_sell.ve = 0.95737568   → 1 VES ≈ 1,04 CLP
 *     clp_sell.veusd = no existe → Vita NO tiene riel en dólares a Venezuela
 *
 * Ecuador sirve de control: dolarizado de verdad, se comporta igual que Estados
 * Unidos. Venezuela se separa por un factor de ~954.
 *
 * El convenio del propio código ya lo decía: los destinos donde Vita entrega
 * dólares llevan sufijo 'usd' en la clave (causd, hkusd, cnusd). VE no lo tiene,
 * así que getVitaCountryKey('VE') devuelve 've', la clave de moneda local.
 *
 * QUÉ NO CAMBIA, y por qué esto es solo una etiqueta:
 *   La tasa que ya se usaba era la de 've', porque destKey() en vitaRailResolver
 *   resuelve a 've' en ambas ramas (getVitaCountryKey sólo bifurca por moneda en
 *   China). Es decir: el monto calculado YA estaba en bolívares, y lo único
 *   erróneo era el rótulo que veía el usuario. Cambiar destinationCurrency NO
 *   altera la aritmética, la pone de acuerdo con lo que ya hacía.
 *
 *   Tampoco cambian las comisiones: fixedFee va en moneda de ORIGEN (8 BOB,
 *   500 CLP), no de destino.
 *
 * ALCANCE: al 2026-10-17 había 3 transacciones a Venezuela, las tres en estado
 * failed por validación de campos del beneficiario. Ninguna llegó a entregar
 * dinero, así que esto no corrige ningún pago mal hecho: lo previene.
 *
 * Reversible: volver a poner 'USD' en /admin/corridors (aunque sería un error).
 *
 * Uso:
 *   node scripts/migrate-venezuela-moneda-ves.mjs           # dry-run
 *   node scripts/migrate-venezuela-moneda-ves.mjs --apply
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  const corredores = await TransactionConfig.find({ destinationCountry: 'VE' });

  if (!corredores.length) {
    console.log('No hay corredores con destino VE en esta base.');
    return cerrar();
  }

  let porCambiar = 0;

  for (const c of corredores) {
    const actual = c.destinationCurrency;
    const marca  = actual === 'VES' ? 'ya correcto' : `${actual} → VES`;
    console.log(`  ${c.corridorId.padEnd(10)} activo=${c.isActive}  ${marca}`);

    if (actual === 'VES') continue;
    porCambiar++;

    if (APPLY) {
      c.destinationCurrency = 'VES';
      await c.save();
    }
  }

  console.log('');
  if (!porCambiar) {
    console.log('Nada que cambiar.');
  } else if (APPLY) {
    console.log(`✅ ${porCambiar} corredor(es) actualizado(s) a VES.`);
    console.log('   Siguiente: desplegar el frontend, que también declaraba USD para VE');
    console.log('   en COUNTRY_META y no conocía el código VES.');
  } else {
    console.log(`${porCambiar} corredor(es) por actualizar. Relanza con --apply.`);
  }

  return cerrar();
}

async function cerrar() {
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  await cerrar();
  process.exit(1);
});
