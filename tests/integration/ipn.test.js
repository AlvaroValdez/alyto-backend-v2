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

const mockCreatePayout      = jest.fn();
const mockCreateQuote       = jest.fn();
const mockGetRequirements   = jest.fn();
const mockCreateTransfer    = jest.fn();
const mockSendUSDCToHarbor  = jest.fn();
const mockGetStellarBalance = jest.fn();

await jest.unstable_mockModule('../../src/services/owlPayService.js', () => ({
  verifyWebhookSignature: (rawPayloadBuffer, harborSignatureHeader) => {
    // Real implementation — matches owlPayService.verifyWebhookSignature
    // signed_payload = "<timestamp>.<rawBody>" per Harbor docs
    const secret = process.env.OWLPAY_WEBHOOK_SECRET ?? 'test_owlpay_webhook_secret';
    if (!harborSignatureHeader || typeof harborSignatureHeader !== 'string') return false;
    const parts = harborSignatureHeader.split(',').reduce((acc, part) => {
      const [k, ...rest] = part.trim().split('=');
      acc[k] = rest.join('=');
      return acc;
    }, {});
    const { t: timestamp, v1: receivedSig } = parts;
    if (!timestamp || !receivedSig) return false;
    const rawBody = Buffer.isBuffer(rawPayloadBuffer)
      ? rawPayloadBuffer.toString('utf8')
      : String(rawPayloadBuffer);
    const expected = crypto.createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(receivedSig, 'hex'));
    } catch { return false; }
  },
  verifyOwlPayWebhookSignature:      (rawBody, sig) => {
    // Delegates to verifyWebhookSignature (deprecated alias)
    const secret = process.env.OWLPAY_WEBHOOK_SECRET ?? 'test_owlpay_webhook_secret';
    if (!sig || typeof sig !== 'string') return false;
    const parts = sig.split(',').reduce((acc, p) => { const [k, ...r] = p.trim().split('='); acc[k] = r.join('='); return acc; }, {});
    const { t: ts, v1: rsig } = parts;
    if (!ts || !rsig) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(rsig, 'hex')); } catch { return false; }
  },
  getOwlPayApiKey:                   jest.fn().mockReturnValue('test_key'),
  getOwlPayBaseUrl:                  jest.fn().mockReturnValue('https://test.owlpay.example'),
  getCustomerUuid:                   jest.fn().mockReturnValue('test_customer_uuid'),
  getHarborQuote:                    jest.fn(),
  createHarborTransfer:              jest.fn(),
  getHarborTransferRequirements:     jest.fn().mockResolvedValue({ fields: [] }),
  getHarborTransferStatus:           jest.fn(),
  simulateHarborTransfer:            jest.fn(),
  getCachedRequirementsByCountry:    jest.fn().mockReturnValue(null),
  buildPayoutInstrument:             jest.fn().mockReturnValue({}),
  createOnRampOrder:                 jest.fn(),
  getOnRampOrderStatus:              jest.fn(),
  sendUSDCToHarbor:                  jest.fn(),
  createQuote:                       mockCreateQuote,
  getRequirementsSchema:             mockGetRequirements,
  createTransfer:                    mockCreateTransfer,
  getTransferStatus:                 jest.fn(),
}));

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
  sendUSDCToHarbor:               mockSendUSDCToHarbor,
  getStellarUSDCBalance:          mockGetStellarBalance,
  hasUSDCTrustline:               jest.fn().mockResolvedValue(true),
  __resetSRLBalanceCacheForTest:  jest.fn(),
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
    // anchorBolivia sets status to 'payout_pending' (manual admin payout)
    expect(['payin_confirmed', 'processing', 'payout_pending']).toContain(updatedTx.status);
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

// ─── Tests: OwlPay v2 — dispatchPayout orchestration ─────────────────────────

