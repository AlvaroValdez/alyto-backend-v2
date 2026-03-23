/**
 * fullPaymentFlow.test.js — Test E2E del flujo completo de pago cross-border
 *
 * Escenario: Usuario SpA (Chile) → Beneficiario Bolivia
 *   1. GET  /quote                  — cotización con tasas de Vita mockeadas
 *   2. POST /payin/fintoc           — inicia payin (requiere JWT SpA)
 *   3. POST /ipn/vita               — IPN confirma payin recibido (firma HMAC válida)
 *   4. GET  /:id/status             — polling del estado → payin_confirmed
 *   5. POST /ipn/vita               — IPN confirma payout completado
 *   6. GET  /:id/status             — status final = completed
 *   7. Admin verifica               — GET /admin/transactions/:id incluye ipnLog
 *
 * Servicios externos mockeados:
 *   - vitaWalletService.getPrices    → mockVitaPricesResponse()
 *   - vitaWalletService.createPayout → mock inmediato (sin HTTP real)
 *   - stellarService.executeWeb3Transit → mock (no hay red Stellar en test)
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import crypto from 'crypto';
import {
  connectTestDb, disconnectTestDb, clearCollections, seedCorridor,
} from '../helpers/db.js';
import { createSpAUser, createAdminUser } from '../helpers/auth.js';
import {
  mockVitaPricesResponse,
  generateVitaIPNHeaders,
} from '../helpers/vitaMock.js';

// ─── Mocks (deben ir antes de importar server.js) ────────────────────────────

const mockGetPrices    = jest.fn();
const mockCreatePayout = jest.fn().mockResolvedValue({
  id:       'vita_payout_e2e_001',
  status:   'pending',
  amount:   450,
  currency: 'BOB',
});

function buildSortedBodyLocal(body = null) {
  if (!body || Object.keys(body).length === 0) return '';
  return Object.keys(body)
    .sort()
    .map(k => {
      const v = body[k];
      return `${k}${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`;
    })
    .join('');
}

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getPrices:             mockGetPrices,
  generateVitaSignature: (xDate, body) => {
    const login  = process.env.VITA_LOGIN  ?? '';
    const secret = process.env.VITA_SECRET ?? '';
    const sorted = buildSortedBodyLocal(body);
    return crypto.createHmac('sha256', secret).update(login + xDate + sorted).digest('hex');
  },
  createPayout:       mockCreatePayout,
  createPayin:        jest.fn(),
  getWithdrawalRules: jest.fn(),
  getPaymentMethods:  jest.fn(),
  getPayinPrices:     jest.fn(),
}));

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  executeWeb3Transit:      jest.fn().mockResolvedValue({ txid: 'stellar_e2e_txid_001' }),
  buildFeeBumpTransaction: jest.fn(),
  buildInnerTransaction:   jest.fn(),
  ensureTrustline:         jest.fn(),
  submitTransaction:       jest.fn(),
  executeStellarPayment:   jest.fn(),
}));

// ─── Importaciones diferidas ──────────────────────────────────────────────────

const { default: app }         = await import('../../src/server.js');
const { default: request }     = await import('supertest');
const { default: Transaction } = await import('../../src/models/Transaction.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectTestDb();
  mockGetPrices.mockResolvedValue(mockVitaPricesResponse());
});

afterEach(async () => {
  await clearCollections();
  mockGetPrices.mockResolvedValue(mockVitaPricesResponse());
  mockCreatePayout.mockReset();
  mockCreatePayout.mockResolvedValue({
    id: 'vita_payout_e2e_reset', status: 'pending', amount: 450, currency: 'BOB',
  });
});

afterAll(async () => {
  await disconnectTestDb();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Inicia payin con autenticación JWT del usuario SpA */
function startPayin(token, userId, amount) {
  return request(app)
    .post('/api/v1/payments/payin/fintoc')
    .set('Authorization', `Bearer ${token}`)
    .send({ userId, amount });
}

/** Envía IPN de Vita con firma válida */
function sendVitaIPN(body) {
  const rawBody = JSON.stringify(body);
  const headers = generateVitaIPNHeaders(body);
  return request(app)
    .post('/api/v1/ipn/vita')
    .set(headers)
    .set('content-type', 'application/json')
    .send(rawBody);
}

/** Espera a que la BD refleje un estado específico */
async function waitForStatus(alytoTransactionId, expectedStatus, maxWaitMs = 500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const tx = await Transaction.findOne({ alytoTransactionId });
    if (tx?.status === expectedStatus) return tx;
    await new Promise(r => setTimeout(r, 30));
  }
  return Transaction.findOne({ alytoTransactionId });
}

// ─── E2E: Flujo completo CL→BO ───────────────────────────────────────────────

