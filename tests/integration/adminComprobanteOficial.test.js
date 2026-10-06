/**
 * adminComprobanteOficial.test.js — admin puede obtener el Comprobante Oficial.
 *
 * Hueco detectado el 2026-10-06: admin solo exponía el comprobante que SUBE el
 * usuario (paymentProof), no el PDF oficial BOL- generado. En una tx cobrada por
 * QR (sin upload del usuario) no había forma de ver el documento regulatorio.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createAdminUser } from '../helpers/auth.js';

const actualStorage = await import('../../src/services/storageService.js');
await jest.unstable_mockModule('../../src/services/storageService.js', () => ({
  ...actualStorage,
  resolveComprobanteUrl: jest.fn(async (stored) =>
    stored ? 'https://s3.example/presigned/comprobante.pdf?sig=abc' : null),
}));

const { default: app }         = await import('../../src/app.js');
const { default: request }     = await import('supertest');
const { default: Transaction } = await import('../../src/models/Transaction.js');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearCollections);

async function seedTx(overrides = {}) {
  return Transaction.create({
    alytoTransactionId: 'ALY-C-TEST-COMP-1', userId: (await createAdminUser()).user._id,
    legalEntity: 'SRL', operationType: 'crossBorderPayment',
    originalAmount: 239, originCurrency: 'BOB', destinationAmount: 52621, destinationCurrency: 'COP',
    status: 'completed',
    ...overrides,
  });
}

const get = (token, id) => request(app)
  .get(`/api/v1/admin/transactions/${id}/comprobante-oficial`)
  .set('Authorization', `Bearer ${token}`);

describe('GET /admin/transactions/:id/comprobante-oficial', () => {
  test('devuelve la URL presignada y el número cuando existe el comprobante', async () => {
    const { token } = await createAdminUser();
    await seedTx({ boliviaCompliance: {
      numeroComprobante: 'BOL-202610-000002',
      comprobanteUrl: 's3key://pdfs/bolivia/BOL-202610-000002_x.pdf',
      comprobanteGeneratedAt: new Date(),
    }});

    const res = await get(token, 'ALY-C-TEST-COMP-1');
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/presigned/);
    expect(res.body.numeroComprobante).toBe('BOL-202610-000002');
  });

  test('404 accionable cuando la tx aún no generó el comprobante', async () => {
    const { token } = await createAdminUser();
    await seedTx({ boliviaCompliance: null });

    const res = await get(token, 'ALY-C-TEST-COMP-1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_COMPROBANTE');
  });

  test('404 si la transacción no existe', async () => {
    const { token } = await createAdminUser();
    const res = await get(token, 'ALY-C-NO-EXISTE');
    expect(res.status).toBe(404);
  });

  test('sin token → 401', async () => {
    const res = await request(app).get('/api/v1/admin/transactions/ALY-C-TEST-COMP-1/comprobante-oficial');
    expect(res.status).toBe(401);
  });
});
