#!/usr/bin/env node
/**
 * cerrar-perimetro-corredores.mjs — Tareas 1 y 3 de la instrucción 8.
 *
 * TAREA 1 — Desactivar `bo-br-llc`, `bo-mx-llc` y `bo-eu`.
 *
 * Son corredores de origen Bolivia, denominados en bolivianos, bajo entidad LLC. Tres
 * razones concurrentes, y la tercera es la determinante:
 *
 *   1. Contradicen el Convenio Marco Intragrupo, que declara ante ASFI que AV Finance,
 *      LLC no contrata con consumidores financieros bolivianos ni presta servicio en
 *      territorio boliviano.
 *   2. Contradicen la regla de un proveedor por destino del apdo. 4.7.1: Brasil y
 *      México ya integran el perímetro declarado de 23 corredores.
 *   3. Constituyen una ruta que ELUDE los límites del Entorno Controlado: la agregación
 *      de consumo filtra por entidad `SRL`, de modo que una operación cursada por esa
 *      vía no suma al tope diario ni al del período.
 *
 * La corrección del control de acceso (28e85c0) cierra el caso desde el código. La
 * desactivación lo cierra desde la configuración. Las dos, porque el Art. 10° inc. e
 * faculta a revisar ambas.
 *
 * TAREA 3 — Corregir la entidad del usuario administrador a SRL.
 *
 * `v.alvaro.r@gmail.com` figura con entidad SpA siendo el único administrador del
 * servicio boliviano. El expediente declara que la sociedad chilena no interviene
 * frente al consumidor boliviano: es una inconsistencia visible para un revisor.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/cerrar-perimetro-corredores.mjs --prod
 *   node scripts/cerrar-perimetro-corredores.mjs --prod --commit --actor <email>
 *
 * NO eleva roles. La elevación del Responsable de Cumplimiento se hace por el panel,
 * por la vía auditada, y la ejecuta el representante legal.
 */

import mongoose from 'mongoose';

const CORREDORES_A_DESACTIVAR = ['bo-br-llc', 'bo-mx-llc', 'bo-eu'];

const MOTIVO_CORREDORES =
  'Aplicación de la regla de un proveedor por destino declarada ante ASFI, trámite ' +
  'T-2201402987. Destinos atendidos por corredores del perímetro declarado.';

const USUARIO_ADMIN   = 'v.alvaro.r@gmail.com';
const ENTIDAD_CORRECTA = 'SRL';
const MOTIVO_ENTIDAD  =
  'Corrección de entidad del usuario administrador a la sociedad prestadora del ' +
  'servicio, trámite T-2201402987.';

// ── Argumentos y guardas ───────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const has   = f => args.includes(f);
const valOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const COMMIT = has('--commit');
const PROD   = has('--prod');
const ACTOR  = valOf('--actor');

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('✗ Falta MONGODB_URI'); process.exit(1); }

const esProduccion = /alyto-v2(?!-staging)/.test(uri);
if (esProduccion && !PROD) {
  console.error('✗ MONGODB_URI apunta a PRODUCCIÓN y no se pasó --prod.');
  process.exit(1);
}
if (COMMIT && !ACTOR) {
  console.error('✗ --commit exige --actor: sin responsable, el asiento de auditoría no sirve.');
  process.exit(1);
}

await mongoose.connect(uri);
const col   = mongoose.connection.collection('transaction_configs');
const users = mongoose.connection.collection('users');
const audit = mongoose.connection.collection('admin_audit_logs');

console.log('');
console.log(`  Base   : ${mongoose.connection.name}${esProduccion ? '  ⚠️  PRODUCCIÓN' : ''}`);
console.log(`  Modo   : ${COMMIT ? 'APLICAR' : 'simulación (no escribe)'}`);
if (COMMIT) console.log(`  Actor  : ${ACTOR}`);
console.log('');

let actor = null;
if (COMMIT) {
  actor = await users.findOne({ email: ACTOR }, { projection: { _id: 1, email: 1, role: 1 } });
  if (!actor)                 { console.error(`✗ No existe ${ACTOR}`); await mongoose.disconnect(); process.exit(1); }
  if (actor.role !== 'admin') { console.error(`✗ ${ACTOR} no tiene rol admin`); await mongoose.disconnect(); process.exit(1); }
}

const ahora = new Date();

// ── Tarea 1 ────────────────────────────────────────────────────────────────────

