/**
 * emailSoloProduccion.test.js — el correo solo sale desde producción real.
 *
 * El cupo de SendGrid (plan gratuito, 100/día DURO) es de producción, y staging
 * comparte la misma clave. Medido el 2026-10-22: de 108 correos del día, 38 eran
 * altas de prueba de staging y CERO fueron a un usuario real; ese mismo día el
 * tope bloqueó el aviso a una clienta sobre dinero no entregado, la alerta de esa
 * reversión y una alerta de seguridad.
 *
 * De los dos sentidos que se prueban acá, **el que importa es que producción SIGA
 * enviando**. Una compuerta mal puesta no "falla ruidosamente": deja de mandar
 * correos y nadie se entera hasta que un cliente reclama.
 */
import { jest } from '@jest/globals';

const mockSend = jest.fn().mockResolvedValue([{ statusCode: 202 }]);
await jest.unstable_mockModule('@sendgrid/mail', () => ({
  default: { setApiKey: jest.fn(), send: mockSend },
}));

await jest.unstable_mockModule('../../src/services/sentry.js', () => ({
  default: { captureException: jest.fn(), captureMessage: jest.fn() },
}));

const { sendEmail, sendRawEmail } = await import('../../src/services/email.js');

/** Entorno limpio por prueba: el discriminante se lee DENTRO de la función. */
const entorno = ({ nodeEnv, secretos, forzar }) => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;        else process.env.NODE_ENV = nodeEnv;
  if (secretos === undefined) delete process.env.AWS_SECRETS_NAME; else process.env.AWS_SECRETS_NAME = secretos;
  if (forzar === undefined) delete process.env.EMAIL_FORCE_SEND;   else process.env.EMAIL_FORCE_SEND = forzar;
  process.env.SENDGRID_API_KEY = 'SG.fake';
};

const original = { ...process.env };
beforeEach(() => { jest.clearAllMocks(); });
afterAll(() => { process.env = original; });

describe('producción real SIGUE enviando (el sentido peligroso)', () => {
  it('con NODE_ENV=production y AWS_SECRETS_NAME, envía', async () => {
    // Exactamente lo que tiene el contenedor del VPS, verificado antes de activar
    // la compuerta: AWS_SECRETS_NAME=alyto/production y NODE_ENV=production.
    entorno({ nodeEnv: 'production', secretos: 'alyto/production' });

    await expect(sendEmail('u@x.com', 'd-tpl', {})).resolves.toBe(true);
    await expect(sendRawEmail('admin@x.com', 'asunto', '<p>x</p>')).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('fuera de producción real no sale nada', () => {
  it('staging (NODE_ENV=production SIN secretos) no envía', async () => {
    // Render staging corre NODE_ENV=production a propósito, así que NODE_ENV por
    // sí solo no alcanza como discriminante. La señal es AWS_SECRETS_NAME.
    entorno({ nodeEnv: 'production' });

    await expect(sendEmail('srl_123@test.alyto.io', 'd-tpl', {})).resolves.toBe(false);
    await expect(sendRawEmail('admin@x.com', 'asunto', '<p>x</p>')).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('desarrollo local no envía, aunque tenga AWS_SECRETS_NAME', async () => {
    // El `.env` del repo trae NODE_ENV=development JUNTO A AWS_SECRETS_NAME,
    // porque en local los secretos se leen de AWS. NODE_ENV de desarrollo manda.
    entorno({ nodeEnv: 'development', secretos: 'alyto/production' });

    await expect(sendRawEmail('a@x.com', 's', 'h')).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('tampoco en test', async () => {
    entorno({ nodeEnv: 'test', secretos: 'alyto/production' });
    await expect(sendRawEmail('a@x.com', 's', 'h')).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('la salida de emergencia', () => {
  it('EMAIL_FORCE_SEND=true reactiva el envío en staging', async () => {
    entorno({ nodeEnv: 'production', forzar: 'true' });

    await expect(sendRawEmail('a@x.com', 's', 'h')).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('solo la acepta en "true", no con cualquier valor', async () => {
    // Para que un '0', 'false' o 'no' no abra la compuerta por accidente.
    for (const v of ['false', '0', 'no', '']) {
      jest.clearAllMocks();
      entorno({ nodeEnv: 'production', forzar: v });
      await expect(sendRawEmail('a@x.com', 's', 'h')).resolves.toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    }
  });
});

describe('sin clave de API tampoco envía', () => {
  it('devuelve false y no llama a SendGrid', async () => {
    entorno({ nodeEnv: 'production', secretos: 'alyto/production' });
    delete process.env.SENDGRID_API_KEY;

    await expect(sendEmail('a@x.com', 'd-tpl', {})).resolves.toBe(false);
    await expect(sendRawEmail('a@x.com', 's', 'h')).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
