#!/usr/bin/env node
/**
 * exportar-datos-anexos.mjs — vuelca en JSON los datos reales para armar los
 * Anexos A y D como documento de expediente. Sólo lectura.
 */
import mongoose from 'mongoose';
const uri = process.env.MONGODB_URI;
await mongoose.connect(uri);
const c = n => mongoose.connection.collection(n);

const out = { fecha: new Date().toISOString(), base: mongoose.connection.name };

// Operaciones de la campaña (A.4)
out.operaciones = await c('transactions').find({})
  .project({ alytoTransactionId: 1, legalEntity: 1, operationType: 1, status: 1,
             originCurrency: 1, destinationCurrency: 1, originalAmount: 1, failureCategory: 1, createdAt: 1 })
  .sort({ createdAt: 1 }).toArray();

// Tarifario de los 23 (A.7 / D.1)
out.tarifario = await c('transaction_configs').find({ legalEntity: 'SRL', isActive: true })
  .project({ corridorId: 1, destinationCountry: 1, destinationCurrency: 1, payoutMethod: 1,
             alytoCSpread: 1, fixedFee: 1, businessAlytoCSpread: 1, businessFixedFee: 1,
             profitRetentionPercent: 1, payinFeePercent: 1 })
  .sort({ corridorId: 1 }).toArray();

// Historial de comisiones del trámite (A.8 / D.2) — con fecha exacta e identificador
const conHist = await c('transaction_configs').find({ 'changeLog.note': /T-2201402987/ })
  .project({ corridorId: 1, changeLog: 1 }).toArray();
const hist = [];
for (const t of conHist) {
  for (const e of (t.changeLog ?? [])) {
    if (!/T-2201402987/.test(e.note ?? '')) continue;
    hist.push({
      corridor: t.corridorId, field: e.field,
      oldValue: e.oldValue, newValue: e.newValue,
      changedAt: e.changedAt, changedBy: e.changedBy ? String(e.changedBy) : null,
      note: e.note,
    });
  }
}
hist.sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
out.historial = hist;

// Correlación con la bitácora de administración (para dar un identificador de asiento a D.2)
out.auditRoleChanges = await c('admin_audit_logs')
  .find({}).project({ action: 1, actorEmail: 1, createdAt: 1 }).sort({ createdAt: 1 }).toArray();

console.log(JSON.stringify(out));
await mongoose.disconnect();
process.exit(0);
