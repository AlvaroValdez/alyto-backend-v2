/**
 * adminForcedActions.test.js — Acciones admin que dan por ocurrido algo que
 * nadie verificó, y la reemisión de documentos regulatorios.
 *
 * Hallazgos de la revisión adversarial del 2026-08-15:
 *
 *   H5 · POST /admin/vita/force-complete — marca 'completed', emite comprobante
 *        y notifica al usuario basándose SOLO en la afirmación del operador de
 *        que Vita pagó. No pedía motivo ni dejaba AdminAuditLog.
 *
 *   H2 · POST /admin/regenerate-comprobante — segunda vía de emisión del
 *        Comprobante Oficial: no auditaba, recalculaba el tipo de cambio (podía
 *        diferir del documento original) y devolvía err.stack al cliente.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createAdminUser, createSRLUser } from '../helpers/auth.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const actualPdf     = await import('../../src/utils/pdfGenerator.js');
const actualStorage = await import('../../src/services/storageService.js');
const actualStellar = await import('../../src/services/stellarService.js');

await jest.unstable_mockModule('../../src/utils/pdfGenerator.js', () => ({
  ...actualPdf,
  generateOfficialReceipt: jest.fn().mockResolvedValue({
    buffer: Buffer.from('%PDF-1.4 mock'), filename: 'comprobante_mock.pdf',
  }),
}));

await jest.unstable_mockModule('../../src/services/storageService.js', () => ({
  ...actualStorage,
  uploadBuffer:           jest.fn().mockResolvedValue({ url: 's3key://pdfs/bolivia/mock.pdf', storage: 'mock', key: 'mock' }),
  resolveComprobanteUrl:  jest.fn().mockResolvedValue('https://cdn.example/mock.pdf'),
}));

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  ...actualStellar,
  registerAuditTrail: jest.fn().mockResolvedValue('stellar_hash_mock'),
}));

const { default: app }           = await import('../../src/server.js');
const { default: request }       = await import('supertest');
const { default: Transaction }   = await import('../../src/models/Transaction.js');
const { default: AdminAuditLog } = await import('../../src/models/AdminAuditLog.js');
const pdfGen                     = await import('../../src/utils/pdfGenerator.js');

const MOTIVO = 'Confirmado en el panel de Vita Business, referencia VT-99120';

async function crearTx(userDoc, overrides = {}) {
  return Transaction.create({
    alytoTransactionId: `ALY-C-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    userId:             userDoc._id,
    legalEntity:        'SRL',
    operationType:      'crossBorderPayment',
    routingScenario:    'C',
    status:             'payout_sent',
    originalAmount:     931,
    digitalAssetAmount: 100,
    originCurrency:     'BOB',
    originCountry:      'BO',
    destinationCurrency: 'ARS',
    destinationCountry: 'AR',
    destinationAmount:  95000,
    digitalAsset:       'USDC',
    payoutReference:    'vita_ref_123',
    ...overrides,
  });
}

beforeAll(async () => { await connectTestDb(); });
afterEach(async () => { jest.clearAllMocks(); await clearCollections(); });
afterAll(async () => { await disconnectTestDb(); });

// ─── H5 · force-complete ──────────────────────────────────────────────────────

describe('POST /admin/vita/force-complete', () => {

  test('400 sin motivo — y la transacción NO se completa', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .post('/api/v1/admin/vita/force-complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect((await Transaction.findById(tx._id).lean()).status).toBe('payout_sent');
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('400 con motivo demasiado corto', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .post('/api/v1/admin/vita/force-complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: '  ok  ' });

    expect(res.status).toBe(400);
    expect((await Transaction.findById(tx._id).lean()).status).toBe('payout_sent');
  });

  test('200 con motivo — completa y deja registro con el estado previo', async () => {
    const { user }  = await createSRLUser();
    const { user: adminUser, token } = await createAdminUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .post('/api/v1/admin/vita/force-complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: MOTIVO });

    expect(res.status).toBe(200);
    expect(res.body.auditLogId).toBeTruthy();

    const fresca = await Transaction.findById(tx._id).lean();
    expect(fresca.status).toBe('completed');

    const log = await AdminAuditLog.findOne({ action: 'payout.vita.force_complete' }).lean();
    expect(String(log.actorId)).toBe(String(adminUser._id));
    expect(log.before.status).toBe('payout_sent');
    expect(log.after.status).toBe('completed');
    expect(log.reason).toBe(MOTIVO);
    expect(log.metadata.payoutReference).toBe('vita_ref_123');

    // El motivo también queda en el ipnLog de la propia transacción.
    const entrada = fresca.ipnLog.find(e => e.eventType === 'payout_completed_admin_forced');
    expect(entrada.rawPayload.reason).toBe(MOTIVO);
    expect(entrada.rawPayload.forcedBy).toBe(adminUser.email);
  });

  test('400 si la transacción no está en payout_sent', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user, { status: 'completed' });

    const res = await request(app)
      .post('/api/v1/admin/vita/force-complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: MOTIVO });

    expect(res.status).toBe(400);
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('403 — un usuario normal no llega al endpoint', async () => {
    const { user, token } = await createSRLUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .post('/api/v1/admin/vita/force-complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: MOTIVO });

    expect(res.status).toBe(403);
    expect((await Transaction.findById(tx._id).lean()).status).toBe('payout_sent');
  });
});

// ─── H1 · el camino barato al lado de force-complete ──────────────────────────

describe('PATCH /admin/transactions/:id/status — estados terminales forzados', () => {

  test('400 — llevar a completed con una note de 1 carácter ya no alcanza', async () => {
    // Era el bypass de /vita/force-complete: mismo poder (marcar completed y
    // habilitar la emisión del Comprobante Oficial) con `note: "x"` y sin
    // AdminAuditLog.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', note: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect((await Transaction.findById(tx._id).lean()).status).toBe('payout_sent');
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('200 con motivo — completa y queda auditado', async () => {
    const { user }  = await createSRLUser();
    const { user: adminUser, token } = await createAdminUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', note: 'Vita confirmó fuera de banda, ticket SOP-4412' });

    expect(res.status).toBe(200);
    expect((await Transaction.findById(tx._id).lean()).status).toBe('completed');

    const log = await AdminAuditLog.findOne({ action: 'transaction.force_status' }).lean();
    expect(String(log.actorId)).toBe(String(adminUser._id));
    expect(log.before.status).toBe('payout_sent');
    expect(log.after.status).toBe('completed');
    expect(log.reason).toContain('SOP-4412');
  });

  test('refunded también exige motivo', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user);

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'refunded', note: 'ok' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });

  test('los estados NO terminales siguen aceptando una note corta (sin regresión)', async () => {
    // El endpoint se usa a diario para mover estados intermedios; el rigor
    // extra aplica solo a los que afirman que el dinero se movió.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user, { status: 'payin_pending' });

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'payin_confirmed', note: 'ok' });

    expect(res.status).toBe(200);
    expect(await AdminAuditLog.countDocuments({ action: 'transaction.force_status' })).toBe(0);
  });

  test('reafirmar el mismo estado terminal no exige motivo (no hay cambio)', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user, { status: 'completed' });

    const res = await request(app)
      .patch(`/api/v1/admin/transactions/${tx.alytoTransactionId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed', note: 'ok' });

    expect(res.status).toBe(200);
  });
});

// ─── H2 · regenerate-comprobante ──────────────────────────────────────────────

describe('POST /admin/regenerate-comprobante', () => {

  const txCompletada = (user, extra = {}) => crearTx(user, {
    status: 'completed',
    boliviaCompliance: {
      numeroComprobante: 'BOL-202608-000042',
      exchangeRateBob:   6.96,
      amountBob:         931,
    },
    ...extra,
  });

  test('reproduce la tasa del comprobante original, no una recalculada', async () => {
    // originalAmount/digitalAssetAmount = 931/100 = 9.31, distinto del 6.96 que
    // se estampó al liquidar. Regenerar debe REPRODUCIR el documento, no emitir
    // uno nuevo con otra tasa bajo el mismo número de correlativo.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await txCompletada(user);

    const res = await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: 'El PDF original no llegó a S3' });

    expect(res.status).toBe(200);
    expect(res.body.numeroComprobante).toBe('BOL-202608-000042');

    const dto = pdfGen.generateOfficialReceipt.mock.calls[0][0];
    expect(dto.tipoDeCambio).toBe(6.96);
    expect(dto.numeroComprobante).toBe('BOL-202608-000042');
  });

  test('la reemisión queda auditada', async () => {
    const { user }  = await createSRLUser();
    const { user: adminUser, token } = await createAdminUser();
    const tx = await txCompletada(user);

    await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: 'El PDF original no se subió a S3' });

    const log = await AdminAuditLog.findOne({ action: 'comprobante.regenerate' }).lean();
    expect(log).toBeTruthy();
    expect(String(log.actorId)).toBe(String(adminUser._id));
    expect(log.before.numeroComprobante).toBe('BOL-202608-000042');
    expect(log.after.numeroComprobante).toBe('BOL-202608-000042');
    expect(log.reason).toBe('El PDF original no se subió a S3');
    expect(log.metadata.correlativoNuevo).toBe(false);
  });

  test('marca en la auditoría cuando consume un correlativo NUEVO', async () => {
    // Sin numeroComprobante previo, este endpoint quema uno de la serie oficial.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await crearTx(user, { status: 'completed', conversionRate: { rate: 6.96 } });

    const res = await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: 'Comprobante nunca emitido al completar' });

    expect(res.status).toBe(200);
    expect(res.body.numeroComprobante).toMatch(/^BOL-\d{6}-\d{6}$/);

    const log = await AdminAuditLog.findOne({ action: 'comprobante.regenerate' }).lean();
    expect(log.metadata.correlativoNuevo).toBe(true);
    expect(log.before.numeroComprobante).toBeNull();
  });

  test('la comisión sale del campo canónico fees.totalDeducted, no del legacy', async () => {
    // `feeBreakdown` es un sub-esquema legacy que NINGÚN path escribe. Leerlo
    // daba comisión 0 y totalLiquidado = originalAmount, o sea un Comprobante
    // Oficial con cifras distintas a las del documento emitido al liquidar —
    // bajo el mismo correlativo y la misma key de S3 con Object Lock.
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await txCompletada(user, { fees: { totalDeducted: 66.1, profitRetention: 0 } });

    await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: 'Reemisión por pedido de compliance' });

    const dto = pdfGen.generateOfficialReceipt.mock.calls[0][0];
    expect(dto.comisionServicio).toBe(66.1);
    expect(dto.totalLiquidado).toBeCloseTo(931 - 66.1, 5);
  });

  test('400 sin motivo — no reemite ni quema correlativo', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await txCompletada(user);

    const res = await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect(pdfGen.generateOfficialReceipt).not.toHaveBeenCalled();
  });

  test('400 sobre una tx business — no emite un BOL para algo que ya tiene SRV', async () => {
    // Las tx SRL business reciben un Comprobante Oficial de Servicio (serie SRV)
    // y dejan boliviaCompliance vacío. Sin guard, cada llamada quemaba un
    // correlativo BOL y producía un segundo documento oficial de otra serie.
    const { user }  = await createSRLUser({ accountType: 'business' });
    const { token } = await createAdminUser();
    const tx = await crearTx(user, {
      status: 'completed',
      businessInvoice: { invoiceNumber: 'SRV-202608-000007' },
    });

    const res = await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: 'Reemisión solicitada por el cliente' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BUSINESS_INVOICE_TRANSACTION');
    expect(res.body.invoiceNumber).toBe('SRV-202608-000007');
    expect(pdfGen.generateOfficialReceipt).not.toHaveBeenCalled();
  });

  test('un 500 no devuelve el stack trace al cliente', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const tx = await txCompletada(user);

    pdfGen.generateOfficialReceipt.mockRejectedValueOnce(
      new Error('boom en /home/avf/Desarrollo/alyto-backend-v2/src/utils/pdfGenerator.js'),
    );

    const res = await request(app)
      .post('/api/v1/admin/regenerate-comprobante')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: tx.alytoTransactionId, reason: 'Reintento tras fallo de subida' });

    expect(res.status).toBe(500);
    expect(res.body.stack).toBeUndefined();
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});
