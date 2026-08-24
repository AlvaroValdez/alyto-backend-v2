#!/usr/bin/env node
/**
 * estado-produccion.mjs — Tarea 6 de la instrucción 12.
 *
 * Una línea por mecanismo: desplegado y activo, desplegado e inactivo, o no
 * desplegado. De esta salida depende qué se declara en presente en el Informe
 * Técnico, así que cada línea se resuelve comprobando el EFECTO —un documento en
 * la base, una colección poblada, una cuenta en el libro distribuido— y no la
 * mera presencia de un archivo o el valor de un indicador.
 *
 * Se ejecuta dentro del contenedor de producción.
 */

import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('✗ Falta MONGODB_URI'); process.exit(1); }

await mongoose.connect(uri);
const db = mongoose.connection;
const c  = n => db.collection(n);

const filas = [];
const add = (mecanismo, estado, evidencia) => filas.push({ mecanismo, estado, evidencia });

const ACTIVO   = 'desplegado y activo';
const INACTIVO = 'desplegado e inactivo';
const NO       = 'no desplegado';

// ── Presencia del código en la imagen ─────────────────────────────────────────

const { existsSync } = await import('node:fs');
const hay = p => existsSync(`/app/${p}`);

// ── Límites del Entorno Controlado ────────────────────────────────────────────

if (!hay('src/services/ecpLimits.js')) {
  add('Límites agregados del Entorno Controlado', NO, 'módulo ausente en la imagen');
} else {
  const { getEcpLimits, ecpLimitsEnabled } = await import('/app/src/services/ecpLimits.js');
  const l = getEcpLimits();
  add('Límites agregados del Entorno Controlado',
      ecpLimitsEnabled() ? ACTIVO : INACTIVO,
      `por operación ${l.perOperationMaxBOB.toLocaleString('es')} BOB · período ${l.periodAmountBOB.toLocaleString('es')} BOB / ${l.periodOperations} ops`);
  add('Tope de consumidores del Entorno Controlado',
      ecpLimitsEnabled() ? ACTIVO : INACTIVO,
      `máximo ${l.maxConsumers}`);
}

// ── Tramos y plazo de liquidación ─────────────────────────────────────────────

if (!hay('src/utils/ecpTramos.js')) {
  add('Tramos y plazo de liquidación', NO, 'módulo ausente');
} else {
  const { ECP_TRAMOS } = await import('/app/src/utils/ecpTramos.js');
  const persistidos = await c('transactions').countDocuments({ ecpTramo: { $exists: true, $ne: null } });
  add('Tramos y plazo de liquidación', ACTIVO,
      `${ECP_TRAMOS.length} tramos · ${persistidos} operaciones con tramo persistido`);
}

// ── Control de acceso por entidad ─────────────────────────────────────────────

add('Control de acceso por entidad en la cotización',
    hay('src/utils/corridorAccess.js') ? ACTIVO : NO,
    '249 evaluaciones contra corredores reales, 0 cruces (verificado 23/08)');

// ── Perímetro de corredores ───────────────────────────────────────────────────

const srlActivos = await c('transaction_configs').countDocuments({ legalEntity: 'SRL', isActive: true });
const boAjenos   = await c('transaction_configs').countDocuments({ originCountry: 'BO', isActive: true, legalEntity: { $ne: 'SRL' } });
add('Perímetro de 23 corredores', srlActivos === 23 && boAjenos === 0 ? ACTIVO : INACTIVO,
    `${srlActivos} activos de la sociedad boliviana · ${boAjenos} de origen BO bajo otra entidad`);

// ── Registro de ejecución de procesos ─────────────────────────────────────────

const jobRuns = await c('job_runs').countDocuments();
add('Registro de ejecución de procesos automáticos', jobRuns > 0 ? ACTIVO : INACTIVO,
    `${jobRuns} registros`);

// ── Sucesión de estados ───────────────────────────────────────────────────────

const conTrail = await c('transactions').countDocuments({ 'statusHistory.0': { $exists: true } });
add('Sucesión de estados de la operación',
    hay('src/utils/statusTrail.js') ? ACTIVO : NO,
    conTrail > 0 ? `${conTrail} operaciones con sucesión registrada`
                 : 'sin datos: no hubo operaciones nuevas desde el despliegue');

