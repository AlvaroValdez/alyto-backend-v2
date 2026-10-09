/**
 * custodyAccountNotProvisioned.test.js — Cobertura de la vigilancia de cuentas custodiales.
 *
 * Dos agujeros distintos del mismo job, los dos verificados contra producción:
 *
 *  1. Una cuenta a medio provisionar (publicKey persistida, `createAccount` fallido)
 *     responde 404 para siempre. El job sondea cada 30s, así que tratarlo como error
 *     mandaba ~2.880 excepciones por día y por cuenta a Sentry: la forma más eficiente
 *     de enterrar las alertas que sí importan. Lo que se protege es la DISCRIMINACIÓN:
 *     el 404 se cuenta y se sigue, pero un fallo de red SIGUE siendo error. Tragarse
 *     los dos dejaría al monitor mudo ante Horizon caído.
 *
 *  2. La cuenta se provisiona al aprobar el KYC, pero la WalletUSDC nace perezosamente
 *     cuando el usuario entra a la pantalla de USDC. En ese tramo la cuenta ya puede
 *     recibir USDC y el usuario puede conocer su dirección por /stellar/custody/keypair.
 *     Vigilar solo las direcciones con WalletUSDC dejaba ese tramo ciego y un depósito
 *     ahí no se detectaba nunca. Ahora la lista es la unión, y el apunte contable se da
 *     de alta al acreditar.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const ADDR     = 'GBYUCYGC2TCH4DLAUMQNLPOT5FGXZVEQEHODG6K52QPRDPODRDFA7H4T';
const ADDR_2   = 'GC2BGWC3UANSKFYHXPQV2CWMH4QNDX7CMCD6GCPZZDQYCFGV7STKZRX3';
const ISSUER   = 'GA5ZUSDCISSUER';
const HEARTBEAT = 'stellar:monitor:heartbeat';

/** Thenable que sirve tanto para `await find()` como para `find().select().lean()`. */
const qr = (value) => ({
  select: () => qr(value),
  lean:   () => Promise.resolve(value),
  then:   (res, rej) => Promise.resolve(value).then(res, rej),
});

const mockCaptureException = jest.fn();
await jest.unstable_mockModule('@sentry/node', () => ({
  captureException: mockCaptureException,
}));

await jest.unstable_mockModule('mongoose', () => ({
  default: {
    startSession: async () => ({
      withTransaction: async (fn) => fn(),
      endSession:      async () => {},
    }),
  },
}));

// Cadena fluida de Horizon: payments().forAccount().cursor().limit().order().call()
const mockCall = jest.fn();
const horizonChain = {
  payments:   () => horizonChain,
  forAccount: () => horizonChain,
  cursor:     () => horizonChain,
  limit:      () => horizonChain,
  order:      () => horizonChain,
  call:       mockCall,
};
await jest.unstable_mockModule('../../src/config/stellar.js', () => ({
  horizonServer: horizonChain,
  ASSETS: { USDC: { issuer: ISSUER } },
}));

const mockSetValue = jest.fn();
await jest.unstable_mockModule('../../src/models/SystemConfig.js', () => ({
  default: { getValue: jest.fn(async (_k, d) => d), setValue: mockSetValue },
}));

const mockWalletDistinct  = jest.fn(async () => [ADDR]);
const mockWalletFindOne   = jest.fn(() => qr(null));
const mockWalletUpdate    = jest.fn(async () => ({ _id: 'w1', balance: 10, userId: 'u1' }));
await jest.unstable_mockModule('../../src/models/WalletUSDC.js', () => ({
  default: {
    distinct:          mockWalletDistinct,
    findOne:           mockWalletFindOne,
    findOneAndUpdate:  mockWalletUpdate,
  },
}));

const mockUserDistinct = jest.fn(async () => []);
const mockUserFindOne  = jest.fn(() => qr(null));
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { distinct: mockUserDistinct, findOne: mockUserFindOne },
}));

const mockWtxCreate = jest.fn(async () => [{}]);
await jest.unstable_mockModule('../../src/models/WalletTransaction.js', () => ({
  default: { exists: jest.fn(async () => null), create: mockWtxCreate },
}));
await jest.unstable_mockModule('../../src/models/Transaction.js', () => ({
  default: { findOneAndUpdate: jest.fn(async () => null) },
}));
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notify: jest.fn(async () => {}),
  NOTIFICATIONS: { usdcDepositReceived: () => ({}) },
}));

