/**
 * buildInfo.test.js — qué commit corre este proceso.
 *
 * Nace de no haber podido responder esa pregunta el 2026-10-22: `/api/health`
 * devuelve un `version` fijo de `package.json` y el cambio que había que verificar
 * (una compuerta de correo) no era observable por HTTP. La única respuesta
 * disponible era inferir desde tiempos de reinicio.
 *
 * Lo que se fija acá, además de lo obvio, es que **un placeholder no se propague
 * como si fuera un SHA**. Un `commit: "unknown"` o un `"$GIT_COMMIT"` sin expandir
 * es peor que `null`: parece un dato y no lo es.
 */
import { commitSha, commitCorto, buildInfo } from '../../src/utils/buildInfo.js';

const SHA = '2ceff47a1b3c4d5e6f708192a3b4c5d6e7f80912';

const limpiar = () => {
  for (const k of ['GIT_COMMIT', 'RENDER_GIT_COMMIT', 'SOURCE_COMMIT', 'COMMIT_SHA']) {
    delete process.env[k];
  }
};

const original = { ...process.env };
beforeEach(limpiar);
afterAll(() => { process.env = original; });

describe('de dónde sale el SHA', () => {
  it('lo toma de GIT_COMMIT (el del VPS, vía build arg)', () => {
    process.env.GIT_COMMIT = SHA;
    expect(commitSha()).toBe(SHA);
    expect(commitCorto()).toBe('2ceff47');
  });

  it('lo toma de RENDER_GIT_COMMIT, que Render inyecta solo', () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    expect(commitCorto()).toBe('2ceff47');
  });

  it('GIT_COMMIT tiene prioridad sobre el resto', () => {
    process.env.RENDER_GIT_COMMIT = 'aaaaaaaaaa';
    process.env.GIT_COMMIT        = SHA;
    expect(commitSha()).toBe(SHA);
  });

  it('acepta el formato corto de 7 caracteres', () => {
    process.env.GIT_COMMIT = '2ceff47';
    expect(commitSha()).toBe('2ceff47');
    expect(commitCorto()).toBe('2ceff47');
  });

  it('normaliza a minúsculas y tolera espacios', () => {
    process.env.GIT_COMMIT = '  2CEFF47A1B  ';
    expect(commitSha()).toBe('2ceff47a1b');
  });
});

describe('un placeholder NO es un SHA', () => {
  it.each([
    ['sin definir',        undefined],
    ['vacío',              ''],
    ['solo espacios',      '   '],
    ['literal unknown',    'unknown'],
    ['variable sin expandir', '$GIT_COMMIT'],
    ['demasiado corto',    'abc123'],
    ['no es hexadecimal',  'zzzzzzz'],
    ['con sufijo sucio',   '2ceff47-dirty'],
  ])('%s → null, no se propaga', (_, valor) => {
    if (valor !== undefined) process.env.GIT_COMMIT = valor;
    expect(commitSha()).toBeNull();
    expect(commitCorto()).toBeNull();
  });
});

describe('buildInfo — lo que devuelve el endpoint', () => {
  it('informa el commit y distingue el entorno por AWS_SECRETS_NAME', () => {
    // Los dos entornos corren NODE_ENV=production, así que el discriminante útil
    // es el mismo que usa el resto del repo: la presencia de los secretos.
    process.env.GIT_COMMIT = SHA;
    process.env.AWS_SECRETS_NAME = 'alyto/production';

    const i = buildInfo();
    expect(i.commit).toBe(SHA);
    expect(i.commitCorto).toBe('2ceff47');
    expect(i.entorno).toBe('produccion-vps');
    expect(typeof i.arrancado).toBe('string');

    delete process.env.AWS_SECRETS_NAME;
    expect(buildInfo().entorno).toBe('no-produccion');
  });

  it('sin SHA informa null en vez de inventar', () => {
    const i = buildInfo();
    expect(i.commit).toBeNull();
    expect(i.commitCorto).toBeNull();
    expect(i.version).toBeTruthy();   // la versión de package.json sigue estando
  });
});