console.log('  ══ Tarea 1 · desactivar corredores fuera del perímetro ══');
for (const corridorId of CORREDORES_A_DESACTIVAR) {
  const c = await col.findOne({ corridorId });
  if (!c)             { console.log(`   ${corridorId.padEnd(12)} no existe`);        continue; }
  if (!c.isActive)    { console.log(`   ${corridorId.padEnd(12)} ya inactivo`);      continue; }

  console.log(`   ${corridorId.padEnd(12)} isActive  true → false   (${c.legalEntity}, origen ${c.originCountry})`);
  if (!COMMIT) continue;

  const r = await col.updateOne(
    { corridorId },
    {
      $set:  { isActive: false, deletedAt: ahora, updatedAt: ahora },
      $push: { changeLog: {
        field: 'isActive', oldValue: true, newValue: false,
        changedBy: actor._id, changedAt: ahora, note: MOTIVO_CORREDORES,
      } },
    },
  );
  console.log(r.modifiedCount === 1 ? '                ✓ desactivado, 1 entrada en changeLog'
                                    : '                ✗ no se modificó');
}

// ── Tarea 3 ────────────────────────────────────────────────────────────────────

console.log('');
console.log('  ══ Tarea 3 · entidad del usuario administrador ══');
const u = await users.findOne({ email: USUARIO_ADMIN }, { projection: { _id:1, email:1, role:1, legalEntity:1 } });
if (!u) {
  console.log(`   ${USUARIO_ADMIN} no existe`);
} else if (u.legalEntity === ENTIDAD_CORRECTA) {
  console.log(`   ${USUARIO_ADMIN} ya está en ${ENTIDAD_CORRECTA}`);
} else {
  console.log(`   ${USUARIO_ADMIN}  legalEntity  ${u.legalEntity} → ${ENTIDAD_CORRECTA}`);
  if (COMMIT) {
    await users.updateOne({ _id: u._id }, { $set: { legalEntity: ENTIDAD_CORRECTA, updatedAt: ahora } });
    // Asiento en la bitácora de acciones administrativas, con el mismo formato que
    // produce `recordAdminAction`. No es un cambio de rol: es de entidad, y el
    // endpoint del panel no lo cubre.
    await audit.insertOne({
      actorId: actor._id, actorEmail: actor.email, actorRole: actor.role,
      action: 'user.legalEntity.changed', targetType: 'User', targetId: String(u._id),
      before: { legalEntity: u.legalEntity }, after: { legalEntity: ENTIDAD_CORRECTA },
      reason: MOTIVO_ENTIDAD, ip: null, userAgent: 'script:cerrar-perimetro-corredores',
      result: 'success', errorMessage: null, createdAt: ahora, updatedAt: ahora,
    });
    console.log('                ✓ corregido, 1 asiento en la bitácora de auditoría');
  }
}

// ── Verificación ───────────────────────────────────────────────────────────────

if (COMMIT) {
  console.log('');
  console.log('  ══ verificación ══');

  const srlAct = await col.countDocuments({ legalEntity: 'SRL', isActive: true });
  console.log(`   corredores SRL activos                      : ${srlAct}${srlAct === 23 ? '  ✓ coincide con el apdo. 4.7' : '  ⚠️ el apdo. 4.7 declara 23'}`);

  const boOtros = await col.find({ originCountry: 'BO', isActive: true, legalEntity: { $ne: 'SRL' } })
    .project({ corridorId: 1, legalEntity: 1 }).toArray();
  console.log(`   corredores activos origen BO de otra entidad : ${boOtros.length}${boOtros.length === 0 ? '  ✓' : '  ⚠️ ' + boOtros.map(x => x.corridorId).join(', ')}`);

  const adm = await users.findOne({ email: USUARIO_ADMIN }, { projection: { legalEntity: 1 } });
  console.log(`   entidad del usuario administrador            : ${adm?.legalEntity}${adm?.legalEntity === 'SRL' ? '  ✓' : '  ⚠️'}`);

  const n = await col.countDocuments({ 'changeLog.note': /T-2201402987/ });
  console.log(`   corredores con asientos del trámite          : ${n}`);
} else {
  console.log('');
  console.log('  Simulación. Para aplicar:');
  console.log('    node scripts/cerrar-perimetro-corredores.mjs --prod --commit --actor <email-admin>');
}

console.log('');
await mongoose.disconnect();
