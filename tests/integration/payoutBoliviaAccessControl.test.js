/**
 * payoutBoliviaAccessControl.test.js — Control de acceso de la liquidación
 * manual del Corredor Bolivia (DEFECTO 1).
 *
 * POST /api/v1/payouts/bolivia/manual marca la transacción como 'completed',
 * consume un correlativo de la serie oficial BOL-YYYYMM-NNNNNN y emite el
 * Comprobante Oficial de Transacción (documento con valor regulatorio ante ASFI).
 *
 * Antes bastaba un JWT de CUALQUIER usuario bajo la entidad SRL: se podía
 * liquidar una transacción ajena, quemar un correlativo, fijar un tipo de cambio
 * arbitrario y recibir de vuelta un PDF con el KYC del titular.
 *
 * Se cubre: rol admin exigido, override de tasa acotado y auditado, y reclamo
 * atómico del estado para que dos llamadas concurrentes no emitan dos
 * comprobantes oficiales de la misma operación.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createAdminUser, createSRLUser } from '../helpers/auth.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Patrón del repo: importar el módulo REAL y hacer spread + override.

const actualPdf     = await import('../../src/utils/pdfGenerator.js');
const actualStorage = await import('../../src/services/storageService.js');
const actualFx      = await import('../../src/services/exchangeRateService.js');

await jest.unstable_mockModule('../../src/utils/pdfGenerator.js', () => ({
  ...actualPdf,
  generateOfficialReceipt: jest.fn().mockResolvedValue({
    buffer:   Buffer.from('%PDF-1.4 mock comprobante'),
    filename: 'comprobante_mock.pdf',
  }),
}));

await jest.unstable_mockModule('../../src/services/storageService.js', () => ({
  ...actualStorage,
  uploadBuffer: jest.fn().mockResolvedValue({ url: 's3key://pdfs/bolivia/mock.pdf', storage: 'mock', key: 'mock' }),
}));

// getBOBRate pega a Binance P2P — jamás debe salir a la red en tests.
await jest.unstable_mockModule('../../src/services/exchangeRateService.js', () => ({
  ...actualFx,
  getBOBRate: jest.fn().mockResolvedValue(6.90),
}));

// ─── Importaciones diferidas (después de registrar los mocks) ─────────────────

const { default: app }           = await import('../../src/server.js');
const { default: request }       = await import('supertest');
const { default: Transaction }   = await import('../../src/models/Transaction.js');
const { default: Counter }       = await import('../../src/models/Counter.js');
const { default: AdminAuditLog } = await import('../../src/models/AdminAuditLog.js');
const { generateToken }          = await import('../helpers/auth.js');

const LOCKED_RATE = 6.96;

async function createSettlableTransaction(userDoc, overrides = {}) {
  return Transaction.create({
    alytoTransactionId: `ALY-C-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    userId:             userDoc._id,
    legalEntity:        'SRL',
    operationType:      'crossBorderPayment',
    routingScenario:    'C',
    status:             'in_transit',
    originalAmount:     1000,
    originCurrency:     'BOB',
    originCountry:      'BO',
    destinationCurrency: 'BOB',
    digitalAsset:       'USDC',
    digitalAssetAmount: 143.68,
    stellarTxId:        'abc123def456',
    conversionRate: {
      fromCurrency: 'BOB', toCurrency: 'USD', rate: LOCKED_RATE, convertedAmount: 143.68,
    },
    ...overrides,
  });
}

/** Secuencia consumida este mes de la serie oficial BOL. 0 si nunca se tocó. */
async function currentBolSeq() {
  const now    = new Date();
  const key    = `BOL-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const doc    = await Counter.findById(key).lean();
  return doc?.seq ?? 0;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => { await connectTestDb(); });
afterEach(async () => { await clearCollections(); });
afterAll(async () => { await disconnectTestDb(); });

// ─── Control de acceso ────────────────────────────────────────────────────────

describe('POST /api/v1/payouts/bolivia/manual — control de acceso', () => {

  test('401 sin token', async () => {
    const { user } = await createSRLUser();
    const tx = await createSettlableTransaction(user);

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(401);
  });

  test('403 — usuario SRL autenticado NO admin (el agujero original)', async () => {
    // Este era el escenario explotable: cualquier boliviano con cuenta podía
    // liquidar la transacción de otro y recibir su comprobante.
    const { user: victima }              = await createSRLUser();
    const { user: atacante, token }      = await createSRLUser();
    const tx = await createSettlableTransaction(victima);
    const seqAntes = await currentBolSeq();

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(403);
    expect(atacante.role).toBe('user');

    // Y lo que importa de verdad: no hubo efecto lateral.
    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).toBe('in_transit');
    expect(fresca.boliviaCompliance?.numeroComprobante).toBeUndefined();
    expect(await currentBolSeq()).toBe(seqAntes);          // no se quemó correlativo
  });

  test('403 — ni siquiera el propio titular de la transacción puede liquidarla', async () => {
    // Emitir el Comprobante Oficial es back-office, no una acción del cliente.
    const { user, token } = await createSRLUser();
    const tx = await createSettlableTransaction(user);

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(403);
    expect((await Transaction.findById(tx._id).lean()).status).toBe('in_transit');
  });

  test('403 — un usuario desactivado con token válido tampoco pasa', async () => {
    const { user } = await createSRLUser();
    const { user: adminUser } = await createAdminUser({ isActive: false });
    const tx = await createSettlableTransaction(user);

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${generateToken(adminUser._id)}`)
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(401);   // protect() corta antes por cuenta suspendida
  });

  test('200 — el admin sí liquida, aunque su legalEntity sea LLC', async () => {
    // Regresión del arreglo: el middleware anterior era requireEntity(['SRL']),
    // que valida la entidad del LLAMADOR. Los admins se crean bajo LLC
    // (scripts/seedAdmin.js), así que combinarlo con requireAdmin habría dejado
    // el endpoint inalcanzable. La restricción SRL aplica a la TRANSACCIÓN.
    const { user }  = await createSRLUser();
    const { user: adminUser, token } = await createAdminUser();
    expect(adminUser.legalEntity).toBe('LLC');

    const tx = await createSettlableTransaction(user);

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).toBe('completed');
    expect(fresca.boliviaCompliance.exchangeRateBob).toBe(LOCKED_RATE);
    expect(fresca.boliviaCompliance.exchangeRateSource).toBe('locked_quote');
    expect(fresca.boliviaCompliance.numeroComprobante).toMatch(/^BOL-\d{6}-\d{6}$/);
  });

  test('403 — transacción de otra entidad legal (SpA/LLC) sigue bloqueada para el admin', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user, { legalEntity: 'SpA' });

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(403);
    expect((await Transaction.findById(tx._id).lean()).status).toBe('in_transit');
  });
});