const mockGetOrCreate = jest.fn(async () => ({ _id: 'w-nueva', userId: 'u1', walletId: 'WUSDC-NUEVA' }));
await jest.unstable_mockModule('../../src/controllers/walletUSDCController.js', () => ({
  getOrCreateWalletUSDC: mockGetOrCreate,
}));

const { monitorUSDCDeposits } = await import('../../src/jobs/monitorUSDCDeposits.js');

/** Stats del ciclo. Se busca el heartbeat por clave: setValue también graba cursores. */
function statsDelCiclo() {
  const call = mockSetValue.mock.calls.filter(c => c[0] === HEARTBEAT).at(-1);
  return call?.[1]?.stats ?? null;
}

const horizon404 = () => Object.assign(new Error('Not Found'), { response: { status: 404 } });

const pagoUSDC = (to = ADDR, amount = '25.5') => ({
  id: 'op-1', type: 'payment', asset_code: 'USDC', asset_issuer: ISSUER,
  to, from: 'GREMITENTE', amount, transaction_hash: 'hash-1', paging_token: '123',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWalletDistinct.mockResolvedValue([ADDR]);
  mockUserDistinct.mockResolvedValue([]);
  mockWalletFindOne.mockImplementation(() => qr(null));
  mockUserFindOne.mockImplementation(() => qr(null));
  mockWalletUpdate.mockResolvedValue({ _id: 'w1', balance: 10, userId: 'u1' });
  mockGetOrCreate.mockResolvedValue({ _id: 'w-nueva', userId: 'u1', walletId: 'WUSDC-NUEVA' });
  // Sin dirección de tesorería no se ejercita el tramo legacy, donde un 404 SÍ es alarma.
  delete process.env.STELLAR_SRL_PUBLIC_KEY;
});

describe('cuenta custodial sin provisionar — 404 no es un error', () => {

  it('404 de Horizon: NO va a Sentry y no cuenta como error', async () => {
    mockCall.mockRejectedValue(horizon404());

    await monitorUSDCDeposits();

    expect(mockCaptureException).not.toHaveBeenCalled();
    const stats = statsDelCiclo();
    expect(stats.notProvisioned).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it('NotFoundError del SDK se trata igual que el 404 HTTP', async () => {
    mockCall.mockRejectedValue(Object.assign(new Error('not found'), { name: 'NotFoundError' }));

    await monitorUSDCDeposits();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(statsDelCiclo().notProvisioned).toBe(1);
  });

  it('fallo de red SIGUE siendo error y SÍ va a Sentry', async () => {
    mockCall.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await monitorUSDCDeposits();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const stats = statsDelCiclo();
    expect(stats.errors).toBe(1);
    expect(stats.notProvisioned).toBe(0);
  });

  it('un 5xx de Horizon tampoco se confunde con cuenta inexistente', async () => {
    mockCall.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { response: { status: 502 } }));

    await monitorUSDCDeposits();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(statsDelCiclo().errors).toBe(1);
  });

  it('el ciclo completa y publica heartbeat aunque la cuenta no exista', async () => {
    mockCall.mockRejectedValue(horizon404());

    await monitorUSDCDeposits();

    // Que el heartbeat se escriba importa: AnchorAdmin lo usa para detectar un
    // listener muerto. Un throw no capturado acá lo dejaría sin latido.
    expect(mockSetValue).toHaveBeenCalledWith(HEARTBEAT, expect.objectContaining({ stats: expect.any(Object) }));
    expect(statsDelCiclo().addresses).toBe(1);
  });
});

describe('cobertura de la vigilancia — unión de las dos fuentes', () => {

  it('vigila una cuenta provisionada que todavía NO tiene WalletUSDC', async () => {
    mockWalletDistinct.mockResolvedValue([]);        // nadie entró a la pantalla de USDC
    mockUserDistinct.mockResolvedValue([ADDR_2]);    // pero el KYC ya provisionó la cuenta
    mockCall.mockResolvedValue({ records: [] });

    await monitorUSDCDeposits();

    expect(statsDelCiclo().addresses).toBe(1);
  });

  it('no sondea dos veces una dirección que está en ambas fuentes', async () => {
    mockWalletDistinct.mockResolvedValue([ADDR]);
    mockUserDistinct.mockResolvedValue([ADDR]);
    mockCall.mockResolvedValue({ records: [] });

    await monitorUSDCDeposits();

    expect(statsDelCiclo().addresses).toBe(1);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });
});

