/**
 * changePassword.test.js — El cambio de contraseña desde el perfil.
 *
 * Esta función estuvo ROTA desde el commit inicial (2026-03-23) hasta el 2026-10-09 y
 * nadie lo supo: exigía `confirmPassword`, el frontend nunca lo enviaba, así que
 * devolvía 400 a TODOS los usuarios, siempre. Se descubrió el 2026-10-09 porque ningún
 * tester pudo cambiar su contraseña. Estaba vivo en producción, verificado contra el
 * bundle servido en alyto.app (`confirmPassword`: 0 ocurrencias).
 *
 * La doble escritura es un control de la INTERFAZ: el servidor no puede verificarla,
 * solo compara dos cadenas que el mismo cliente envía y controla. Exigirla no aportaba
 * seguridad y sí podía tumbar el flujo entero. Ahora es opcional, pero se valida si
 * llega — un cliente que la manda mal sigue siendo atajado.
 *
 * El primer test es el guard de la regresión: si alguien vuelve a hacerla obligatoria,
 * falla.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockCompare = jest.fn();
const mockHash    = jest.fn(async () => '$2a$12$hashnuevo');
await jest.unstable_mockModule('bcryptjs', () => ({
  default: { compare: mockCompare, hash: mockHash },
}));

const mockFindById         = jest.fn();
const mockFindByIdAndUpdate = jest.fn(async () => ({}));
await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findById: mockFindById, findByIdAndUpdate: mockFindByIdAndUpdate },
}));

await jest.unstable_mockModule('../../src/middlewares/authMiddleware.js', () => ({
  invalidateUserCache: jest.fn(),
}));
await jest.unstable_mockModule('../../src/services/piiCrypto.js', () => ({
  ensureDek: jest.fn(), isPiiEncryptionEnabled: () => false,
}));
await jest.unstable_mockModule('../../src/utils/clientDocument.js', () => ({
  isRealDocumentNumber: () => true,
  readDocumentNumber:   async () => '123',
  applyDocumentNumberToSet: jest.fn(),
}));

const { changePassword } = await import('../../src/controllers/userController.js');

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}
const req = (body) => ({ user: { _id: 'u1' }, body });

const VALIDA = 'Contrasena1!';

beforeEach(() => {
  jest.clearAllMocks();
  // findById(...).select('+password')
  mockFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1', password: '$2a$12$viejo' }) });
  mockCompare.mockResolvedValue(true);   // la contraseña actual es correcta
  mockHash.mockResolvedValue('$2a$12$hashnuevo');
});

describe('changePassword — sin confirmPassword (el bug que rompió a los testers)', () => {

  it('SIN confirmPassword el cambio FUNCIONA', async () => {
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!', newPassword: VALIDA }), res);

    expect(res.statusCode).toBe(200);
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('u1', { $set: { password: '$2a$12$hashnuevo' } });
  });

  it('la nueva contraseña se guarda HASHEADA, nunca en claro', async () => {
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!', newPassword: VALIDA }), res);

    expect(mockHash).toHaveBeenCalledWith(VALIDA, 12);
    const [, update] = mockFindByIdAndUpdate.mock.calls[0];
    expect(update.$set.password).not.toBe(VALIDA);
  });
});

describe('changePassword — la confirmación se valida si llega', () => {

  it('con confirmPassword coincidente: 200', async () => {
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!', newPassword: VALIDA, confirmPassword: VALIDA }), res);

    expect(res.statusCode).toBe(200);
  });

  it('con confirmPassword distinta: 400 y NO se guarda', async () => {
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!', newPassword: VALIDA, confirmPassword: 'Otra1!xx' }), res);

    expect(res.statusCode).toBe(400);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('confirmPassword vacía se trata como enviada y no coincidente', async () => {
    // Una cadena vacía es un dato que el cliente mandó, no una ausencia. Si se tratara
    // como ausente, un formulario con el campo en blanco pasaría de largo.
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!', newPassword: VALIDA, confirmPassword: '' }), res);

    expect(res.statusCode).toBe(400);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('changePassword — los controles que sí importan siguen puestos', () => {

  it('sin currentPassword: 400', async () => {
    const res = fakeRes();
    await changePassword(req({ newPassword: VALIDA }), res);
    expect(res.statusCode).toBe(400);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('sin newPassword: 400', async () => {
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('contraseña actual incorrecta: 400 y NO se guarda', async () => {
    mockCompare.mockResolvedValue(false);
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'malade', newPassword: VALIDA }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/actual es incorrecta/i);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('body vacío no revienta: 400', async () => {
    const res = fakeRes();
    await changePassword({ user: { _id: 'u1' } }, res);   // sin body
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['corta',        'Abc1!'],
    ['sin mayúscula','contrasena1!'],
    ['sin número',   'Contrasena!!'],
    ['sin símbolo',  'Contrasena11'],
  ])('contraseña débil (%s): 400', async (_caso, pw) => {
    const res = fakeRes();
    await changePassword(req({ currentPassword: 'Vieja1!', newPassword: pw }), res);

    expect(res.statusCode).toBe(400);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});
