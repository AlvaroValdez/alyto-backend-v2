/**
 * crossborder.test.js — Tests del endpoint POST /api/v1/payments/payin/fintoc
 *
 * Verifica el flujo de inicio de un payin:
 *   1. Validaciones de entrada (requiere JWT + legalEntity SpA)
 *   2. Verificación de KYC
 *   3. Creación de PaymentIntent en Fintoc (modo dev mock)
 *   4. Registro de Transaction en BD
 *
 * Nota: el endpoint usa `protect + requireEntity(['SpA'])` — todos los requests
 * válidos deben incluir un token JWT de un usuario SpA.
 * El `userId` en el body es el usuario cuya transacción se crea (puede ser
 * distinto del usuario autenticado, aunque en producción siempre coinciden).
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import {
  connectTestDb, disconnectTestDb, clearCollections, seedCorridor,
} from '../helpers/db.js';
import { createSpAUser, createSRLUser } from '../helpers/auth.js';

// ─── Mocks de servicios externos ──────────────────────────────────────────────

const mockGetPrices = jest.fn();

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getPrices:                mockGetPrices,
  generateVitaSignature:    jest.fn().mockReturnValue('mock_sig'),
  createPayout:             jest.fn(),
  createVitaSentPayout:     jest.fn(),
  createPayin:              jest.fn(),
  getWithdrawalRules:       jest.fn(),
  getPaymentMethods:        jest.fn(),
  getPayinPrices:           jest.fn(),
  getWallets:               jest.fn(),
  getDeposits:              jest.fn(),
  getCryptoPrices:          jest.fn(),
  VITA_SENT_ONLY_COUNTRIES: new Set(['GT', 'SV', 'ES', 'PL']),
}));

await jest.unstable_mockModule('../../src/services/owlPayService.js', () => ({
  verifyOwlPayWebhookSignature:   jest.fn().mockResolvedValue(true),
  verifyWebhookSignature:         jest.fn().mockReturnValue(true),
  getOwlPayApiKey:                jest.fn().mockReturnValue('test_key'),
  getOwlPayBaseUrl:               jest.fn().mockReturnValue('https://test.owlpay.example'),
  getCustomerUuid:                jest.fn().mockReturnValue('test_customer_uuid'),
  getHarborQuote:                 jest.fn(),
  createHarborTransfer:           jest.fn(),
  getHarborTransferRequirements:  jest.fn().mockResolvedValue({ fields: [] }),
  getHarborTransferStatus:        jest.fn(),
  simulateHarborTransfer:         jest.fn(),
  getCachedRequirementsByCountry: jest.fn().mockReturnValue(null),
  buildPayoutInstrument:          jest.fn().mockReturnValue({}),
  createOnRampOrder:              jest.fn(),
  getOnRampOrderStatus:           jest.fn(),
  sendUSDCToHarbor:               jest.fn(),
  createQuote:                    jest.fn(),
  getRequirementsSchema:          jest.fn(),
  createTransfer:                 jest.fn(),
  getTransferStatus:              jest.fn(),
}));

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  executeWeb3Transit:             jest.fn().mockResolvedValue({ txid: 'mock_stellar_txid' }),
  buildFeeBumpTransaction:        jest.fn(),
  buildInnerTransaction:          jest.fn(),
  ensureTrustline:                jest.fn(),
  submitTransaction:              jest.fn(),
  executeStellarPayment:          jest.fn(),
  registerAuditTrail:             jest.fn().mockResolvedValue(null),
  getAuditTrail:                  jest.fn().mockResolvedValue(null),
  freezeUserTrustline:            jest.fn().mockResolvedValue(null),
  unfreezeUserTrustline:          jest.fn().mockResolvedValue(null),
  sendUSDCToHarbor:               jest.fn().mockResolvedValue({ hash: 'mock_hash', ledger: 1, successful: true }),
  getStellarUSDCBalance:          jest.fn().mockResolvedValue(9999),
  hasUSDCTrustline:               jest.fn().mockResolvedValue(true),
  __resetSRLBalanceCacheForTest:  jest.fn(),
}));

// ─── Importaciones diferidas ──────────────────────────────────────────────────

const { default: app }         = await import('../../src/server.js');
const { default: request }     = await import('supertest');
const { default: Transaction } = await import('../../src/models/Transaction.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectTestDb();
  await seedCorridor();                  // corredor CL→BO activo
});

afterEach(async () => {
  await clearCollections();
  await seedCorridor();                  // re-sembrar corredor en cada test
});

afterAll(async () => {
  await disconnectTestDb();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** POST /payin/fintoc con token del usuario dado */
