/**
 * kycSessionResolver.test.js — Traducción de una sesión de Stripe Identity a un
 * estado KYC, y barrido de las verificaciones que quedaron colgadas.
 *
 * Qué protege:
 *
 *  1. Que el criterio sea UNO solo. El polling del usuario y el barrido periódico
 *     resuelven el mismo estado; si divergen, dos caminos dejan al mismo usuario
 *     en estados distintos. Por eso ambos entran por `resolveKycFromStripe`.
 *
 *  2. Que una sesión 'requires_input' sin error NO se degrade mientras el usuario
 *     está capturando. Es el caso ambiguo: se ve idéntica a una que nunca cargó,
 *     y degradarla antes de tiempo desactiva el fallback anti-webhook-perdido.
 *
 *  3. Que el motivo del rechazo llegue a la base. `kycRejectedAt` y `kycErrorCode`
 *     se escribían sin estar declarados en el esquema, así que Mongoose los
 *     descartaba en silencio: quedaban usuarios en 'rejected' sin constancia de
 *     por qué. Es el caso que el expediente necesita poder reconstruir.
 *
 *  4. Que el barrido desatasque a quien nunca volvió a abrir la aplicación. Salir
 *     de 'in_review' dependía de que el usuario hiciera polling; si no volvía,
 *     se quedaba ahí (había uno desde el 2026-08-29).
 */
import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const mockApprove = jest.fn();
await jest.unstable_mockModule('../../src/webhooks/stripeWebhook.js', () => ({
  approveKycFromSession: mockApprove,
}));

const mockRetrieve = jest.fn();
await jest.unstable_mockModule('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.identity = { verificationSessions: { retrieve: mockRetrieve } };
    }
  },
}));

const { default: User }       = await import('../../src/models/User.js');
const { default: KycAttempt } = await import('../../src/models/KycAttempt.js');
const { resolveKycFromStripe } = await import('../../src/services/kycSessionResolver.js');
const { kycStaleSessionSweeper } = await import('../../src/jobs/kycStaleSessionSweeper.js');

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => {
  await clearCollections();
  mockApprove.mockReset();
  mockRetrieve.mockReset();
});

let seq = 0;
async function crearUsuarioEnRevision(sessionId) {
  seq += 1;
  return User.create({
    firstName:        'Test',
    lastName:         'KYC',
    email:            `kyc_${seq}_${Date.now()}@test.alyto.io`,
    password:         '$2b$10$hashedpassword.for.testing.only',
    legalEntity:      'SRL',
    kycStatus:        'in_review',
    kycProvider:      'stripe_identity',
    stripeVerificationSessionId: sessionId,
    residenceCountry: 'BO',
    identityDocument: { type: 'ci_bolivia', number: `${1000000 + seq}`, issuingCountry: 'BO' },
    isActive:         true,
  });
}

/** Sesión de Stripe con `created` en segundos, como la devuelve la API real. */
function sesion({ id = 'vs_test', status, lastErrorCode = null, edadMin = 1 }) {
  return {
    id,
    status,
    created:    Math.floor((Date.now() - edadMin * 60_000) / 1000),
    last_error: lastErrorCode ? { code: lastErrorCode, reason: 'motivo de prueba' } : null,
  };
}

