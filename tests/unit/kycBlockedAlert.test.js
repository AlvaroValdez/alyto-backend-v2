/**
 * kycBlockedAlert.test.js — Detección del usuario que no logra verificarse.
 *
 * La señal que se usa acá no es un tiempo de espera sino un acto del usuario:
 * lanzar una sesión nueva. Para hacerlo tuvo que volver a la aplicación y pulsar
 * otra vez, cosa que sólo ocurre si la anterior no llegó a término. Eso resuelve
 * la ambigüedad que arrastra todo este flujo, donde una sesión recién creada y
 * una cuyo alojado nunca cargó se ven idénticas en la API de Stripe.
 *
 * Lo que se protege: que la racha se corte en el primer intento que SÍ volvió
 * (si no, un usuario con un historial largo dispararía la alerta para siempre),
 * y que un fallo aislado no alerte, porque eso convertiría el aviso en ruido y
 * acabaría ignorado.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const mockNotifyAdmins = jest.fn();
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notifyAdmins: mockNotifyAdmins,
  notify:       jest.fn(),
}));

const mockSendRaw = jest.fn();
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  sendRawEmail: mockSendRaw,
}));

const { default: KycAttempt } = await import('../../src/models/KycAttempt.js');
const { revisarBloqueoKyc, contarFallosConsecutivos } =
  await import('../../src/services/kycBlockedAlert.js');
const mongoose = (await import('mongoose')).default;

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
beforeEach(async () => {
  await clearCollections();
  mockNotifyAdmins.mockReset();
  mockSendRaw.mockReset();
});

describe('contarFallosConsecutivos', () => {

  it('cuenta la racha de intentos sin retorno, del más reciente hacia atrás', () => {
    expect(contarFallosConsecutivos([
      { returnedAt: null }, { returnedAt: null }, { returnedAt: null },
    ])).toBe(3);
  });

  it('la racha se corta en el primero que SÍ volvió del alojado de Stripe', () => {
    // Sin este corte, alguien con un historial largo quedaría alertando para
    // siempre, aunque su último problema ya esté resuelto.
    expect(contarFallosConsecutivos([
      { returnedAt: null }, { returnedAt: new Date() }, { returnedAt: null }, { returnedAt: null },
    ])).toBe(1);
  });

  it('sin historial no hay racha', () => {
    expect(contarFallosConsecutivos([])).toBe(0);
  });
});

describe('revisarBloqueoKyc', () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    email: 'bloqueado@gmail.com',
    firstName: 'Denzel',
    legalEntity: 'SRL',
  };

  /** Crea intentos del más antiguo al más reciente. */
  async function historial(...retornos) {
    let t = Date.now() - retornos.length * 60_000;
    for (const [i, volvio] of retornos.entries()) {
      await KycAttempt.create({
        userId: user._id, sessionId: `vs_prev_${i}`, platform: 'mobile-web',
        returnedAt: volvio ? new Date(t) : null,
        createdAt: new Date(t), outcome: volvio ? 'approved' : 'open',
        ip: '131.0.196.135', userAgent: 'Chrome/154 Android',
      });
      t += 60_000;
    }
    await KycAttempt.create({
      userId: user._id, sessionId: 'vs_nuevo', platform: 'mobile-web', outcome: 'open',
    });
  }

  it('un solo fallo no alerta: puede ser una conexión caída o alguien que cambió de idea', async () => {
    await historial(false);
    const r = await revisarBloqueoKyc(user, 'vs_nuevo');

    expect(r.alertado).toBe(false);
    expect(r.fallos).toBe(1);
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('dos fallos seguidos sí alertan: ya es un patrón', async () => {
    await historial(false, false);
    const r = await revisarBloqueoKyc(user, 'vs_nuevo');

    expect(r.alertado).toBe(true);
    expect(r.fallos).toBe(2);
    expect(mockNotifyAdmins).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmins.mock.calls[0][0].data.type).toBe('admin_kyc_bloqueado');

    // El correo tiene que traer lo necesario para actuar sin volver a la base.
    const [destino, asunto, html] = mockSendRaw.mock.calls[0];
    expect(destino).toBeTruthy();
    expect(asunto).toContain('bloqueado@gmail.com');
    expect(html).toContain('131.0.196.135');
    expect(html).toContain('vs_prev_1');
  });

  it('no alerta a quien falló antes pero su último intento sí llegó a Stripe', async () => {
    await historial(false, false, true);
    const r = await revisarBloqueoKyc(user, 'vs_nuevo');

    expect(r.alertado).toBe(false);
    expect(r.fallos).toBe(0);
  });

  it('no repite el aviso dentro del cooldown', async () => {
    await historial(false, false);
    await revisarBloqueoKyc(user, 'vs_nuevo');
    const segunda = await revisarBloqueoKyc(user, 'vs_nuevo');

    // El cooldown es persistente (vive en la base), así que un redespliegue
    // tampoco lo reinicia.
    expect(segunda.alertado).toBe(false);
    expect(segunda.motivo).toBe('cooldown');
    expect(mockNotifyAdmins).toHaveBeenCalledTimes(1);
  });

  it('el intento recién abierto no se cuenta a sí mismo', async () => {
    // vs_nuevo tiene returnedAt nulo por definición: acaba de crearse. Contarlo
    // adelantaría la alerta en uno y dispararía con un solo fallo real.
    await historial(false);
    const r = await revisarBloqueoKyc(user, 'vs_nuevo');
    expect(r.fallos).toBe(1);
  });
});