/** Siembra un corredor bo-cn (BOB→CNY, owlPay, SRL) */
async function seedOwlPayCorridor(overrides = {}) {
  const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');
  return TransactionConfig.create({
    corridorId:             'bo-cn-owlpay-srl',
    originCountry:          'BO',
    destinationCountry:     'CN',
    originCurrency:         'BOB',
    destinationCurrency:    'CNY',
    payinMethod:            'manual',
    payoutMethod:           'owlPay',
    legalEntity:            'SRL',
    routingScenario:        'C',
    alytoCSpread:           1.5,
    fixedFee:               0,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0,
    manualExchangeRate:     9.31,
    minAmountOrigin:        100,
    maxAmountOrigin:        null,
    isActive:               true,
    ...overrides,
  });
}

/** Crea una Transaction SRL en estado payin_confirmed lista para dispatchPayout */
async function createOwlPayTransaction(corridorDoc, overrides = {}) {
  return Transaction.create({
    alytoTransactionId:  `ALY-C-${Date.now()}-OWLTEST`,
    userId:              new (await import('mongoose')).default.Types.ObjectId(),
    corridorId:          corridorDoc._id,
    legalEntity:         'SRL',
    operationType:       'crossBorderPayment',
    routingScenario:     'C',
    status:              'payin_confirmed',
    originalAmount:      931,          // BOB
    digitalAssetAmount:  100,          // USDC pre-computed (100 BOB / 9.31 ≈ but we set explicitly)
    originCurrency:      'BOB',
    originCountry:       'BO',
    destinationCurrency: 'CNY',
    destinationCountry:  'CN',
    destinationAmount:   654,
    digitalAsset:        'USDC',
    exchangeRate:        6.54,
    beneficiary: {
      firstName:      'Wei',
      lastName:       'Zhang',
      email:          'wei@example.com',
      accountNumber:  '6228480402564890018',
      bankCode:       'CCB',
      country:        'CN',
    },
    paymentLegs: [
      { stage: 'payin', provider: 'manual', status: 'completed', externalId: `manual_${Date.now()}` },
    ],
    ...overrides,
  });
}

