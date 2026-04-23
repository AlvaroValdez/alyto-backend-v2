/**
 * adminLedger.test.js — Tests de integración del Backoffice Ledger
 *
 * Cubre los 5 endpoints de admin:
 *   GET    /api/v1/admin/transactions
 *   GET    /api/v1/admin/transactions/:transactionId
 *   PATCH  /api/v1/admin/transactions/:transactionId/status
 *   GET    /api/v1/admin/corridors
 *   PATCH  /api/v1/admin/corridors/:corridorId
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import {
  connectTestDb, disconnectTestDb, clearCollections,
  seedCorridor, seedCorridorClCo,
} from '../helpers/db.js';
import { createAdminUser, createSpAUser } from '../helpers/auth.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getPrices:                jest.fn(),
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

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  executeWeb3Transit:      jest.fn(),
  registerAuditTrail:      jest.fn().mockResolvedValue(null),
  getAuditTrail:           jest.fn().mockResolvedValue(null),
  freezeUserTrustline:     jest.fn().mockResolvedValue(null),
  unfreezeUserTrustline:   jest.fn().mockResolvedValue(null),
}));

// ─── Importaciones diferidas ──────────────────────────────────────────────────

const { default: app }         = await import('../../src/server.js');
const { default: request }     = await import('supertest');
const { default: Transaction } = await import('../../src/models/Transaction.js');

// ─── Helpers de test ──────────────────────────────────────────────────────────

async function createTestTransaction(corridorDoc, userDoc, overrides = {}) {
  return Transaction.create({
    alytoTransactionId: `ALY-B-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    userId:             userDoc._id,
    corridorId:         corridorDoc._id,
    legalEntity:        corridorDoc.legalEntity ?? 'SpA',
    operationType:      'crossBorderPayment',
    routingScenario:    'B',
    status:             'payin_pending',
    originalAmount:     150000,
    originCurrency:     'CLP',
    originCountry:      'CL',
    destinationCurrency: 'BOB',
    destinationCountry:  'BO',
    digitalAsset:       'USDC',
    exchangeRate:       0.0045,
    paymentLegs: [
      { stage: 'payin', provider: 'fintoc', status: 'pending' },
    ],
    ...overrides,
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ─── Tests: GET /api/v1/admin/transactions ────────────────────────────────────

describe('GET /api/v1/admin/transactions', () => {

  test('200 — admin obtiene lista de transacciones con summary', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    await createTestTransaction(corridor, user);
    await createTestTransaction(corridor, user, { status: 'completed' });

    const res = await request(app)
      .get('/api/v1/admin/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toBeInstanceOf(Array);
    expect(res.body.transactions.length).toBe(2);

    // Pagination
    expect(res.body.pagination).toMatchObject({
      page:  1,
      limit: expect.any(Number),
      total: 2,
    });

    // Summary
    expect(res.body.summary).toHaveProperty('totalVolume');
    expect(res.body.summary).toHaveProperty('totalCompleted');
    expect(res.body.summary).toHaveProperty('totalFailed');
    expect(res.body.summary).toHaveProperty('totalFees');
  });

  test('401 — usuario no autenticado', async () => {
    const res = await request(app)
      .get('/api/v1/admin/transactions');

    expect(res.status).toBe(401);
  });

  test('403 — usuario normal rechazado', async () => {
    const { token } = await createSpAUser();

    const res = await request(app)
      .get('/api/v1/admin/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('filtro por status — solo transacciones completadas', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    await createTestTransaction(corridor, user, { status: 'payin_pending' });
    await createTestTransaction(corridor, user, { status: 'completed' });
    await createTestTransaction(corridor, user, { status: 'failed' });

    const res = await request(app)
      .get('/api/v1/admin/transactions')
      .set('Authorization', `Bearer ${token}`)
      .query({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBe(1);
    expect(res.body.transactions[0].status).toBe('completed');
  });

  test('filtro por entity — solo transacciones SpA', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    await createTestTransaction(corridor, user, { legalEntity: 'SpA' });
    await createTestTransaction(corridor, user, { legalEntity: 'LLC' });

    const res = await request(app)
      .get('/api/v1/admin/transactions')
      .set('Authorization', `Bearer ${token}`)
      .query({ entity: 'SpA' });

    expect(res.status).toBe(200);
    expect(res.body.transactions.every(tx => tx.legalEntity === 'SpA')).toBe(true);
  });

  test('paginación — página 2', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    // Crear 5 transacciones
    for (let i = 0; i < 5; i++) {
      await createTestTransaction(corridor, user);
    }

    const res = await request(app)
      .get('/api/v1/admin/transactions')
      .set('Authorization', `Bearer ${token}`)
      .query({ page: 2, limit: 3 });

    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBe(2);   // 5 total, 3 en pág 1 → 2 en pág 2
    expect(res.body.pagination.page).toBe(2);
  });

});

// ─── Tests: GET /api/v1/admin/transactions/:id ────────────────────────────────

describe('GET /api/v1/admin/transactions/:transactionId', () => {

  test('200 — admin obtiene detalle completo con ipnLog', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    const tx = await createTestTransaction(corridor, user);

    const res = await request(app)
      .get(`/api/v1/admin/transactions/${tx.alytoTransactionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.transaction.alytoTransactionId).toBe(tx.alytoTransactionId);
    expect(res.body.transaction).toHaveProperty('ipnLog');
    expect(res.body.transaction).toHaveProperty('userId');     // populado con datos del usuario
  });

  test('404 — transacción no encontrada', async () => {
    const { token } = await createAdminUser();

    const res = await request(app)
      .get('/api/v1/admin/transactions/ALY-X-NONEXISTENT-99999')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('403 — usuario normal rechazado', async () => {
    const { token } = await createSpAUser();

    const res = await request(app)
      .get('/api/v1/admin/transactions/ALY-B-TEST')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

});

// ─── Tests: PATCH /api/v1/admin/transactions/:id/status ──────────────────────

describe('PATCH /api/v1/admin/transactions/:transactionId/status', () => {

  test('200 — actualiza estado con nota → queda en ipnLog', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    const tx = await createTestTransaction(corridor, user, { status: 'payin_pending' });

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', note: 'Pago verificado manualmente por admin.' });

    expect(res.status).toBe(200);

    // Verificar en BD
    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.status).toBe('completed');

    // Nota registrada en ipnLog — verificar en res.body.transaction directamente
    const adminLog = res.body.transaction.ipnLog.find(l => l.provider === 'manual');
    expect(adminLog).toBeTruthy();
    expect(adminLog.rawPayload.note).toBe('Pago verificado manualmente por admin.');
    expect(adminLog.rawPayload.previousStatus).toBe('payin_pending');
    expect(adminLog.rawPayload.newStatus).toBe('completed');
  });

  test('400 — status inválido rechazado', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    const tx = await createTestTransaction(corridor, user);

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'invalid_status_xyz', note: 'Test' });

    expect(res.status).toBe(400);
  });

  test('400 — nota faltante rechazada', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSpAUser();
    const corridor  = await seedCorridor();

    const tx = await createTestTransaction(corridor, user);

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed' });   // sin note

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/note|requerido/i);
  });

  test('404 — transacción no encontrada', async () => {
    const { token } = await createAdminUser();

    const res = await request(app)
      .patch('/api/v1/admin/transactions/ALY-X-NONEXISTENT-99/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', note: 'Test' });

    expect(res.status).toBe(404);
  });

});

// ─── Tests: GET /api/v1/admin/corridors ──────────────────────────────────────

describe('GET /api/v1/admin/corridors', () => {

  test('200 — admin lista todos los corredores', async () => {
    const { token } = await createAdminUser();
    await seedCorridor();
    await seedCorridorClCo();

    const res = await request(app)
      .get('/api/v1/admin/corridors')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.corridors).toBeInstanceOf(Array);
    expect(res.body.corridors.length).toBe(2);
  });

  test('401 — sin autenticación', async () => {
    const res = await request(app).get('/api/v1/admin/corridors');
    expect(res.status).toBe(401);
  });

  test('403 — usuario normal rechazado', async () => {
    const { token } = await createSpAUser();

    const res = await request(app)
      .get('/api/v1/admin/corridors')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

});

// ─── Tests: PATCH /api/v1/admin/corridors/:corridorId ────────────────────────

describe('PATCH /api/v1/admin/corridors/:corridorId', () => {

  test('200 — actualiza alytoCSpread', async () => {
    const { token } = await createAdminUser();
    const corridor  = await seedCorridor();

    const res = await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ alytoCSpread: 2.0 });

    expect(res.status).toBe(200);

    const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');
    const updated = await TransactionConfig.findById(corridor._id);
    expect(updated.alytoCSpread).toBe(2.0);
  });

  test('200 — actualiza isActive (desactiva corredor)', async () => {
    const { token } = await createAdminUser();
    const corridor  = await seedCorridor();

    const res = await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);

    const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');
    const updated = await TransactionConfig.findById(corridor._id);
    expect(updated.isActive).toBe(false);
  });

  test('400 — intentar modificar corridorId rechazado', async () => {
    const { token } = await createAdminUser();
    const corridor  = await seedCorridor();

    const res = await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ corridorId: 'nuevo-corredor-id' });

    // corridorId es un campo protegido — se ignora del body, updates queda vacío → 400
    expect(res.status).toBe(400);
  });

  test('404 — corredor no encontrado', async () => {
    const { token } = await createAdminUser();

    const res = await request(app)
      .patch('/api/v1/admin/corridors/cl-bo-nonexistent-corridor')
      .set('Authorization', `Bearer ${token}`)
      .send({ alytoCSpread: 2.0 });

    expect(res.status).toBe(404);
  });

  test('400 — alytoCSpread fuera del rango (max 20)', async () => {
    const { token } = await createAdminUser();
    const corridor  = await seedCorridor();

    const res = await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ alytoCSpread: 99 });

    expect(res.status).toBe(400);
  });

});
