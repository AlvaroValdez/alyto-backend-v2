/**
 * resealAuditTrails.test.js — Red de seguridad del sello on-chain.
 *
 * Acredita la garantía declarada ante ASFI: ninguna operación completada queda sin su
 * sello de existencia. El job busca operaciones completadas sin `stellarTxId` y reintenta
 * el sello; sólo esas, y con cota de reintentos. Se mockea registerAuditTrail para
 * ejercitar el job sin red.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const mockRegister = jest.fn();
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  registerAuditTrail: mockRegister,
}));

const { default: Transaction } = await import('../../src/models/Transaction.js');
const { resealAuditTrails, buildResealFilter } = await import('../../src/jobs/resealAuditTrails.js');

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => { await clearCollections(); mockRegister.mockReset(); });

let seq = 0;
function baseTx(overrides = {}) {
  seq += 1;
  return {
    alytoTransactionId: `ALY-C-RESEAL-${seq}`,
    userId:             new mongoose.Types.ObjectId(),
    legalEntity:        'SRL',
    operationType:      'crossBorderPayment',
    routingScenario:    'C',
    status:             'completed',
    originalAmount:     1000,
    originCurrency:     'BOB',
    originCountry:      'BO',
    destinationCurrency: 'BRL',
    destinationCountry:  'BR',
    digitalAsset:       'USDC',
    exchangeRate:       0.14,
    ...overrides,
  };
}

describe('buildResealFilter — sólo operaciones completadas sin sello, dentro de cota', () => {
  it('arma el filtro con ventana, cooldown y presupuesto de intentos', () => {
    const now = new Date('2026-09-12T12:00:00Z');
    const f = buildResealFilter({ now, maxAttempts: 10, cooldownMs: 900_000, sinceMs: 86_400_000 });

    expect(f.status).toBe('completed');
    expect(f.stellarTxId).toEqual({ $in: [null, ''] });
    expect(f.createdAt.$gte).toEqual(new Date(now.getTime() - 86_400_000));   // ventana
    // Presupuesto de intentos + cooldown como cláusulas $or dentro de $and.
    const [attemptsClause, cooldownClause] = f.$and;
    expect(attemptsClause.$or).toContainEqual({ stellarAuditAttempts: { $lt: 10 } });
    expect(cooldownClause.$or).toContainEqual({ stellarAuditLastAttemptAt: { $lte: new Date(now.getTime() - 900_000) } });
  });
});

describe('resealAuditTrails — sella lo pendiente, ignora lo demás', () => {
  it('sólo toca operaciones completadas sin sello; sella las que Stellar acepta', async () => {
    // 3 completadas SIN sello (candidatas) …
    const a = await Transaction.create(baseTx());
    const b = await Transaction.create(baseTx());
    const c = await Transaction.create(baseTx());
    // … 1 completada YA sellada (debe ignorarse) …
    await Transaction.create(baseTx({ stellarTxId: 'HASH-YA-SELLADA' }));
    // … 1 NO completada (debe ignorarse).
    await Transaction.create(baseTx({ status: 'payin_pending' }));

    // Stellar acepta a y c; b falla (devuelve null).
    mockRegister.mockImplementation(async (tx) =>
      tx.alytoTransactionId === b.alytoTransactionId ? null : `HASH-${tx.alytoTransactionId}`);

    const res = await resealAuditTrails();

    expect(res.processed).toBe(3);       // sólo las 3 candidatas
    expect(res.sealed).toBe(2);          // a y c
    expect(res.stillPending).toBe(1);    // b
    expect(mockRegister).toHaveBeenCalledTimes(3);

    const aFresh = await Transaction.findById(a._id).lean();
    const bFresh = await Transaction.findById(b._id).lean();
    const cFresh = await Transaction.findById(c._id).lean();

    expect(aFresh.stellarTxId).toBe(`HASH-${a.alytoTransactionId}`);
    expect(cFresh.stellarTxId).toBe(`HASH-${c.alytoTransactionId}`);
    // La que falló: sigue sin sello, con el intento contabilizado y marca de error.
    expect(bFresh.stellarTxId ?? '').toBe('');
    expect(bFresh.stellarAuditAttempts).toBe(1);
    expect(bFresh.stellarAuditLastAttemptAt).toBeTruthy();
    expect(bFresh.stellarAuditLastError).toBeTruthy();
  });

  it('agota el presupuesto de intentos → lo reporta como exhausto (no en silencio)', async () => {
    process.env.STELLAR_AUDIT_RESEAL_MAX_ATTEMPTS = '1';
    const t = await Transaction.create(baseTx());
    mockRegister.mockResolvedValue(null);   // siempre falla

    const res = await resealAuditTrails();

    expect(res.stillPending).toBe(1);
    expect(res.exhausted).toBe(1);          // llegó al tope en esta corrida
    const fresh = await Transaction.findById(t._id).lean();
    expect(fresh.stellarAuditAttempts).toBe(1);
    delete process.env.STELLAR_AUDIT_RESEAL_MAX_ATTEMPTS;
  });

  it('una operación ya sellada nunca se re-sella', async () => {
    await Transaction.create(baseTx({ stellarTxId: 'HASH-EXISTENTE' }));
    const res = await resealAuditTrails();
    expect(res.processed).toBe(0);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
