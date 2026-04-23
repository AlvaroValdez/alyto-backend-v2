/**
 * quote.test.js — Tests de integración del endpoint GET /api/v1/payments/quote
 *
 * Mocking: vitaWalletService.getPrices() es mockeado para evitar llamadas HTTP reales.
 * DB: MongoDB en memoria — se siembra un corredor CL→CO en beforeAll.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections, seedCorridorClCo } from '../helpers/db.js';
import { createSpAUser } from '../helpers/auth.js';
import { mockVitaPricesResponse } from '../helpers/vitaMock.js';

// ─── Mock de vitaWalletService (debe ir antes de importar server.js) ──────────

const mockGetPrices = jest.fn();

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getPrices:                mockGetPrices,
  generateVitaSignature:    jest.fn().mockReturnValue('mock_signature'),
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

// Mock de stellarService para evitar conexiones reales a Stellar
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  executeWeb3Transit: jest.fn().mockResolvedValue({ txid: 'mock_txid' }),
  registerAuditTrail:    jest.fn().mockResolvedValue(null),
  getAuditTrail:         jest.fn().mockResolvedValue(null),
  freezeUserTrustline:   jest.fn().mockResolvedValue(null),
  unfreezeUserTrustline: jest.fn().mockResolvedValue(null),
}));

// ─── Importaciones diferidas (después de mocks) ───────────────────────────────

const { default: app }     = await import('../../src/server.js');
const { default: request } = await import('supertest');

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectTestDb();
  mockGetPrices.mockResolvedValue(mockVitaPricesResponse());
});

afterEach(async () => {
  await clearCollections();
  mockGetPrices.mockReset();
  mockGetPrices.mockResolvedValue(mockVitaPricesResponse());
});

afterAll(async () => {
  await disconnectTestDb();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/payments/quote', () => {

  test('200 — cotización válida CL→CO con todos los campos del response', async () => {
    const { token } = await createSpAUser();
    await seedCorridorClCo();

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(200);

    // Estructura del response
    expect(res.body).toMatchObject({
      corridorId:          'cl-co-fintoc-vitawallet',
      originAmount:        100000,
      originCurrency:      'CLP',
      destinationCurrency: 'COP',
      payinMethod:         'fintoc',
      payoutMethod:        'vitaWallet',
      entity:              'SpA',
    });

    // Campos de fees presentes
    expect(res.body.fees).toHaveProperty('payinFee');
    expect(res.body.fees).toHaveProperty('alytoCSpread');
    expect(res.body.fees).toHaveProperty('fixedFee');
    expect(res.body.fees).toHaveProperty('payoutFee');
    expect(res.body.fees).toHaveProperty('totalDeducted');

    // Montos positivos
    expect(res.body.destinationAmount).toBeGreaterThan(0);
    expect(res.body.exchangeRate).toBeGreaterThan(0);

    // quoteExpiresAt presente y en el futuro
    expect(new Date(res.body.quoteExpiresAt).getTime()).toBeGreaterThan(Date.now());

    // Vita fue llamada una vez
    expect(mockGetPrices).toHaveBeenCalledTimes(1);
  });

  test('404 — corredor no existe para el par de países', async () => {
    const { token } = await createSpAUser();
    // No sembramos corredor — BD vacía

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Corredor no disponible');
  });

  test('400 — originAmount inferior al mínimo del corredor', async () => {
    const { token } = await createSpAUser();
    await seedCorridorClCo();     // minAmountOrigin = 10000

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('mínimo');
  });

  test('400 — originAmount faltante', async () => {
    const { token } = await createSpAUser();

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO' });

    expect(res.status).toBe(400);
  });

  test('401 — sin token JWT', async () => {
    const res = await request(app)
      .get('/api/v1/payments/quote')
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(401);
  });

  test('503 — Vita API no disponible', async () => {
    const { token } = await createSpAUser();
    await seedCorridorClCo();
    mockGetPrices.mockRejectedValue(new Error('Vita API timeout'));

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('tasas');
  });

  test('503 — Vita API responde pero sin la tasa para el par', async () => {
    const { token } = await createSpAUser();
    await seedCorridorClCo();

    // Vita responde sin datos de CO
    mockGetPrices.mockResolvedValue({
      withdrawal: {
        prices: { attributes: { clp_sell: {} } },  // sin co
      },
      valid_until: null,
    });

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(503);
  });

  test('corredor inactivo devuelve 404', async () => {
    const { token } = await createSpAUser();
    await seedCorridorClCo({ isActive: false });

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(404);
  });

  test('cálculo matemático correcto: spread 1.5%, fixedFee 500, payoutFee 200', async () => {
    const { token } = await createSpAUser();
    await seedCorridorClCo({
      alytoCSpread:  1.5,
      fixedFee:      500,
      payoutFeeFixed: 0,         // Vita fixed_cost (200 de CO) se usará
    });

    // Vita devuelve fixed_cost=200 para CO
    mockGetPrices.mockResolvedValue(mockVitaPricesResponse());

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'CO', originAmount: 100000 });

    expect(res.status).toBe(200);

    const { fees, destinationAmount, exchangeRate } = res.body;

    // alytoCSpread = 1.5% × 100000 = 1500
    expect(fees.alytoCSpread).toBe(1500);
    // fixedFee = 500
    expect(fees.fixedFee).toBe(500);
    // payoutFee = vitaFixedCost(200) > payoutFeeFixed(0) → 200
    expect(fees.payoutFee).toBe(200);

    // amountAfterFees = 100000 - 1500 - 500 = 98000
    // destinationAmount = (98000 × 4.5) - 200 = 441000 - 200 = 440800
    expect(exchangeRate).toBe(4.5);
    expect(destinationAmount).toBe(440800);
  });

});
