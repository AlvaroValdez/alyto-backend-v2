/**
 * depositoQrBancario.test.js
 *
 * El camino de carga de saldo BOB por QR bancario NO tenía prueba de
 * integración, y eso costó caro: el 2026-10-10 se desplegó un `const cuenta`
 * declarado dentro del `try` y usado después del `catch`, lo que rompía TODO
 * depósito con `500 cuenta is not defined`. La suite pasó en verde con el bug
 * adentro durante cuatro días, hasta que un usuario real lo reportó.
 *
 * Estas pruebas recorren `initiateDeposit` de verdad, con sus modelos reales,
 * mockeando solo las fronteras externas (el banco y la lectura de la cuenta).
 * Un error de alcance como aquel revienta acá de inmediato.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/depositoQrBancario.test.js
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.WALLET_DEPOSIT_BANKQR_ENABLED = 'true';
process.env.BEC_ACCOUNT_CREDIT = '2111088816';

let qrGenerado = { qrId: '26101401016728173568', qrImage: 'iVBORw0KGgo=' };
let generarFalla = null;
const cuentaDevuelta = {
  bankName: 'Banco Económico', accountHolder: 'AV FINANCE SRL',
  accountNumber: '2111088816', accountType: 'Caja de Ahorro',
};

await jest.unstable_mockModule('../../src/services/bankQr/bankQrRegistry.js', () => ({
  getBankQrService: () => ({
    generateQR: async (p) => {
      if (generarFalla) throw generarFalla;
      return { ...qrGenerado, _args: p };
    },
  }),
}));

await jest.unstable_mockModule('../../src/services/srlBankData.js', () => ({
  getSrlBankData: async () => cuentaDevuelta,
}));

await jest.unstable_mockModule('../../src/services/sentry.js', () => ({
  default: { captureException: () => {} },
}));

const WalletBOB         = (await import('../../src/models/WalletBOB.js')).default;
const WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default;
const { initiateDeposit } = await import('../../src/controllers/walletController.js');

let mongod;
const userId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await WalletBOB.deleteMany({});
  await WalletTransaction.deleteMany({});
  generarFalla = null;
});

/** req/res mínimos: se ejecuta el controller real. */
function pedido(amount = 80) {
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this },
    json(b)   { this.body = b; return this },
  };
  const req = {
    body: { amount },
    user: { _id: userId, email: 'usuario@ejemplo.test', legalEntity: 'SRL', kycStatus: 'approved' },
  };
  return { req, res };
}

describe('carga de saldo BOB por QR bancario', () => {
  test('el camino feliz NO devuelve 500 y deja el depósito listo para pagar', async () => {
    // Es la prueba que faltaba: con el bug de alcance esto daba 500.
    const { req, res } = pedido(80);

    await initiateDeposit(req, res);

    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ method: 'bankQr' });
    expect(res.body.bankQrId).toBe(qrGenerado.qrId);
  });

  test('deja registrada la cuenta donde va a caer el cobro', async () => {
    const { req, res } = pedido(80);
    await initiateDeposit(req, res);

    const wtx = await WalletTransaction.findOne({ wtxId: res.body.wtxId }).lean();
    expect(wtx.bankQr.accountCredit).toBe('2111088816');
    expect(wtx.bankQr.purpose).toBe('wallet_deposit');
    expect(wtx.status).toBe('pending');
  });

  test('le manda al banco la misma cuenta que registra', async () => {
    // Si se resolvieran por separado podrían divergir y el registro mentiría.
    const { req, res } = pedido(80);
    await initiateDeposit(req, res);

    const wtx = await WalletTransaction.findOne({ wtxId: res.body.wtxId }).lean();
    expect(wtx.bankQr.accountCredit).toBe(cuentaDevuelta.accountNumber);
  });

  test('si el banco falla, el depósito queda failed y NO se devuelve 500', async () => {
    generarFalla = new Error('BEC API /generateQR → HTTP 503');
    const { req, res } = pedido(80);

    await initiateDeposit(req, res);

    expect(res.statusCode).not.toBe(500);
    const wtx = await WalletTransaction.findOne({ userId }).sort({ createdAt: -1 }).lean();
    expect(wtx.status).toBe('failed');
    // Y sin QR: no se puede dejar un depósito cobrable que el banco nunca emitió.
    expect(wtx.bankQr?.qrId).toBeUndefined();
  });
});
