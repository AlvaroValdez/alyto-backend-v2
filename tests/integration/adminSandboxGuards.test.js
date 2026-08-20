/**
 * adminSandboxGuards.test.js — Endpoints de simulación bloqueados en producción
 * (DEFECTO 2).
 *
 * `POST /admin/transactions/:id/simulate-bankqr-payment` decía "SOLO PARA
 * SANDBOX" en su docstring pero no tenía ningún check de NODE_ENV. En
 * producción acredita saldo BOB de la nada (confirmBankQrDeposit → $inc
 * balance) o marca payin_confirmed y dispara dispatchPayout — un payout
 * internacional real contra un ingreso que nunca existió.
 *
 * Se cubre el guard de los tres simuladores del panel admin, y que fuera de
 * producción sigan siendo usables (el guard no debe romper staging).
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createAdminUser, createSRLUser } from '../helpers/auth.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const actualOwlPay = await import('../../src/services/owlPayService.js');

await jest.unstable_mockModule('../../src/services/owlPayService.js', () => ({
  ...actualOwlPay,
  // Si el guard fallara, esto se llamaría — el spy lo delata.
  simulateTransferCompleted: jest.fn().mockResolvedValue({ ok: true }),
}));

const { default: app }         = await import('../../src/server.js');
const { default: request }     = await import('supertest');
const { default: Transaction } = await import('../../src/models/Transaction.js');
const { default: WalletBOB }   = await import('../../src/models/WalletBOB.js');
const owlPay                   = await import('../../src/services/owlPayService.js');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SECRETS  = process.env.AWS_SECRETS_NAME;

/** Simula el VPS de producción real: NODE_ENV=production + Secrets Manager. */
function simularProduccionReal() {
  process.env.NODE_ENV         = 'production';
  process.env.AWS_SECRETS_NAME = 'alyto/production';
}

function restaurarEntorno() {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_SECRETS === undefined) delete process.env.AWS_SECRETS_NAME;
  else process.env.AWS_SECRETS_NAME = ORIGINAL_SECRETS;
}

// Los tres simuladores del panel admin.
const SIMULADORES = [
  { nombre: 'bankQr payin',      metodo: 'post', path: () => '/api/v1/admin/transactions/ALY-C-1-XYZ/simulate-bankqr-payment' },
  { nombre: 'retiro settle',     metodo: 'post', path: () => '/api/v1/admin/wallet/withdrawal/simulate-settle', body: { wtxId: 'WTX-1' } },
  { nombre: 'OwlPay transfer',   metodo: 'post', path: () => '/api/v1/admin/sandbox/owlpay/simulate/uuid-1' },
];

async function crearTxBankQr(userDoc) {
  return Transaction.create({
    alytoTransactionId: `ALY-C-${Date.now()}-BANKQR`,
    userId:             userDoc._id,
    legalEntity:        'SRL',
    operationType:      'crossBorderPayment',
    routingScenario:    'C',
    status:             'payin_pending',
    originalAmount:     1000,
    originCurrency:     'BOB',
    originCountry:      'BO',
    destinationCurrency: 'ARS',
    destinationCountry: 'AR',
    digitalAsset:       'USDC',
    bankQr:             { qrId: 'mock-bec-123', bankId: 'bec' },
  });
}

beforeAll(async () => { await connectTestDb(); });

afterEach(async () => {
  restaurarEntorno();
  jest.clearAllMocks();
  await clearCollections();
});

afterAll(async () => {
  restaurarEntorno();
  await disconnectTestDb();
});

