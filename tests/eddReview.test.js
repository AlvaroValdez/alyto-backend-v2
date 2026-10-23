/**
 * eddReview.test.js
 *
 * Resolución de la diligencia reforzada por el Oficial de Cumplimiento.
 *
 * Lo que se protege: que una decisión de cumplimiento quede SIEMPRE con motivo
 * escrito y con autor. Una cola que se resuelve sin rastro no es un control,
 * es un botón.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/eddReview.test.js
 */

import { jest } from '@jest/globals';

const db = { usuario: null, actualizado: null };

jest.unstable_mockModule('../src/models/User.js', () => ({
  default: {
    findById: () => ({ select: () => ({ lean: async () => db.usuario }) }),
    findByIdAndUpdate: jest.fn(async (id, upd) => { db.actualizado = { id, ...upd.$set }; return db.actualizado; }),
    find: () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) }),
  },
}));
const { resolverEdd, listarEdd } = await import('../src/controllers/adminController.js');

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}
const req = (body = {}, userId = 'u1') => ({
  params: { userId }, body, query: {}, user: { _id: 'admin-1' },
});

beforeEach(() => { db.usuario = { eddStatus: 'pending' }; db.actualizado = null; });

describe('resolverEdd', () => {
  test('aprueba y deja constancia de quién, cuándo y por qué', async () => {
    const res = fakeRes();
    await resolverEdd(req({ decision: 'approved', notes: 'Cargo municipal verificado, origen de fondos consistente.' }), res);

    expect(res.statusCode).toBe(200);
    expect(db.actualizado.eddStatus).toBe('approved');
    expect(db.actualizado.eddReviewedBy).toBe('admin-1');
    expect(db.actualizado.eddReviewedAt).toBeInstanceOf(Date);
    expect(db.actualizado.eddNotes).toContain('Cargo municipal');
  });

  // El motivo es obligatorio a propósito: es lo que pide un revisor externo.
  test('rechaza una resolución sin motivo escrito', async () => {
    const res = fakeRes();
    await resolverEdd(req({ decision: 'approved', notes: 'ok' }), res);
    expect(res.statusCode).toBe(400);
    expect(db.actualizado).toBeNull();
  });

  test('rechaza una decisión que no sea aprobar o rechazar', async () => {
    const res = fakeRes();
    await resolverEdd(req({ decision: 'quizas', notes: 'un motivo suficientemente largo' }), res);
    expect(res.statusCode).toBe(400);
  });

  test('no se puede resolver dos veces: devuelve conflicto', async () => {
    db.usuario = { eddStatus: 'approved' };
    const res = fakeRes();
    await resolverEdd(req({ decision: 'rejected', notes: 'intento de cambiar lo ya resuelto' }), res);
    expect(res.statusCode).toBe(409);
    expect(db.actualizado).toBeNull();
  });

  test('usuario inexistente devuelve 404', async () => {
    db.usuario = null;
    const res = fakeRes();
    await resolverEdd(req({ decision: 'approved', notes: 'motivo suficientemente largo' }), res);
    expect(res.statusCode).toBe(404);
  });

  // Rechazar la EDD no es dar de baja: son decisiones distintas y la segunda es
  // mucho más grave. Que una no arrastre a la otra es deliberado.
  test('rechazar NO desactiva la cuenta', async () => {
    const res = fakeRes();
    await resolverEdd(req({ decision: 'rejected', notes: 'No acredita el origen de los fondos declarados.' }), res);
    expect(res.statusCode).toBe(200);
    expect(db.actualizado).not.toHaveProperty('isActive');
  });
});

describe('listarEdd', () => {
  test('rechaza un estado que no existe', async () => {
    const res = fakeRes();
    await listarEdd({ query: { status: 'inventado' }, user: { _id: 'admin-1' } }, res);
    expect(res.statusCode).toBe(400);
  });

  test('por defecto devuelve lo pendiente, que es lo accionable', async () => {
    const res = fakeRes();
    await listarEdd({ query: {}, user: { _id: 'admin-1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('pending');
  });
});
