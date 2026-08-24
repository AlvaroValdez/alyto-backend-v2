#!/usr/bin/env node
/**
 * verificar-perimetro-corredores.mjs — Tarea 2 de la instrucción 12.
 *
 * Las cinco verificaciones que hacen verdadero el apdo. 4.7 del Informe Técnico.
 * Se ejecuta contra producción y su salida integra la evidencia del expediente,
 * de modo que debe ser reproducible por esta Autoridad conforme al Art. 10° inc. e.
 *
 * NO corrige nada. Si una verificación no coincide, informa la discrepancia: una
 * diferencia acá puede significar que el Informe deba ajustarse, no producción.
 */

import mongoose from 'mongoose';

// El perímetro declarado. Transcrito del apdo. 1.2 del Protocolo de Pruebas y
// contrastado contra el cuadro de costos del apdo. 5.5 del Informe Técnico.
const DECLARADOS_LATAM = [
  'bo-cl', 'bo-ve', 'bo-do', 'bo-ar', 'bo-cn-usd', 'bo-ca', 'bo-uy', 'bo-co',
  'bo-mx', 'bo-pe', 'bo-py', 'bo-cr', 'bo-ec', 'bo-pa', 'bo-es', 'bo-au',
];
const DECLARADOS_INTL = [
  'bo-us', 'bo-br', 'bo-gb', 'bo-sg', 'bo-ae-srl', 'bo-jp', 'bo-ng',
];
const DECLARADOS = [...DECLARADOS_LATAM, ...DECLARADOS_INTL];

// Cómo se llama cada red en la configuración.
const RED = { vitaWallet: 'latinoamericana', owlPay: 'internacional' };

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('✗ Falta MONGODB_URI'); process.exit(1); }

await mongoose.connect(uri);
const col = mongoose.connection.collection('transaction_configs');

const ok = s => `  ✓ ${s}`;
const no = s => `  ✗ ${s}`;
let fallos = 0;

const activos = await col.find({ legalEntity: 'SRL', isActive: true })
  .project({ corridorId: 1, destinationCountry: 1, destinationCurrency: 1, payoutMethod: 1 })
  .toArray();

console.log('');
console.log(`  Base: ${mongoose.connection.name}   ${new Date().toISOString()}`);
console.log('');

// ── 1. Recuento ────────────────────────────────────────────────────────────────

console.log('  ══ 1 · recuento ══');
console.log(`   corredores activos de la sociedad boliviana : ${activos.length}`);
console.log(`   declarados en el apdo. 4.7                  : ${DECLARADOS.length}`);
if (activos.length === DECLARADOS.length) console.log(ok('coincide'));
else { console.log(no('NO coincide')); fallos++; }

// ── 2. Correspondencia uno a uno ───────────────────────────────────────────────

console.log('');
console.log('  ══ 2 · correspondencia uno a uno con lo declarado ══');
const enProd     = new Set(activos.map(c => c.corridorId));
const declarados = new Set(DECLARADOS);
const sobran  = [...enProd].filter(id => !declarados.has(id)).sort();
const faltan  = [...declarados].filter(id => !enProd.has(id)).sort();
console.log(`   en producción y no declarados : ${sobran.length ? sobran.join(', ') : 'ninguno'}`);
console.log(`   declarados y no en producción : ${faltan.length ? faltan.join(', ') : 'ninguno'}`);
if (!sobran.length && !faltan.length) console.log(ok('correspondencia exacta'));
else { console.log(no('DISCREPANCIA — no corregir por cuenta propia; informar')); fallos++; }

// ── 3. Distribución por red ────────────────────────────────────────────────────

console.log('');
console.log('  ══ 3 · distribución por red de liquidación ══');
const porRed = {};
for (const c of activos) {
  const r = RED[c.payoutMethod] ?? `otra (${c.payoutMethod})`;
  (porRed[r] ??= []).push(c.corridorId);
}
const nLatam = (porRed.latinoamericana ?? []).length;
const nIntl  = (porRed.internacional   ?? []).length;
console.log(`   latinoamericana : ${nLatam}   (declarados ${DECLARADOS_LATAM.length})`);
console.log(`   internacional   : ${nIntl}   (declarados ${DECLARADOS_INTL.length})`);
for (const [r, ids] of Object.entries(porRed)) {
  if (!['latinoamericana', 'internacional'].includes(r)) {
    console.log(no(`método de liquidación no previsto: ${r} → ${ids.join(', ')}`)); fallos++;
  }
}
if (nLatam === DECLARADOS_LATAM.length && nIntl === DECLARADOS_INTL.length) console.log(ok('coincide'));
else { console.log(no('NO coincide con el cuadro declarado')); fallos++; }

// ── 4. Un solo corredor por destino ────────────────────────────────────────────

console.log('');
console.log('  ══ 4 · un solo corredor por destino ══');
const porDestino = {};
for (const c of activos) {
  const clave = `${c.destinationCountry}/${c.destinationCurrency}`;
  (porDestino[clave] ??= []).push(`${c.corridorId} (${RED[c.payoutMethod] ?? c.payoutMethod})`);
}
const duplicados = Object.entries(porDestino).filter(([, ids]) => ids.length > 1);
console.log(`   destinos distintos                         : ${Object.keys(porDestino).length}`);
console.log(`   destinos atendidos por más de un corredor   : ${duplicados.length}`);
for (const [d, ids] of duplicados) console.log(no(`   ${d} → ${ids.join(' · ')}`));
if (!duplicados.length) console.log(ok('la regla del apdo. 4.7.1 se cumple sin excepción'));
else fallos++;

// ── 5. Corredores de origen Bolivia bajo otra entidad ──────────────────────────

console.log('');
console.log('  ══ 5 · corredores de origen Bolivia bajo otra entidad ══');
const ajenos = await col.find({ originCountry: 'BO', isActive: true, legalEntity: { $ne: 'SRL' } })
  .project({ corridorId: 1, legalEntity: 1 }).toArray();
console.log(`   activos con origen BO de otra sociedad del grupo : ${ajenos.length}`);
for (const c of ajenos) console.log(no(`   ${c.corridorId} (${c.legalEntity})`));
if (!ajenos.length) console.log(ok('ninguno'));
else fallos++;

// ── Cierre ─────────────────────────────────────────────────────────────────────

console.log('');
console.log(fallos === 0
  ? '  RESULTADO: las cinco verificaciones pasan.'
  : `  RESULTADO: ${fallos} verificación(es) NO coinciden — informar, no corregir.`);
console.log('');

await mongoose.disconnect();
process.exit(fallos === 0 ? 0 : 1);