describe('Simuladores admin — bloqueados en producción real', () => {

  test.each(SIMULADORES)('403 SANDBOX_ONLY — $nombre', async ({ metodo, path, body }) => {
    const { token } = await createAdminUser();
    simularProduccionReal();

    const res = await request(app)[metodo](path())
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SANDBOX_ONLY');
  });

  test('el simulador de payin NO acredita saldo ni dispara payout en producción', async () => {
    // El efecto que se está previniendo, verificado sobre el estado, no sobre el
    // código de respuesta: la transacción sigue en payin_pending y no hay saldo.
    const { user } = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTxBankQr(user);
    await WalletBOB.create({ userId: user._id, balance: 0 });

    simularProduccionReal();

    const res = await request(app)
      .post(`/api/v1/admin/transactions/${tx.alytoTransactionId}/simulate-bankqr-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);

    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).toBe('payin_pending');
    expect(fresca.bankQr.paidAt).toBeUndefined();
    expect((await WalletBOB.findOne({ userId: user._id }).lean()).balance).toBe(0);
  });

  test('el simulador de OwlPay no llega a llamar al proveedor en producción', async () => {
    const { token } = await createAdminUser();
    simularProduccionReal();

    await request(app)
      .post('/api/v1/admin/sandbox/owlpay/simulate/uuid-abc')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(owlPay.simulateTransferCompleted).not.toHaveBeenCalled();
  });

  test('un no-admin recibe 403 de checkAdmin incluso fuera de producción', async () => {
    const { token } = await createSRLUser();

    const res = await request(app)
      .post('/api/v1/admin/transactions/ALY-C-1-XYZ/simulate-bankqr-payment')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('SANDBOX_ONLY');   // lo cortó el rol, no el entorno
  });
});

describe('Simuladores admin — siguen usables fuera de producción', () => {

  test('en test/staging el guard deja pasar y responde la lógica real (404)', async () => {
    // Regresión: el guard no debe romper el flujo de sandbox — llega al handler,
    // que responde 404 porque la transacción no existe.
    const { token } = await createAdminUser();

    const res = await request(app)
      .post('/api/v1/admin/transactions/ALY-C-NO-EXISTE/simulate-bankqr-payment')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).not.toBe('SANDBOX_ONLY');
  });

  test('Render staging (NODE_ENV=production SIN Secrets Manager): denegado por defecto, habilitable', async () => {
    // Render staging corre NODE_ENV=production a propósito (render.yaml) y ahí
    // el botón "⚡ Simular pago bancario" es la herramienta de prueba de Fase 42.
    // Un guard que mirara solo NODE_ENV lo habría roto sin aviso.
    const { token } = await createAdminUser();
    delete process.env.AWS_SECRETS_NAME;
    process.env.NODE_ENV = 'production';

    const bloqueado = await request(app)
      .post('/api/v1/admin/transactions/ALY-C-NO-EXISTE/simulate-bankqr-payment')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.body.code).toBe('SANDBOX_ONLY');

    process.env.ALYTO_SANDBOX_SIMULATORS = 'true';
    const habilitado = await request(app)
      .post('/api/v1/admin/transactions/ALY-C-NO-EXISTE/simulate-bankqr-payment')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(habilitado.status).toBe(404);   // llegó al handler
    delete process.env.ALYTO_SANDBOX_SIMULATORS;
  });

  test('el opt-in de staging NO reabre los simuladores en producción real', async () => {
    const { token } = await createAdminUser();
    simularProduccionReal();
    process.env.ALYTO_SANDBOX_SIMULATORS = 'true';

    const res = await request(app)
      .post('/api/v1/admin/transactions/ALY-C-NO-EXISTE/simulate-bankqr-payment')
      .set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SANDBOX_ONLY');
    delete process.env.ALYTO_SANDBOX_SIMULATORS;
  });

  test('en sandbox el simulador SÍ confirma el payin (comportamiento preservado)', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTxBankQr(user);

    const res = await request(app)
      .post(`/api/v1/admin/transactions/${tx.alytoTransactionId}/simulate-bankqr-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);

    // No se afirma sobre `status`: dispatchPayout corre fire-and-forget tras la
    // confirmación y lo avanza (payin_confirmed → processing…). Lo estable es la
    // marca del pago simulado.
    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).not.toBe('payin_pending');
    expect(fresca.bankQr.paidAt).toBeInstanceOf(Date);
    expect(fresca.bankQr.payment.simulated).toBe(true);
  });
});
