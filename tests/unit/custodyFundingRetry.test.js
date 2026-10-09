/**
 * custodyFundingRetry.test.js — Dos KYC aprobados a la vez no se pisan.
 *
 * Caso REAL, staging 2026-10-08: dos usuarios aprobaron KYC con 2,5 s de diferencia.
 * `fundUserAccount` carga la secuencia del canal y firma la transacción con ese número
 * dentro. Dos llamadas concurrentes leen la MISMA secuencia, así que la segunda se
 * rechaza con `tx_bad_seq` y, como `provisionUserKeypair` no relanza el fallo del
 * fondeo, el usuario quedó con una publicKey en MongoDB y sin cuenta on-chain. El canal
 * tenía 7.567 XLM: no fue falta de fondos, fue una carrera.
 *
 * Lo que se protege: que el fondeo RECONSTRUYA la transacción en cada intento. Reenviar
 * la misma transacción firmada no arregla un tx_bad_seq, porque la secuencia ya está
 * firmada dentro. Si alguien "optimiza" sacando el loadAccount del reintento, estos
 * tests fallan.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';
import { Account } from '@stellar/stellar-sdk';

const mockLoadAccount = jest.fn();
const mockSubmit      = jest.fn();
// El mock cubre TODO lo que config/stellar exporta y que consumen custodyService y
// stellarService: a un export que falte, el enlace del módulo falla entero.
await jest.unstable_mockModule('../../src/config/stellar.js', () => ({
  horizonServer:       { loadAccount: mockLoadAccount, submitTransaction: mockSubmit },
  NETWORK_PASSPHRASE:  'Test SDF Network ; September 2015',
  ASSETS:              { USDC: { getCode: () => 'USDC', getIssuer: () => 'GISSUER' } },
  PRIORITY_FEE_STROOPS:'1000',
  BASE_FEE_STROOPS:    '100',
  TX_TIMEOUT_SECONDS:  30,
  NETWORK_INFO:        { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
  SEP10_SIGNING_PUBLIC: 'GSIGNING',
}));

// submitWithRetry real: es justo la pieza cuyo comportamiento se está verificando.
// Solo se neutraliza la espera para que el test no duerma 400ms + 800ms.
const { submitWithRetry: realRetry, isRetriableStellarError } =
  await import('../../src/services/stellarService.js');
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  submitWithRetry: (fn, opts = {}) =>
    realRetry(fn, { ...opts, sleep: () => Promise.resolve(), isRetriable: isRetriableStellarError }),
  isRetriableStellarError,
}));

const mockUserFindById = jest.fn();
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findById: mockUserFindById, findByIdAndUpdate: jest.fn(async () => ({})), updateOne: jest.fn(async () => ({})) },
}));

const { ensureAccountOnChain } = await import('../../src/services/custodyService.js');

const PK = 'GBYUCYGC2TCH4DLAUMQNLPOT5FGXZVEQEHODG6K52QPRDPODRDFA7H4T';

// Keypair desechable generado para el test. Keypair.fromSecret valida el checksum, así
// que un secreto inventado a mano revienta antes de llegar a lo que se quiere probar.
// No corresponde a ninguna cuenta real: nunca se firma nada que se envíe a la red.
const CANAL_SECRET = 'SDFQCFI7GKYVZLEQXG2WE7T36GHY2LK67PLSFREJBYJUPOUUJEXOJW7D';
const CANAL_PUBLIC = 'GBWEG4ZD56LAOZVIISNUNTSTVNYGLS67OFS66DIKCL57ZODYSPGCO7WS';

/** Cadena de Mongoose findById().select().lean() */
const chain = (doc) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

const badSeq = () => ({
  response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } },
  message:  'tx_bad_seq',
});
const noExiste = () => Object.assign(new Error('Not Found'), { response: { status: 404 } });

/** Cuenta con trustline USDC ya puesta: aísla el fondeo del resto. */
const cuentaConTrustline = {
  balances: [{ asset_code: 'USDC', asset_issuer: 'GISSUER', balance: '0' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STELLAR_MASTER_SECRET = CANAL_SECRET;
  mockUserFindById.mockReturnValue(chain({ stellarAccount: { publicKey: PK } }));
});

describe('fondeo de la cuenta custodial — carrera por la secuencia del canal', () => {

  it('un tx_bad_seq se reintenta y la cuenta termina creada', async () => {
    let intentos = 0;
    // 1ª: la cuenta no existe. Tras fondear: existe y con trustline.
    mockLoadAccount.mockImplementation(async (key) => {
      if (key === PK) {
        if (intentos === 0) throw noExiste();
        return cuentaConTrustline;
      }
      return new Account(CANAL_PUBLIC, '1');   // canal: Account real del SDK
    });
    mockSubmit.mockImplementation(async () => {
      intentos++;
      if (intentos === 1) throw badSeq();   // la otra provisión ganó la secuencia
      return { hash: 'ok' };
    });

    const r = await ensureAccountOnChain('u1');

    expect(r.funded).toBe(true);
    expect(mockSubmit).toHaveBeenCalledTimes(2);
  });

  it('la secuencia se RELEE en cada intento, no se reenvía la misma tx', async () => {
    let intentos = 0;
    mockLoadAccount.mockImplementation(async (key) => {
      if (key === PK) {
        if (intentos === 0) throw noExiste();
        return cuentaConTrustline;
      }
      return new Account(CANAL_PUBLIC, '1');
    });
    mockSubmit.mockImplementation(async () => {
      intentos++;
      if (intentos === 1) throw badSeq();
      return { hash: 'ok' };
    });

    await ensureAccountOnChain('u1');

    // El canal se carga una vez por intento de submit. Si el loadAccount viviera fuera
    // del reintento, esto seria 1 y el tx_bad_seq se repetiria para siempre.
    const cargasDelCanal = mockLoadAccount.mock.calls.filter(([k]) => k !== PK).length;
    expect(cargasDelCanal).toBe(2);
  });

  it('un error permanente NO se reintenta', async () => {
    mockLoadAccount.mockImplementation(async (key) => {
      if (key === PK) throw noExiste();
      return new Account(CANAL_PUBLIC, '1');
    });
    // tx_bad_auth: reintentar no lo arregla, hay que fallar rápido.
    mockSubmit.mockRejectedValue({
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_auth' } } } },
      message:  'tx_bad_auth',
    });

    await expect(ensureAccountOnChain('u1')).rejects.toBeDefined();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('si el fondeo no se permite, no se intenta ningún submit', async () => {
    mockLoadAccount.mockImplementation(async (key) => {
      if (key === PK) throw noExiste();
      return new Account(CANAL_PUBLIC, '1');
    });

    const r = await ensureAccountOnChain('u1', { allowFunding: false });

    expect(r.needsFunding).toBe(true);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('una cuenta ya sana no toca la red para escribir', async () => {
    mockLoadAccount.mockResolvedValue(cuentaConTrustline);

    const r = await ensureAccountOnChain('u1');

    expect(r.alreadyOk).toBe(true);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
