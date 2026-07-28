/**
 * marketingAdmin.test.js — Panel admin del agente de marketing.
 *
 * Cubre los 6 endpoints de /api/v1/admin/marketing:
 *   GET  /estado
 *   POST /generar
 *   GET  /pendientes
 *   GET  /historial
 *   POST /:id/aprobar
 *   POST /:id/rechazar
 *
 * Lo que importa acá, más allá del CRUD:
 *   1. Que el gate humano NO se pueda resolver dos veces (dos admins, un clic
 *      cada uno) ni saltear (aprobar algo que nunca estuvo pendiente).
 *   2. Que cada resolución deje evidencia en AdminAuditLog. El gate vale lo que
 *      valga su rastro.
 *   3. Que checkAdmin realmente esté aplicado a todas las rutas.
 *
 * Montaje: se monta el router real en un Express mínimo con `protect` mockeado
 * (lee el usuario de un header). checkAdmin, el controller, el servicio, el
 * clasificador y la auditoría son los reales — lo único simulado es el modelo.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';

const completeMock = jest.fn();

await jest.unstable_mockModule('../../src/services/llmProvider.js', () => ({
  complete: completeMock,
  default: { complete: completeMock },
}));
await jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }));

// `protect` simulado: toma el usuario del header x-test-user. checkAdmin queda real.
await jest.unstable_mockModule('../../src/middlewares/authMiddleware.js', () => ({
  protect: (req, _res, next) => {
    if (req.headers['x-test-user']) req.user = JSON.parse(req.headers['x-test-user']);
    next();
  },
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { connectTestDb, disconnectTestDb, clearCollections } = await import('../helpers/db.js');
const { default: marketingAgentRoutes } = await import('../../src/routes/marketingAgentRoutes.js');
const { default: ContentPiece } = await import('../../src/models/ContentPiece.js');
const { default: AdminAuditLog } = await import('../../src/models/AdminAuditLog.js');

const app = express();
app.use(express.json());
app.use('/api/v1/admin/marketing', marketingAgentRoutes);

const ADMIN = { _id: '507f1f77bcf86cd799439011', email: 'admin@alyto.app', role: 'admin' };
const OTRO_ADMIN = { _id: '507f1f77bcf86cd799439012', email: 'otro@alyto.app', role: 'admin' };
const USUARIO = { _id: '507f1f77bcf86cd799439013', email: 'user@alyto.app', role: 'user' };

const como = (user) => ({ 'x-test-user': JSON.stringify(user) });

// Respuesta del modelo en el formato estructurado del system prompt.
function respuesta({ titulo = 'Qué es la custodia institucional', cuerpo = 'Una entidad regulada protege tus activos digitales.' } = {}) {
  return {
    text: [
      `TITULO: ${titulo}`, '', `CUERPO: ${cuerpo}`, '',
      'SUGERENCIA_VISUAL: Aly junto a una bóveda, paleta navy y dorado.', '',
      'CANAL: facebook', '', 'TIPO: educacion', '',
      'AUTOEVALUACION_RIESGO: bajo', 'MOTIVO_RIESGO: Pieza educativa.',
    ].join('\n'),
    stopReason: 'end_turn',
    usage: { inputTokens: 900, outputTokens: 150 },
  };
}

// Crea una pieza directamente en Mongo, sin pasar por el modelo.
const sembrarPieza = (over = {}) => ContentPiece.create({
  titulo: 'Título', cuerpo: 'Cuerpo', canal: 'facebook', tipo: 'educacion',
  autoevaluacionRiesgo: 'alto', clasificacionFinal: 'alto',
  motivosClasificador: ['Contiene cifras económicas'],
  estado: 'pendiente_aprobacion', ...over,
});

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
afterEach(async () => { await clearCollections(); completeMock.mockReset(); });
beforeEach(() => { process.env.MARKETING_AGENT_ENABLED = 'true'; });

// ─────────────────────────────────────────────────────────────────────────────
describe('autorización', () => {
  test.each([
    ['GET',  '/estado'],
    ['POST', '/generar'],
    ['GET',  '/pendientes'],
    ['GET',  '/historial'],
    ['POST', '/507f1f77bcf86cd799439099/aprobar'],
    ['POST', '/507f1f77bcf86cd799439099/rechazar'],
  ])('%s %s exige rol admin', async (metodo, ruta) => {
    const url = `/api/v1/admin/marketing${ruta}`;
    const sinAuth = await request(app)[metodo.toLowerCase()](url);
    expect(sinAuth.status).toBe(401);

    const noAdmin = await request(app)[metodo.toLowerCase()](url).set(como(USUARIO));
    expect(noAdmin.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /generar', () => {
  test('pieza limpia → 201 y queda autopublicada', async () => {
    completeMock.mockResolvedValue(respuesta());

    const res = await request(app).post('/api/v1/admin/marketing/generar')
      .set(como(ADMIN)).send({ tarea: 'Explicá la custodia institucional.' });

    expect(res.status).toBe(201);
    expect(res.body.pieza.estado).toBe('autopublicado');
    expect(res.body.pieza.clasificacionFinal).toBe('bajo');
    expect(res.body.pieza.creadoPor).toBe('admin@alyto.app');
  });

  test('pieza con cifra → 201 y cae en la cola', async () => {
    completeMock.mockResolvedValue(respuesta({ cuerpo: 'Solo 2% de comisión por operación.' }));

    const res = await request(app).post('/api/v1/admin/marketing/generar')
      .set(como(ADMIN)).send({ tarea: 'Contá nuestras comisiones.' });

    expect(res.status).toBe(201);
    expect(res.body.pieza.estado).toBe('pendiente_aprobacion');
    expect(res.body.pieza.motivosClasificador).toContain('Contiene cifras económicas');
  });

  test.each([
    ['sin body',      {}],
    ['tarea vacía',   { tarea: '   ' }],
    ['tarea no string', { tarea: 42 }],
  ])('%s → 400 sin llamar al modelo', async (_, body) => {
    const res = await request(app).post('/api/v1/admin/marketing/generar')
      .set(como(ADMIN)).send(body);

    expect(res.status).toBe(400);
    expect(completeMock).not.toHaveBeenCalled();
  });

  test('respuesta ilegible del modelo → 502 con código accionable, no 500', async () => {
    completeMock.mockResolvedValue({ text: 'Claro, con gusto.', stopReason: 'end_turn', usage: {} });

    const res = await request(app).post('/api/v1/admin/marketing/generar')
      .set(como(ADMIN)).send({ tarea: 'Generá algo.' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('RESPUESTA_NO_PARSEABLE');
    expect(await ContentPiece.countDocuments()).toBe(0);
  });

  test('flag apagado → 503, no 500', async () => {
    process.env.MARKETING_AGENT_ENABLED = 'false';

    const res = await request(app).post('/api/v1/admin/marketing/generar')
      .set(como(ADMIN)).send({ tarea: 'Generá algo.' });

    expect(res.status).toBe(503);
    expect(completeMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /pendientes', () => {
  test('devuelve solo las pendientes, más viejas primero', async () => {
    const vieja = await sembrarPieza({ titulo: 'Vieja', createdAt: new Date('2026-01-01') });
    await sembrarPieza({ titulo: 'Nueva', createdAt: new Date('2026-06-01') });
    await sembrarPieza({ titulo: 'Ya autopublicada', estado: 'autopublicado', clasificacionFinal: 'bajo' });
    await sembrarPieza({ titulo: 'Ya rechazada', estado: 'rechazado' });

    const res = await request(app).get('/api/v1/admin/marketing/pendientes').set(como(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.piezas.map(p => p.titulo)).toEqual(['Vieja', 'Nueva']);
    expect(res.body.piezas[0]._id).toBe(vieja._id.toString());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /historial', () => {
  test('pagina y filtra por estado', async () => {
    for (let i = 0; i < 5; i++) await sembrarPieza({ titulo: `P${i}` });
    await sembrarPieza({ titulo: 'Auto', estado: 'autopublicado', clasificacionFinal: 'bajo' });

    const pag = await request(app).get('/api/v1/admin/marketing/historial?page=1&limit=2').set(como(ADMIN));
    expect(pag.body.piezas).toHaveLength(2);
    expect(pag.body.pagination).toMatchObject({ page: 1, limit: 2, total: 6, pages: 3 });

    const filtrado = await request(app).get('/api/v1/admin/marketing/historial?estado=autopublicado').set(como(ADMIN));
    expect(filtrado.body.pagination.total).toBe(1);
    expect(filtrado.body.piezas[0].titulo).toBe('Auto');
  });

  test('el límite por página está acotado (no se puede pedir todo)', async () => {
    const res = await request(app).get('/api/v1/admin/marketing/historial?limit=99999').set(como(ADMIN));
    expect(res.body.pagination.limit).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gate humano: aprobar / rechazar', () => {
  test('aprobar deja quién y cuándo', async () => {
    const pieza = await sembrarPieza();

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.pieza.estado).toBe('aprobado');
    expect(res.body.pieza.aprobadoPor).toBe('admin@alyto.app');
    expect(res.body.pieza.aprobadoEn).toBeTruthy();
  });

  test('rechazar con motivo', async () => {
    const pieza = await sembrarPieza();

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/rechazar`)
      .set(como(ADMIN)).send({ motivo: 'La cifra no está aprobada por compliance.' });

    expect(res.status).toBe(200);
    expect(res.body.pieza.estado).toBe('rechazado');
  });

  test('NO se puede resolver dos veces: el segundo admin recibe 409 y no pisa al primero', async () => {
    const pieza = await sembrarPieza();

    const primero = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));
    const segundo = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/rechazar`).set(como(OTRO_ADMIN));

    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect(segundo.body.estado).toBe('aprobado');
    expect(segundo.body.aprobadoPor).toBe('admin@alyto.app');

    const final = await ContentPiece.findById(pieza._id).lean();
    expect(final.estado).toBe('aprobado');
    expect(final.aprobadoPor).toBe('admin@alyto.app');   // el primero, intacto
  });

  test('clics simultáneos: solo uno gana', async () => {
    const pieza = await sembrarPieza();
    const url = `/api/v1/admin/marketing/${pieza._id}/aprobar`;

    const res = await Promise.all([
      request(app).post(url).set(como(ADMIN)),
      request(app).post(url).set(como(OTRO_ADMIN)),
    ]);

    const codigos = res.map(r => r.status).sort();
    expect(codigos).toEqual([200, 409]);
    expect(await ContentPiece.countDocuments({ estado: 'aprobado' })).toBe(1);
  });

  test('una pieza autopublicada no pasa por el gate → 409', async () => {
    const pieza = await sembrarPieza({ estado: 'autopublicado', clasificacionFinal: 'bajo' });

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));

    expect(res.status).toBe(409);
    expect(res.body.estado).toBe('autopublicado');
  });

  test.each([
    ['id inexistente', '507f1f77bcf86cd799439099', 404],
    ['id malformado',  'no-es-un-objectid',        400],
  ])('%s → %s', async (_, id, esperado) => {
    const res = await request(app).post(`/api/v1/admin/marketing/${id}/aprobar`).set(como(ADMIN));
    expect(res.status).toBe(esperado);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('prohibiciones absolutas: la aprobación se bloquea', () => {
  // Distinción central: hay riesgo REVISABLE (un humano decide con contexto) y
  // riesgo PROHIBIDO (no hay contexto que lo habilite). La interfaz no debe
  // ofrecer un botón para lo segundo.

  test.each([
    ['terminología de marca', 'Manda tu remesa a Bolivia con Alyto.'],
    ['certificación FDIC',    'Tus fondos están asegurados por FDIC.'],
    ['sobre-afirmación ASFI', 'Alyto está regulado por ASFI.'],
    ['exchange',              'Alyto es el exchange más seguro de Bolivia.'],
  ])('%s → 422 y la pieza sigue pendiente', async (_, cuerpo) => {
    const pieza = await sembrarPieza({ cuerpo });

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));

    expect(res.status).toBe(422);
    expect(res.body.bloqueada).toBe(true);
    expect(res.body.coincidencia).toBeTruthy();

    const final = await ContentPiece.findById(pieza._id).lean();
    expect(final.estado).toBe('pendiente_aprobacion');   // no se movió
    expect(final.aprobadoPor).toBeNull();
  });

  test('una pieza prohibida SÍ se puede rechazar (es lo que corresponde)', async () => {
    const pieza = await sembrarPieza({ cuerpo: 'Manda tu remesa hoy.' });

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/rechazar`)
      .set(como(ADMIN)).send({ motivo: 'Usa terminología prohibida.' });

    expect(res.status).toBe(200);
    expect(res.body.pieza.estado).toBe('rechazado');
  });

  test('riesgo REVISABLE (una cifra) sigue siendo aprobable por un humano', async () => {
    const pieza = await sembrarPieza({ cuerpo: 'La comisión de hoy es de 2% sobre el monto.' });

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.pieza.estado).toBe('aprobado');
  });

  test('el bloqueo también mira la sugerencia visual, no solo el cuerpo', async () => {
    const pieza = await sembrarPieza({
      cuerpo: 'Transferencias internacionales seguras y transparentes.',
      sugerenciaVisual: 'Aly sosteniendo un cartel que dice "remesas rápidas".',
    });

    const res = await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));

    expect(res.status).toBe(422);
  });

  test('un intento bloqueado no deja rastro de aprobación en el audit', async () => {
    const pieza = await sembrarPieza({ cuerpo: 'Manda tu remesa hoy.' });

    await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));
    await new Promise(r => setImmediate(r));

    expect(await AdminAuditLog.countDocuments({ targetId: pieza._id.toString() })).toBe(0);
  });

  test('GET /pendientes marca cuáles no son aprobables', async () => {
    await sembrarPieza({ titulo: 'Con cifra',   cuerpo: 'Comisión de 2%.' });
    await sembrarPieza({ titulo: 'Con remesa',  cuerpo: 'Manda tu remesa hoy.' });

    const res = await request(app).get('/api/v1/admin/marketing/pendientes').set(como(ADMIN));

    const porTitulo = Object.fromEntries(res.body.piezas.map(p => [p.titulo, p]));
    expect(porTitulo['Con cifra'].prohibida).toBe(false);
    expect(porTitulo['Con remesa'].prohibida).toBe(true);
    expect(porTitulo['Con remesa'].motivoProhibicion).toBe('Usa terminología prohibida de marca');
    expect(porTitulo['Con remesa'].coincidencia).toBe('remesa');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('evidencia de la revisión humana', () => {
  test('aprobar escribe un AdminAuditLog con actor, estado previo y motivos', async () => {
    const pieza = await sembrarPieza();

    await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));

    // El audit se escribe fire-and-forget: dar una vuelta al event loop.
    await new Promise(r => setImmediate(r));

    const log = await AdminAuditLog.findOne({ targetId: pieza._id.toString() }).lean();
    expect(log).toBeTruthy();
    expect(log.action).toBe('marketing.piece.approve');
    expect(log.targetType).toBe('ContentPiece');
    expect(log.actorEmail).toBe('admin@alyto.app');
    expect(log.before).toMatchObject({ estado: 'pendiente_aprobacion' });
    expect(log.after).toMatchObject({ estado: 'aprobado' });
    expect(log.metadata.motivosClasificador).toContain('Contiene cifras económicas');
  });

  test('rechazar guarda el motivo en el audit', async () => {
    const pieza = await sembrarPieza();

    await request(app).post(`/api/v1/admin/marketing/${pieza._id}/rechazar`)
      .set(como(ADMIN)).send({ motivo: 'Menciona una cifra sin aprobar.' });
    await new Promise(r => setImmediate(r));

    const log = await AdminAuditLog.findOne({ targetId: pieza._id.toString() }).lean();
    expect(log.action).toBe('marketing.piece.reject');
    expect(log.reason).toBe('Menciona una cifra sin aprobar.');
  });

  test('un intento fallido (409) NO deja rastro de aprobación', async () => {
    const pieza = await sembrarPieza({ estado: 'aprobado', aprobadoPor: 'otro@alyto.app' });

    await request(app).post(`/api/v1/admin/marketing/${pieza._id}/aprobar`).set(como(ADMIN));
    await new Promise(r => setImmediate(r));

    expect(await AdminAuditLog.countDocuments({ targetId: pieza._id.toString() })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /estado', () => {
  test('reporta flag, modelo y conteo por estado', async () => {
    await sembrarPieza();
    await sembrarPieza();
    await sembrarPieza({ estado: 'autopublicado', clasificacionFinal: 'bajo' });

    const res = await request(app).get('/api/v1/admin/marketing/estado').set(como(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.habilitado).toBe(true);
    expect(res.body.modelo).toBe('claude-sonnet-4-6');
    expect(res.body.piezas).toEqual({ pendiente_aprobacion: 2, autopublicado: 1 });
  });
});
