/**
 * quote.test.js — Tests de integración del endpoint GET /api/v1/payments/quote
 *
 * Mocking: vitaWalletService.getPrices() es mockeado para evitar llamadas HTTP reales.
 * DB: MongoDB en memoria — se siembra un corredor CL→CO en beforeAll.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections, seedCorridorClCo, seedCorridor } from '../helpers/db.js';
import { createSpAUser, createSRLUser } from '../helpers/auth.js';
import { mockVitaPricesResponse } from '../helpers/vitaMock.js';

// ─── Mock de vitaWalletService (debe ir antes de importar server.js) ──────────
// Patrón: se importa el módulo REAL y se hace spread + override — así el mock
// nunca queda desactualizado cuando el módulo real agrega exports nuevos.

const actualVita    = await import('../../src/services/vitaWalletService.js');
const actualOwlPay  = await import('../../src/services/owlPayService.js');
const actualStellar = await import('../../src/services/stellarService.js');

const mockGetPrices = jest.fn();

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  ...actualVita,
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
}));

await jest.unstable_mockModule('../../src/services/owlPayService.js', () => ({
  ...actualOwlPay,
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

// Mock de stellarService para evitar conexiones reales a Stellar
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  ...actualStellar,
  executeWeb3Transit:             jest.fn().mockResolvedValue({ txid: 'mock_txid' }),
  registerAuditTrail:             jest.fn().mockResolvedValue(null),
  getAuditTrail:                  jest.fn().mockResolvedValue(null),
  freezeUserTrustline:            jest.fn().mockResolvedValue(null),
  unfreezeUserTrustline:          jest.fn().mockResolvedValue(null),
  sendUSDCToHarbor:               jest.fn().mockResolvedValue({ hash: 'mock_hash', ledger: 1, successful: true }),
  getStellarUSDCBalance:          jest.fn().mockResolvedValue(9999),
  hasUSDCTrustline:               jest.fn().mockResolvedValue(true),
  __resetSRLBalanceCacheForTest:  jest.fn(),
}));

// ─── Importaciones diferidas (después de mocks) ───────────────────────────────

const { default: app }     = await import('../../src/app.js');
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

  test('200 — cotización CL→BO (anchorBolivia) NO revienta con 500 (regresión Bug B)', async () => {
    // Regresión Bug B (fix 2026-07-02): la rama CL→BO de getQuote referenciaba una
    // variable `transaction` inexistente al construir exchangeRateDisplay →
    // ReferenceError → 500 en TODA cotización CL→BO. Debe devolver 200 con el
    // display de tasa correctamente formateado.
    const { token } = await createSpAUser();
    await seedCorridor();   // corredor CL→BO (payoutMethod anchorBolivia) activo

    // El corredor CL→BO exige un SpAConfig activo con clpPerBob + accountNumber.
    const { default: SpAConfig } = await import('../../src/models/SpAConfig.js');
    await SpAConfig.create({
      isActive:      true,
      clpPerBob:     99.55,
      accountNumber: '000-1234567-8',
      bankName:      'Banco de Chile',
      minAmountCLP:  10000,
      maxAmountCLP:  5000000,
    });

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ originCountry: 'CL', destinationCountry: 'BO', originAmount: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.destinationCountry).toBe('BO');
    expect(res.body.destinationCurrency).toBe('BOB');
    expect(res.body.payoutMethod).toBe('anchorBolivia');
    expect(res.body.destinationAmount).toBeGreaterThan(0);
    // exchangeRateDisplay debe estar bien formado (antes lanzaba ReferenceError).
    expect(res.body.exchangeRateDisplay).toMatch(/^1 BOB = [\d.]+ CLP$/);
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
    // payoutFee reportado = 0: el fixed_cost de Vita (200) ya viene descontado
    // de destinationAmount (está en moneda destino, no en origen)
    expect(fees.payoutFee).toBe(0);

    // amountAfterFees = 100000 - 1500 - 500 = 98000
    // destinationAmount = (98000 × 4.5) - 200 = 441000 - 200 = 440800
    expect(exchangeRate).toBe(4.5);
    expect(destinationAmount).toBe(440800);
  });

});

// ─── Regresión: cotización BOB → Vita (la rama que faltaba cubrir) ─────────────
//
// El 2026-10-05 un `let vitaResponse` quedó encerrado en un bloque mientras
// applyVitaRail lo consumía afuera: "vitaResponse is not defined" en runtime.
// Tumbó la cotización REST de los 17 corredores Vita de origen BOB en producción
// y la suite no lo vio porque solo cubría quotes de origen CL (rama genérica) y
// Harbor. Lo encontró la prueba e2e manual. Este bloque cierra ese hueco: si la
// rama Vita-BOB vuelve a romperse, se rompe acá y no en producción.
describe('GET /api/v1/payments/quote — corredor BOB → Vita (bo-br)', () => {

  async function seedBoBrVita() {
    const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');
    return TransactionConfig.create({
      corridorId:          'bo-br',
      originCountry:       'BO',
      destinationCountry:  'BR',
      originCurrency:      'BOB',
      destinationCurrency: 'BRL',
      payinMethod:         'manual',
      payoutMethod:        'vitaWallet',
      legalEntity:         'SRL',
      routingScenario:     'C',
      alytoCSpread:        6.5,
      fixedFee:            6,
      payinFeePercent:     0,
      payoutFeeFixed:      0,
      profitRetentionPercent: 0,
      minAmountOrigin:     100,
      isActive:            true,
    });
  }

  /**
   * Precios con la sección `usd.withdrawal` que la rama de origen BOB lee
   * (extractVitaPricing → vitaPricesResponse.usd.withdrawal.prices.attributes).
   * El mock base trae solo la forma top-level/CLP, que esta rama no consulta.
   */
  const preciosConBrasil = () => {
    const base = mockVitaPricesResponse();
    base.usd = {
      withdrawal: {
        prices: {
          attributes: {
            usd_sell:    { br: 4.88 },
            fixed_cost:  { br: 3 },
            valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          },
        },
      },
    };
    return base;
  };

  test('cotiza de punta a punta sin reventar (regresión vitaResponse)', async () => {
    await seedBoBrVita();
    const { token } = await createSRLUser();
    mockGetPrices.mockResolvedValue(preciosConBrasil());

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ corridorId: 'bo-br', originAmount: 400 });

    // Lo esencial de la regresión: 200, no 500 por ReferenceError.
    expect(res.status).toBe(200);
    expect(res.body.destinationCurrency).toBe('BRL');
    expect(res.body.destinationAmount).toBeGreaterThan(0);
    expect(res.body.exchangeRate).toBeGreaterThan(0);
    // La rama Vita marca la tasa como estimada (la exacta es de Harbor).
    expect(res.body.rateSource).toBe('vita');
  });

  test('el desglose descuenta los fees del corredor y la fija de Vita', async () => {
    await seedBoBrVita();
    const { token } = await createSRLUser();
    mockGetPrices.mockResolvedValue(preciosConBrasil());

    const res = await request(app)
      .get('/api/v1/payments/quote')
      .set('Authorization', `Bearer ${token}`)
      .query({ corridorId: 'bo-br', originAmount: 400 });

    expect(res.status).toBe(200);
    const { fees, destinationAmount } = res.body;
    // 6.5% de 400 = 26 de spread + Bs 6 fija = 32 deducidos
    expect(fees.alytoCSpread).toBe(26);
    expect(fees.fixedFee).toBe(6);
    // Verificación inversa gruesa: neto 368 BOB → USD (tasa viva o fallback) →
    // × 4.88 − 3 BRL. Sin fijar la tasa BOB/USD del entorno, el destino debe
    // quedar en un rango sano, no en 0 ni negativo.
    expect(destinationAmount).toBeGreaterThan(50);
  });
});