// ─── Tipo de cambio ───────────────────────────────────────────────────────────

describe('POST /api/v1/payouts/bolivia/manual — tipo de cambio del comprobante', () => {

  test('422 — tipoCambioManual arbitrario fuera de banda, sin efecto lateral', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);
    const seqAntes = await currentBolSeq();

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString(), tipoCambioManual: 25 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MANUAL_RATE_OUT_OF_BOUNDS');
    expect(res.body.referenceRate).toBe(LOCKED_RATE);

    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).toBe('in_transit');
    expect(await currentBolSeq()).toBe(seqAntes);
  });

  test('422 — tipoCambioManual no numérico', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString(), tipoCambioManual: 'seis noventa y seis' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MANUAL_RATE_INVALID');
  });

  test('200 — override dentro de banda: se aplica, se marca y queda auditado', async () => {
    const { user }  = await createSRLUser();
    const { user: adminUser, token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString(), tipoCambioManual: 7.10 });

    expect(res.status).toBe(200);

    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.boliviaCompliance.exchangeRateBob).toBe(7.10);
    expect(fresca.boliviaCompliance.exchangeRateSource).toBe('manual_override');

    // El override altera el monto de un documento regulatorio: debe haber rastro.
    const logs = await AdminAuditLog.find({ action: 'payout.bolivia.manual_rate_override' }).lean();
    expect(logs).toHaveLength(1);
    expect(String(logs[0].actorId)).toBe(String(adminUser._id));
    expect(logs[0].before.exchangeRateBob).toBe(LOCKED_RATE);
    expect(logs[0].after.exchangeRateBob).toBe(7.10);
    expect(logs[0].metadata.numeroComprobante).toMatch(/^BOL-/);
  });

  test('la liquidación sin override NO genera registro de auditoría', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);

    await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(await AdminAuditLog.countDocuments({ action: 'payout.bolivia.manual_rate_override' })).toBe(0);
  });

  test('422 — transacción sin tasa bloqueada y sin override', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user, { conversionRate: undefined });

    const res = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_RATE_AVAILABLE');
  });
});

