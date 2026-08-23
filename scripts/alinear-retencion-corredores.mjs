#!/usr/bin/env node
/**
 * alinear-retencion-corredores.mjs — Lleva `profitRetentionPercent` a cero.
 *
 * PUNTO 5 de la instrucción 2. Cierra la última afirmación falsa del Informe Técnico:
 * el apartado 5.4 declara que "todo importe descontado se informa", y mientras `bo-au`
 * y `bo-cn-usd` carguen retención el desglose no suma el total detraído. Es verificable
 * pidiendo una cotización en esos corredores.
 *
 * ── Por qué un script y no el PATCH del panel ───────────────────────────────────
 *
 * `updateCorridor` registra en `changeLog` el campo, el valor anterior, el nuevo, el
 * responsable y la fecha — pero NO acepta un motivo: el campo `note` del esquema sólo
 * lo usa el cambio de tasa manual. La instrucción exige que el motivo quede asentado,
 * porque ese historial es el respaldo del Anexo D. Este script escribe la entrada
 * completa, con el mismo formato que produce el panel más la nota.
 *
 * No modifica código ni requiere despliegue: sólo datos.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────────
 *
 *   # 1. Ver qué cambiaría (no escribe nada)
 *   node scripts/alinear-retencion-corredores.mjs
 *
 *   # 2. Aplicar
 *   node scripts/alinear-retencion-corredores.mjs \
 *     --commit \
 *     --actor admin@alyto.app \
 *     --motivo "Subsanación ASFI/DSC/R-155901/2026 — apdo. 5.4: todo importe descontado se informa"
 *
 * Contra producción hay que agregar `--prod`, y la variable MONGODB_URI debe apuntar
 * ahí de forma explícita. Sin ese flag el script se niega a tocar `alyto-v2`.
 */

import mongoose from 'mongoose';

// ── Objetivo ───────────────────────────────────────────────────────────────────
//
// La retención va a CERO en ambos: eso es lo que cierra el apartado 5.4 y no admite
// discusión. Los demás valores alinean la estructura de cobros con la del resto de
// corredores (6,5% retail / 4% business, Bs 6 / Bs 10).
//

// La retención se PLIEGA dentro del spread: el consumidor paga exactamente lo mismo
// que hoy, y desaparece el importe que se descontaba sin informarse. Decisión del
// representante legal el 2026-08-23.
//
//   bo-au        1,5 % spread + 0,8 % retención  →  2,3 % spread, retención 0
//   bo-cn-usd    2,0 % spread + 1,0 % retención  →  3,0 % spread, retención 0
//                0,5 % business + 1,0 % retención →  1,5 % business
//
// La retención NO está segmentada por tipo de cuenta —`profitRetentionPercent` se
// aplica igual a retail y a business—, así que al plegarla hay que sumarla a AMBOS
// spreads donde el business esté configurado. En `bo-au` el spread business es 0 y
// cae por defecto al retail, de modo que plegar el retail alcanza.
//
// Las comisiones fijas no se tocan: no participan de la retención.

const OBJETIVO_POR_CORREDOR = {
  'bo-au': {
    profitRetentionPercent: 0,
    alytoCSpread:           2.3,
  },
  'bo-cn-usd': {
    profitRetentionPercent: 0,
    alytoCSpread:           3,
    businessAlytoCSpread:   1.5,
  },
  // Inactivo y fuera de los 23 corredores declarados, pero su prefijo lo identifica
  // como corredor de la sociedad boliviana. Un revisor que consulte la configuración
  // conforme al Art. 10° inc. e encontraría retención no informada en un corredor de
  // la entidad, y eso obliga a explicar una excepción evitable. Se pliega igual.
  'bo-za': {
    profitRetentionPercent: 0,
    alytoCSpread:           3,     // 2 % spread + 1 % retención
  },
};

const CORREDORES = Object.keys(OBJETIVO_POR_CORREDOR);

// ── Argumentos ─────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const has    = f => args.includes(f);
const valOf  = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const COMMIT = has('--commit');
const PROD   = has('--prod');
const ACTOR  = valOf('--actor');
const MOTIVO = valOf('--motivo');

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('✗ Falta MONGODB_URI'); process.exit(1); }

const esProduccion = /alyto-v2(?!-staging)/.test(uri);
if (esProduccion && !PROD) {
  console.error('✗ MONGODB_URI apunta a PRODUCCIÓN y no se pasó --prod.');
  console.error('  Operar sobre producción tiene que ser un acto explícito, no un descuido.');
  process.exit(1);
}

if (COMMIT && (!ACTOR || !MOTIVO)) {
  console.error('✗ --commit exige --actor y --motivo.');
  console.error('  Sin ellos el changeLog queda sin responsable ni motivo, que es');
  console.error('  justamente la evidencia que este cambio tiene que producir.');
  process.exit(1);
}