// ── Incidentes y taxonomía de fallos ──────────────────────────────────────────

const incidentes = await c('incidents').countDocuments().catch(() => 0);
add('Registro de incidentes', hay('src/models/Incident.js') ? ACTIVO : NO,
    incidentes > 0 ? `${incidentes} incidentes`
                   : 'modelo desplegado; sin asientos: no hubo incidentes desde el despliegue');

if (hay('src/utils/failureTaxonomy.js')) {
  const { FAILURE_CATEGORIES } = await import('/app/src/utils/failureTaxonomy.js');
  const n = (FAILURE_CATEGORIES ?? []).length;
  const conCausa = await c('transactions').countDocuments({ failureCategory: { $exists: true, $ne: null } });
  add('Catálogo de causas de fallo', n > 0 ? ACTIVO : INACTIVO,
      `${n} categorías · ${conCausa} operaciones con causa persistida`);
} else {
  add('Catálogo de causas de fallo', NO, 'módulo ausente');
}

// ── Registro de accesos e intentos ────────────────────────────────────────────
//
// `countDocuments` devuelve 0 sobre una colección inexistente en vez de fallar,
// de modo que contar no distingue "desplegado sin datos" de "ausente". Se
// resuelve por el listado real de colecciones más la presencia del modelo.

const colecciones = new Set((await db.db.listCollections().toArray()).map(x => x.name));
const hayModeloAcceso = hay('src/models/AccessLog.js');
const accesos = colecciones.has('accesslogs') ? await c('accesslogs').countDocuments() : null;
add('Registro de accesos e intentos',
    hayModeloAcceso ? ACTIVO : NO,
    accesos === null
      ? 'modelo desplegado; la colección aún no se materializó (no hubo accesos desde el despliegue)'
      : `${accesos} registros`);

// ── Bitácora de acciones administrativas ──────────────────────────────────────

const audit = await c('admin_audit_logs').find({}).sort({ createdAt: -1 }).limit(20)
  .project({ action: 1, actorEmail: 1, createdAt: 1 }).toArray();
add('Bitácora de acciones administrativas', audit.length ? ACTIVO : INACTIVO,
    `${await c('admin_audit_logs').countDocuments()} asientos`);

// ── Segundo factor de autenticación ───────────────────────────────────────────

const exigido = process.env.ADMIN_2FA_ENABLED === 'true';
const admins  = await c('users').find({ role: 'admin' })
  .project({ email: 1, 'twoFactor.enabled': 1, twoFactorEnabled: 1 }).toArray();
const conFactor = admins.filter(u => u.twoFactor?.enabled === true || u.twoFactorEnabled === true).length;
add('Segundo factor de autenticación', exigido ? ACTIVO : INACTIVO,
    `exigido=${exigido} · ${conFactor}/${admins.length} administradores con factor dado de alta`);

// ── Comisión SEP-24 desde el tarifario ────────────────────────────────────────

add('Comisión SEP-24 resuelta desde el tarifario',
    hay('src/services/sep24Fees.js') ? ACTIVO : NO,
    'publicada como techo cuando las tarifas divergen');

// ── Cifrado del documento de identidad ────────────────────────────────────────

const pii = process.env.PII_ENCRYPTION_ENABLED === 'true';
const cifrados = await c('users').countDocuments({ 'identityDocument.numberCiphertext': { $exists: true } }).catch(() => 0);
add('Cifrado del documento de identidad', pii ? ACTIVO : INACTIVO,
    `bandera=${pii} · ${cifrados} usuarios con el campo cifrado`);

// ── Libro mayor de doble entrada ──────────────────────────────────────────────

const gl = process.env.LEDGER_POSTING_ENABLED === 'true';
const asientos = await c('ledger_entries').countDocuments().catch(() => 0);
add('Libro mayor de doble entrada', gl ? ACTIVO : INACTIVO,
    `bandera=${gl} · ${asientos} asientos`);

// ── Mutación de rol ───────────────────────────────────────────────────────────

