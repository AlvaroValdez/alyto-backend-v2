/**
 * adminWalletAudit.test.js (integración) — Asiento de auditoría en las acciones
 * admin que MUEVEN dinero de usuarios (Tier 1 del barrido 2026-10-05).
 *
 * La regla (agosto 2026, versión fuerte): el asiento se escribe DENTRO de la
 * misma transacción de Mongo que la mutación — commitean juntos o abortan
 * juntos. Si la auditoría no se puede escribir, el dinero NO se mueve.
 *
 * Infra: estos endpoints usan sesiones de Mongoose, que el MongoMemoryServer
 * standalone del helper compartido no soporta. Este archivo levanta su PROPIO
 * MongoMemoryReplSet (1 nodo), que sí las soporta — es la primera cobertura de
 * integración de estos flujos.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createAdminUser, createSRLUser } from '../helpers/auth.js';

// ─── Mocks (patrón spread+override de quote.test.js) ──────────────────────────

const actualStellar = await import('../../src/services/stellarService.js');
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  ...actualStellar,
  registerAuditTrail:    jest.fn().mockResolvedValue(null),
  getStellarUSDCBalance: jest.fn().mockResolvedValue(9999),
  getAuditTrail:         jest.fn().mockResolvedValue(null),
}));

const { default: mongoose }          = await import('mongoose');
const { default: app }               = await import('../../src/app.js');
const { default: request }           = await import('supertest');
const { default: WalletBOB }         = await import('../../src/models/WalletBOB.js');
const { default: WalletUSDC }        = await import('../../src/models/WalletUSDC.js');
const { default: WalletTransaction } = await import('../../src/models/WalletTransaction.js');
const { default: AdminAuditLog }     = await import('../../src/models/AdminAuditLog.js');

let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  // Calentar colecciones e índices ANTES de la primera transacción: en un
  // replset recién nacido, los builds de índice compiten con la transacción y
  // Mongo la aborta con "catalog changes; please retry" (flake intermitente).
  const { default: User } = await import('../../src/models/User.js');
  await Promise.all([WalletBOB, WalletUSDC, WalletTransaction, AdminAuditLog, User]
    .map(m => m.init().catch(() => {})));
}, 90_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map(c => c.deleteMany({})));
  jest.restoreAllMocks();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
const nextId = (p) => `${p}-AUDIT-${Date.now()}-${++seq}`;

async function seedDepositPendiente(user, amount = 500) {
  const wallet = await WalletBOB.create({ userId: user._id, balance: 100, balanceReserved: 0 });
  const wtx = await WalletTransaction.create({
    wtxId: nextId('DEP'), walletId: wallet._id, walletModel: 'WalletBOB',
    userId: user._id, currency: 'BOB', type: 'deposit', amount,
    balanceBefore: 0, balanceAfter: 0,
    status: 'pending', metadata: { comprobante: { filename: 'c.jpg' } },
  });
  return { wallet, wtx };
}

async function seedRetiroPendiente(user, amount = 200) {
  const wallet = await WalletBOB.create({ userId: user._id, balance: 500, balanceReserved: amount });
  const wtx = await WalletTransaction.create({
    wtxId: nextId('RET'), walletId: wallet._id, walletModel: 'WalletBOB',
    userId: user._id, currency: 'BOB', type: 'withdrawal', amount,
    balanceBefore: 0, balanceAfter: 0,
    status: 'pending', metadata: { method: 'bank', accountNumber: '123', accountHolder: 'Test' },
  });
  return { wallet, wtx };
}

async function seedConversionPendiente(user, bobAmount = 240, usdcAmount = 20) {
  const walletBOB  = await WalletBOB.create({ userId: user._id, balance: 500, balanceReserved: bobAmount });
  const walletUSDC = await WalletUSDC.create({ userId: user._id, balance: 0, balanceReserved: 0 });
  const wtx = await WalletTransaction.create({
    wtxId: nextId('CNV'), walletId: walletBOB._id, walletModel: 'WalletBOB',
    userId: user._id, currency: 'BOB', type: 'bob_to_usdc', amount: bobAmount,
    balanceBefore: 0, balanceAfter: 0,
    status: 'pending',
    metadata: { bobAmount, usdcAmount, bobPerUsdc: 12,
                walletBOBId: String(walletBOB._id), walletUSDCId: String(walletUSDC._id) },
  });
  return { walletBOB, walletUSDC, wtx };
}

const post = (token, path, body) => request(app)
  .post(path).set('Authorization', `Bearer ${token}`).send(body);

// ─── Confirmación de depósito ─────────────────────────────────────────────────

describe('wallet.deposit.confirm — asiento atómico', () => {
  test('acreditar deja asiento con actor, monto y saldos', async () => {
    const { user }         = await createSRLUser();
    const { user: adminU, token } = await createAdminUser();
    const { wallet, wtx }  = await seedDepositPendiente(user, 500);

    const res = await post(token, '/api/v1/admin/wallet/deposit/confirm',
      { wtxId: wtx.wtxId, bankReference: 'BEC-777', note: 'visto en extracto' });
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'wallet.deposit.confirm' }).lean();
    expect(asiento).not.toBeNull();
    expect(String(asiento.actorId)).toBe(String(adminU._id));
    expect(asiento.targetId).toBe(wtx.wtxId);
    expect(asiento.metadata.amountBOB).toBe(500);
    expect(asiento.metadata.userId).toBe(String(user._id));
    expect(asiento.reason).toBe('visto en extracto');
    expect(asiento.before.balance).toBe(100);
    expect(asiento.after.balance).toBe(600);

    const w = await WalletBOB.findById(wallet._id).lean();
    expect(w.balance).toBe(600);
  });

  test('FAIL-CLOSED: si el asiento no se puede escribir, el dinero NO se mueve', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const { wallet, wtx } = await seedDepositPendiente(user, 500);

    // La escritura del asiento revienta → la transacción entera debe abortar.
    jest.spyOn(AdminAuditLog, 'create').mockRejectedValueOnce(new Error('auditoría caída'));

    const res = await post(token, '/api/v1/admin/wallet/deposit/confirm',
      { wtxId: wtx.wtxId, bankReference: 'BEC-778' });
    expect(res.status).toBe(500);

    // La garantía que convierte el asiento en control y no en adorno:
    const w = await WalletBOB.findById(wallet._id).lean();
    expect(w.balance).toBe(100);                                   // sin acreditar
    const t = await WalletTransaction.findById(wtx._id).lean();
    expect(t.status).toBe('pending');                              // sin consumir
  });
});

// ─── Rechazo de retiro ────────────────────────────────────────────────────────

describe('wallet.withdrawal.reject — asiento con motivo', () => {
  test('rechazar deja asiento y libera la reserva', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const { wallet, wtx } = await seedRetiroPendiente(user, 200);

    const res = await post(token, '/api/v1/admin/wallet/withdrawal/reject',
      { wtxId: wtx.wtxId, reason: 'cuenta destino no coincide con el titular' });
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'wallet.withdrawal.reject' }).lean();
    expect(asiento).not.toBeNull();
    expect(asiento.reason).toMatch(/no coincide/);
    expect(asiento.after.reservaLiberada).toBe(200);

    const w = await WalletBOB.findById(wallet._id).lean();
    expect(w.balanceReserved).toBe(0);
    expect(w.balance).toBe(500);   // el saldo no se descuenta en un rechazo
  });
});

// ─── Conversión BOB→USDC ──────────────────────────────────────────────────────

describe('wallet.conversion.bob_usdc.confirm — asiento atómico con la conversión', () => {
  test('confirmar deja asiento con ambos montos y mueve los dos saldos', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const { walletBOB, walletUSDC, wtx } = await seedConversionPendiente(user, 240, 20);

    const res = await post(token, '/api/v1/admin/wallet/usdc/conversions/confirm',
      { wtxId: wtx.wtxId, note: 'USDC comprado en P2P, orden 123' });
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'wallet.conversion.bob_usdc.confirm' }).lean();
    expect(asiento).not.toBeNull();
    expect(asiento.metadata.bobAmount).toBe(240);
    expect(asiento.metadata.usdcAmount).toBe(20);
    expect(asiento.metadata.userId).toBe(String(user._id));

    const wb = await WalletBOB.findById(walletBOB._id).lean();
    const wu = await WalletUSDC.findById(walletUSDC._id).lean();
    expect(wb.balance).toBe(260);          // 500 − 240
    expect(wb.balanceReserved).toBe(0);
    expect(wu.balance).toBe(20);
  });

  test('FAIL-CLOSED: asiento caído → ni se debita BOB ni se acredita USDC', async () => {
    const { user }  = await createSRLUser();
    const { token } = await createAdminUser();
    const { walletBOB, walletUSDC, wtx } = await seedConversionPendiente(user, 240, 20);

    jest.spyOn(AdminAuditLog, 'create').mockRejectedValueOnce(new Error('auditoría caída'));

    const res = await post(token, '/api/v1/admin/wallet/usdc/conversions/confirm',
      { wtxId: wtx.wtxId });
    expect(res.status).toBe(500);

    const wb = await WalletBOB.findById(walletBOB._id).lean();
    const wu = await WalletUSDC.findById(walletUSDC._id).lean();
    expect(wb.balance).toBe(500);
    expect(wb.balanceReserved).toBe(240);  // la reserva sigue intacta
    expect(wu.balance).toBe(0);
    expect((await WalletTransaction.findById(wtx._id).lean()).status).toBe('pending');
  });
});

// ─── Comprobante retroactivo (sin sesión) ─────────────────────────────────────

describe('wallet.withdrawal.attach_comprobante — asiento del adjunto excepcional', () => {
  test('adjuntar deja asiento con quién y a qué retiro', async () => {
    const { user }  = await createSRLUser();
    const { user: adminU, token } = await createAdminUser();
    const { wtx } = await seedRetiroPendiente(user, 200);

    const res = await request(app)
      .post(`/api/v1/admin/wallet/withdrawals/${wtx.wtxId}/comprobante`)
      .set('Authorization', `Bearer ${token}`)
      .attach('comprobante', Buffer.from('fake-jpg'), 'transferencia.jpg');
    expect(res.status).toBe(200);

    const asiento = await AdminAuditLog.findOne({ action: 'wallet.withdrawal.attach_comprobante' }).lean();
    expect(asiento).not.toBeNull();
    expect(String(asiento.actorId)).toBe(String(adminU._id));
    expect(asiento.before.teniaComprobante).toBe(false);
    expect(asiento.after.filename).toBe('transferencia.jpg');
  });
});
