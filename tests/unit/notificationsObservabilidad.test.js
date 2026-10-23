/**
 * notificationsObservabilidad.test.js — una push que no se entrega tiene que dejar rastro.
 *
 * Por qué existe: el push de Android estuvo caído desde que existe la app y nada
 * avisó. `sendPushNotification` salía con `return` pelado en cuatro caminos y
 * `notify` terminaba en `.catch(() => {})`, así que "no se entregó" era
 * indistinguible de "se entregó". En producción eso se veía como 2 envíos logueados
 * en 72h cuando en realidad 45 de 64 notificaciones de 7 días no habían salido.
 *
 * El caso que más pesa es `sin_tokens` (18 de 25 usuarios no tienen ninguno), y es
 * el que estaba completamente mudo.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

// Las credenciales tienen que estar ANTES de importar el módulo: `initFirebase()`
// corre en el cuerpo del módulo y decide ahí si el push queda habilitado.
process.env.FIREBASE_PROJECT_ID   = 'alyto-test';
process.env.FIREBASE_CLIENT_EMAIL = 'test@alyto-test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY  = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----';

const mockSend = jest.fn();
await jest.unstable_mockModule('firebase-admin', () => ({
  default: {
    apps:          [],
    credential:    { cert: () => ({}) },
    initializeApp: jest.fn(),
    messaging:     () => ({ send: mockSend }),
  },
}));

const mockFindById  = jest.fn();
const mockUpdateOne = jest.fn(async () => ({}));
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findById: mockFindById, updateOne: mockUpdateOne, find: jest.fn() },
}));

const mockCreate = jest.fn(async () => ({}));
await jest.unstable_mockModule('../../src/models/Notification.js', () => ({
  default: { create: mockCreate },
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
await jest.unstable_mockModule('../../src/utils/logger.js', () => ({ logger: mockLog }));

const mockCaptureMessage   = jest.fn();
const mockCaptureException = jest.fn();
await jest.unstable_mockModule('@sentry/node', () => ({
  captureMessage:   mockCaptureMessage,
  captureException: mockCaptureException,
}));

const { sendPushNotification, notify } = await import('../../src/services/notifications.js');

// `initFirebase()` es async y no se espera en el cuerpo del módulo.
await new Promise((r) => setImmediate(r));

/** Cadena de Mongoose: findById().select().lean() */
const usuario = (doc) => ({ select: () => ({ lean: async () => doc }) });

const AVISO = { title: 'Pago recibido', body: 'Recibiste Bs 240', data: { type: 'payin_confirmed' } };

/** Devuelve el texto de todos los logs de un nivel, concatenado. */
const textoDe = (nivel) => mockLog[nivel].mock.calls.map((c) => c[0]).join(' | ');

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue('ok');
});

