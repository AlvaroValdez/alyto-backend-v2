/**
 * supportReport.test.js
 *
 * POST /api/v1/support/report — denuncia de contenido generado por la IA.
 *
 * Lo que se protege aquí no es una función, es un requisito: la política de IA
 * generativa de Google Play exige poder denunciar contenido ofensivo desde
 * dentro de la app. Si este endpoint deja de aceptar denuncias, la declaración
 * de la ficha pasa a ser falsa.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/supportReport.test.js
 */

import { jest } from '@jest/globals';

const creados = [];
const correos = [];

jest.unstable_mockModule('../src/models/AiContentReport.js', () => ({
  default: {
    create: jest.fn(async (doc) => {
      const guardado = { ...doc, reportId: `AIR-TEST-${creados.length + 1}` };
      creados.push(guardado);
      return guardado;
    }),
  },
  MOTIVOS: ['ofensivo', 'peligroso', 'incorrecto', 'otro'],
}));

jest.unstable_mockModule('../src/services/email.js', () => ({
  sendRawEmail: jest.fn(async (to, subject, html) => { correos.push({ to, subject, html }); }),
}));

jest.unstable_mockModule('@sentry/node', () => ({
  captureException: jest.fn(),
}));

jest.unstable_mockModule('../src/services/supportAgentService.js', () => ({
  askSupport:            jest.fn(),
  isSupportAgentEnabled: jest.fn(() => false),
}));

const { reportAiContent } = await import('../src/controllers/supportController.js');

function hacerRes() {
  return {
    statusCode: 200,
    body:       null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}

const usuario = { _id: 'user-123' };

beforeEach(() => { creados.length = 0; correos.length = 0; });

describe('reportAiContent', () => {
  test('guarda la denuncia y devuelve 201 con su identificador', async () => {
    const res = hacerRes();
    await reportAiContent({
      user: usuario,
      body: { contenido: 'respuesta ofensiva', motivo: 'ofensivo', mensajeUsuario: 'hola' },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.reportId).toMatch(/^AIR-/);
    expect(creados).toHaveLength(1);
    expect(creados[0].contenido).toBe('respuesta ofensiva');
    expect(creados[0].mensajeUsuario).toBe('hola');
    expect(creados[0].userId).toBe('user-123');
  });

  test('rechaza un motivo que no está en la lista', async () => {
    const res = hacerRes();
    await reportAiContent({ user: usuario, body: { contenido: 'x', motivo: 'inventado' } }, res);
    expect(res.statusCode).toBe(400);
    expect(creados).toHaveLength(0);
  });

  test('rechaza una denuncia sin contenido', async () => {
    const res = hacerRes();
    await reportAiContent({ user: usuario, body: { motivo: 'ofensivo', contenido: '   ' } }, res);
    expect(res.statusCode).toBe(400);
    expect(creados).toHaveLength(0);
  });

  test('avisa a soporte por correo', async () => {
    const res = hacerRes();
    await reportAiContent({ user: usuario, body: { contenido: 'algo', motivo: 'peligroso' } }, res);
    expect(res.statusCode).toBe(201);
    expect(correos).toHaveLength(1);
    expect(correos[0].subject).toContain('peligroso');
  });

  test('si el correo falla, la denuncia igual queda guardada', async () => {
    const { sendRawEmail } = await import('../src/services/email.js');
    sendRawEmail.mockImplementationOnce(() => Promise.reject(new Error('SendGrid caido')));

    const res = hacerRes();
    await reportAiContent({ user: usuario, body: { contenido: 'algo', motivo: 'otro' } }, res);

    expect(res.statusCode).toBe(201);
    expect(creados).toHaveLength(1);
  });

  test('recorta los campos largos en vez de rechazarlos', async () => {
    const res = hacerRes();
    await reportAiContent({
      user: usuario,
      body: {
        contenido:      'a'.repeat(9000),
        motivo:         'incorrecto',
        mensajeUsuario: 'b'.repeat(9000),
        comentario:     'c'.repeat(9000),
      },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(creados[0].contenido.length).toBe(4000);
    expect(creados[0].mensajeUsuario.length).toBe(2000);
    expect(creados[0].comentario.length).toBe(1000);
  });

  test('el comentario vacío se guarda como null, no como cadena vacía', async () => {
    const res = hacerRes();
    await reportAiContent({
      user: usuario,
      body: { contenido: 'algo', motivo: 'otro', comentario: '   ' },
    }, res);
    expect(creados[0].comentario).toBeNull();
  });
});
