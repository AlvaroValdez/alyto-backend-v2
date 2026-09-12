/**
 * adminAuditAppendOnly.test.js — Bitácora de administración de solo agregado.
 *
 * Acredita el control declarado ante ASFI: un asiento de la bitácora de acciones
 * administrativas no admite modificación ni supresión posterior. La prueba intenta
 * cada operación de escritura sobre un asiento ya creado y verifica que la capa de
 * datos la rechaza.
 */
import '../setup.env.js';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const { default: AdminAuditLog } = await import('../../src/models/AdminAuditLog.js');

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => { await clearCollections(); });

async function crearAsiento() {
  return AdminAuditLog.create({
    action: 'test.control', actorEmail: 'a@x.com', actorRole: 'admin',
    targetType: 'User', targetId: '1', before: { role: 'user' }, after: { role: 'admin' },
    reason: 'prueba de solo-agregado',
  });
}

describe('la bitácora de administración es de solo agregado', () => {

  it('crear un asiento sí está permitido', async () => {
    const a = await crearAsiento();
    expect(a._id).toBeTruthy();
  });

  it('updateOne sobre un asiento existente es rechazado', async () => {
    await crearAsiento();
    await expect(AdminAuditLog.updateOne({ action: 'test.control' }, { $set: { reason: 'alterado' } }))
      .rejects.toThrow(/append-only/i);
  });

  it('findOneAndUpdate es rechazado', async () => {
    await crearAsiento();
    await expect(AdminAuditLog.findOneAndUpdate({ action: 'test.control' }, { $set: { reason: 'x' } }))
      .rejects.toThrow(/append-only/i);
  });

  it('deleteOne es rechazado', async () => {
    await crearAsiento();
    await expect(AdminAuditLog.deleteOne({ action: 'test.control' })).rejects.toThrow(/append-only/i);
  });

  it('deleteMany es rechazado', async () => {
    await crearAsiento();
    await expect(AdminAuditLog.deleteMany({})).rejects.toThrow(/append-only/i);
  });

  it('save() sobre un documento ya persistido es rechazado', async () => {
    const a = await crearAsiento();
    a.reason = 'intento de reescritura';
    await expect(a.save()).rejects.toThrow(/append-only/i);
  });

  it('tras los intentos, el asiento original permanece intacto', async () => {
    await crearAsiento();
    try { await AdminAuditLog.updateOne({ action: 'test.control' }, { $set: { reason: 'x' } }); } catch { /* esperado */ }
    const vivo = await AdminAuditLog.findOne({ action: 'test.control' }).lean();
    expect(vivo.reason).toBe('prueba de solo-agregado');
  });
});
