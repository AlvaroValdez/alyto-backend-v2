/**
 * kycRetryNudge.test.js — A quién se le escribe y, sobre todo, a quién no.
 *
 * Un aviso automático mal acotado es correo basura enviado desde el dominio de la
 * empresa. Lo que se protege acá es el criterio de exclusión, que es la parte que
 * falla en silencio: si sobra gente, nadie lo nota hasta que alguien se queja; y
 * si SendGrid se queda sin cuota —plan gratuito, tope duro de 100 diarios— deja de
 * salir TODO el correo transaccional, confirmaciones de pago incluidas.
 */
import '../setup.env.js';
import { evaluarUsuario } from '../../src/jobs/kycRetryNudge.js';

const AHORA = new Date('2026-10-03T12:00:00Z').getTime();
const hace  = (horas) => new Date(AHORA - horas * 3600_000);

const CFG = {
  habilitado: true,
  maxAvisos: 2,
  graciaMs: 2 * 3600_000,
  maxPorCorrida: 25,
  dominiosExcluidos: ['avfinance.net', 'avfinance.com', 'alyto.app'],
};

/** Usuario real que se quedó a medias: el caso que motivó todo esto. */
function base(over = {}) {
  return {
    email:         'usuario@gmail.com',
    firstName:     'Denzel',
    kycStatus:     'pending',
    emailVerified: true,
    isActive:      true,
    deletedAt:     null,
    stripeVerificationSessionId: 'vs_fallida',
    kycNudge:      { sentAt: null, count: 0, sessionId: null },
    createdAt:     hace(48),
    ...over,
  };
}

const evaluar = (u, ultimoIntentoAt = null) =>
  evaluarUsuario(u, { ahora: AHORA, cfg: CFG, ultimoIntentoAt });

describe('a quién sí se le avisa', () => {

  it('al que lanzó la biometría y no terminó → variante "interrumpida"', () => {
    const r = evaluar(base());
    expect(r.avisar).toBe(true);
    expect(r.variante).toBe('interrumpida');
  });

  it('al que se registró y nunca la abrió → variante "sin_iniciar"', () => {
    const r = evaluar(base({ stripeVerificationSessionId: null }));
    expect(r.avisar).toBe(true);
    // Decirle "vuelve a intentarlo" a quien nunca empezó no significa nada.
    expect(r.variante).toBe('sin_iniciar');
  });

  it('al que volvió a intentar y volvió a quedarse a medias, aunque ya tuviera un aviso', () => {
    const r = evaluar(base({
      stripeVerificationSessionId: 'vs_segunda',
      kycNudge: { sentAt: hace(20), count: 1, sessionId: 'vs_primera' },
    }));
    // Hay un intento NUEVO: el aviso aporta información, no insiste.
    expect(r.avisar).toBe(true);
  });
});

describe('a quién NO se le avisa', () => {

  it.each([
    ['ya verificado',          { kycStatus: 'approved' },  'estado_no_pendiente'],
    ['sin email verificado',   { emailVerified: false },   'email_sin_verificar'],
    ['cuenta desactivada',     { isActive: false },        'cuenta_inactiva'],
    ['cuenta borrada',         { deletedAt: hace(5) },     'cuenta_borrada'],
  ])('%s', (_caso, over, motivo) => {
    const r = evaluar(base(over));
    expect(r.avisar).toBe(false);
    expect(r.motivo).toBe(motivo);
  });

  it('cuentas internas y de prueba: comparten estado con un usuario real', () => {
    for (const email of ['admin@alyto.app', 'test2@avfinance.net', 'admin@avfinance.com']) {
      const r = evaluar(base({ email }));
      expect(r.avisar).toBe(false);
      expect(r.motivo).toBe('dominio_interno');
    }
  });

  it('quien está verificando ahora mismo: dentro del periodo de gracia', () => {
    const r = evaluar(base(), hace(0.5));   // intentó hace media hora
    expect(r.avisar).toBe(false);
    expect(r.motivo).toBe('dentro_de_gracia');
  });

  it('recién registrado sin sesión: la gracia corre desde el alta', () => {
    const r = evaluar(base({ stripeVerificationSessionId: null, createdAt: hace(1) }));
    expect(r.avisar).toBe(false);
    expect(r.motivo).toBe('dentro_de_gracia');
  });

  it('una escritura reciente ajena al intento NO mete al usuario en la gracia', () => {
    // Regresión: antes la referencia era `user.updatedAt`, así que el propio
    // barrido que devuelve al usuario a 'pending' le reseteaba el reloj y lo
    // dejaba sin aviso justo a él, que es a quien hay que avisar.
    const r = evaluar(base({ createdAt: hace(500) }), null);
    expect(r.avisar).toBe(true);
    expect(r.variante).toBe('interrumpida');
  });

  it('ya avisado y sin ningún intento nuevo: insistir no informa, molesta', () => {
    const r = evaluar(base({
      stripeVerificationSessionId: 'vs_fallida',
      kycNudge: { sentAt: hace(20), count: 1, sessionId: 'vs_fallida' },
    }));
    expect(r.avisar).toBe(false);
    expect(r.motivo).toBe('ya_avisado_sin_intento_nuevo');
  });

  it('quien nunca empezó y ya recibió su aviso: el paso del tiempo no lo repite', () => {
    const r = evaluar(base({
      stripeVerificationSessionId: null,
      kycNudge: { sentAt: hace(200), count: 1, sessionId: null },
    }));
    expect(r.avisar).toBe(false);
    expect(r.motivo).toBe('ya_avisado_sin_intento_nuevo');
  });

  it('tope duro de avisos: después de dos, no se insiste ni con intentos nuevos', () => {
    const r = evaluar(base({
      stripeVerificationSessionId: 'vs_tercera',
      kycNudge: { sentAt: hace(30), count: 2, sessionId: 'vs_segunda' },
    }));
    expect(r.avisar).toBe(false);
    expect(r.motivo).toBe('tope_de_avisos');
  });
});