describe('E2E — Flujo completo SpA Chile → Bolivia (fintoc + anchorBolivia)', () => {

  test('Paso 1-4: quote → payin → IPN payin confirmed → status polling', async () => {
    const { user, token } = await createSpAUser();
    await seedCorridor();   // CL→BO, payoutMethod: anchorBolivia

    // ── Paso 1: Cotización ─────────────────────────────────────────────────
    const quoteRes = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'BO', originAmount: 150000 });

    expect(quoteRes.status).toBe(200);
    expect(quoteRes.body.destinationAmount).toBeGreaterThan(0);
    expect(quoteRes.body.payinMethod).toBe('fintoc');
    expect(quoteRes.body.payoutMethod).toBe('anchorBolivia');

    // ── Paso 2: Iniciar Payin ──────────────────────────────────────────────
    const payinRes = await startPayin(token, user._id.toString(), 150000);

    expect(payinRes.status).toBe(201);
    expect(payinRes.body.success).toBe(true);

    const alytoTransactionId = payinRes.body.alytoTransactionId;

    expect(alytoTransactionId).toMatch(/^ALY-/);
    expect(payinRes.body.widgetUrl).toBeTruthy();

    // BD: transacción creada en estado payin_pending
    const txAfterPayin = await Transaction.findOne({ alytoTransactionId });
    expect(txAfterPayin).not.toBeNull();
    expect(txAfterPayin.status).toBe('payin_pending');

    // ── Paso 3: Polling inicial (status = payin_pending) ──────────────────
    const statusRes1 = await request(app)
      .get(`/api/v1/payments/${alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`);

    expect(statusRes1.status).toBe(200);
    expect(statusRes1.body.status).toBe('payin_pending');
    expect(statusRes1.body.transactionId).toBe(alytoTransactionId);

    // ── Paso 4: IPN de Vita confirma payin ─────────────────────────────────
    const ipnPayinBody = {
      status: 'completed',
      order:  alytoTransactionId,
      wallet: { uuid: 'vita_payin_wallet_uuid', token: 'vita_token' },
    };

    const ipnRes = await sendVitaIPN(ipnPayinBody);
    expect(ipnRes.status).toBe(200);
    expect(ipnRes.body.received).toBe(true);

    // ── Paso 5: Verificar status actualizado ──────────────────────────────
    // El status pasa a payin_confirmed; dispatchPayout es fire-and-forget
    const txAfterIPN = await waitForStatus(alytoTransactionId, 'payin_confirmed', 400);
    expect(['payin_confirmed', 'processing']).toContain(txAfterIPN.status);
    expect(txAfterIPN.ipnLog.length).toBeGreaterThan(0);
    expect(txAfterIPN.payinReference).toBe('vita_payin_wallet_uuid');
  });

  test('Flujo completo → completed (payin + payout IPN)', async () => {
    const { user, token } = await createSpAUser();
    await seedCorridor();

    const payinRes = await startPayin(token, user._id.toString(), 100000);
    expect(payinRes.status).toBe(201);

    const alytoTransactionId = payinRes.body.alytoTransactionId;

    // IPN payin confirmado
    await sendVitaIPN({
      status: 'completed',
      order:  alytoTransactionId,
      wallet: { uuid: 'vita_payin_uuid' },
    });

    await new Promise(r => setTimeout(r, 150));

    // Simular que Vita aceptó el withdrawal → poner en payout_sent
    await Transaction.findOneAndUpdate(
      { alytoTransactionId },
      { $set: { status: 'payout_sent', payoutReference: 'vita_withdrawal_e2e' } },
    );

    // IPN payout completado
    await sendVitaIPN({
      status: 'completed',
      order:  alytoTransactionId,
      wallet: { uuid: 'vita_payout_uuid' },
    });

    await new Promise(r => setTimeout(r, 150));

    // Polling final — status debe ser completed
    const finalStatus = await request(app)
      .get(`/api/v1/payments/${alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`);

    expect(finalStatus.status).toBe(200);
    expect(finalStatus.body.status).toBe('completed');
    expect(finalStatus.body.transactionId).toBe(alytoTransactionId);
    expect(finalStatus.body.estimatedDelivery).toBe('1 día hábil');
  });

  test('Admin puede ver la transacción completa con ipnLog', async () => {
    const { user, token }        = await createSpAUser();
    const { token: adminToken }  = await createAdminUser();
    await seedCorridor();

    const payinRes           = await startPayin(token, user._id.toString(), 80000);
    const alytoTransactionId = payinRes.body.alytoTransactionId;

    await sendVitaIPN({
      status: 'completed',
      order:  alytoTransactionId,
      wallet: { uuid: 'vita_admin_test' },
    });

    await new Promise(r => setTimeout(r, 150));

    const adminRes = await request(app)
      .get(`/api/v1/admin/transactions/${alytoTransactionId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(adminRes.status).toBe(200);
    expect(adminRes.body.transaction.alytoTransactionId).toBe(alytoTransactionId);
    expect(adminRes.body.transaction.ipnLog).toBeInstanceOf(Array);
    expect(adminRes.body.transaction.ipnLog.length).toBeGreaterThan(0);
    expect(adminRes.body.transaction.userId).toBeTruthy();
  });

  test('Payin fallido → status failed → polling devuelve failed', async () => {
    const { user, token } = await createSpAUser();
    await seedCorridor();

    const payinRes           = await startPayin(token, user._id.toString(), 50000);
    const alytoTransactionId = payinRes.body.alytoTransactionId;

    await sendVitaIPN({
      status: 'denied',
      order:  alytoTransactionId,
      wallet: {},
    });

    await new Promise(r => setTimeout(r, 100));

    const statusRes = await request(app)
      .get(`/api/v1/payments/${alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('failed');
  });

  test('Usuario no puede ver transacciones de otro usuario', async () => {
    const { user: user1, token: token1 } = await createSpAUser();
    const { token: token2 }              = await createSpAUser();
    await seedCorridor();

    const payinRes           = await startPayin(token1, user1._id.toString(), 75000);
    const alytoTransactionId = payinRes.body.alytoTransactionId;

    // user2 intenta ver la transacción de user1
    const res = await request(app)
      .get(`/api/v1/payments/${alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(404);   // devuelve 404 (no revela que existe)
  });

});