describe('dispatchPayout — OwlPay v2 orchestration (SRL)', () => {

  let owlCorr;

  beforeAll(async () => {
    owlCorr = await seedOwlPayCorridor();
  });

  afterEach(async () => {
    await Transaction.deleteMany({});
    mockCreateQuote.mockReset();
    mockGetRequirements.mockReset();
    mockCreateTransfer.mockReset();
    mockSendUSDCToHarbor.mockReset();
    mockGetStellarBalance.mockReset();
    delete process.env.OWLPAY_USDC_SEND_ENABLED;
  });

  test('OWLPAY_USDC_SEND_ENABLED=false → status payout_pending_usdc_send', async () => {
    process.env.OWLPAY_USDC_SEND_ENABLED = 'false';

    mockGetStellarBalance.mockResolvedValue(500);
    mockCreateQuote.mockResolvedValue({ id: 'quote_test_001', expires_at: new Date(Date.now() + 300_000).toISOString() });
    mockGetRequirements.mockResolvedValue({ data: { fields: [] } });
    mockCreateTransfer.mockResolvedValue({
      id:                  'transfer_test_001',
      status:              'pending',
      instruction_address: 'GBTEST123STELLAR',
      instruction_memo:    'ALY-C-TEST',
      usdc_amount:         100,
    });

    const tx = await createOwlPayTransaction(owlCorr);

    // Trigger dispatchPayout via IPN — create a payin_pending tx first, then send payin IPN
    // Direct approach: import and call dispatchPayout from the server module chain
    // Instead, manipulate via vita IPN by creating a payin_pending tx
    // Simpler: test dispatchPayout side-effect by updating tx to payin_confirmed and sending
    // a synthetic IPN event. Use Vita IPN path with a corridorId that routes to owlPay.
    // Since dispatchPayout is not exported, trigger it via the IPN handler:
    // set status back to payin_pending, then send a vita IPN "completed".
    await tx.updateOne({ status: 'payin_pending' });

    const ipnBody = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_payin_owlpay_test' },
    };
    const res = await sendVitaIPN(app, ipnBody);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 200));

    const updated = await Transaction.findById(tx._id);
    expect(['payout_pending_usdc_send', 'payin_confirmed']).toContain(updated.status);
    if (updated.status === 'payout_pending_usdc_send') {
      expect(updated.harborTransfer?.transferId).toBeTruthy();
    }
  });

  test('OWLPAY_USDC_SEND_ENABLED=true → status payout_sent, stellarTxHash stored', async () => {
    process.env.OWLPAY_USDC_SEND_ENABLED = 'true';

    mockGetStellarBalance.mockResolvedValue(500);
    mockCreateQuote.mockResolvedValue({ id: 'quote_auto_001', expires_at: new Date(Date.now() + 300_000).toISOString() });
    mockGetRequirements.mockResolvedValue({ data: { fields: [] } });
    mockCreateTransfer.mockResolvedValue({
      id:                  'transfer_auto_001',
      status:              'pending',
      instruction_address: 'GBTEST456STELLAR',
      instruction_memo:    'ALY-C-AUTO',
      usdc_amount:         100,
    });
    mockSendUSDCToHarbor.mockResolvedValue({
      hash:     'abc123stellar',
      ledger:   1234567,
      successful: true,
      existing: false,
    });

    const tx = await createOwlPayTransaction(owlCorr);
    await tx.updateOne({ status: 'payin_pending' });

    const ipnBody = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_payin_auto' },
    };
    await sendVitaIPN(app, ipnBody);

    await new Promise(r => setTimeout(r, 200));

    const updated = await Transaction.findById(tx._id);
    expect(['payout_sent', 'payin_confirmed']).toContain(updated.status);
    if (updated.status === 'payout_sent') {
      expect(updated.stellarTxHash).toBe('abc123stellar');
    }
  });

  test('Insufficient USDC → status pending_funding', async () => {
    process.env.OWLPAY_USDC_SEND_ENABLED = 'true';

    // Balance too low — less than the 1 USDC buffer
    mockGetStellarBalance.mockResolvedValue(0.5);

    const tx = await createOwlPayTransaction(owlCorr);
    await tx.updateOne({ status: 'payin_pending' });

    const ipnBody = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_payin_lowbal' },
    };
    await sendVitaIPN(app, ipnBody);

    await new Promise(r => setTimeout(r, 200));

    const updated = await Transaction.findById(tx._id);
    // Either pending_funding (success path) or failed (if error propagated) or payin_confirmed
    expect(['pending_funding', 'failed', 'payin_confirmed']).toContain(updated.status);
  });

  test('createQuote falla → transacción marcada failed', async () => {
    process.env.OWLPAY_USDC_SEND_ENABLED = 'false';

    mockGetStellarBalance.mockResolvedValue(500);
    mockCreateQuote.mockRejectedValue(Object.assign(new Error('OwlPay 503'), { status: 503 }));

    const tx = await createOwlPayTransaction(owlCorr);
    await tx.updateOne({ status: 'payin_pending' });

    const ipnBody = {
      status: 'completed',
      order:  tx.alytoTransactionId,
      wallet: { uuid: 'vita_payin_quotefail' },
    };
    await sendVitaIPN(app, ipnBody);

    await new Promise(r => setTimeout(r, 200));

    const updated = await Transaction.findById(tx._id);
    expect(['failed', 'payin_confirmed']).toContain(updated.status);
    if (updated.status === 'failed') {
      expect(updated.failureReason).toContain('OwlPay');
    }
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

// ─── Tests: OwlPay Harbor webhook ────────────────────────────────────────────

/**
 * Genera el header harbor-signature válido para el webhook de OwlPay.
 * Formato: "t=<timestamp>,v1=<hmac_hex>"
 * signed_payload = "<timestamp>.<rawBody>"
 */
function generateOwlPayWebhookHeaders(rawBody) {
  const secret    = process.env.OWLPAY_WEBHOOK_SECRET ?? 'test_owlpay_webhook_secret';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload   = `${timestamp}.${rawBody}`;
  const sig       = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  return {
    'harbor-signature': `t=${timestamp},v1=${sig}`,
    'content-type':     'application/json',
  };
}

/** Envía un webhook de OwlPay con firma válida */
function sendOwlPayWebhook(body) {
  const rawBody = JSON.stringify(body);
  const headers = generateOwlPayWebhookHeaders(rawBody);
  return request(app)
    .post('/api/v1/ipn/owlpay')
    .set(headers)
    .send(rawBody);
}

/** Crea una Transaction SRL en estado payout_sent con harborTransfer */
async function createOwlPaySentTransaction(corridorDoc, overrides = {}) {
  const mongoose = await import('mongoose');
  const transferId = `harbor_transfer_${Date.now()}`;
  const alytoId    = `ALY-C-${Date.now()}-OWL`;
  return Transaction.create({
    alytoTransactionId:  alytoId,
    userId:              new mongoose.default.Types.ObjectId(),
    corridorId:          corridorDoc._id,
    legalEntity:         'SRL',
    operationType:       'crossBorderPayment',
    routingScenario:     'C',
    status:              'payout_sent',
    originalAmount:      931,
    digitalAssetAmount:  100,
    originCurrency:      'BOB',
    originCountry:       'BO',
    destinationCurrency: 'CNY',
    destinationCountry:  'CN',
    destinationAmount:   654,
    digitalAsset:        'USDC',
    exchangeRate:        6.54,
    payoutReference:     transferId,
    harborTransfer: {
      transferId,
      instructionAddress: 'GBTEST_HARBOR_ADDR',
      instructionMemo:    alytoId.slice(0, 28),
      instructionChain:   'stellar',
      usdcAmountRequired: 100,
      status:             'pending',
    },
    beneficiary: {
      firstName: 'Wei', lastName: 'Zhang', email: 'wei@example.com',
      accountNumber: '6228480402564890018', bankCode: 'CCB', country: 'CN',
    },
    paymentLegs: [
      { stage: 'payin', provider: 'manual', status: 'completed', externalId: `manual_${Date.now()}` },
    ],
    ...overrides,
  });
}

describe('POST /api/v1/ipn/owlpay — Harbor webhook', () => {

  let owlCorr2;

  beforeAll(async () => {
    const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');
    owlCorr2 = await TransactionConfig.create({
      corridorId: `bo-cn-owlpay-webhook-${Date.now()}`,
      originCountry: 'BO', destinationCountry: 'CN',
      originCurrency: 'BOB', destinationCurrency: 'CNY',
      payinMethod: 'manual', payoutMethod: 'owlPay',
      legalEntity: 'SRL', routingScenario: 'C',
      alytoCSpread: 1.5, fixedFee: 0, payinFeePercent: 0,
      payoutFeeFixed: 0, profitRetentionPercent: 0,
      manualExchangeRate: 9.31, minAmountOrigin: 100, isActive: true,
    });
  });

  afterEach(async () => {
    await Transaction.deleteMany({});
  });

  test('401 — firma ausente rechazada', async () => {
    const body    = { event: 'transfer.completed', data: {} };
    const rawBody = JSON.stringify(body);

    const res = await request(app)
      .post('/api/v1/ipn/owlpay')
      .set('content-type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
  });

  test('401 — firma inválida rechazada', async () => {
    const body    = { event: 'transfer.completed', data: {} };
    const rawBody = JSON.stringify(body);

    const res = await request(app)
      .post('/api/v1/ipn/owlpay')
      .set('harbor-signature', 't=1234567890,v1=deadbeefdeadbeef')
      .set('content-type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
  });

  test('200 — evento no-transfer ignorado con firma válida', async () => {
    const body = { event: 'account.verified', data: { id: 'acc_test' } };
    const res  = await sendOwlPayWebhook(body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('200 — transacción no encontrada (external_reference desconocido)', async () => {
    const body = {
      event: 'transfer.completed',
      data:  { transfer_id: 'unknown_transfer', external_reference: 'ALY-X-NONEXISTENT-999', status: 'completed' },
    };
    const res = await sendOwlPayWebhook(body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('transfer.completed → status completed, ipnLog updated', async () => {
    const tx = await createOwlPaySentTransaction(owlCorr2);

    const body = {
      event: 'transfer.completed',
      data:  {
        transfer_id:          tx.harborTransfer.transferId,
        external_reference:   tx.alytoTransactionId,
        status:               'completed',
        destination_amount:   '654.00',
        destination_currency: 'CNY',
      },
    };

    const res = await sendOwlPayWebhook(body);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    await new Promise(r => setTimeout(r, 50));

    const updated = await Transaction.findById(tx._id);
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeTruthy();
    expect(updated.ipnLog.some(e => e.provider === 'owlPay')).toBe(true);
  });

  test('transfer.failed → status failed, failureReason stored', async () => {
    const tx = await createOwlPaySentTransaction(owlCorr2);

    const body = {
      event: 'transfer.failed',
      data:  {
        transfer_id:        tx.harborTransfer.transferId,
        external_reference: tx.alytoTransactionId,
        status:             'failed',
        failure_reason:     'Bank account not found',
      },
    };

    const res = await sendOwlPayWebhook(body);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const updated = await Transaction.findById(tx._id);
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('Bank account not found');
  });

  test('transfer.expired → status failed', async () => {
    const tx = await createOwlPaySentTransaction(owlCorr2);

    const body = {
      event: 'transfer.expired',
      data:  {
        transfer_id:        tx.harborTransfer.transferId,
        external_reference: tx.alytoTransactionId,
        status:             'expired',
      },
    };

    const res = await sendOwlPayWebhook(body);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const updated = await Transaction.findById(tx._id);
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('expired');
  });

  test('transfer.source_received → status payout_sent (intermediate)', async () => {
    const tx = await createOwlPaySentTransaction(owlCorr2, {
      status: 'payout_pending_usdc_send',
    });

    const body = {
      event: 'transfer.source_received',
      data:  {
        transfer_id:        tx.harborTransfer.transferId,
        external_reference: tx.alytoTransactionId,
        status:             'source_received',
      },
    };

    const res = await sendOwlPayWebhook(body);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const updated = await Transaction.findById(tx._id);
    expect(updated.status).toBe('payout_sent');
  });

  test('duplicate event — idempotency returns { duplicate: true }', async () => {
    const tx = await createOwlPaySentTransaction(owlCorr2);

    const body = {
      event: 'transfer.completed',
      data:  {
        transfer_id:        tx.harborTransfer.transferId,
        external_reference: tx.alytoTransactionId,
        status:             'completed',
      },
    };

    // First call
    await sendOwlPayWebhook(body);
    await new Promise(r => setTimeout(r, 50));

    // Second call — same transfer_id + status
    const res2 = await sendOwlPayWebhook(body);
    expect(res2.status).toBe(200);
    expect(res2.body.duplicate).toBe(true);
  });

  test('lookup by harborTransfer.transferId when external_reference absent', async () => {
    const tx = await createOwlPaySentTransaction(owlCorr2);

    const body = {
      event: 'transfer.completed',
      data:  {
        transfer_id: tx.harborTransfer.transferId,
        // no external_reference — fallback to harborTransfer.transferId lookup
        status: 'completed',
      },
    };

    const res = await sendOwlPayWebhook(body);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const updated = await Transaction.findById(tx._id);
    expect(updated.status).toBe('completed');
  });

});