// ─── Un solo comprobante por operación ────────────────────────────────────────

describe('POST /api/v1/payouts/bolivia/manual — no emite comprobantes duplicados', () => {

  test('409 al reintentar sobre una transacción ya liquidada', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);

    const primera = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });
    expect(primera.status).toBe(200);

    const seqTrasPrimera = await currentBolSeq();

    const segunda = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    expect(segunda.status).toBe(409);
    expect(await currentBolSeq()).toBe(seqTrasPrimera);   // no quemó otro número
  });

  test('revertir el estado a in_transit NO habilita un segundo Comprobante Oficial', async () => {
    // El filtro por estado solo serializa la concurrencia. `PATCH
    // /admin/transactions/:id/status` acepta 'in_transit' como destino sin guard
    // de transición, así que un admin podía revertir y re-liquidar: se quemaba
    // otro correlativo y el numeroComprobante anterior quedaba huérfano en la
    // serie oficial. El guard idempotente es el correlativo ya emitido.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);

    await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    const trasPrimera = await Transaction.findById(tx._id).lean();
    const correlativoOriginal = trasPrimera.boliviaCompliance.numeroComprobante;
    const seqTrasPrimera = await currentBolSeq();

    // Rollback del estado, tal como lo permite el endpoint admin de status.
    await Transaction.updateOne({ _id: tx._id }, { $set: { status: 'in_transit' } });

    const replay = await request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString(), tipoCambioManual: 7.10 });

    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('COMPROBANTE_ALREADY_ISSUED');
    expect(replay.body.numeroComprobante).toBe(correlativoOriginal);

    // Ni correlativo nuevo, ni correlativo huérfano, ni tasa pisada.
    expect(await currentBolSeq()).toBe(seqTrasPrimera);
    const final = await Transaction.findById(tx._id).lean();
    expect(final.boliviaCompliance.numeroComprobante).toBe(correlativoOriginal);
    expect(final.boliviaCompliance.exchangeRateBob).toBe(LOCKED_RATE);
    expect(await AdminAuditLog.countDocuments({ action: 'payout.bolivia.manual_rate_override' })).toBe(0);
  });

  test('dos llamadas concurrentes: solo una liquida y solo se consume un correlativo', async () => {
    // El chequeo de estado era check-then-act: ambas llamadas lo pasaban y cada
    // una emitía su propio Comprobante Oficial para la MISMA operación.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await createSettlableTransaction(user);
    const seqAntes = await currentBolSeq();

    const enviar = () => request(app)
      .post('/api/v1/payouts/bolivia/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx._id.toString() });

    const resultados = await Promise.all([enviar(), enviar(), enviar()]);
    const ok      = resultados.filter(r => r.status === 200);
    const chocan  = resultados.filter(r => r.status === 409);

    expect(ok).toHaveLength(1);
    expect(chocan).toHaveLength(2);
    expect(await currentBolSeq()).toBe(seqAntes + 1);

    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).toBe('completed');
    // Un solo asiento de payout, no tres.
    expect(fresca.paymentLegs.filter(l => l.provider === 'anchorBolivia')).toHaveLength(1);
  });
});
