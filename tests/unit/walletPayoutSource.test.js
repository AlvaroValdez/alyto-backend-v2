/**
 * walletPayoutSource.test.js — De qué cuenta sale el USDC del payout.
 *
 * Es la decisión central del pago con saldo: un pago normal lo liquida la tesorería
 * corporativa, pero uno financiado con el saldo del usuario debe liquidarse desde SU
 * cuenta Stellar segregada. Si esto se rutea mal, o la tesorería paga algo que ya cobró
 * al usuario (se descapitaliza), o se intenta firmar con una llave que no corresponde.
 *
 * Lo que se protege acá es que el ruteo dependa exclusivamente de `paymentSource`, que
 * el memo que Harbor exige viaje en ambos caminos, y que un usuario sin cuenta
 * provisionada falle de forma permanente en lugar de reintentarse para siempre.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockSendUSDCToHarbor  = jest.fn();
const mockSendCustodialUSDC = jest.fn();
const mockGetBalance        = jest.fn();

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  sendUSDCToHarbor:      mockSendUSDCToHarbor,
  getStellarUSDCBalance: mockGetBalance,
}));

await jest.unstable_mockModule('../../src/services/custodyService.js', () => ({
  sendCustodialUSDC: mockSendCustodialUSDC,
}));

const mockFindById = jest.fn();
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findById: mockFindById },
}));

const { sendPayoutUSDC, getWalletPayinLiquidity } =
  await import('../../src/services/walletPaymentService.js');

const USER_PK = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HARBOR  = 'GDSC6YPSTF6AXDBVCBQKQBQKQBQKQBQKQBQKQBQKQBQKQBQKQBQKQBQK';

/** Simula el chain User.findById(...).select(...).lean() */
function stubUser(publicKey) {
  mockFindById.mockReturnValue({
    select: () => ({ lean: async () => (publicKey ? { stellarAccount: { publicKey } } : null) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendUSDCToHarbor.mockResolvedValue({ hash: 'TREASURY_HASH', ledger: 1, existing: false });
  mockSendCustodialUSDC.mockResolvedValue('CUSTODIAL_HASH');
  stubUser(USER_PK);
});

describe('sendPayoutUSDC — ruteo del origen de fondos', () => {
  test('pago normal: liquida la tesorería y no toca la cuenta del usuario', async () => {
    const tx = { alytoTransactionId: 'ALY-C-1', userId: 'u1', paymentSource: 'bank' };

    const r = await sendPayoutUSDC({ transaction: tx, destinationAddress: HARBOR, amount: 50, memo: '123' });

    expect(mockSendUSDCToHarbor).toHaveBeenCalledTimes(1);
    expect(mockSendCustodialUSDC).not.toHaveBeenCalled();
    expect(r).toMatchObject({ hash: 'TREASURY_HASH', from: 'treasury' });
  });

  test('sin paymentSource (tx histórica) también liquida la tesorería', async () => {
    const tx = { alytoTransactionId: 'ALY-C-2', userId: 'u1' };

    const r = await sendPayoutUSDC({ transaction: tx, destinationAddress: HARBOR, amount: 50, memo: '123' });

    expect(mockSendUSDCToHarbor).toHaveBeenCalledTimes(1);
    expect(r.from).toBe('treasury');
  });

  test('pago con saldo: liquida la cuenta del usuario, no la tesorería', async () => {
    const tx = { alytoTransactionId: 'ALY-C-3', userId: 'u1', paymentSource: 'walletUSDC' };

    const r = await sendPayoutUSDC({ transaction: tx, destinationAddress: HARBOR, amount: 50, memo: '987' });

    expect(mockSendUSDCToHarbor).not.toHaveBeenCalled();
    expect(mockSendCustodialUSDC).toHaveBeenCalledWith('u1', USER_PK, HARBOR, 50, { memo: '987' });
    expect(r).toMatchObject({ hash: 'CUSTODIAL_HASH', from: 'custodial', sourcePublicKey: USER_PK });
  });

  test('el memo que Harbor exige viaja en el envío custodial', async () => {
    const tx = { alytoTransactionId: 'ALY-C-4', userId: 'u1', paymentSource: 'walletUSDC' };

    await sendPayoutUSDC({ transaction: tx, destinationAddress: HARBOR, amount: 10, memo: 'MEMO-XYZ' });

    expect(mockSendCustodialUSDC.mock.calls[0][4]).toEqual({ memo: 'MEMO-XYZ' });
  });

  test('usuario sin cuenta Stellar: falla permanente y NO cae a la tesorería', async () => {
    stubUser(null);
    const tx = { alytoTransactionId: 'ALY-C-5', userId: 'u1', paymentSource: 'walletUSDC' };

    await expect(sendPayoutUSDC({ transaction: tx, destinationAddress: HARBOR, amount: 50, memo: '1' }))
      .rejects.toMatchObject({ isPermanent: true, code: 'NO_CUSTODIAL_ACCOUNT' });

    // Lo importante: no debe "rescatar" el pago liquidándolo contra la tesorería.
    expect(mockSendUSDCToHarbor).not.toHaveBeenCalled();
  });
});

describe('getWalletPayinLiquidity — mide la cuenta del usuario', () => {
  test('lee el saldo on-chain de la cuenta del usuario, no de la tesorería', async () => {
    mockGetBalance.mockResolvedValue(42.5);
    const tx = { alytoTransactionId: 'ALY-C-6', userId: 'u1', paymentSource: 'walletUSDC' };

    const r = await getWalletPayinLiquidity(tx);

    expect(mockGetBalance).toHaveBeenCalledWith(USER_PK);
    expect(r).toEqual({ sourcePublicKey: USER_PK, onChain: 42.5 });
  });

  test('usuario sin cuenta provisionada: falla permanente', async () => {
    stubUser(null);
    await expect(getWalletPayinLiquidity({ userId: 'u1' }))
      .rejects.toMatchObject({ isPermanent: true });
  });
});
