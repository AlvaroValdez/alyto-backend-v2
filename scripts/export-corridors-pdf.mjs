#!/usr/bin/env node
/**
 * export-corridors-pdf.mjs — Exporta los corredores activos agrupados por proveedor
 * (payoutMethod) a un PDF imprimible. Fuente de verdad: TransactionConfig en MongoDB.
 *
 * USO: node --env-file=.env scripts/export-corridors-pdf.mjs
 * Genuina lectura (no escribe nada en la DB).
 */

import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('Falta MONGODB_URI'); process.exit(1); }

const dbName = (MONGODB_URI.match(/\/([^/?]+)(\?|$)/) ?? [])[1] ?? 'desconocida';

const PROVIDER_LABEL = {
  vitaWallet:    'Vita Wallet',
  owlPay:        'OwlPay Harbor',
  anchorBolivia: 'Anchor Bolivia (manual SRL)',
  rampNetwork:   'Ramp Network',
  stellar_direct:'Stellar directo',
  manual:        'Manual',
};

await mongoose.connect(MONGODB_URI);
const col = mongoose.connection.collection('transaction_configs');
const docs = await col.find({}).toArray();

// Agrupar por payoutMethod
const groups = {};
for (const d of docs) {
  const k = d.payoutMethod ?? 'sin_payoutMethod';
  (groups[k] ??= []).push(d);
}
for (const k of Object.keys(groups)) {
  groups[k].sort((a, b) => (a.corridorId ?? '').localeCompare(b.corridorId ?? ''));
}

// ── PDF ──
const out = 'corredores-router-alyto.pdf';
const doc = new PDFDocument({ size: 'A4', margin: 40 });
doc.pipe(createWriteStream(out));

const NAVY = '#1D3461', GRAY = '#64748B', GREEN = '#16A34A', RED = '#DC2626';

doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text('Alyto — Corredores por Proveedor');
doc.font('Helvetica').fontSize(9).fillColor(GRAY)
   .text(`Fuente: TransactionConfig (DB: ${dbName}) · Total: ${docs.length} corredores · Generado por export-corridors-pdf`);
doc.moveDown(0.5);

const ORDER = ['vitaWallet', 'owlPay', 'anchorBolivia', 'rampNetwork', 'stellar_direct', 'manual', 'sin_payoutMethod'];
const providers = Object.keys(groups).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

for (const prov of providers) {
  const list = groups[prov];
  const activos = list.filter(c => c.isActive !== false).length;
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY)
     .text(`${PROVIDER_LABEL[prov] ?? prov}  —  ${list.length} corredores (${activos} activos)`);
  doc.moveDown(0.2);

  // Encabezado de columnas
  const cols = [
    { x: 40,  w: 130, t: 'Corredor' },
    { x: 170, w: 90,  t: 'Ruta' },
    { x: 260, w: 130, t: 'Monedas' },
    { x: 390, w: 80,  t: 'Payin' },
    { x: 470, w: 90,  t: 'Estado' },
  ];
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY);
  for (const c of cols) doc.text(c.t, c.x, doc.y, { width: c.w, continued: false, lineBreak: false });
  doc.moveDown(0.3);
  let y = doc.y;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#E2E8F0').stroke();
  doc.moveDown(0.2);

  for (const c of list) {
    if (doc.y > 770) { doc.addPage(); }
    const rowY = doc.y;
    const active = c.isActive !== false;
    doc.font('Helvetica').fontSize(8).fillColor('#1A1A1A');
    doc.text(c.corridorId ?? '—', cols[0].x, rowY, { width: cols[0].w, lineBreak: false });
    doc.text(`${c.originCountry ?? '?'}→${c.destinationCountry ?? '?'}`, cols[1].x, rowY, { width: cols[1].w, lineBreak: false });
    doc.text(`${c.originCurrency ?? '?'}→${c.destinationCurrency ?? '?'}`, cols[2].x, rowY, { width: cols[2].w, lineBreak: false });
    doc.text(c.payinMethod ?? '—', cols[3].x, rowY, { width: cols[3].w, lineBreak: false });
    doc.fillColor(active ? GREEN : RED).text(active ? 'Activo' : 'Inactivo', cols[4].x, rowY, { width: cols[4].w, lineBreak: false });
    doc.moveDown(0.45);
  }
}

doc.end();
await new Promise(r => doc.on('end', r));
await mongoose.disconnect();
console.log(`✅ PDF generado: ${out} (${docs.length} corredores)`);
