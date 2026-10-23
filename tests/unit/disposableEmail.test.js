/**
 * disposableEmail.test.js — a qué direcciones no vale la pena escribirles.
 *
 * El cupo de SendGrid es de 100/día DURO. Una sonda se da de alta en producción a
 * ~1 por hora y cada alta dispara tres correos, así que el 2026-10-22 el cupo
 * quedó en 108/100 con UN solo correo de usuario real ese día. Bloquear la IP no
 * alcanzó: rotó de 133.223.59.4 a 32.196.243.11 en horas.
 *
 * Lo que más se cuida acá es **no bloquear a un usuario real**. Un falso positivo
 * no es ruido: es una persona que no recibe su código de verificación y no puede
 * entrar, y nadie se enteraría porque el correo "se envió" sin error.
 */
import { esCorreoDescartable, dominiosDescartables } from '../../src/utils/disposableEmail.js';

const original = { ...process.env };
beforeEach(() => { delete process.env.DISPOSABLE_EMAIL_DOMAINS; });
afterAll(() => { process.env = original; });

describe('las direcciones reales del sondeo', () => {
  it.each([
    // Interactsh, con subdominio generado — el caso que motivó el matcheo por etiquetas
    'hs-e400-1792714001@dbda9pups0ls6845t40g3t8z74mxrxij6.oast.online',
    'hs-e401-1792714021@example.com',
    'hs-e432-1792715068@example.com',
    'srl_1792535526878@test.alyto.io',
    'hs-e253-1792633931@maildrop.cc',
    'hs-e253-1792634813@mailinator.com',
    '1e0319f2-8627-4e05-8235-c4bd36523c6b@emailhook.site',
    'dev@alyto.test',                                    // TLD .test, reservado por RFC 6761
    'nonexistent-control-311@invalid.example',           // doble reservado
    'hs-e83-1792607885@maxxspace.com',
    'hs-e12c-1792569331@westcast-systems.com',
  ])('descarta %s', (dir) => {
    expect(esCorreoDescartable(dir)).toBe(true);
  });
});

describe('los usuarios reales NO se bloquean', () => {
  it.each([
    // Todos salen de la base de producción: son las cuentas que de verdad operan.
    'danielaefloresdiaz@gmail.com',
    'v.alvaro.r@gmail.com',
    'arvaldez@avfinance.net',
    'denzelcampos41@gmail.com',
    'gmamaniv@fcpn.edu.bo',
    'isbel.flores.v@gmail.com',
    'admin@alyto.app',
    'eblancochuquimia@gmail.com',
  ])('deja pasar %s', (dir) => {
    expect(esCorreoDescartable(dir)).toBe(false);
  });

  it('no se engaña con un dominio que TERMINA parecido', () => {
    // Un `endsWith` pelado daría falso positivo acá. Por eso se compara por
    // etiquetas completas: 'notoast.online' no es un subdominio de 'oast.online'.
    expect(esCorreoDescartable('alguien@notoast.online')).toBe(false);
    expect(esCorreoDescartable('alguien@myexample.com')).toBe(false);
    expect(esCorreoDescartable('alguien@mailinator.com.bo')).toBe(false);
  });

  it('un gmail con etiqueta +algo sigue siendo válido', () => {
    // La sonda usó 'combtmp+9gm31@gmail.com', pero bloquear etiquetas '+' rompería
    // a cualquiera que las use legítimamente. No se filtra por eso.
    expect(esCorreoDescartable('combtmp+9gm31@gmail.com')).toBe(false);
  });
});

describe('subdominios y forma', () => {
  it('casa el dominio y todos sus padres', () => {
    expect(esCorreoDescartable('a@oast.online')).toBe(true);
    expect(esCorreoDescartable('a@x.oast.online')).toBe(true);
    expect(esCorreoDescartable('a@x.y.z.oast.online')).toBe(true);
  });

  it('es indiferente a mayúsculas y espacios', () => {
    expect(esCorreoDescartable('  A@EXAMPLE.COM  ')).toBe(true);
  });

  it.each([
    ['vacío',        ''],
    ['nulo',         null],
    ['sin arroba',   'nodominio'],
    ['sin dominio',  'algo@'],
    ['solo arroba',  '@example.com'],
  ])('%s → false, que lo rechace la validación normal', (_, v) => {
    expect(esCorreoDescartable(v)).toBe(false);
  });
});

describe('ampliable sin desplegar', () => {
  it('DISPOSABLE_EMAIL_DOMAINS suma dominios', () => {
    expect(esCorreoDescartable('a@nuevo-del-sondeo.io')).toBe(false);

    process.env.DISPOSABLE_EMAIL_DOMAINS = ' nuevo-del-sondeo.io , otro.tld ';
    expect(esCorreoDescartable('a@nuevo-del-sondeo.io')).toBe(true);
    expect(esCorreoDescartable('a@sub.otro.tld')).toBe(true);
    expect(esCorreoDescartable('a@gmail.com')).toBe(false);   // y no afecta al resto
  });

  it('expone las listas activas para diagnóstico', () => {
    process.env.DISPOSABLE_EMAIL_DOMAINS = 'x.io';
    const d = dominiosDescartables();
    expect(d.tldReservados).toContain('test');
    expect(d.nuncaEntregables).toContain('oast.online');
    expect(d.observadosEnSondeo).toContain('maxxspace.com');
    expect(d.extrasPorEntorno).toEqual(['x.io']);
  });
});