// ── Ejecución ──────────────────────────────────────────────────────────────────

await mongoose.connect(uri);
const col   = mongoose.connection.collection('transaction_configs');
const users = mongoose.connection.collection('users');

console.log('');
console.log(`  Base      : ${mongoose.connection.name}${esProduccion ? '  ⚠️  PRODUCCIÓN' : ''}`);
console.log(`  Modo      : ${COMMIT ? 'APLICAR' : 'simulación (no escribe)'}`);
if (COMMIT) {
  console.log(`  Responsable: ${ACTOR}`);
  console.log(`  Motivo    : ${MOTIVO}`);
}
console.log('');

let actorId = null;
if (COMMIT) {
  const u = await users.findOne({ email: ACTOR }, { projection: { _id: 1, role: 1 } });
  if (!u) { console.error(`✗ No existe el usuario ${ACTOR}`); await mongoose.disconnect(); process.exit(1); }
  if (u.role !== 'admin') { console.error(`✗ ${ACTOR} no tiene rol admin`); await mongoose.disconnect(); process.exit(1); }
  actorId = u._id;
}

/** Costo total sobre Bs 1.000, para ver el efecto real del cambio. */
const todoIncluido = (c) =>
  (Number(c.alytoCSpread ?? 0) + Number(c.profitRetentionPercent ?? 0)) * 10 + Number(c.fixedFee ?? 0);

let cambios = 0;

for (const corridorId of CORREDORES) {
  const c = await col.findOne({ corridorId });
  if (!c) { console.log(`  ⚠️  ${corridorId}: no existe\n`); continue; }

  const objetivo = OBJETIVO_POR_CORREDOR[corridorId];
  const diffs = Object.entries(objetivo)
    .filter(([campo, nuevo]) => Number(c[campo] ?? 0) !== Number(nuevo))
    .map(([campo, nuevo]) => ({ campo, anterior: c[campo] ?? 0, nuevo }));

  console.log(`  ── ${corridorId} ──`);
  if (diffs.length === 0) { console.log('     ya alineado\n'); continue; }

  for (const d of diffs) {
    const marca = d.campo === 'profitRetentionPercent' ? ' ← retención no informada' : '';
    console.log(`     ${d.campo.padEnd(24)} ${String(d.anterior).padStart(6)} → ${String(d.nuevo).padStart(6)}${marca}`);
  }

  const antes    = todoIncluido(c);
  const despues  = todoIncluido({ ...c, ...objetivo });
  console.log(`     ${'costo sobre Bs 1.000'.padEnd(24)} ${antes.toFixed(2).padStart(6)} → ${despues.toFixed(2).padStart(6)}  (${(despues - antes >= 0 ? '+' : '')}${(despues - antes).toFixed(2)})`);

  if (!COMMIT) { console.log(''); continue; }

  const ahora = new Date();
  const entradas = diffs.map(d => ({
    field:     d.campo,
    oldValue:  d.anterior,
    newValue:  d.nuevo,
    changedBy: actorId,
    changedAt: ahora,
    note:      MOTIVO,
  }));

  const r = await col.updateOne(
    { corridorId },
    { $set: { ...objetivo, updatedAt: ahora }, $push: { changeLog: { $each: entradas } } },
  );

  if (r.modifiedCount === 1) { cambios++; console.log(`     ✓ aplicado · ${entradas.length} entrada(s) en changeLog\n`); }
  else                        { console.log('     ✗ no se modificó\n'); }
}

// ── Verificación posterior ─────────────────────────────────────────────────────

if (COMMIT) {
  console.log('  ── verificación ──');
  let ok = true;
  for (const corridorId of CORREDORES) {
    const c = await col.findOne({ corridorId });
    if (!c) continue;
    const ret = Number(c.profitRetentionPercent ?? 0);
    const n   = (c.changeLog ?? []).filter(e => e.note === MOTIVO).length;
    console.log(`     ${corridorId.padEnd(12)} retención=${ret}  entradas de este cambio=${n}`);
    if (ret !== 0) ok = false;
  }
  console.log('');
  console.log(ok
    ? '  ✓ Retención en cero en ambos corredores. El apartado 5.4 queda sostenido.'
    : '  ✗ Quedó retención distinta de cero — REVISAR antes de presentar.');
  console.log(`  ✓ ${cambios} corredor(es) modificado(s)`);
} else {
  console.log('  Simulación. Para aplicar:');
  console.log('    node scripts/alinear-retencion-corredores.mjs --commit \\');
  console.log('      --actor <email-admin> --motivo "<motivo>"');
}

console.log('');
await mongoose.disconnect();
