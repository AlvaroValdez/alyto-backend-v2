/**
 * custodyAccountNotProvisioned.test.js — Una cuenta a medio provisionar no es una alarma.
 *
 * `provisionUserKeypair` persiste la publicKey ANTES de fondear la cuenta y no relanza
 * si el `createAccount` falla, así que una WalletUSDC puede quedar 'active' apuntando a
 * una cuenta que Horizon responde 404. El monitor sondea cada 30s: tratar ese 404 como
 * error mandaba ~2.880 excepciones por día y por cuenta a Sentry, que es la forma más
 * eficiente de enterrar las alertas que sí importan.
 *
 * Lo que se protege acá es la discriminación: el 404 se cuenta y se sigue, pero un fallo
 * de red SIGUE siendo error. Tragarse los dos dejaría al monitor mudo ante Horizon caído.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const ADDR = 'GBYUCYGC2TCH4DLAUMQNLPOT5FGXZVEQEHODG6K52QPRDPODRDFA7H4T';

const mockCaptureException = jest.fn();
await jest.unstable_mockModule('@sentry/node', () => ({
  captureException: mockCaptureException,
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
  ASSETS: { USDC: { issuer: 'GA5ZUSDCISSUER' } },
}));

const mockSetValue = jest.fn();
await jest.unstable_mockModule('../../src/models/SystemConfig.js', () => ({
  default: { getValue: jest.fn(async (_k, d) => d), setValue: mockSetValue },
}));
await jest.unstable_mockModule('../../src/models/WalletUSDC.js', () => ({
  default: { distinct: jest.fn(async () => [ADDR]), findOne: jest.fn(async () => null) },
}));
await jest.unstable_mockModule('../../src/models/WalletTransaction.js', () => ({
  default: { exists: jest.fn(async () => null), create: jest.fn() },
}));
await jest.unstable_mockModule('../../src/models/Transaction.js', () => ({
  default: { findOneAndUpdate: jest.fn(async () => null) },
}));
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notify: jest.fn(async () => {}),
  NOTIFICATIONS: { usdcDepositReceived: () => ({}) },
}));

const { monitorUSDCDeposits } = await import('../../src/jobs/monitorUSDCDeposits.js');

/** Stats del ciclo, leídas del heartbeat — es donde el job las publica. */
function statsDelCiclo() {
  const call = mockSetValue.mock.calls.at(-1);
  return call?.[1]?.stats ?? null;
}

const horizon404 = () => Object.assign(new Error('Not Found'), { response: { status: 404 } });

beforeEach(() => {
  jest.clearAllMocks();
  // Sin dirección de tesorería no se ejercita el tramo legacy, donde un 404 SÍ es alarma.
  delete process.env.STELLAR_SRL_PUBLIC_KEY;
});

describe('monitorUSDCDeposits — cuenta custodial sin provisionar', () => {

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
    expect(mockSetValue).toHaveBeenCalledWith(
      'stellar:monitor:heartbeat',
      expect.objectContaining({ stats: expect.any(Object) }),
    );
    expect(statsDelCiclo().addresses).toBe(1);
  });
});
