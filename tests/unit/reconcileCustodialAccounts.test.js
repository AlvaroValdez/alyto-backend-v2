/**
 * reconcileCustodialAccounts.test.js — La red de seguridad de la provisión custodial.
 *
 * `provisionUserKeypair` persiste la publicKey antes de fondear y no relanza si el
 * `createAccount` falla, y quien la llama es el webhook de KYC fire-and-forget. Sin este
 * job, una cuenta a medio provisionar no la reintenta NADIE: el usuario no puede recibir
 * USDC y el monitor la sondea cada 30s para siempre.
 *
 * Lo que se protege acá es el guard de XLM del canal, que es la parte con consecuencia
 * económica. Un canal vacío es la causa raíz más probable de que estas cuentas existan:
 * reintentar sin fondearlo repite el fallo y gasta fees. Y lo contrario también importa:
 * que un presupuesto agotado NO bloquee las reparaciones que no consumen reserva.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockEnsure = jest.fn();
await jest.unstable_mockModule('../../src/services/custodyService.js', () => ({
  ensureAccountOnChain: mockEnsure,
}));

const mockGetXLM = jest.fn();
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  getXLMBalance: mockGetXLM,
}));

const mockUpdateOne = jest.fn(async () => ({}));
const mockFind      = jest.fn();
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: {
    updateOne: mockUpdateOne,
    find:      mockFind,
  },
}));

const { reconcileCustodialAccounts, buildRepairFilter, alcanzaElCanal } =
  await import('../../src/jobs/reconcileCustodialAccounts.js');

/** Cadena de Mongoose: find().select().sort().limit().lean() */
const chain = (docs) => {
  const c = {
    select: () => c, sort: () => c, limit: () => c,
    lean:   () => Promise.resolve(docs),
  };
  return c;
};

const usuario = (n, over = {}) => ({
  _id: `u${n}`, email: `u${n}@x.com`, legalEntity: 'SRL',
  stellarAccount: { publicKey: `G${'A'.repeat(54)}${n}`, ...over },
});

const OK_REPARADA = { funded: true,  trustlineCreated: false, alreadyOk: false, needsFunding: false };
const OK_SANA     = { funded: false, trustlineCreated: false, alreadyOk: true,  needsFunding: false };
const SOLO_TRUST  = { funded: false, trustlineCreated: true,  alreadyOk: false, needsFunding: false };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STELLAR_MASTER_PUBLIC = 'GCANAL';
  mockGetXLM.mockResolvedValue(100);
  mockEnsure.mockResolvedValue(OK_REPARADA);
  mockFind.mockReturnValue(chain([]));
});

describe('alcanzaElCanal — guard de XLM, puro', () => {
  it('sin cuentas pendientes siempre alcanza', () => {
    expect(alcanzaElCanal(0, 0)).toBe(true);
    expect(alcanzaElCanal(null, 0)).toBe(true);
  });

  it('exige 1,5 XLM por cuenta más colchón de 2', () => {
    expect(alcanzaElCanal(3.5, 1)).toBe(true);    // 1,5 + 2
    expect(alcanzaElCanal(3.49, 1)).toBe(false);
    expect(alcanzaElCanal(8, 4)).toBe(true);      // 6 + 2
    expect(alcanzaElCanal(7.99, 4)).toBe(false);
  });

  it('un saldo que no se pudo leer NO cuenta como suficiente', () => {
    // Asumir que alcanza es justamente el error que dejó estas cuentas a medias.
    expect(alcanzaElCanal(null, 1)).toBe(false);
    expect(alcanzaElCanal(undefined, 1)).toBe(false);
    expect(alcanzaElCanal(NaN, 1)).toBe(false);
  });
});

describe('buildRepairFilter — a quién se mira, puro', () => {
  const now = new Date('2026-10-08T20:00:00Z');
  const f   = buildRepairFilter({ now, maxAttempts: 8, cooldownMs: 30 * 60 * 1000 });

  it('solo cuentas con publicKey: sin ella no hay nada que completar', () => {
    expect(f['stellarAccount.publicKey']).toEqual({ $nin: [null, ''] });
  });

  it('respeta el presupuesto de intentos y el cooldown', () => {
    const json = JSON.stringify(f);
    expect(json).toContain('repairAttempts');
    expect(json).toContain('$lt');
    expect(json).toContain('repairLastAttemptAt');
    // El cooldown se mide contra 30 min antes de ahora.
    const cutoff = f.$and[1].$or.find(c => c['stellarAccount.repairLastAttemptAt']?.$lte);
    expect(cutoff['stellarAccount.repairLastAttemptAt'].$lte)
      .toEqual(new Date('2026-10-08T19:30:00Z'));
  });
});

