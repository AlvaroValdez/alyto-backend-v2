/**
 * authAnomalies.test.js — detectar reconocimiento contra el acceso.
 *
 * El caso que originó esto: 133.223.59.4 hizo 16 intentos fallidos contra ~10
 * cuentas distintas en 31 h, incluida una de admin, y nadie se enteró en 36 horas.
 * Ni el límite por cuenta ni el por IP podían verlo, porque el patrón no es
 * volumen sino DISPERSIÓN:
 *
 *   - por cuenta: rotó entre diez, ninguna racha pasó de 2 (umbral 5)
 *   - por IP:     su ráfaga más densa fueron 5 fallos en 51 s (umbral 5 / 15 min)
 *
 * Lo que se prueba acá es que el patrón disperso se detecta, y —igual de
 * importante— que una multitud detrás de un CGNAT NO se marca, porque bloquear o
 * alarmar por IP sin discriminar es el bug que ya se arregló una vez (PR #36).
 */
import '../setup.env.js';

const { evaluarAnomalias, construirAviso } = await import('../../src/jobs/monitorAuthAnomalies.js');

const U = { minFallos: 10, minCuentas: 3, minInexistentes: 3 };

/** Fila agregada por IP, con los valores sanos por defecto. */
const fila = (over = {}) => ({
  ip: '1.2.3.4', fallos: 0, correos: [], cuentasExistentes: 0,
  inexistentes: 0, adminApuntado: false, agentes: [],
  primero: new Date('2026-10-21T07:44:00Z'), ultimo: new Date('2026-10-22T11:55:00Z'),
  ...over,
});

/** La sonda real, con sus números medidos en producción. */
const LA_SONDA = fila({
  ip: '133.223.59.4',
  fallos: 16,
  correos: ['llctest@alyto.app','dev@alyto.test','test@avfinance.net','admin@alyto.app',
            'test-srl@alyto.app','v.alvaro.r@gmail.com','nonexistent-control-311@invalid.example',
            'testuser@alyto.app','test@alyto.app','admin@avf.com'],
  cuentasExistentes: 3,
  inexistentes: 12,
  adminApuntado: true,
  agentes: ['curl/8.21.0', 'hengsuo-e83-marker/1.0'],
});

describe('el caso real que se nos escapó 36 horas', () => {
  it('marca la sonda, y con las tres señales', () => {
    const [m] = evaluarAnomalias([LA_SONDA], U);

    expect(m.ip).toBe('133.223.59.4');
    expect(m.gravedad).toBe(3);
    expect(m.senales.join(' ')).toMatch(/enumeración/);
    expect(m.senales.join(' ')).toMatch(/rociado/);
    expect(m.senales.join(' ')).toMatch(/ADMIN/);
  });

  it('el aviso lleva lo necesario para decidir y para actuar', () => {
    const aviso = construirAviso('133.223.59.4', { ...LA_SONDA, senales: ['x'] }, 24);

    expect(aviso).toMatch(/133\.223\.59\.4/);
    expect(aviso).toMatch(/hengsuo-e83-marker/);          // el agente delata la herramienta
    expect(aviso).toMatch(/Direcciones inexistentes: 12/);
    expect(aviso).toMatch(/Cuenta admin apuntada:    SÍ/);
    expect(aviso).toMatch(/server_proxy\.conf/);          // el runbook del bloqueo
    expect(aviso).toMatch(/CGNAT/);                       // y la advertencia de no bloquear a ciegas
  });
});