describe('resolveKycFromStripe — traducción de la sesión al estado KYC', () => {

  it('verified → aprueba reusando el hook del webhook (no reimplementa los efectos)', async () => {
    const user = await crearUsuarioEnRevision('vs_ok');
    const s    = sesion({ id: 'vs_ok', status: 'verified' });

    const r = await resolveKycFromStripe(user, { session: s });

    expect(r.kycStatus).toBe('approved');
    expect(r.changed).toBe(true);
    // El fallback por polling tiene que aplicar TODOS los efectos (verified_outputs,
    // screening AML, keypair custodial), no solo cambiar el estado.
    expect(mockApprove).toHaveBeenCalledWith(s);
  });

  it('requires_input SIN error y reciente → sigue in_review: la captura está en curso', async () => {
    const user = await crearUsuarioEnRevision('vs_curso');

    const r = await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_curso', status: 'requires_input', edadMin: 2 }),
    });

    expect(r.kycStatus).toBe('in_review');
    expect(r.changed).toBe(false);
    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('in_review');
  });

  it('requires_input SIN error y vieja → vuelve a pending para que pueda reintentar', async () => {
    const user = await crearUsuarioEnRevision('vs_vieja');

    const r = await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_vieja', status: 'requires_input', edadMin: 60 }),
    });

    expect(r.kycStatus).toBe('pending');
    expect(r.changed).toBe(true);
    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('pending');
  });

  it('requires_input con error recuperable → pending aunque la sesión sea reciente', async () => {
    const user = await crearUsuarioEnRevision('vs_abandon');

    const r = await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_abandon', status: 'requires_input', lastErrorCode: 'abandoned', edadMin: 1 }),
    });

    expect(r.kycStatus).toBe('pending');
    expect(r.reason).toBe('abandoned');
  });

  it('requires_input con error definitivo → rechaza Y deja constancia del motivo', async () => {
    const user = await crearUsuarioEnRevision('vs_rechazo');

    const r = await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_rechazo', status: 'requires_input', lastErrorCode: 'document_expired' }),
    });

    expect(r.kycStatus).toBe('rejected');

    // Regresión: estos dos campos no existían en el esquema, así que Mongoose los
    // descartaba en silencio y el motivo del rechazo se perdía.
    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('rejected');
    expect(enBase.kycErrorCode).toBe('document_expired');
    expect(enBase.kycRejectedAt).toBeInstanceOf(Date);
  });

  it('canceled → pending: sin esto el usuario queda esperando un resultado que no llega', async () => {
    const user = await crearUsuarioEnRevision('vs_cancel');

    const r = await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_cancel', status: 'canceled' }),
    });

    expect(r.kycStatus).toBe('pending');
    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('pending');
  });

  it('processing → no toca nada: Stripe todavía está resolviendo una captura enviada', async () => {
    const user = await crearUsuarioEnRevision('vs_proc');

    const r = await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_proc', status: 'processing' }),
    });

    expect(r.changed).toBe(false);
    const enBase = await User.findById(user._id).lean();
    expect(enBase.kycStatus).toBe('in_review');
  });

  it('cierra el intento en la bitácora con el desenlace observado', async () => {
    const user = await crearUsuarioEnRevision('vs_bitacora');
    await KycAttempt.create({
      userId: user._id, sessionId: 'vs_bitacora', platform: 'mobile-web', outcome: 'open',
    });

    await resolveKycFromStripe(user, {
      session: sesion({ id: 'vs_bitacora', status: 'requires_input', lastErrorCode: 'abandoned' }),
    });

    const intento = await KycAttempt.findOne({ sessionId: 'vs_bitacora' }).lean();
    expect(intento.outcome).toBe('abandoned');
    expect(intento.stripeErrorCode).toBe('abandoned');
    expect(intento.outcomeAt).toBeInstanceOf(Date);
  });
});

describe('kycStaleSessionSweeper — desatasca a quien no volvió a abrir la aplicación', () => {

  it('resuelve las sesiones colgadas consultando Stripe', async () => {
    const colgado = await crearUsuarioEnRevision('vs_colgado');
    mockRetrieve.mockResolvedValue(
      sesion({ id: 'vs_colgado', status: 'requires_input', lastErrorCode: 'abandoned' }),
    );

    const r = await kycStaleSessionSweeper();

    expect(r.processed).toBe(1);
    expect(r.resueltos).toBe(1);
    const enBase = await User.findById(colgado._id).lean();
    expect(enBase.kycStatus).toBe('pending');
  });

  it('un usuario que falla no corta el barrido del resto', async () => {
    await crearUsuarioEnRevision('vs_falla');
    await crearUsuarioEnRevision('vs_sano');

    mockRetrieve.mockImplementation(async (id) => {
      if (id === 'vs_falla') throw new Error('Stripe no responde');
      return sesion({ id, status: 'canceled' });
    });

    const r = await kycStaleSessionSweeper();

    expect(r.processed).toBe(2);
    expect(r.fallidos).toBe(1);
    expect(r.resueltos).toBe(1);
    const sano = await User.findOne({ stripeVerificationSessionId: 'vs_sano' }).lean();
    expect(sano.kycStatus).toBe('pending');
  });

  it('no toca a quien no tiene sesión ni a quien ya está resuelto', async () => {
    const aprobado = await User.create({
      firstName: 'Ya', lastName: 'Aprobado',
      email: `ok_${Date.now()}@test.alyto.io`,
      password: '$2b$10$hashedpassword.for.testing.only',
      legalEntity: 'SRL', kycStatus: 'approved',
      identityDocument: { type: 'ci_bolivia', number: '9999999', issuingCountry: 'BO' },
      stripeVerificationSessionId: 'vs_aprobado', isActive: true,
    });
    const sinSesion = await crearUsuarioEnRevision(null);

    const r = await kycStaleSessionSweeper();

    expect(r.processed).toBe(0);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect((await User.findById(aprobado._id).lean()).kycStatus).toBe('approved');
    expect((await User.findById(sinSesion._id).lean()).kycStatus).toBe('in_review');
  });
});
