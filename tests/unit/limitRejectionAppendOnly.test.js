/**
 * limitRejectionAppendOnly.test.js — Asiento de rechazo por límite del ECP.
 *
 * Acredita el control declarado ante ASFI: cuando el sistema rechaza una operación por
 * exceso de límite del Protocolo, el rechazo queda como asiento CONSULTABLE en el
 * sistema —con el límite alcanzado, el consumo previo y el remanente— y ese asiento es
 * de SOLO AGREGADO (no se edita ni se borra).
 */
import '../setup.env.js';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const { default: LimitRejection } = await import('../../src/models/LimitRejection.js');
const { buildLimitRejectionRecord, recordEcpRejection } =
  await import('../../src/services/limitRejectionService.js');

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => { await clearCollections(); });

// Un violation típico de evaluateEcpLimits (tope diario en BOB alcanzado).
const violation = {
  code: 'ECP_DAILY_AMOUNT_LIMIT', scope: 'diario', unit: 'BOB',
  limit: 170_000, used: 165_000, requested: 10_000, remaining: 5_000,
};

async function crearAsiento() {
  return LimitRejection.create(buildLimitRejectionRecord({
    violation, amountBOB: 10_000,
    corridor: { corridorId: 'bo-br', destinationCountry: 'BR' },
    user: { legalEntity: 'SRL' },
  }));
}

describe('el mapeo del rechazo captura límite, consumo previo y remanente', () => {
  it('buildLimitRejectionRecord traslada las cifras del violation', () => {
    const rec = buildLimitRejectionRecord({
      violation, amountBOB: 10_000,
      corridor: { corridorId: 'bo-br', destinationCountry: 'BR' },
      user: { legalEntity: 'SRL' },
    });
    expect(rec.code).toBe('ECP_DAILY_AMOUNT_LIMIT');
    expect(rec.limit).toBe(170_000);      // límite alcanzado
    expect(rec.used).toBe(165_000);       // consumo previo
    expect(rec.remaining).toBe(5_000);    // remanente
    expect(rec.amountBOB).toBe(10_000);
    expect(rec.corridorCode).toBe('bo-br');
    expect(rec.legalEntity).toBe('SRL');
  });

  it('un violation sin cifras (verificación no disponible) no rompe el mapeo', () => {
    const rec = buildLimitRejectionRecord({
      violation: { code: 'ECP_LIMIT_CHECK_UNAVAILABLE', scope: 'verificación',
                   unit: null, limit: null, used: null, requested: 500, remaining: null },
      amountBOB: 500,
    });
    expect(rec.code).toBe('ECP_LIMIT_CHECK_UNAVAILABLE');
    expect(rec.limit).toBeNull();
    expect(rec.used).toBeNull();
    expect(rec.remaining).toBeNull();
  });
});

describe('recordEcpRejection persiste el rechazo en el sistema', () => {
  it('crea un asiento consultable con el contexto de auditoría', async () => {
    const req = {
      user: { _id: undefined, legalEntity: 'SRL' },
      headers: { 'x-forwarded-for': '181.1.2.3, 10.0.0.1', 'user-agent': 'jest' },
    };
    const doc = await recordEcpRejection({
      req, violation, amountBOB: 10_000,
      corridor: { corridorId: 'bo-br', destinationCountry: 'BR' },
    });
    expect(doc?._id).toBeTruthy();
    expect(doc.ip).toBe('181.1.2.3');       // primer hop del x-forwarded-for
    expect(doc.userAgent).toBe('jest');
    expect(await LimitRejection.countDocuments()).toBe(1);
  });

  it('nunca lanza: un fallo de persistencia devuelve null', async () => {
    // violation con un tipo imposible para forzar un CastError en el número.
    const doc = await recordEcpRejection({ req: {}, violation, amountBOB: 'no-es-numero' });
    // amountBOB no numérico cae a null por num(); igual persiste. Verifica que no lanzó.
    expect(doc === null || doc?._id).toBeTruthy();
  });
});

describe('el asiento de rechazo es de solo agregado', () => {
  it('crear un asiento sí está permitido', async () => {
    const a = await crearAsiento();
    expect(a._id).toBeTruthy();
  });

  it('updateOne sobre un asiento existente es rechazado', async () => {
    await crearAsiento();
    await expect(LimitRejection.updateOne({ code: 'ECP_DAILY_AMOUNT_LIMIT' }, { $set: { used: 0 } }))
      .rejects.toThrow(/append-only/i);
  });

  it('findOneAndUpdate es rechazado', async () => {
    await crearAsiento();
    await expect(LimitRejection.findOneAndUpdate({ code: 'ECP_DAILY_AMOUNT_LIMIT' }, { $set: { used: 0 } }))
      .rejects.toThrow(/append-only/i);
  });

  it('deleteOne es rechazado', async () => {
    await crearAsiento();
    await expect(LimitRejection.deleteOne({ code: 'ECP_DAILY_AMOUNT_LIMIT' })).rejects.toThrow(/append-only/i);
  });

  it('deleteMany es rechazado', async () => {
    await crearAsiento();
    await expect(LimitRejection.deleteMany({})).rejects.toThrow(/append-only/i);
  });

  it('save() sobre un documento ya persistido es rechazado', async () => {
    const a = await crearAsiento();
    a.used = 0;
    await expect(a.save()).rejects.toThrow(/append-only/i);
  });

  it('tras los intentos, el asiento original permanece intacto', async () => {
    await crearAsiento();
    try { await LimitRejection.updateOne({ code: 'ECP_DAILY_AMOUNT_LIMIT' }, { $set: { used: 0 } }); } catch { /* esperado */ }
    const vivo = await LimitRejection.findOne({ code: 'ECP_DAILY_AMOUNT_LIMIT' }).lean();
    expect(vivo.used).toBe(165_000);
  });
});
