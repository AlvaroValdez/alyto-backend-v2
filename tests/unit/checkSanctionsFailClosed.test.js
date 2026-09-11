/**
 * checkSanctionsFailClosed.test.js — Contraste contra listas restrictivas, fail-closed.
 *
 * Acredita el control declarado ante ASFI: el contraste contra listas de sanciones
 * bloquea por defecto ante una falla del servicio de screening en producción, en vez
 * de dejar pasar la operación. Un screening que "deja pasar ante error" permitiría
 * evadir el control provocando el error.
 *
 * Se mockea el servicio de screening y la lectura del documento, para ejercitar los
 * tres desenlaces del middleware sin base de datos.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockScreenUser = jest.fn();
await jest.unstable_mockModule('../../src/services/sanctionsService.js', () => ({
  screenUser: mockScreenUser,
}));
await jest.unstable_mockModule('../../src/utils/clientDocument.js', () => ({
  readDocumentNumber: () => '12345678',   // evita la ruta a base de datos
}));
await jest.unstable_mockModule('../../src/services/piiCrypto.js', () => ({
  ensureDek: jest.fn(), isPiiEncryptionEnabled: () => false,
}));

const { checkSanctions } = await import('../../src/middlewares/checkSanctions.js');

function fakeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = () => ({ user: { _id: '1', firstName: 'Ana', lastName: 'Pérez', email: 'a@x.com' } });

const NODE_ENV_ORIG = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = NODE_ENV_ORIG; mockScreenUser.mockReset(); });

describe('contraste contra listas restrictivas — fail-closed en producción', () => {

  it('falla del screening en PRODUCCIÓN → 503, la operación NO continúa', async () => {
    process.env.NODE_ENV = 'production';
    mockScreenUser.mockResolvedValue({ isClean: true, error: 'servicio caído' });
    const res = fakeRes(); let siguio = false;
    await checkSanctions(req(), res, () => { siguio = true; });
    expect(siguio).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('SCREENING_UNAVAILABLE');
  });

  it('coincidencia confirmada → 403, la operación NO continúa', async () => {
    process.env.NODE_ENV = 'production';
    mockScreenUser.mockResolvedValue({ isClean: false, hits: [{ entryId: 'x', listSource: 'OFAC' }] });
    const res = fakeRes(); let siguio = false;
    await checkSanctions(req(), res, () => { siguio = true; });
    expect(siguio).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('SANCTIONS_HIT');
  });

  it('screening limpio → la operación continúa', async () => {
    process.env.NODE_ENV = 'production';
    mockScreenUser.mockResolvedValue({ isClean: true, hits: [] });
    const res = fakeRes(); let siguio = false;
    await checkSanctions(req(), res, () => { siguio = true; });
    expect(siguio).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});
