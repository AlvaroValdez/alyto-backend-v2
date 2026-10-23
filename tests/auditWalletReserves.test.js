/**
 * auditWalletReserves.test.js
 *
 * Auditoría del saldo reservado.
 *
 * Nació de un caso real: 3 conversiones BOB→USDC llevaban 62 días en 'pending'
 * reteniendo 150 Bs de un usuario, con su saldo USDC en 0. El mecanismo para
 * devolver ese dinero existía desde hacía meses; lo que no había era quién
 * mirara.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/auditWalletReserves.test.js
 */

import { jest } from '@jest/globals';

const db = { paradas: [], agregado: [], wallets: [], avisos: [], marcados: [] };

jest.unstable_mockModule('../src/models/WalletTransaction.js', () => ({
  default: {
    find: jest.fn((f) => { db.ultimoFiltro = f; return { limit: () => ({ lean: async () => db.paradas }) }; }),
    aggregate: jest.fn(async () => db.agregado),
    updateOne: jest.fn(async (f, upd) => { db.marcados.push(upd.$set); return {}; }),
  },
}));
jest.unstable_mockModule('../src/models/WalletBOB.js', () => ({
  default: { find: () => ({ select: () => ({ lean: async () => db.wallets }) }) },
}));
jest.unstable_mockModule('../src/services/notifications.js', () => ({
  notifyAdmins: jest.fn(async (n) => { db.avisos.push(n); }),
  NOTIFICATIONS: {},
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }));

const { auditWalletReserves, RETIENEN_RESERVA } = await import('../src/jobs/auditWalletReserves.js');

beforeEach(() => {
  db.paradas = []; db.agregado = []; db.wallets = []; db.avisos = []; db.marcados = [];
  delete process.env.WALLET_STUCK_ALERT_DAYS;
});

describe('operaciones detenidas', () => {
  test('con todo en orden no avisa', async () => {
    const r = await auditWalletReserves();
    expect(r.ok).toBe(true);
    expect(r.paradasAvisadas).toBe(0);
    expect(db.avisos).toHaveLength(0);
  });

  test('avisa de una conversión detenida y dice que rechazar devuelve el saldo', async () => {
    db.paradas = [{ _id: 'c1', wtxId: 'WTX-CONV-1', amount: 50,
                    createdAt: new Date(Date.now() - 62 * 86_400_000) }];
    const r = await auditWalletReserves();

    expect(r.paradasAvisadas).toBe(1);
    expect(db.avisos[0].body).toContain('WTX-CONV-1');
    expect(db.avisos[0].body).toContain('62 días');
    expect(db.avisos[0].body).toMatch(/rechazar/i);
  });

  test('marca la operación para no repetir el aviso en cada corrida', async () => {
    db.paradas = [{ _id: 'c1', wtxId: 'WTX-CONV-1', amount: 50, createdAt: new Date(0) }];
    await auditWalletReserves();
    expect(db.marcados[0]['metadata.stuckAlertedAt']).toBeInstanceOf(Date);
  });

  test('el umbral por defecto son 2 días y se puede ajustar', async () => {
    await auditWalletReserves();
    const d1 = (Date.now() - db.ultimoFiltro.createdAt.$lt.getTime()) / 86_400_000;
    expect(d1).toBeCloseTo(2, 1);

    process.env.WALLET_STUCK_ALERT_DAYS = '7';
    await auditWalletReserves();
    const d2 = (Date.now() - db.ultimoFiltro.createdAt.$lt.getTime()) / 86_400_000;
    expect(d2).toBeCloseTo(7, 1);
  });
});

describe('cuadre de la reserva', () => {
  test('si lo reservado coincide con lo comprometido, no avisa', async () => {
    db.agregado = [{ _id: 'w1', total: 100 }];
    db.wallets  = [{ _id: 'w1', balanceReserved: 100 }];
    const r = await auditWalletReserves();
    expect(r.descuadradas).toBe(0);
  });

  // El caso real: reserva retenida sin operación viva que la justifique.
  test('detecta saldo reservado SIN operación que lo respalde', async () => {
    db.agregado = [];
    db.wallets  = [{ _id: 'w1', balanceReserved: 150 }];
    const r = await auditWalletReserves();
    expect(r.descuadradas).toBe(1);
    expect(db.avisos.some(a => /descuadrad/i.test(a.title))).toBe(true);
  });

  // El caso inverso, más peligroso: el usuario podría gastar lo comprometido.
  test('detecta operación viva SIN reserva que la respalde', async () => {
    db.agregado = [{ _id: 'w1', total: 100 }];
    db.wallets  = [{ _id: 'w1', balanceReserved: 0 }];
    const r = await auditWalletReserves();
    expect(r.descuadradas).toBe(1);
  });

  test('una billetera sin reserva ni operaciones está en orden', async () => {
    db.wallets = [{ _id: 'w1' }];   // sin el campo balanceReserved
    const r = await auditWalletReserves();
    expect(r.descuadradas).toBe(0);
  });
});

describe('contrato del módulo', () => {
  // Si se añade un tipo que reserve y no se añade aquí, el cuadre dará falsos
  // positivos. Esta prueba obliga a pasar por aquí al tocarlo.
  test('los estados que retienen reserva son los esperados', () => {
    expect(RETIENEN_RESERVA).toEqual([
      { type: 'withdrawal',  status: ['pending', 'dispatched'] },
      { type: 'bob_to_usdc', status: ['pending'] },
    ]);
  });

  test('no resuelve nada: solo marca que avisó', async () => {
    db.paradas = [{ _id: 'c1', wtxId: 'WTX-CONV-1', amount: 50, createdAt: new Date(0) }];
    await auditWalletReserves();
    for (const set of db.marcados) {
      expect(Object.keys(set)).toEqual(['metadata.stuckAlertedAt']);
    }
  });
});
