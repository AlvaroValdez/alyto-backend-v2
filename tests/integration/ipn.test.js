/**
 * ipn.test.js — Tests de integración de los handlers de IPN
 *
 * Cubre:
 *   POST /api/v1/ipn/vita   — IPN de Vita (payin y payout confirmations)
 *   POST /api/v1/ipn/fintoc — IPN de Fintoc cross-border
 *
 * Seguridad: genera firmas HMAC válidas usando las mismas variables de entorno
 * que el handler usa para validar. VITA_LOGIN y VITA_SECRET deben coincidir.
 *
 * Nota sobre captureRawBody: las rutas IPN leen el body stream directamente
 * y hacen JSON.parse manual (no usan express.json()). Supertest debe enviar
 * el body como string con Content-Type application/json para que funcione.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import crypto from 'crypto';
import {
  connectTestDb, disconnectTestDb, clearCollections, seedCorridor,
} from '../helpers/db.js';
import {
  generateVitaIPNHeaders,
  vitaPayinSucceededIPN,
  vitaPayoutSucceededIPN,
  vitaPayoutFailedIPN,
} from '../helpers/vitaMock.js';

// ─── Helper para buildSortedBody (misma lógica que vitaWalletService) ─────────

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

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCreatePayout = jest.fn();

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getPrices:             jest.fn(),
  generateVitaSignature: (xDate, body) => {
    // Reimplementar con las mismas vars de entorno para que el mock sea coherente
    // con validateVitaIPNSignature del controller
    const xLogin  = process.env.VITA_LOGIN  ?? 'test_vita_login';
    const secret  = process.env.VITA_SECRET ?? 'test_vita_secret_key';
    const sorted  = buildSortedBodyLocal(body);
    return crypto.createHmac('sha256', secret).update(xLogin + xDate + sorted).digest('hex');
  },
  createPayout:             mockCreatePayout,
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
  executeWeb3Transit:      jest.fn().mockResolvedValue({ txid: 'mock_stellar_txid' }),
  buildFeeBumpTransaction: jest.fn(),
  buildInnerTransaction:   jest.fn(),
  ensureTrustline:         jest.fn(),
  submitTransaction:       jest.fn(),
  executeStellarPayment:   jest.fn(),
  registerAuditTrail:      jest.fn().mockResolvedValue(null),
  getAuditTrail:           jest.fn().mockResolvedValue(null),
  freezeUserTrustline:     jest.fn().mockResolvedValue(null),
  unfreezeUserTrustline:   jest.fn().mockResolvedValue(null),
}));

// ─── Importaciones diferidas ──────────────────────────────────────────────────

const { default: app }         = await import('../../src/server.js');
const { default: request }     = await import('supertest');
const { default: Transaction } = await import('../../src/models/Transaction.js');

// ─── Helpers locales ──────────────────────────────────────────────────────────

/** Crea una Transaction de test en estado payin_pending */
async function createPendingTransaction(corridorDoc, overrides = {}) {
  return Transaction.create({
    alytoTransactionId: `ALY-B-${Date.now()}-TEST`,
    userId:             new (await import('mongoose')).default.Types.ObjectId(),
    corridorId:         corridorDoc._id,
    legalEntity:        'SpA',
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
      { stage: 'payin', provider: 'fintoc', status: 'pending', externalId: `pi_test_${Date.now()}` },
    ],
    ...overrides,
  });
}