describe('depósito en una cuenta sin WalletUSDC — se da de alta y se acredita', () => {

  it('usuario SRL: crea la wallet y acredita el depósito', async () => {
    mockWalletDistinct.mockResolvedValue([]);
    mockUserDistinct.mockResolvedValue([ADDR]);
    mockUserFindOne.mockImplementation(() => qr({ _id: 'u1', legalEntity: 'SRL' }));
    mockCall.mockResolvedValue({ records: [pagoUSDC(ADDR, '25.5')] });

    await monitorUSDCDeposits();

    expect(mockGetOrCreate).toHaveBeenCalledWith('u1');
    const stats = statsDelCiclo();
    expect(stats.walletsCreadas).toBe(1);
    expect(stats.credited).toBe(1);
    expect(stats.noMatch).toBe(0);
    expect(mockWtxCreate).toHaveBeenCalled();
  });

  // Caso REAL de producción, no hipotético: `amandachalar@gmail.com` es SpA y tiene una
  // cuenta custodial provisionada y fondeada en mainnet desde el 2026-09-09, porque el
  // webhook de KYC provisiona sin mirar la entidad. La WalletUSDC es exclusiva de SRL
  // (getUSDCBalance responde 403 fuera de ahí), así que para ella es INALCANZABLE: darla
  // de alta acá contradiría ese 403. Se vigila y se avisa; lo resuelve una persona.
  it('usuario NO-SRL: no inventa el apunte, lo deja visible', async () => {
    mockWalletDistinct.mockResolvedValue([]);
    mockUserDistinct.mockResolvedValue([ADDR]);
    mockUserFindOne.mockImplementation(() => qr({ _id: 'u9', legalEntity: 'SpA' }));
    mockCall.mockResolvedValue({ records: [pagoUSDC()] });

    await monitorUSDCDeposits();

    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const stats = statsDelCiclo();
    expect(stats.noMatch).toBe(1);
    expect(stats.credited).toBe(0);
  });

  it('dirección que no pertenece a ningún usuario: tampoco se acredita', async () => {
    mockWalletDistinct.mockResolvedValue([]);
    mockUserDistinct.mockResolvedValue([ADDR]);
    mockUserFindOne.mockImplementation(() => qr(null));
    mockCall.mockResolvedValue({ records: [pagoUSDC()] });

    await monitorUSDCDeposits();

    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(statsDelCiclo().credited).toBe(0);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('wallet congelada: NO se acredita, aunque el depósito ya llegó', async () => {
    mockWalletDistinct.mockResolvedValue([]);
    mockUserDistinct.mockResolvedValue([ADDR]);
    mockUserFindOne.mockImplementation(() => qr({ _id: 'u1', legalEntity: 'SRL' }));
    // findOne por dirección → null; findOne por userId con status != active → congelada
    mockWalletFindOne.mockImplementation((q) =>
      qr(q?.status?.$ne === 'active' ? { walletId: 'WUSDC-CONG', status: 'frozen' } : null));
    mockCall.mockResolvedValue({ records: [pagoUSDC()] });

    await monitorUSDCDeposits();

    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockWtxCreate).not.toHaveBeenCalled();
    const stats = statsDelCiclo();
    expect(stats.credited).toBe(0);
    expect(stats.noMatch).toBe(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('con WalletUSDC existente no se llama al alta', async () => {
    mockWalletFindOne.mockImplementation((q) =>
      qr(q?.stellarAddress ? { _id: 'w1', userId: 'u1' } : null));
    mockCall.mockResolvedValue({ records: [pagoUSDC()] });

    await monitorUSDCDeposits();

    expect(mockGetOrCreate).not.toHaveBeenCalled();
    const stats = statsDelCiclo();
    expect(stats.credited).toBe(1);
    expect(stats.walletsCreadas).toBe(0);
  });
});