describe('no-entregas que antes eran silenciosas', () => {
  it('un usuario sin tokens deja un aviso con marca buscable', async () => {
    mockFindById.mockReturnValue(usuario({ fcmTokens: [] }));

    const r = await sendPushNotification('u1', AVISO);

    expect(r).toEqual({ delivered: 0, attempted: 0, reason: 'sin_tokens' });
    expect(textoDe('warn')).toMatch(/SIN TOKENS/);
    // No va a Sentry: hoy son 18 de 25 usuarios y ahogaría todo lo demás.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('un usuario inexistente cuenta como sin tokens, no como éxito', async () => {
    mockFindById.mockReturnValue(usuario(null));

    const r = await sendPushNotification('u1', AVISO);

    expect(r.reason).toBe('sin_tokens');
    expect(r.delivered).toBe(0);
  });

  it('si no se puede leer el usuario, lo dice y avisa a Sentry', async () => {
    mockFindById.mockImplementation(() => { throw new Error('Mongo caído'); });

    const r = await sendPushNotification('u1', AVISO);

    expect(r.reason).toBe('usuario_ilegible');
    expect(textoDe('error')).toMatch(/NO ENTREGADA/);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('tener tokens y que ninguno acepte SÍ es una falla, y se reporta', async () => {
    mockFindById.mockReturnValue(usuario({ fcmTokens: ['t1', 't2'] }));
    mockSend.mockRejectedValue(Object.assign(new Error('SenderId mismatch'), {
      code: 'messaging/mismatched-credential',
    }));

    const r = await sendPushNotification('u1', AVISO);

    expect(r).toEqual({ delivered: 0, attempted: 2, reason: 'enviado' });
    expect(textoDe('error')).toMatch(/NO ENTREGADA/);
    expect(mockCaptureMessage).toHaveBeenCalled();
  });

  it('el log trae los motivos del fallo, no solo el conteo', async () => {
    // Antes decía "failed: 2" y nada más, así que una credencial mala se veía
    // igual que un token viejo. El motivo es lo que permite distinguirlas.
    mockFindById.mockReturnValue(usuario({ fcmTokens: ['t1'] }));
    mockSend.mockRejectedValue(Object.assign(new Error('Quota exceeded'), { code: 'messaging/quota-exceeded' }));

    await sendPushNotification('u1', AVISO);

    const [, detalle] = mockLog.error.mock.calls.at(-1);
    expect(detalle.motivosFallo).toEqual(['Quota exceeded']);
    expect(detalle.type).toBe('payin_confirmed');
  });
});

describe('no-entregas legítimas y entregas', () => {
  it('respeta que el usuario haya apagado las push y lo distingue de una falla', async () => {
    mockFindById.mockReturnValue(usuario({
      fcmTokens:   ['t1'],
      preferences: { notifications: { push: false } },
    }));

    const r = await sendPushNotification('u1', AVISO);

    expect(r.reason).toBe('push_desactivado_por_usuario');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('una entrega exitosa informa cuántos dispositivos la recibieron', async () => {
    mockFindById.mockReturnValue(usuario({ fcmTokens: ['t1', 't2'] }));

    const r = await sendPushNotification('u1', AVISO);

    expect(r).toEqual({ delivered: 2, attempted: 2, reason: 'enviado' });
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('entrega parcial no se reporta como falla: alguien la recibió', async () => {
    mockFindById.mockReturnValue(usuario({ fcmTokens: ['bueno', 'viejo'] }));
    mockSend.mockImplementation(({ token }) => (token === 'bueno'
      ? Promise.resolve('ok')
      : Promise.reject(Object.assign(new Error('NotRegistered'), {
          code: 'messaging/registration-token-not-registered',
        }))));

    const r = await sendPushNotification('u1', AVISO);

    expect(r.delivered).toBe(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    // El token muerto se limpia solo.
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $pull: { fcmTokens: { $in: ['viejo'] } } },
    );
  });
});

describe('notify — persistir y empujar son independientes', () => {
  it('persiste la notificación aunque no haya a quién empujarla', async () => {
    // Es deliberado: la campana de la app debe mostrarla igual. Pero justamente por
    // eso el usuario la ve y nadie nota que nunca recibió el aviso, así que la
    // no-entrega tiene que quedar en el log.
    mockFindById.mockReturnValue(usuario({ fcmTokens: [] }));

    await notify('u1', AVISO);
    await new Promise((r) => setImmediate(r));

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', type: 'payin_confirmed', body: 'Recibiste Bs 240',
    }));
    expect(textoDe('warn')).toMatch(/SIN TOKENS/);
  });

  it('si falla el guardado en Mongo, lo dice e intenta la push igual', async () => {
    mockCreate.mockRejectedValueOnce(new Error('escritura rechazada'));
    mockFindById.mockReturnValue(usuario({ fcmTokens: ['t1'] }));

    await notify('u1', AVISO);
    await new Promise((r) => setImmediate(r));

    expect(textoDe('error')).toMatch(/Error persistiendo/);
    expect(mockSend).toHaveBeenCalled();
  });
});
