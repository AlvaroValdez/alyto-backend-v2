/**
 * custodyEntityScope.test.js — La cuenta custodial y la wallet USDC son de SRL.
 *
 * Decisión 2026-10-08. La cuenta custodial solo la consume superficie de Bolivia:
 * `WalletUSDC` es exclusiva de SRL, el P2P exige SRL en ambas puntas y los payouts de
 * Fase 43 son corredores SRL. Provisionar a las demás entidades al aprobar KYC creaba
 * cuentas fondeadas en mainnet (~1,5 XLM) que ningún flujo podía usar: había una SpA así
 * en producción, con trustline y todo, desde el 2026-09-09.
 *
 * El alcance se defiende en dos capas, y las dos importan:
 *   1. No provisionar de entrada a quien no la va a usar.
 *   2. Fail-closed en el ALTA de la WalletUSDC. Los endpoints ya responden 403, pero el
 *      alta vive en getOrCreateWalletUSDC: sin guard ahí, un camino nuevo que la llame
 *      sin filtrar crea un registro que contradice el invariante y que el usuario ni
 *      puede ver, porque el endpoint de saldo le responde 403. Es lo que pasaba por
 *      SEP-24, que además estampaba la operación como SRL.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockFindOne = jest.fn();
const mockCreate  = jest.fn(async (docs) => [{ ...docs[0], walletId: 'WUSDC-X' }]);
await jest.unstable_mockModule('../../src/models/WalletUSDC.js', () => ({
  default: { findOne: mockFindOne, create: mockCreate, updateOne: jest.fn(async () => ({})) },
}));

const mockUserFindById = jest.fn();
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findById: mockUserFindById },
}));

const { getOrCreateWalletUSDC } = await import('../../src/controllers/walletUSDCController.js');

const PK = 'GC2BGWC3UANSKFYHXPQV2CWMH4QNDX7CMCD6GCPZZDQYCFGV7STKZRX3';

/** findById(id, proy, opts).lean() */
const lean = (doc) => ({ lean: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOne.mockResolvedValue(null);   // sin wallet previa → se intenta el alta
});

describe('alta de WalletUSDC — acotada a SRL', () => {

  it('usuario SRL: se crea con su dirección custodial', async () => {
    mockUserFindById.mockReturnValue(lean({ legalEntity: 'SRL', stellarAccount: { publicKey: PK } }));

    const w = await getOrCreateWalletUSDC('u1');

    expect(mockCreate).toHaveBeenCalled();
    expect(w.stellarAddress).toBe(PK);
  });

  it('usuario SpA: NO se crea, y el error dice por qué', async () => {
    // Caso real de producción: una cuenta SpA provisionada y fondeada en mainnet.
    mockUserFindById.mockReturnValue(lean({ legalEntity: 'SpA', stellarAccount: { publicKey: PK } }));

    await expect(getOrCreateWalletUSDC('u9')).rejects.toMatchObject({ status: 403 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('usuario LLC: tampoco', async () => {
    mockUserFindById.mockReturnValue(lean({ legalEntity: 'LLC' }));

    await expect(getOrCreateWalletUSDC('u8')).rejects.toMatchObject({ status: 403 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('usuario inexistente: fail-closed, no se asume SRL', async () => {
    mockUserFindById.mockReturnValue(lean(null));

    await expect(getOrCreateWalletUSDC('fantasma')).rejects.toMatchObject({ status: 403 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('una wallet que YA existe se devuelve sin revisar la entidad', async () => {
    // El guard es del ALTA. Revisar acá rompería a un usuario cuya entidad cambió
    // despues de tener saldo, y dejarlo sin acceso a su propio dinero es peor.
    mockFindOne.mockResolvedValue({ _id: 'w1', walletId: 'WUSDC-VIEJA', balance: 50 });

    const w = await getOrCreateWalletUSDC('u9');

    expect(w.walletId).toBe('WUSDC-VIEJA');
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('el alta resuelve entidad y dirección en UNA consulta al usuario', async () => {
    mockUserFindById.mockReturnValue(lean({ legalEntity: 'SRL', stellarAccount: { publicKey: PK } }));

    await getOrCreateWalletUSDC('u1');

    expect(mockUserFindById).toHaveBeenCalledTimes(1);
    const [, proyeccion] = mockUserFindById.mock.calls[0];
    expect(proyeccion).toContain('legalEntity');
    expect(proyeccion).toContain('stellarAccount.publicKey');
  });
});
