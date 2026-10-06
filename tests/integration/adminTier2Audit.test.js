/**
 * adminTier2Audit.test.js (integración) — Asiento de auditoría en las mutaciones
 * admin de CONFIGURACIÓN y estado (Tier 2 del barrido 2026-10-05).
 *
 * Dos mecanismos bajo prueba:
 *   1. El middleware genérico `auditAdmin` (tasas, corredores, QR, funding,
 *      jobs): asienta actor + target + body redactado SOLO si la respuesta fue
 *      2xx — una mutación rechazada no es una acción ejecutada.
 *   2. Los asientos a mano con before/after donde el estado previo importa:
 *      kyb.review, reclamo.responder, ros.alert.review.
 *
 * Sin sesiones de Mongo acá (eso es Tier 1): corre sobre el helper estándar.
 */

import '../setup.env.js';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';
import { createAdminUser, createSRLUser } from '../helpers/auth.js';

const { default: app }               = await import('../../src/app.js');
const { default: request }           = await import('supertest');
const { default: AdminAuditLog }     = await import('../../src/models/AdminAuditLog.js');
const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');
const { default: BusinessProfile }   = await import('../../src/models/BusinessProfile.js');
const { default: Reclamo }           = await import('../../src/models/Reclamo.js');
const { default: ROSAlert }          = await import('../../src/models/ROSAlert.js');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearCollections);

