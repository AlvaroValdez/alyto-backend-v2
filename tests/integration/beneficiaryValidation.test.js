/**
 * beneficiaryValidation.test.js (integración) — El create rechaza beneficiarios
 * que el proveedor va a rechazar, ANTES de emitir instrucciones de cobro.
 *
 * Reproduce la e2e del 2026-10-05 (tx ALY-C-1791248531719-BNBIXN) pero con el
 * final correcto: el pix_key_type inválido muere en el create con 400 y detalle
 * accionable, sin transacción persistida y sin QR — no en Vita con el cobro
 * ya tomado.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createSRLUser } from '../helpers/auth.js';

// ─── Mocks (mismo patrón spread+override que quote.test.js) ───────────────────

const actualVita = await import('../../src/services/vitaWalletService.js');

const mockGetWithdrawalRules = jest.fn();
const mockGetPrices          = jest.fn();
const mockGetWallets         = jest.fn();

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  ...actualVita,
  getWithdrawalRules: mockGetWithdrawalRules,
  getPrices:          mockGetPrices,
  getWallets:         mockGetWallets,
  createPayout:       jest.fn(),
  createPayin:        jest.fn(),
}));

const { default: app }               = await import('../../src/app.js');
const { default: request }           = await import('supertest');
const { default: Transaction }       = await import('../../src/models/Transaction.js');
const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');

// Campos BR reales (verificados contra Vita prod 2026-10-05), reducidos a lo esencial.
const RULES_BR = {
  rules: {
    br: {
      fields: [
        { key: 'beneficiary_first_name', type: 'text' },
        { key: 'pix_key_type', type: 'select',
          options: [{ value: 'code_cpf' }, { value: 'email' }, { value: 'random_key' }] },
        { key: 'account_bank__code_cpf', type: 'numeric', when: { key: 'pix_key_type', value: 'code_cpf' } },
        { key: 'purpose', type: 'select', options: [{ value: 'EPFAMT' }, { value: 'EPREMT' }] },
      ],
    },
  },
};

const BENEFICIARIO_OK = {
  beneficiary_first_name: 'Ana', beneficiary_last_name: 'Prueba',
  pix_key_type: 'code_cpf', account_bank__code_cpf: '39053344705',
  purpose: 'EPFAMT',
};

async function seedBoBr(overrides = {}) {
  return TransactionConfig.create({
    corridorId: 'bo-br', originCountry: 'BO', destinationCountry: 'BR',
    originCurrency: 'BOB', destinationCurrency: 'BRL',
    payinMethod: 'manual', payoutMethod: 'vitaWallet', legalEntity: 'SRL',
    routingScenario: 'C', alytoCSpread: 6.5, fixedFee: 6, payinFeePercent: 0,
    payoutFeeFixed: 0, profitRetentionPercent: 0, minAmountOrigin: 100, isActive: true,
    ...overrides,
  });
}

async function seedBoUs(overrides = {}) {
  return TransactionConfig.create({
    corridorId: 'bo-us', originCountry: 'BO', destinationCountry: 'US',
    originCurrency: 'BOB', destinationCurrency: 'USD',
    payinMethod: 'manual', payoutMethod: 'owlPay', legalEntity: 'SRL',
    routingScenario: 'C', alytoCSpread: 6.5, fixedFee: 6, payinFeePercent: 0,
    payoutFeeFixed: 0, profitRetentionPercent: 0, minAmountOrigin: 100, isActive: true,
    ...overrides,
  });
}

function postCrossborder(token, body) {
  return request(app)
    .post('/api/v1/payments/crossborder')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', `benval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    .send(body);
}

beforeAll(async () => {
  await connectTestDb();
  mockGetPrices.mockResolvedValue(null);     // fail-open del floor: no es el sujeto de estos tests
  mockGetWallets.mockResolvedValue({ data: [] });
});
afterAll(disconnectTestDb);
afterEach(async () => {
  await clearCollections();
  mockGetWithdrawalRules.mockReset();
  mockGetPrices.mockReset();
  mockGetWallets.mockReset();
  mockGetPrices.mockResolvedValue(null);
  mockGetWallets.mockResolvedValue({ data: [] });
});

describe('POST /crossborder — beneficiario Vita contra las rules del país', () => {
  test('el caso e2e: pix_key_type inválido → 400 accionable, sin tx y sin instrucciones', async () => {
    await seedBoBr();
    const { token, user } = await createSRLUser();
    mockGetWithdrawalRules.mockResolvedValue(RULES_BR);

    const res = await postCrossborder(token, {
      corridorId: 'bo-br', originAmount: 300,
      beneficiaryData: { ...BENEFICIARIO_OK, pix_key_type: 'cpf' },   // el valor del incidente
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BENEFICIARY_INVALID');
    expect(res.body.detalles.join(' ')).toMatch(/pix_key_type/);
    expect(res.body.detalles.join(' ')).toMatch(/code_cpf/);   // enseña el valor correcto

    // La garantía central: NADA quedó persistido. No hay cobro posible.
    expect(await Transaction.countDocuments({ userId: user._id })).toBe(0);
  });

  test('la chave del tipo elegido ausente → 400', async () => {
    await seedBoBr();
    const { token } = await createSRLUser();
    mockGetWithdrawalRules.mockResolvedValue(RULES_BR);

    const { account_bank__code_cpf: _, ...sinChave } = BENEFICIARIO_OK;
    const res = await postCrossborder(token, { corridorId: 'bo-br', originAmount: 300, beneficiaryData: sinChave });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BENEFICIARY_INVALID');
  });

  test('beneficiario correcto → la tx nace en payin_pending con instrucciones manuales', async () => {
    await seedBoBr();
    const { token, user } = await createSRLUser();
    mockGetWithdrawalRules.mockResolvedValue(RULES_BR);

    const res = await postCrossborder(token, {
      corridorId: 'bo-br', originAmount: 300, beneficiaryData: BENEFICIARIO_OK,
    });

    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('payin_pending');
    expect(await Transaction.countDocuments({ userId: user._id })).toBe(1);
  });

  test('fail-open: si las rules de Vita no responden, el create NO se bloquea', async () => {
    await seedBoBr();
    const { token } = await createSRLUser();
    mockGetWithdrawalRules.mockRejectedValue(new Error('Vita timeout'));

    const res = await postCrossborder(token, {
      corridorId: 'bo-br', originAmount: 300,
      beneficiaryData: { ...BENEFICIARIO_OK, pix_key_type: 'cpf' },   // inválido, pero inverificable
    });

    // Un proveedor de metadatos caído no puede cerrar la caja: pasa.
    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('payin_pending');
  });
});

describe('POST /crossborder — beneficiario Harbor (dry-run del instrumento)', () => {
  const US_OK = {
    account_holder_name: 'John Doe', bank_name: 'Bank of America',
    account_number: '123456789012', routing_number: '021000021',
    street: '123 Main St', city: 'Los Angeles', state_province: 'CA', postal_code: '90001',
  };

  test('sin routing number → 400 antes de emitir instrucciones', async () => {
    await seedBoUs();
    const { token, user } = await createSRLUser();

    const { routing_number: _, ...sinRouting } = US_OK;
    const res = await postCrossborder(token, { corridorId: 'bo-us', originAmount: 700, beneficiaryData: sinRouting });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BENEFICIARY_INVALID');
    expect(await Transaction.countDocuments({ userId: user._id })).toBe(0);
  });

  test('beneficiario US completo → payin_pending', async () => {
    await seedBoUs();
    const { token } = await createSRLUser();

    const res = await postCrossborder(token, { corridorId: 'bo-us', originAmount: 700, beneficiaryData: US_OK });

    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('payin_pending');
  });
});
