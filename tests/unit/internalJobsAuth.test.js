/**
 * internalJobsAuth.test.js — La puerta del endpoint interno de jobs.
 *
 * Pese al nombre, `/api/v1/internal/jobs/*` ES alcanzable desde internet: nginx no la
 * bloquea (verificado contra producción: responde sin token, no da timeout). El token
 * compartido es la única barrera y es el MISMO para los 15 jobs, varios de los cuales
 * mueven dinero y uno gasta XLM.
 *
 * Lo que se protege acá, en orden de importancia:
 *   1. Que el llamador legítimo siga pasando. Un endurecimiento que rompa a la Lambda
 *      apaga 14 jobs en producción en silencio, que es peor que el abuso que previene.
 *   2. Que el token incorrecto no distinga entre "mal token" y "ruta inexistente".
 *   3. Que la comparación no dependa de la longitud del token.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';
import crypto from 'node:crypto';

const mockRunJob = jest.fn(async (name) => ({ ok: true, name, ms: 10, processed: 3 }));
await jest.unstable_mockModule('../../src/jobs/jobRegistry.js', () => ({
  runJob:   mockRunJob,
  jobNames: () => ['reconcile-custodial-accounts', 'refresh-rates'],
}));

const { default: router } = await import('../../src/routes/internalJobsRoutes.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');

const TOKEN = 'a'.repeat(64);

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/internal', router);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTERNAL_JOB_TOKEN = TOKEN;
});

describe('endpoint interno de jobs — el llamador legítimo', () => {

  it('con el token correcto dispara el job', async () => {
    const res = await request(app())
      .post('/api/v1/internal/jobs/refresh-rates')
      .set('X-Internal-Token', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockRunJob).toHaveBeenCalledWith('refresh-rates');
  });

  it('con el token correcto lista los jobs', async () => {
    const res = await request(app())
      .get('/api/v1/internal/jobs')
      .set('X-Internal-Token', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.jobs).toContain('reconcile-custodial-accounts');
  });

  it('un job desconocido con token válido sigue devolviendo su detalle', async () => {
    mockRunJob.mockResolvedValue({ ok: false, name: 'inventado', error: 'unknown_job', known: [] });
    const res = await request(app())
      .post('/api/v1/internal/jobs/inventado')
      .set('X-Internal-Token', TOKEN);

    // 404 igual que el rechazo, pero con cuerpo informativo: quien tiene el token
    // merece saber que escribió mal el nombre.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_job');
  });

  it('un job que falla por dentro NO es un fallo del disparo', async () => {
    mockRunJob.mockResolvedValue({ ok: false, name: 'refresh-rates', ms: 5, error: 'Horizon caído' });
    const res = await request(app())
      .post('/api/v1/internal/jobs/refresh-rates')
      .set('X-Internal-Token', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.error).toBe('Horizon caído');
  });
});

describe('endpoint interno de jobs — rechazos', () => {

  it.each([
    ['sin cabecera',        undefined],
    ['token vacío',         ''],
    ['token incorrecto',    'b'.repeat(64)],
    ['token más corto',     'a'.repeat(32)],
    ['token más largo',     'a'.repeat(128)],
  ])('%s → 404, y el job NO corre', async (_caso, token) => {
    const req = request(app()).post('/api/v1/internal/jobs/refresh-rates');
    if (token !== undefined) req.set('X-Internal-Token', token);
    const res = await req;

    // 404 y no 401: un 401 confirmaría que la ruta existe.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it('las longitudes distintas se rechazan igual que un token del mismo largo', async () => {
    // Antes se comparaba la longitud primero y se salía, lo que metía una rama de
    // tiempo distinta y delataba el largo del token. Ahora ambos lados son SHA-256.
    const corto = await request(app()).post('/api/v1/internal/jobs/refresh-rates')
      .set('X-Internal-Token', 'x');
    const mismo = await request(app()).post('/api/v1/internal/jobs/refresh-rates')
      .set('X-Internal-Token', 'b'.repeat(64));

    expect(corto.status).toBe(mismo.status);
    expect(corto.body).toEqual(mismo.body);
  });

  it('sin INTERNAL_JOB_TOKEN configurado el endpoint queda cerrado', async () => {
    delete process.env.INTERNAL_JOB_TOKEN;

    const res = await request(app())
      .post('/api/v1/internal/jobs/refresh-rates')
      .set('X-Internal-Token', TOKEN);

    // Fail-closed: sin la variable no se abre, se cierra.
    expect(res.status).toBe(404);
    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it('el token se lee en cada petición, no se captura al cargar el módulo', async () => {
    // Regla 21 del CLAUDE.md: los secretos llegan DESPUÉS de importar. Si el valor se
    // hubiera capturado en un const de nivel superior, el endpoint quedaría cerrado
    // para siempre en producción.
    process.env.INTERNAL_JOB_TOKEN = 'c'.repeat(64);

    const res = await request(app())
      .post('/api/v1/internal/jobs/refresh-rates')
      .set('X-Internal-Token', 'c'.repeat(64));

    expect(res.status).toBe(200);
  });
});

describe('comparación del token — propiedades', () => {

  it('el SHA-256 de dos tokens distintos nunca coincide en longitud variable', () => {
    // Deja asentado por qué el hash resuelve el problema: cualquiera sea la entrada,
    // el digest mide 32 bytes, así que timingSafeEqual nunca lanza por longitud.
    for (const v of ['', 'x', 'a'.repeat(1000)]) {
      expect(crypto.createHash('sha256').update(v).digest()).toHaveLength(32);
    }
  });
});