describe('reconcileCustodialAccounts — comportamiento', () => {

  it('sin candidatas no llama a Horizon ni al canal', async () => {
    const r = await reconcileCustodialAccounts();

    expect(r.processed).toBe(0);
    expect(mockGetXLM).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('repara una cuenta y consume un intento', async () => {
    mockFind.mockReturnValue(chain([usuario(1)]));

    const r = await reconcileCustodialAccounts();

    expect(r).toMatchObject({ processed: 1, repaired: 1, failed: 0, skippedNoXLM: 0 });
    expect(mockEnsure).toHaveBeenCalledWith('u1', { allowFunding: true });
    const [[, update]] = mockUpdateOne.mock.calls;
    expect(update.$set['stellarAccount.repairAttempts']).toBe(1);
  });

  it('una cuenta ya sana limpia el rastro de intentos previos', async () => {
    mockFind.mockReturnValue(chain([usuario(1, { repairAttempts: 3 })]));
    mockEnsure.mockResolvedValue(OK_SANA);

    const r = await reconcileCustodialAccounts();

    expect(r.alreadyOk).toBe(1);
    // Si no se limpiara, un fallo viejo gastaría presupuesto cuando vuelva a romperse.
    // Object.keys y no toHaveProperty: la clave lleva puntos literales, que jest
    // interpretaría como una ruta anidada.
    const [[, update]] = mockUpdateOne.mock.calls;
    expect(Object.keys(update.$unset)).toContain('stellarAccount.repairAttempts');
  });

  it('canal sin XLM: no funde, y NO consume intento', async () => {
    mockFind.mockReturnValue(chain([usuario(1)]));
    mockGetXLM.mockResolvedValue(0.5);
    mockEnsure.mockResolvedValue({ ...OK_REPARADA, funded: false, needsFunding: true });

    const r = await reconcileCustodialAccounts();

    expect(r.skippedNoXLM).toBe(1);
    expect(r.repaired).toBe(0);
    expect(mockEnsure).toHaveBeenCalledWith('u1', { allowFunding: false });
    // Sin intento consumido: la cuenta no falló, se decidió no intentarla.
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('saldo del canal ilegible: tampoco funde', async () => {
    mockFind.mockReturnValue(chain([usuario(1)]));
    mockGetXLM.mockRejectedValue(new Error('Horizon caído'));
    mockEnsure.mockResolvedValue({ ...OK_REPARADA, funded: false, needsFunding: true });

    await reconcileCustodialAccounts();

    expect(mockEnsure).toHaveBeenCalledWith('u1', { allowFunding: false });
  });

  it('sin presupuesto se repara igual lo que solo necesita trustline', async () => {
    // La trustline va por Fee Bump y no consume reserva del canal, así que el límite
    // de XLM no le aplica. Bloquearla sería dejar la cuenta sin poder recibir USDC.
    mockFind.mockReturnValue(chain([usuario(1)]));
    mockGetXLM.mockResolvedValue(0);
    mockEnsure.mockResolvedValue(SOLO_TRUST);

    const r = await reconcileCustodialAccounts();

    expect(r.repaired).toBe(1);
    expect(r.skippedNoXLM).toBe(0);
  });

  it('el presupuesto limita cuántas funde en una corrida', async () => {
    // 5 XLM: alcanza para 2 cuentas (2×1,5 + 2 = 5), no para 3.
    mockFind.mockReturnValue(chain([usuario(1), usuario(2), usuario(3)]));
    mockGetXLM.mockResolvedValue(5);
    mockEnsure.mockImplementation(async (_id, { allowFunding }) =>
      allowFunding ? OK_REPARADA : { ...OK_REPARADA, funded: false, needsFunding: true });

    const r = await reconcileCustodialAccounts();

    expect(r.repaired).toBe(2);
    expect(r.skippedNoXLM).toBe(1);
  });

  it('un fallo consume intento y guarda el motivo', async () => {
    mockFind.mockReturnValue(chain([usuario(1)]));
    mockEnsure.mockRejectedValue(new Error('tx_bad_seq'));

    const r = await reconcileCustodialAccounts();

    expect(r.failed).toBe(1);
    const [[, update]] = mockUpdateOne.mock.calls;
    expect(update.$set['stellarAccount.repairLastError']).toBe('tx_bad_seq');
  });

  it('un error permanente se declara agotado de inmediato', async () => {
    mockFind.mockReturnValue(chain([usuario(1)]));
    mockEnsure.mockRejectedValue(Object.assign(new Error('sin publicKey'), { isPermanent: true }));

    const r = await reconcileCustodialAccounts();

    // No se gastan 8 corridas en algo que reintentar no arregla.
    expect(r.exhausted).toBe(1);
  });

  it('al llegar al techo de intentos se declara agotado', async () => {
    mockFind.mockReturnValue(chain([usuario(1, { repairAttempts: 7 })]));
    mockEnsure.mockRejectedValue(new Error('canal sin XLM'));

    const r = await reconcileCustodialAccounts();

    expect(r.exhausted).toBe(1);   // 7 + 1 === maxAttempts por defecto (8)
  });

  it('una cuenta que falla no detiene a las siguientes', async () => {
    mockFind.mockReturnValue(chain([usuario(1), usuario(2)]));
    mockEnsure
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(OK_REPARADA);

    const r = await reconcileCustodialAccounts();

    expect(r.failed).toBe(1);
    expect(r.repaired).toBe(1);
  });
});