describe('las tres señales, una por una', () => {
  it('enumerar nombres de cuenta alcanza sin volumen', () => {
    // Solo 3 fallos: por debajo del umbral de rociado. Pero las 3 direcciones no
    // existen, y eso una multitud legítima no lo produce.
    const [m] = evaluarAnomalias([fila({ fallos: 3, inexistentes: 3, correos: ['a@x.com','b@x.com','c@x.com'] })], U);
    expect(m.senales).toHaveLength(1);
    expect(m.senales[0]).toMatch(/enumeración/);
  });

  it('el rociado disperso se detecta aunque ninguna cuenta acumule', () => {
    // 12 fallos sobre 6 cuentas existentes = 2 por cuenta. Por cuenta jamás llega
    // al umbral de 5; por IP tampoco, si están repartidos en horas.
    const [m] = evaluarAnomalias([fila({
      fallos: 12, cuentasExistentes: 6,
      correos: ['a@x.com','b@x.com','c@x.com','d@x.com','e@x.com','f@x.com'],
    })], U);
    expect(m.senales).toHaveLength(1);
    expect(m.senales[0]).toMatch(/rociado/);
  });

  it('apuntar a un admin es AGRAVANTE, no disparador', () => {
    // Medido contra producción: como disparador autónomo marcaba la IP del propio
    // dueño equivocándose su contraseña de admin 9 veces en 72 h. Insistir sobre
    // UNA cuenta ya lo frena `failedStreak`; acá solo agrava si hay dispersión.
    expect(evaluarAnomalias([fila({
      fallos: 9, cuentasExistentes: 2, inexistentes: 0,
      correos: ['admin@x.com', 'otra@x.com'], adminApuntado: true,
    })], U)).toEqual([]);

    // Con enumeración de por medio, sí suma la señal.
    const [m] = evaluarAnomalias([fila({ fallos: 4, inexistentes: 3, correos: ['a@x.com','b@x.com','c@x.com'], adminApuntado: true })], U);
    expect(m.senales).toHaveLength(2);
    expect(m.senales[1]).toMatch(/ADMIN/);
  });

  it('ordena de más grave a menos', () => {
    const r = evaluarAnomalias([
      fila({ ip: 'leve', fallos: 4, inexistentes: 3, correos: ['a@x.com','b@x.com','c@x.com'] }),
      LA_SONDA,
    ], U);
    expect(r.map(x => x.ip)).toEqual(['133.223.59.4', 'leve']);
  });
});

describe('lo que NO se marca — el riesgo de alarmar por IP', () => {
  it('una multitud detrás de un CGNAT no se marca', () => {
    // Seis usuarios reales compartiendo IP pública, cada uno equivocándose una vez
    // en SU propia cuenta, que existe. Exactamente el escenario que rompió el
    // limitador antes del PR #36. Hay 6 fallos y 6 cuentas, pero cero inexistentes
    // y no se llega al umbral de fallos.
    expect(evaluarAnomalias([fila({
      fallos: 6, cuentasExistentes: 6, inexistentes: 0,
      correos: ['u1@x.com','u2@x.com','u3@x.com','u4@x.com','u5@x.com','u6@x.com'],
      agentes: ['Mozilla/5.0 (Linux; Android 12; SM-A217M)'],
    })], U)).toEqual([]);
  });

  it('un usuario olvidadizo en su propia cuenta no se marca', () => {
    // 20 fallos, pero todos en UNA cuenta: eso ya lo cubre `failedStreak`, que lo
    // bloquea a los 5. Marcarlo acá sería ruido duplicado.
    expect(evaluarAnomalias([fila({
      fallos: 20, cuentasExistentes: 1, inexistentes: 0, correos: ['olvidadizo@x.com'],
    })], U)).toEqual([]);
  });

  it('filas sin IP se ignoran en vez de reventar', () => {
    expect(evaluarAnomalias([fila({ ip: null, fallos: 99, inexistentes: 99 }), null], U)).toEqual([]);
  });

  it('sin filas no marca nada', () => {
    expect(evaluarAnomalias([], U)).toEqual([]);
    expect(evaluarAnomalias(undefined, U)).toEqual([]);
  });
});

describe('umbrales configurables', () => {
  it('bajarlos marca lo que antes pasaba', () => {
    const limpio = fila({ fallos: 6, cuentasExistentes: 6, inexistentes: 0,
      correos: ['a@x.com','b@x.com','c@x.com','d@x.com','e@x.com','f@x.com'] });

    expect(evaluarAnomalias([limpio], U)).toEqual([]);
    expect(evaluarAnomalias([limpio], { ...U, minFallos: 5 })[0].senales[0]).toMatch(/rociado/);
  });
});