/** El middleware asienta en res.on('finish'), que corre DESPUÉS de responder. */
async function asientoEventual(filtro, intentos = 20) {
  for (let i = 0; i < intentos; i++) {
    const doc = await AdminAuditLog.findOne(filtro).lean();
    if (doc) return doc;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

async function seedCorridorBoBr() {
  return TransactionConfig.create({
    corridorId: 'bo-br', originCountry: 'BO', destinationCountry: 'BR',
    originCurrency: 'BOB', destinationCurrency: 'BRL',
    payinMethod: 'manual', payoutMethod: 'vitaWallet', legalEntity: 'SRL',
    routingScenario: 'C', alytoCSpread: 6.5, fixedFee: 6, payinFeePercent: 0,
    payoutFeeFixed: 0, profitRetentionPercent: 0, minAmountOrigin: 240, isActive: true,
  });
}

// ─── 1. Middleware genérico ───────────────────────────────────────────────────

describe('auditAdmin (middleware) — mutaciones de configuración', () => {
  test('editar un corredor deja asiento con actor, target y el body como estado nuevo', async () => {
    const { user: adminU, token } = await createAdminUser();
    await seedCorridorBoBr();

    const res = await request(app)
      .patch('/api/v1/admin/corridors/bo-br')
      .set('Authorization', `Bearer ${token}`)
      .send({ minAmountUSD: 25, note: 'ajuste de política Vita' });
    expect(res.status).toBe(200);

    const asiento = await asientoEventual({ action: 'corridor.update' });
    expect(asiento).not.toBeNull();
    expect(String(asiento.actorId)).toBe(String(adminU._id));
    expect(asiento.targetType).toBe('TransactionConfig');
    expect(asiento.targetId).toBe('bo-br');
    expect(asiento.after.minAmountUSD).toBe(25);
    expect(asiento.reason).toBe('ajuste de política Vita');
    expect(asiento.metadata.method).toBe('PATCH');
  });

  test('una mutación RECHAZADA no deja asiento (4xx no es una acción ejecutada)', async () => {
    const { token } = await createAdminUser();
    // corredor inexistente → 404 del controller
    const res = await request(app)
      .patch('/api/v1/admin/corridors/no-existe')
      .set('Authorization', `Bearer ${token}`)
      .send({ minAmountUSD: 25 });
    expect(res.status).toBeGreaterThanOrEqual(400);

    await new Promise(r => setTimeout(r, 150));
    expect(await AdminAuditLog.countDocuments({ action: 'corridor.update' })).toBe(0);
  });

  test('disparar un job manual queda asentado con quién lo corrió', async () => {
    const { user: adminU, token } = await createAdminUser();

    const res = await request(app)
      .post('/api/v1/admin/cleanup-orphans')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);

    const asiento = await asientoEventual({ action: 'job.cleanup_orphans' });
    expect(asiento).not.toBeNull();
    expect(String(asiento.actorId)).toBe(String(adminU._id));
  });
});

// ─── 2. KYB review ────────────────────────────────────────────────────────────

describe('kyb.review — asiento con transición de estado', () => {
  test('aprobar un KYB asienta before/after, límites y quién decidió', async () => {
    const { user } = await createSRLUser();
    const { user: adminU, token } = await createAdminUser();

    const profile = await BusinessProfile.create({
      userId: user._id,
      legalName: 'Prueba SRL', taxId: '1234567890',
      countryOfIncorporation: 'BO', businessType: 'SRL',
      kybStatus: 'pending',
      documents: [{ type: 'docConstitution', filename: 'doc.pdf', mimetype: 'application/pdf', data: 'eA==' }],
    });

    const res = await request(app)
      .patch(`/api/v1/admin/kyb/${profile.businessId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved', note: 'documentación completa y verificada' });
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'kyb.review' }).lean();
    expect(asiento).not.toBeNull();
    expect(String(asiento.actorId)).toBe(String(adminU._id));
    expect(asiento.targetId).toBe(profile.businessId);
    expect(asiento.before.kybStatus).toBe('pending');
    expect(asiento.after.kybStatus).toBe('approved');
    expect(asiento.reason).toMatch(/documentación completa/);
    expect(asiento.metadata.userId).toBe(String(user._id));
  });
});

// ─── 3. Reclamos PRILI ────────────────────────────────────────────────────────

describe('reclamo.responder — asiento del acto con plazo regulatorio', () => {
  test('resolver un reclamo asienta la transición y la respuesta', async () => {
    const { user } = await createSRLUser();
    const { token } = await createAdminUser();

    const reclamo = await Reclamo.create({
      userId: user._id, tipo: 'demora',
      descripcion: 'Mi transferencia lleva tres días sin llegar al beneficiario.',
    });

    const res = await request(app)
      .patch(`/api/v1/admin/reclamos/${reclamo.reclamoId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'resuelto', respuesta: 'El pago se liquidó hoy; adjuntamos el comprobante del proveedor.' });
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'reclamo.responder' }).lean();
    expect(asiento).not.toBeNull();
    expect(asiento.targetId).toBe(reclamo.reclamoId);
    expect(asiento.before.status).toBe('recibido');
    expect(asiento.after.status).toBe('resuelto');
    expect(asiento.after.respondido).toBe(true);
    expect(asiento.metadata.plazoVence).toBeDefined();
  });
});

// ─── 4. Alertas ROS ───────────────────────────────────────────────────────────

describe('ros.alert.review — trazabilidad AML', () => {
  test('desestimar una alerta asienta el before/after y el reviewNote', async () => {
    const { user } = await createSRLUser();
    const { user: adminU, token } = await createAdminUser();

    const alert = await ROSAlert.create({
      alertId: `ROS-TEST-${Date.now()}`,
      userId: user._id, source: 'crossborder',
      rule: 'daily_cumulative', severity: 'medium', status: 'open',
      details: { montoBOB: 48000 },
    });

    const res = await request(app)
      .patch(`/api/v1/admin/ros/alerts/${alert.alertId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'dismissed', reviewNote: 'operaciones justificadas con contratos del cliente' });
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'ros.alert.review' }).lean();
    expect(asiento).not.toBeNull();
    expect(String(asiento.actorId)).toBe(String(adminU._id));
    expect(asiento.before.status).toBe('open');
    expect(asiento.after.status).toBe('dismissed');
    expect(asiento.reason).toMatch(/justificadas/);
  });
});