function postPayin(app, token, body) {
  return request(app)
    .post('/api/v1/payments/payin/fintoc')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/payments/payin/fintoc', () => {

  test('201 — crea payin y registra Transaction en BD (usuario SpA, KYC aprobado)', async () => {
    const { user, token } = await createSpAUser();

    const res = await postPayin(app, token, {
      userId: user._id.toString(),
      amount: 150000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.alytoTransactionId).toMatch(/^ALY-/);
    expect(res.body.widgetUrl).toBeTruthy();
    expect(res.body.fintocPaymentIntentId).toBeTruthy();

    // Verificar que la Transaction fue guardada en BD
    const tx = await Transaction.findOne({ alytoTransactionId: res.body.alytoTransactionId });
    expect(tx).not.toBeNull();
    expect(tx.status).toBe('payin_pending');
    expect(tx.originalAmount).toBe(150000);
    expect(tx.userId.toString()).toBe(user._id.toString());
    expect(tx.legalEntity).toBe('SpA');
  });

  test('401 — sin token JWT', async () => {
    const res = await request(app)
      .post('/api/v1/payments/payin/fintoc')
      .send({ amount: 150000 });

    expect(res.status).toBe(401);
  });

  test('403 — usuario SRL rechazado por requireEntity (Fintoc solo es SpA)', async () => {
    const { user, token } = await createSRLUser();

    const res = await postPayin(app, token, {
      userId: user._id.toString(),
      amount: 150000,
    });

    // requireEntity(['SpA']) rechaza con 403 antes de llegar al controller
    expect(res.status).toBe(403);
  });

  test('400 — userId faltante en body', async () => {
    const { token } = await createSpAUser();

    const res = await postPayin(app, token, { amount: 150000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('requeridos');
  });

  test('400 — amount faltante en body', async () => {
    const { user, token } = await createSpAUser();

    const res = await postPayin(app, token, { userId: user._id.toString() });

    expect(res.status).toBe(400);
  });

  test('400 — amount negativo rechazado', async () => {
    const { user, token } = await createSpAUser();

    const res = await postPayin(app, token, {
      userId: user._id.toString(),
      amount: -500,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('entero positivo');
  });

  test('400 — amount decimal rechazado (debe ser entero CLP)', async () => {
    const { user, token } = await createSpAUser();

    const res = await postPayin(app, token, {
      userId: user._id.toString(),
      amount: 150000.50,
    });

    expect(res.status).toBe(400);
  });

  test('400 — userId inválido (formato no ObjectId)', async () => {
    const { token } = await createSpAUser();

    const res = await postPayin(app, token, {
      userId: 'not-a-valid-objectid',
      amount: 150000,
    });

    expect(res.status).toBe(400);
  });

  test('404 — userId válido pero usuario no encontrado en BD', async () => {
    const { default: mongoose } = await import('mongoose');
    const { token }             = await createSpAUser();
    const fakeId                = new mongoose.Types.ObjectId().toString();

    const res = await postPayin(app, token, {
      userId: fakeId,
      amount: 150000,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('no encontrado');
  });

  test('403 — usuario con KYC pendiente rechazado por el controller', async () => {
    const { user, token } = await createSpAUser({ kycStatus: 'pending' });

    const res = await postPayin(app, token, {
      userId: user._id.toString(),
      amount: 150000,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('KYC');
  });

  test('paymentLegs registrado correctamente en la Transaction', async () => {
    const { user, token } = await createSpAUser();

    const res = await postPayin(app, token, {
      userId: user._id.toString(),
      amount: 75000,
    });

    expect(res.status).toBe(201);

    const tx = await Transaction.findOne({ alytoTransactionId: res.body.alytoTransactionId });
    expect(tx.paymentLegs).toBeInstanceOf(Array);
    expect(tx.paymentLegs.length).toBeGreaterThan(0);

    const payinLeg = tx.paymentLegs.find(l => l.stage === 'payin');
    expect(payinLeg).toBeTruthy();
    expect(payinLeg.provider).toBe('fintoc');
    expect(payinLeg.status).toBe('pending');
  });

});