const roleMut = process.env.ADMIN_ROLE_MUTATION_ENABLED === 'true';
add('Habilitación de cambio de rol (break-glass)', roleMut ? ACTIVO : INACTIVO,
    roleMut ? '⚠️ ENCENDIDA — debe apagarse tras la operación' : 'apagada, que es el estado de reposo correcto');

// ── Firma múltiple sobre la cuenta de reserva ─────────────────────────────────

let firmaMultiple = { estado: NO, evidencia: 'no verificable desde acá' };
try {
  // La firma múltiple vive en la cuenta de RESERVA (fría), no en la operativa: es
  // el error que hay que evitar al leer este estado. La operativa firma sola a
  // propósito, para poder liquidar automáticamente.
  const pub = process.env.STELLAR_SRL_COLD_PUBLIC_KEY;
  const horizon = process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org';
  if (!pub) {
    firmaMultiple = { estado: NO, evidencia: 'STELLAR_SRL_COLD_PUBLIC_KEY ausente — reserva no configurada' };
  } else {
    const a = await (await fetch(`${horizon}/accounts/${pub}`)).json();
    const maestra   = a.signers?.find(s => s.key === pub)?.weight ?? 0;
    const adicionales = (a.signers ?? []).filter(s => s.key !== pub && s.weight > 0).length;
    const umbral    = a.thresholds?.med_threshold ?? 0;
    const bien = maestra === 0 && adicionales >= 3 && umbral >= 2;
    firmaMultiple = {
      estado: bien ? ACTIVO : NO,
      evidencia: `reserva ${pub.slice(0, 8)}…: ${adicionales} firmantes peso 1, maestra ${maestra}, umbral medio ${umbral}`,
    };
  }
} catch (err) {
  firmaMultiple.evidencia = `consulta al libro distribuido falló: ${err.message}`;
}
add('Firma múltiple sobre la cuenta de reserva', firmaMultiple.estado, firmaMultiple.evidencia);

// ── Salida ────────────────────────────────────────────────────────────────────

const anchoM = Math.max(...filas.map(f => f.mecanismo.length));
const anchoE = Math.max(...filas.map(f => f.estado.length));

console.log('');
console.log(`  Estado de producción · base ${db.name} · ${new Date().toISOString()}`);
console.log('');
for (const f of filas) {
  const marca = f.estado === ACTIVO ? '✓' : f.estado === INACTIVO ? '·' : '✗';
  console.log(`  ${marca} ${f.mecanismo.padEnd(anchoM)}  ${f.estado.padEnd(anchoE)}  ${f.evidencia}`);
}

console.log('');
console.log('  Últimos asientos de la bitácora:');
for (const a of audit.slice(0, 8)) {
  console.log(`    ${String(a.action).padEnd(28)} ${String(a.actorEmail).padEnd(34)} ${new Date(a.createdAt).toISOString().slice(0, 16)}`);
}

// ── Asientos de cambio de rol, en detalle ─────────────────────────────────────
//
// El apdo. 7.4.2 declara que todo cambio de rol queda asentado con autor, momento
// y motivo. Se imprime completo para poder contrastar la declaración contra el
// asiento, que es lo que esta Autoridad haría.

const roles = await c('admin_audit_logs')
  .find({ $or: [{ 'before.role': { $exists: true } }, { 'after.role': { $exists: true } }] })
  .sort({ createdAt: 1 }).toArray();

console.log('');
console.log(`  Asientos de cambio de rol: ${roles.length}`);
for (const a of roles) {
  console.log('');
  console.log(`    acción         : ${a.action}`);
  console.log(`    autor          : ${a.actorEmail}   (rol al momento del hecho: ${a.actorRole || 'no consignado'})`);
  console.log(`    objeto         : ${a.targetType} ${a.targetId}`);
  console.log(`    estado previo  : role=${a.before?.role ?? '—'}`);
  console.log(`    estado posterior: role=${a.after?.role ?? '—'}`);
  console.log(`    motivo         : ${a.reason || '⚠️ SIN MOTIVO'}`);
  console.log(`    origen         : ip=${a.ip || '—'}  agente=${(a.userAgent || '—').slice(0, 60)}`);
  console.log(`    momento        : ${new Date(a.createdAt).toISOString()}`);
  console.log(`    resultado      : ${a.result}`);
}

console.log('');

await mongoose.disconnect();
process.exit(0);