/** Envía un IPN de Vita con firma válida */
function sendVitaIPN(app, body) {
  const rawBody = JSON.stringify(body);
  const headers = generateVitaIPNHeaders(body);

  return request(app)
    .post('/api/v1/ipn/vita')
    .set(headers)
    .set('content-type', 'application/json')
    .send(rawBody);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let corridor;

beforeAll(async () => {
  await connectTestDb();
  corridor = await seedCorridor();    // CL→BO, payoutMethod: anchorBolivia
});

afterEach(async () => {
  // Solo limpiar transactions — mantener corredor
  const { default: Transaction } = await import('../../src/models/Transaction.js');
  await Transaction.deleteMany({});
  mockCreatePayout.mockReset();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ─── Tests: Vita IPN ──────────────────────────────────────────────────────────

describe('POST /api/v1/ipn/vita — firma y validación', () => {

  test('401 — sin firma (Authorization header ausente)', async () => {
    const body    = vitaPayinSucceededIPN('ALY-B-TEST-001');
    const rawBody = JSON.stringify(body);

    const res = await request(app)
      .post('/api/v1/ipn/vita')
      .set('content-type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
  });

  test('401 — firma inválida (secret incorrecto)', async () => {
    const body    = vitaPayinSucceededIPN('ALY-B-TEST-001');
    const rawBody = JSON.stringify(body);

    const res = await request(app)
      .post('/api/v1/ipn/vita')
      .set('x-login',       process.env.VITA_LOGIN)
      .set('x-date',        new Date().toISOString())
      .set('authorization', 'V2-HMAC-SHA256, Signature: deadbeefdeadbeef')
      .set('content-type',  'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
  });

  test('200 — firma válida, transacción no encontrada (devuelve 200 de todas formas)', async () => {
    const body = vitaPayinSucceededIPN('ALY-X-NONEXISTENT-999');
    const res  = await sendVitaIPN(app, body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

});

describe('POST /api/v1/ipn/vita — flujo payin → anchorBolivia', () => {

  test('IPN de payin "completed" → transacción pasa a payin_confirmed', async () => {
    const tx  = await createPendingTransaction(corridor);
    const body = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_wallet_uuid_test', token: 'vita_token_test' },
    };

    const res = await sendVitaIPN(app, body);
    expect(res.status).toBe(200);

    // Esperar breve para que el fire-and-forget procese
    await new Promise(r => setTimeout(r, 50));

    const updatedTx = await Transaction.findById(tx._id);
    expect(['payin_confirmed', 'processing']).toContain(updatedTx.status);
    expect(updatedTx.payinReference).toBe('vita_wallet_uuid_test');
  });

  test('IPN de payin "denied" → transacción pasa a failed', async () => {
    const tx  = await createPendingTransaction(corridor);
    const body = {
      status: 'denied',
      order:  tx.alytoTransactionId,
      wallet: {},
    };

    const res = await sendVitaIPN(app, body);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.status).toBe('failed');
  });

  test('IPN queda registrado en ipnLog de la transacción', async () => {
    const tx   = await createPendingTransaction(corridor);
    const body = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_uuid_log_test' },
    };

    await sendVitaIPN(app, body);
    await new Promise(r => setTimeout(r, 50));

    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.ipnLog.length).toBeGreaterThan(0);
    expect(updatedTx.ipnLog[0].provider).toBe('vitaWallet');
  });

});

describe('POST /api/v1/ipn/vita — flujo payout_sent → completed', () => {

  test('IPN de payout "completed" con status payout_sent → completed', async () => {
    const tx = await createPendingTransaction(corridor, {
      status:          'payout_sent',
      payoutReference: 'vita_withdrawal_ref_001',
    });

    const body = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_wallet_uuid_payout' },
    };

    const res = await sendVitaIPN(app, body);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.status).toBe('completed');
  });

});

// ─── Tests: Fintoc IPN (cross-border) ────────────────────────────────────────

describe('POST /api/v1/ipn/fintoc — cross-border', () => {

  test('200 — evento desconocido ignorado (no falla)', async () => {
    const body    = { type: 'payment_intent.created', data: { id: 'pi_test' } };
    const rawBody = JSON.stringify(body);

    const res = await request(app)
      .post('/api/v1/ipn/fintoc')
      .set('content-type', 'application/json')
      .send(rawBody);

    // Fintoc IPN handler siempre devuelve 200 para evitar reintentos
    expect(res.status).toBe(200);
  });

});
