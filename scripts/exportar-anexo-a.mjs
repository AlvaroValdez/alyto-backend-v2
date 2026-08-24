#!/usr/bin/env node
/**
 * exportar-anexo-a.mjs — Cuatro exportaciones del Anexo A (instrucción 20).
 *
 * Produce, desde la base de producción, cuatro piezas del expediente. Sólo lee;
 * no modifica nada. Cada pieza se imprime como tabla para incorporarse al anexo.
 *
 *   4  Registro de operaciones de la campaña de pruebas
 *   5  Registro de incidencias con causa raíz
 *   7  Tarifario vigente, ACOTADO al perímetro de 23 corredores
 *   8  Historial de comisiones del trámite completo
 */

import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('✗ Falta MONGODB_URI'); process.exit(1); }
await mongoose.connect(uri);
const c = n => mongoose.connection.collection(n);

const fecha = new Date().toISOString();
const sep = t => console.log(`\n\n══════ ${t} ══════\n`);

console.log(`Anexo A — exportaciones desde producción · base ${mongoose.connection.name} · ${fecha}`);

// ── 4 · Registro de operaciones de la campaña ─────────────────────────────────

sep('4 · REGISTRO DE OPERACIONES DE LA CAMPAÑA DE PRUEBAS');
const ops = await c('transactions').find({})
  .project({ alytoTransactionId: 1, legalEntity: 1, operationType: 1, status: 1,
             originCurrency: 1, destinationCurrency: 1, originalAmount: 1,
             failureCategory: 1, createdAt: 1 })
  .sort({ createdAt: 1 }).toArray();

console.log(`Total de operaciones: ${ops.length}`);
const porEstado = {};
for (const o of ops) porEstado[o.status] = (porEstado[o.status] ?? 0) + 1;
console.log('Por estado: ' + Object.entries(porEstado).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log('');
console.log('| # | Identificador | Entidad | Tipo | Origen→Destino | Monto | Estado | Causa | Fecha |');
console.log('|---|---|---|---|---|---:|---|---|---|');
ops.forEach((o, i) => {
  console.log(`| ${i + 1} | ${o.alytoTransactionId ?? '—'} | ${o.legalEntity ?? '—'} | ${o.operationType ?? '—'} | ${(o.originCurrency ?? '?')}→${(o.destinationCurrency ?? '?')} | ${o.originalAmount ?? '—'} | ${o.status} | ${o.failureCategory ?? '—'} | ${o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 10) : '—'} |`);
});

// ── 5 · Registro de incidencias con causa raíz ────────────────────────────────

sep('5 · REGISTRO DE INCIDENCIAS CON CAUSA RAÍZ Y CORRECCIÓN');
const colecciones = new Set((await mongoose.connection.db.listCollections().toArray()).map(x => x.name));

let incidentes = [];
if (colecciones.has('incidents')) {
  incidentes = await c('incidents').find({}).sort({ createdAt: 1 }).toArray();
}
if (incidentes.length) {
  console.log('| # | Tipo | Causa | Determinación | Corrección | Fecha |');
  console.log('|---|---|---|---|---|---|');
  incidentes.forEach((x, i) => console.log(`| ${i + 1} | ${x.type ?? '—'} | ${x.causeCategory ?? x.cause ?? '—'} | ${x.determination ?? '—'} | ${x.correction ?? '—'} | ${x.createdAt ? new Date(x.createdAt).toISOString().slice(0, 10) : '—'} |`));
} else {
  console.log('La colección de incidentes no registra asientos: no se materializó ningún incidente');
  console.log('durante la campaña de pruebas técnicas internas.');
  console.log('');
  console.log('Las operaciones fallidas de la campaña se reconstruyen desde su causa de fallo');
  console.log('persistida (columna "Causa" de la pieza 4). Agrupadas por causa raíz:');
  const conCausa = ops.filter(o => o.failureCategory);
  const porCausa = {};
  for (const o of conCausa) porCausa[o.failureCategory] = (porCausa[o.failureCategory] ?? 0) + 1;
  console.log('');
  if (Object.keys(porCausa).length) {
    console.log('| Causa raíz | Operaciones |');
    console.log('|---|---:|');
    for (const [k, v] of Object.entries(porCausa)) console.log(`| ${k} | ${v} |`);
  } else {
    console.log('(sin operaciones con causa de fallo persistida)');
  }
}

// ── 7 · Tarifario vigente, acotado a los 23 corredores ────────────────────────

sep('7 · TARIFARIO VIGENTE — PERÍMETRO DE 23 CORREDORES DE LA SOCIEDAD BOLIVIANA');
console.log('Criterio de selección: corredores activos de AV Finance S.R.L. (legalEntity=SRL,');
console.log('isActive=true). Se excluyen deliberadamente los corredores de otras sociedades del');
console.log('grupo y los inactivos, por estar fuera del perímetro declarado en el apdo. 4.7.');
console.log('');
const corredores = await c('transaction_configs')
  .find({ legalEntity: 'SRL', isActive: true })
  .project({ corridorId: 1, destinationCountry: 1, destinationCurrency: 1, payoutMethod: 1,
             payinFeePercent: 1, alytoCSpread: 1, businessAlytoCSpread: 1,
             fixedFee: 1, businessFixedFee: 1, profitRetentionPercent: 1, payoutFeeFixed: 1 })
  .sort({ corridorId: 1 }).toArray();
console.log(`Corredores en el tarifario: ${corredores.length}`);
console.log('');
console.log('| Corredor | Destino | Riel | Spread retail | Fija retail | Spread business | Fija business | Retención |');
console.log('|---|---|---|---:|---:|---:|---:|---:|');
for (const t of corredores) {
  const riel = t.payoutMethod === 'vitaWallet' ? 'LatAm' : t.payoutMethod === 'owlPay' ? 'Internac.' : t.payoutMethod;
  console.log(`| ${t.corridorId} | ${t.destinationCountry}/${t.destinationCurrency} | ${riel} | ${t.alytoCSpread ?? 0}% | ${t.fixedFee ?? 0} | ${t.businessAlytoCSpread ?? 0}% | ${t.businessFixedFee ?? 0} | ${t.profitRetentionPercent ?? 0}% |`);
}

// ── 8 · Historial de comisiones del trámite ───────────────────────────────────

sep('8 · HISTORIAL DE CAMBIOS DE COMISIONES — TRÁMITE T-2201402987');
const conHistorial = await c('transaction_configs')
  .find({ 'changeLog.note': /T-2201402987/ })
  .project({ corridorId: 1, legalEntity: 1, changeLog: 1 })
  .toArray();

const entradas = [];
for (const t of conHistorial) {
  for (const e of (t.changeLog ?? [])) {
    if (!/T-2201402987/.test(e.note ?? '')) continue;
    entradas.push({ corridorId: t.corridorId, ...e });
  }
}
entradas.sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
console.log(`Corredores con asientos del trámite: ${conHistorial.length} · entradas totales: ${entradas.length}`);
console.log('');
console.log('| # | Corredor | Campo | Valor anterior | Valor nuevo | Fecha | Motivo |');
console.log('|---|---|---|---|---|---|---|');
entradas.forEach((e, i) => {
  console.log(`| ${i + 1} | ${e.corridorId} | ${e.field} | ${JSON.stringify(e.oldValue)} | ${JSON.stringify(e.newValue)} | ${e.changedAt ? new Date(e.changedAt).toISOString().slice(0, 10) : '—'} | ${(e.note ?? '').slice(0, 80)} |`);
});

console.log('');
await mongoose.disconnect();
process.exit(0);
