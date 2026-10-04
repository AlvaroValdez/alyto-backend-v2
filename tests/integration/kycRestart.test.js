/**
 * kycRestart.test.js — Salida del usuario atrapado en 'in_review'.
 *
 * `GET /kyc/session` marca al usuario 'in_review' en cuanto crea la sesión en
 * Stripe, antes de que haya hecho nada. Si la página alojada de Stripe no carga
 * —pasó el 2026-10-02 con un usuario en datos móviles— la pantalla dice
 * "verificando tu identidad" y no había ninguna acción disponible: el estado solo
 * se soltaba solo después de `KYC_SESSION_STALE_MIN` minutos, y únicamente si el
 * usuario volvía a abrir la aplicación para disparar el polling.
 *
 * Lo que se cubre acá son las tres formas de que este endpoint haga daño:
 *   - tirar una verificación que en realidad SÍ se completó (carrera con el webhook)
 *   - hacer repetir documento y selfie a quien ya los envió ('processing')
 *   - dejar al usuario sin salida cuando Stripe no responde
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const mockRetrieve = jest.fn();
const mockCancel   = jest.fn();
await jest.unstable_mockModule('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.identity = { verificationSessions: { retrieve: mockRetrieve, cancel: mockCancel } };
    }
    static get webhooks() { return { constructEvent: () => { throw new Error('no usado'); } }; }
  },
}));

const { createSRLUser }    = await import('../helpers/auth.js');
const { default: app }     = await import('../../src/server.js');
const { default: request } = await import('supertest');
const { default: User }    = await import('../../src/models/User.js');
const { default: KycAttempt } = await import('../../src/models/KycAttempt.js');

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => {
  await clearCollections();
  mockRetrieve.mockReset();
  mockCancel.mockReset();
});

/** Usuario que acaba de lanzar la biometría y quedó esperando. */
async function usuarioEnRevision(sessionId = 'vs_atascado') {
  const { user, token } = await createSRLUser({
    kycStatus:                   'in_review',
    kycApprovedAt:               null,
    kycProfileCompletedAt:       new Date(),
    emailVerified:               true,
    stripeVerificationSessionId: sessionId,
  });
  await KycAttempt.create({ userId: user._id, sessionId, platform: 'mobile-web', outcome: 'open' });
  return { user, token };
}

const reiniciar = (token) => request(app)
  .post('/api/v1/kyc/session/restart')
  .set('Authorization', `Bearer ${token}`)
  .send({});

describe('POST /kyc/session/restart', () => {

  it('cancela la sesión en Stripe y devuelve al usuario a pending', async () => {
    const { user, token } = await usuarioEnRevision();
    mockRetrieve.mockResolvedValue({ id: 'vs_atascado', status: 'requires_input', last_error: null });
    mockCancel.mockResolvedValue({ id: 'vs_atascado', status: 'canceled' });

    const res = await reiniciar(token);

    expect(res.status).toBe(200);
    expect(res.body.kycStatus).toBe('pending');
    expect(res.body.canceledSessionId).toBe('vs_atascado');
    // Cancelar deja la sesión vieja inerte: si no, su webhook tardío pisaría el
    // estado del intento siguiente.
    expect(mockCancel).toHaveBeenCalledWith('vs_atascado');

    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('pending');
    expect(enBase.stripeVerificationSessionId).toBeNull();
  });

  it('deja el intento marcado como reiniciado y sin retorno del alojado de Stripe', async () => {
    const { token } = await usuarioEnRevision();
    mockRetrieve.mockResolvedValue({ id: 'vs_atascado', status: 'requires_input', last_error: null });
    mockCancel.mockResolvedValue({});

    await reiniciar(token);

    const intento = await KycAttempt.findOne({ sessionId: 'vs_atascado' }).lean();
    expect(intento.outcome).toBe('restarted');
    expect(intento.restartedAt).toBeInstanceOf(Date);
    // La firma del incidente: el navegador nunca volvió de Stripe y aun así el
    // usuario pidió reintentar. Distingue "la página falló" de "la abandonó".
    expect(intento.returnedAt).toBeNull();
  });

  it('si la sesión ya estaba verificada, aprueba en vez de tirar la verificación', async () => {
    const { user, token } = await usuarioEnRevision('vs_verificada');
    mockRetrieve.mockResolvedValue({ id: 'vs_verificada', status: 'verified', last_error: null });

    const res = await reiniciar(token);

    expect(res.status).toBe(200);
    expect(res.body.kycStatus).toBe('approved');
    expect(mockCancel).not.toHaveBeenCalled();

    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('approved');
  });

  it('si Stripe está procesando la captura, rechaza el reinicio', async () => {
    const { user, token } = await usuarioEnRevision('vs_procesando');
    mockRetrieve.mockResolvedValue({ id: 'vs_procesando', status: 'processing', last_error: null });

    const res = await reiniciar(token);

    // El usuario YA envió documento y selfie: reiniciar le haría repetirlos.
    expect(res.status).toBe(409);
    expect(res.body.kycStatus).toBe('in_review');
    expect(mockCancel).not.toHaveBeenCalled();
    expect((await User.findById(user._id).lean()).kycStatus).toBe('in_review');
  });

  it('si Stripe no responde, el usuario igual queda habilitado para reintentar', async () => {
    const { user, token } = await usuarioEnRevision('vs_stripe_caido');
    mockRetrieve.mockRejectedValue(new Error('Stripe timeout'));

    const res = await reiniciar(token);

    // Una caída del proveedor no puede dejar a nadie atrapado. La sesión huérfana
    // la cierra después el barrido.
    expect(res.status).toBe(200);
    expect(res.body.kycStatus).toBe('pending');
    expect((await User.findById(user._id).lean()).kycStatus).toBe('pending');
  });

  it('un usuario ya verificado no puede reiniciar su KYC', async () => {
    const { user, token } = await createSRLUser({
      kycProfileCompletedAt: new Date(),
      emailVerified:         true,
    });

    const res = await reiniciar(token);

    expect(res.status).toBe(409);
    expect((await User.findById(user._id).lean()).kycStatus).toBe('approved');
  });

  it('exige autenticación', async () => {
    const res = await request(app).post('/api/v1/kyc/session/restart').send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /kyc/telemetry', () => {

  it('marca el retorno del alojado de Stripe sobre la sesión vigente', async () => {
    const { token } = await usuarioEnRevision('vs_retorno');

    const res = await request(app)
      .post('/api/v1/kyc/telemetry')
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'returned' });

    expect(res.status).toBe(204);
    const intento = await KycAttempt.findOne({ sessionId: 'vs_retorno' }).lean();
    expect(intento.returnedAt).toBeInstanceOf(Date);
    // Es un hito, no un desenlace: el intento sigue abierto.
    expect(intento.outcome).toBe('open');
  });

  it('rechaza eventos desconocidos en vez de anotarlos', async () => {
    const { token } = await usuarioEnRevision('vs_evento_raro');

    const res = await request(app)
      .post('/api/v1/kyc/telemetry')
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'loQueSea' });

    expect(res.status).toBe(400);
  });
});
