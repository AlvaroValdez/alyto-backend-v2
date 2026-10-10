/**
 * devolucionEvidencia.test.js
 *
 * `getBOBCommitted` solo deja de contar un monto como pasivo si hay EVIDENCIA de
 * que el dinero volvió. Estas pruebas fijan qué cuenta como evidencia y qué no.
 *
 * El caso que forzó aceptar la referencia bancaria: los Bs 246 de
 * ALY-C-1791067601018-KCU3DZ se devolvieron el 2026-10-06 por transferencia
 * (débito ACH QR, documento 410375644). Como una devolución bancaria no deja
 * movimiento de billetera, exigir solo `wtxId` convertía una devolución real en
 * una deuda eterna.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/devolucionEvidencia.test.js
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const Transaction = (await import('../../src/models/Transaction.js')).default;
const { getBOBCommitted } = await import('../../src/services/treasuryLiquidity.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => { await Transaction.deleteMany({}); });

/** Operación cobrada (payin confirmado a mano) que no se ejecutó. */
async function cobradaYNoEjecutada(extra = {}) {
  return Transaction.create({
    alytoTransactionId: `ALY-C-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId:         new mongoose.Types.ObjectId(),
    operationType:  'crossBorderPayment',
    legalEntity:    'SRL',
    originCurrency: 'BOB',
    originalAmount: 246,
    status:         'failed',
    confirmationDetails: { confirmedAt: new Date() },
    ...extra,
  });
}

describe('qué cuenta como evidencia de devolución', () => {
  test('sin devolución, el monto es pasivo', async () => {
    await cobradaYNoEjecutada();
    await expect(getBOBCommitted('SRL')).resolves.toMatchObject({ committed: 246, operations: 1 });
  });

  test("'refunded' a secas NO alcanza: sigue siendo pasivo", async () => {
    // Es el caso real que motivó el campo: el estado se puede poner a mano sin
    // mover un centavo.
    await cobradaYNoEjecutada({ status: 'refunded' });
    await expect(getBOBCommitted('SRL')).resolves.toMatchObject({ committed: 246, refundedUnproven: 246 });
  });

  test('con wtxId (devolución a billetera) deja de ser pasivo', async () => {
    await cobradaYNoEjecutada({ status: 'refunded', refund: { method: 'walletBOB', wtxId: 'WTX-1', amount: 246 } });
    await expect(getBOBCommitted('SRL')).resolves.toMatchObject({ committed: 0, operations: 0 });
  });

  test('con bankReference (devolución por transferencia) deja de ser pasivo', async () => {
    // Lo que antes no se podía registrar y dejaba la deuda viva para siempre.
    await cobradaYNoEjecutada({
      status: 'refunded',
      refund: { method: 'bankTransfer', bankReference: '410375644', amount: 246 },
    });
    await expect(getBOBCommitted('SRL')).resolves.toMatchObject({ committed: 0, operations: 0 });
  });

  test('un refund sin ninguna de las dos evidencias NO libera', async () => {
    await cobradaYNoEjecutada({
      status: 'refunded',
      refund: { method: 'external', reason: 'dice que se devolvió', amount: 246 },
    });
    await expect(getBOBCommitted('SRL')).resolves.toMatchObject({ committed: 246 });
  });

  test('una referencia vacía no se toma como evidencia', async () => {
    await cobradaYNoEjecutada({
      status: 'refunded',
      refund: { method: 'bankTransfer', bankReference: '', wtxId: '', amount: 246 },
    });
    await expect(getBOBCommitted('SRL')).resolves.toMatchObject({ committed: 246 });
  });

  test('el comprobante se guarda junto a la evidencia', async () => {
    const t = await cobradaYNoEjecutada({
      status: 'refunded',
      refund: {
        method: 'bankTransfer', bankReference: '410375644', amount: 246,
        proof: { data: Buffer.from('pdf'), filename: 'dev.pdf', mimetype: 'application/pdf', uploadedAt: new Date() },
      },
    });
    const leida = await Transaction.findById(t._id).lean();
    expect(leida.refund.proof.filename).toBe('dev.pdf');
    expect(leida.refund.proof.mimetype).toBe('application/pdf');
  });
});
