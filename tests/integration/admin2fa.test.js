/**
 * admin2fa.test.js (integración) — Ciclo completo del segundo factor.
 *
 * Mismo conjunto que tests/unit/admin2fa.test.js; aquí lo que exige base de
 * datos y servidor: que la sesión NO se emita sin el código, que el contador de
 * bloqueo sea el mismo del punto de contraseña, que un código no valga dos veces,
 * que el restablecimiento exija motivo y quede asentado, y que el secreto no
 * aparezca en claro ni en la base ni en las bitácoras.
 *
 * Cubre el Art. 2° inc. c, Sec. 4 del Reglamento para ETF, y el apdo. 7.4.2 en la
 * parte del restablecimiento.
 */

import '../setup.env.js';

// La clave de datos tiene que estar disponible ANTES de importar el servidor: el
// alta falla cerrado si no puede cifrar el secreto, que es el comportamiento
// deseado en producción y aquí hay que satisfacerlo, no eludirlo.
process.env.PII_KMS_FALLBACK = 'true';
process.env.PII_FALLBACK_KEY = 'test-fallback-key-1234567890';
process.env.ADMIN_2FA_ENABLED = 'true';

import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

const { default: app }           = await import('../../src/server.js');
const { default: request }       = await import('supertest');
const { default: bcrypt }        = await import('bcryptjs');
const { default: mongoose }      = await import('mongoose');
const { default: User }          = await import('../../src/models/User.js');
const { default: AccessLog }     = await import('../../src/models/AccessLog.js');
const { default: AdminAuditLog } = await import('../../src/models/AdminAuditLog.js');
const { generateTotp, timeStep, TOTP_STEP_SECONDS } = await import('../../src/utils/totp.js');
const { decryptField, aadForTotpSecret, ensureDek } = await import('../../src/services/piiCrypto.js');
const { maxFailedAttempts } = await import('../../src/services/accessLogService.js');

const PASSWORD = 'ContrasenaDePrueba123';
const MOTIVO   = 'Teléfono extraviado, reportado por el operador el 22/08/2026';

const ORIGINAL_FLAG = process.env.ADMIN_2FA_ENABLED;

beforeAll(async () => {
  await connectTestDb();
  await ensureDek();
});

afterEach(async () => {
  process.env.ADMIN_2FA_ENABLED = ORIGINAL_FLAG;
  await clearCollections();
});

afterAll(async () => { await disconnectTestDb(); });

// ─── Utilidades ───────────────────────────────────────────────────────────────

let seq = 0;

async function crearAdmin(overrides = {}) {
  return User.create({
    firstName: 'Admin', lastName: 'Prueba',
    email: `admin2fa_${++seq}_${Date.now()}@test.alyto.io`,
    password: await bcrypt.hash(PASSWORD, 10),
    role: 'admin', legalEntity: 'LLC', kycStatus: 'approved',
    residenceCountry: 'US', isActive: true,
    identityDocument: { type: 'passport', number: 'TEST123456', issuingCountry: 'US' },
    ...overrides,
  });
}

const login = (email, password = PASSWORD) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

const post2fa = (ruta, challengeToken, body = {}) =>
  request(app).post(`/api/v1/auth/2fa/${ruta}`)
    .set('Authorization', `Bearer ${challengeToken}`)
    .send(body);

/** Lee el secreto real de la base descifrándolo, para poder calcular códigos. */
async function secretoDe(userId) {
  const u = await User.findById(userId).select('+twoFactor.secretCiphertext').lean();
  return decryptField(u.twoFactor.secretCiphertext, aadForTotpSecret(userId));
}

/**
 * Código del paso SIGUIENTE. El del paso actual quedó consumido al confirmar el
 * alta —así funciona la prevención de reutilización—, de modo que un acceso
 * inmediatamente posterior necesita el siguiente, que sigue dentro de la
 * tolerancia. En uso real la persona tarda más de 30 s y no lo nota.
 */
const codigoSiguiente = secreto => generateTotp(secreto, { step: timeStep() + 1 });

/** Deja a una cuenta con el segundo factor confirmado y devuelve su secreto. */
async function darDeAlta(user) {
  const { body: l } = await login(user.email);
  await post2fa('enroll', l.challengeToken);
  const secreto = await secretoDe(user._id);
  const res = await post2fa('confirm', l.challengeToken, { code: generateTotp(secreto) });
  return { secreto, recoveryCodes: res.body.recoveryCodes, session: res.body.token };
}

// ─── La sesión no se emite sin el segundo factor ──────────────────────────────

describe('login de una cuenta con privilegios', () => {

  test('credencial correcta y sin segundo factor NO obtiene sesión', async () => {
    // Es el criterio de aceptación que hay que poder acreditar con un intento real.
    const admin = await crearAdmin();
    const res   = await login(admin.email);

    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBe(true);
    expect(res.body.enrollmentRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.challengeToken).toBeTruthy();
  });

  test('la credencial intermedia NO sirve como sesión en una ruta protegida', async () => {
    // Si `protect()` la aceptara, todo lo demás sería decorativo.
    const admin = await crearAdmin();
    const { body } = await login(admin.email);

    const res = await request(app).get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.challengeToken}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_FACTOR_REQUIRED');
  });

  test('tampoco abre el panel de administración', async () => {
    const admin = await crearAdmin();
    const { body } = await login(admin.email);

    const res = await request(app).get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${body.challengeToken}`);

    expect(res.status).toBe(401);
  });

  test('ningún verificador de credenciales del proyecto la acepta', async () => {
    // La credencial intermedia lleva el mismo `id` y la misma versión que una
    // sesión: lo único que la distingue es la marca de propósito. Un verificador
    // que no la mire concedería todo lo que protege con la contraseña sola —el
    // control eludido por la puerta de al lado. Esta prueba recorre los tres
    // verificadores del proyecto para que agregar un cuarto sin la comprobación
    // se note aquí.
    const admin = await crearAdmin();
    const { body } = await login(admin.email);
    const cabecera = { Authorization: `Bearer ${body.challengeToken}` };

    const protegidas = [
      request(app).get('/api/v1/auth/me').set(cabecera),                  // protect()
      request(app).get('/api/v1/admin/users').set(cabecera),              // protect() + checkAdmin()
      request(app).get('/api/v1/stellar/customer').set(cabecera),         // sep10Protect()
    ];

    for (const res of await Promise.all(protegidas)) {
      expect(res.status).toBe(401);
    }
  });

  test('el consumidor financiero conserva su login de un solo paso', async () => {
    // Restricción explícita: desarrollo aditivo, sin tocar la autenticación del
    // consumidor. Con la bandera encendida, un usuario normal entra igual que antes.
    const user = await User.create({
      firstName: 'Ana', lastName: 'Quispe',
      email: `user_${++seq}_${Date.now()}@test.alyto.io`,
      password: await bcrypt.hash(PASSWORD, 10),
      role: 'user', legalEntity: 'SRL', kycStatus: 'approved',
      residenceCountry: 'BO', isActive: true,
      identityDocument: { type: 'ci_bolivia', number: '7654321', issuingCountry: 'BO' },
    });

    const res = await login(user.email);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
  });

  test('con la bandera apagada, el administrador entra en un paso', async () => {
    process.env.ADMIN_2FA_ENABLED = 'false';
    const admin = await crearAdmin();

    const res = await login(admin.email);

    expect(res.body.token).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
  });

  test('el primer factor válido queda asentado como pendiente, no como acceso', async () => {
    const admin = await crearAdmin();
    await login(admin.email);

    const asiento = await AccessLog.findOne({ userId: admin._id }).lean();
    expect(asiento.outcome).toBe('pending_2fa');
    expect(asiento.factor).toBe('password');
    expect(asiento.reason).toBe('totp_not_enrolled');
    expect(asiento.role).toBe('admin');
    expect(asiento.ip).toBeTruthy();
    expect(await AccessLog.countDocuments({ outcome: 'success' })).toBe(0);
  });
});

// ─── Alta ─────────────────────────────────────────────────────────────────────

describe('alta del segundo factor', () => {

  test('el alta entrega QR y cadena manual, pero no activa nada', async () => {
    const admin = await crearAdmin();
    const { body: l } = await login(admin.email);

    const res = await post2fa('enroll', l.challengeToken);

    expect(res.status).toBe(200);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(res.body.manualEntry).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4})+$/);
    expect(res.body.policy).toMatchObject({ digits: 6, stepSeconds: 30, window: 1 });

    const guardado = await User.findById(admin._id).lean();
    expect(guardado.twoFactor.enabled).toBe(false);
    expect(guardado.twoFactor.confirmedAt).toBeNull();
  });

  test('un código válido con el factor SIN confirmar no concede acceso', async () => {
    // El enunciado lo pide explícitamente: hay secreto y el código es correcto,
    // pero el alta nunca se confirmó. Sin esto, una interrupción a mitad del alta
    // dejaría un factor a medias que igual abre la puerta.
    const admin = await crearAdmin();
    const { body: l } = await login(admin.email);
    await post2fa('enroll', l.challengeToken);
    const secreto = await secretoDe(admin._id);

    const res = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });

    // Respuesta genérica: los tres motivos de rechazo del segundo factor
    // —código inválido, código ya consumido y factor no configurado— se
    // responden igual, para no revelar el estado del factor de una cuenta.
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
    expect(res.body.token).toBeUndefined();

    const asiento = await AccessLog.findOne({ reason: 'totp_not_enrolled', factor: 'totp' }).lean();
    expect(asiento).toBeTruthy();
  });

  test('confirmar con un código válido activa el factor y entrega los códigos de recuperación', async () => {
    const admin = await crearAdmin();
    const { body: l } = await login(admin.email);
    await post2fa('enroll', l.challengeToken);
    const secreto = await secretoDe(admin._id);

    const res = await post2fa('confirm', l.challengeToken, { code: generateTotp(secreto) });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const guardado = await User.findById(admin._id).lean();
    expect(guardado.twoFactor.enabled).toBe(true);
    expect(guardado.twoFactor.confirmedAt).toBeInstanceOf(Date);
  });

  test('confirmar con un código incorrecto no activa nada', async () => {
    const admin = await crearAdmin();
    const { body: l } = await login(admin.email);
    await post2fa('enroll', l.challengeToken);

    const res = await post2fa('confirm', l.challengeToken, { code: '000000' });

    expect(res.status).toBe(401);
    expect((await User.findById(admin._id).lean()).twoFactor.enabled).toBe(false);
  });

  test('el alta deja asiento en la bitácora, venga del panel o de la consola', async () => {
    // El asiento vivía en el controlador, así que las altas por consola —las
    // primeras de la entidad, hechas durante el despliegue— no dejaban ninguno.
    // La declaración "toda incorporación de un autenticador es detectable" era
    // falsa para el único camino disponible antes de tener interfaz. Se prueban
    // los DOS caminos: un asiento que existe según por dónde entró la petición
    // no sirve como evidencia, porque basta usar el otro para no aparecer.
    const { confirmEnrollment, beginEnrollment } =
      await import('../../src/services/adminTwoFactorService.js');

    // ── Camino web ──────────────────────────────────────────────────────────
    const porPanel = await crearAdmin();
    await darDeAlta(porPanel);

    const asientoPanel = await AdminAuditLog.findOne({
      action: 'admin_2fa.enrolled', targetId: String(porPanel._id),
    }).lean();
    expect(asientoPanel).toBeTruthy();
    expect(asientoPanel.actorEmail).toBe(porPanel.email);
    expect(asientoPanel.after.enabled).toBe(true);
    expect(asientoPanel.metadata.via).toBe('panel');

    // ── Camino consola: se invoca el servicio directo, sin request ──────────
    const porConsola = await crearAdmin();
    const { secret } = await beginEnrollment({ userId: porConsola._id });
    const res = await confirmEnrollment({ userId: porConsola._id, code: generateTotp(secret) });
    expect(res.ok).toBe(true);

    const asientoConsola = await AdminAuditLog.findOne({
      action: 'admin_2fa.enrolled', targetId: String(porConsola._id),
    }).lean();
    expect(asientoConsola).toBeTruthy();
    expect(asientoConsola.actorEmail).toBe(porConsola.email);
    expect(asientoConsola.metadata.via).toBe('cli');
    expect(asientoConsola.createdAt).toBeInstanceOf(Date);
  });

  test('una cuenta ya confirmada no puede rehacerse el alta por esta vía', async () => {
    // Si pudiera, el restablecimiento con motivo del apdo. 7.4.2 tendría un
    // camino paralelo que no deja registro.
    const admin = await crearAdmin();
    await darDeAlta(admin);
    const { body: l } = await login(admin.email);

    const res = await post2fa('enroll', l.challengeToken);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ENROLLED');
  });
});

// ─── Verificación: ventana y reutilización ────────────────────────────────────

describe('verificación del código', () => {

  test('código válido dentro de la ventana: acceso concedido', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);

    const res = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('admin');
  });

  test('la sesión emitida SÍ abre el panel de administración', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);
    const { body: v } = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });

    const res = await request(app).get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${v.token}`);

    expect(res.status).toBe(200);
  });

  test('código de una ventana FUERA del rango de tolerancia: rechazado', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);

    const dosPasosAtras = generateTotp(secreto, { step: timeStep() - 2 });
    const res = await post2fa('verify', l.challengeToken, { code: dosPasosAtras });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(await AccessLog.findOne({ reason: 'totp_invalid' }).lean()).toBeTruthy();
  });

  test('código ya consumido dentro de su ventana: rechazado', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const codigo = codigoSiguiente(secreto);

    const primera = await login(admin.email);
    const uno = await post2fa('verify', primera.body.challengeToken, { code: codigo });
    expect(uno.status).toBe(200);

    // El mismo código, todavía vigente, en un intento nuevo.
    const segunda = await login(admin.email);
    const dos = await post2fa('verify', segunda.body.challengeToken, { code: codigo });

    expect(dos.status).toBe(401);
    expect(dos.body.token).toBeUndefined();
    expect(await AccessLog.findOne({ reason: 'totp_replayed' }).lean()).toBeTruthy();
  });

  test('tampoco se puede retroceder a un código anterior ya superado', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);

    // Se consume el código del paso actual…
    const a = await login(admin.email);
    await post2fa('verify', a.body.challengeToken, { code: generateTotp(secreto) });

    // …y se intenta con el del paso anterior, que sigue dentro de la tolerancia.
    const b = await login(admin.email);
    const res = await post2fa('verify', b.body.challengeToken, {
      code: generateTotp(secreto, { step: timeStep() - 1 }),
    });

    expect(res.status).toBe(401);
  });

  test('el asiento del segundo factor lleva los mismos campos que el de contraseña', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);
    await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });

    const asiento = await AccessLog.findOne({ outcome: 'success', factor: 'totp' }).lean();
    expect(asiento).toMatchObject({
      email:   admin.email,
      outcome: 'success',
      factor:  'totp',
      role:    'admin',
    });
    expect(asiento.userId.toString()).toBe(String(admin._id));
    expect(asiento.ip).toBeTruthy();
    expect(asiento.createdAt).toBeInstanceOf(Date);
    expect(asiento.failedStreak).toBe(0);
  });
});

// ─── Bloqueo: ni de menos ni de más ───────────────────────────────────────────

describe('intentos fallidos y bloqueo', () => {
  const UMBRAL = maxFailedAttempts();

  test(`no bloquea antes del umbral (${UMBRAL}), y bloquea exactamente al alcanzarlo`, async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);

    // Un fallo menos que el umbral: la cuenta sigue habilitada.
    for (let i = 0; i < UMBRAL - 1; i++) {
      const { body: l } = await login(admin.email);
      await post2fa('verify', l.challengeToken, { code: '000000' });
    }
    expect((await User.findById(admin._id).lean()).lockedUntil).toBeNull();

    // El código BUENO todavía funciona: no bloqueó de más.
    const bueno = await login(admin.email);
    const ok = await post2fa('verify', bueno.body.challengeToken, { code: codigoSiguiente(secreto) });
    expect(ok.status).toBe(200);
    expect((await User.findById(admin._id).lean()).failedLoginAttempts).toBe(0);

    // Ahora sí, hasta el umbral.
    for (let i = 0; i < UMBRAL; i++) {
      const { body: l } = await login(admin.email);
      await post2fa('verify', l.challengeToken, { code: '000000' });
    }
    const bloqueado = await User.findById(admin._id).lean();
    expect(bloqueado.lockedUntil).toBeInstanceOf(Date);
    expect(bloqueado.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  test('los intentos SIMULTÁNEOS también cuentan: la racha no se pierde por concurrencia', async () => {
    // El caso que de verdad importa aquí. Quien ataca el segundo factor ya tiene
    // la contraseña —es la premisa del control— y la comprobación de un código es
    // barata, así que puede lanzar los intentos en paralelo. Con el contador
    // leído del documento cargado al principio del request, N peticiones
    // simultáneas leían la misma racha y escribían todas el mismo valor: el
    // contador avanzaba UNO y el bloqueo no llegaba nunca. Con el incremento
    // atómico, los N cuentan.
    const admin = await crearAdmin();
    await darDeAlta(admin);

    const desafios = [];
    for (let i = 0; i < UMBRAL; i++) {
      const { body } = await login(admin.email);
      desafios.push(body.challengeToken);
    }

    await Promise.all(desafios.map(t => post2fa('verify', t, { code: '000000' })));

    const despues = await User.findById(admin._id).lean();
    expect(despues.failedLoginAttempts).toBe(UMBRAL);
    expect(despues.lockedUntil).toBeInstanceOf(Date);
    expect(despues.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  test('estando bloqueada, el login ni siquiera entrega credencial intermedia', async () => {
    // El bloqueo actúa un paso antes: sin credencial intermedia no se llega al
    // punto del segundo factor. Es la misma respuesta genérica de siempre, para
    // no revelar el estado de la cuenta a quien está probando.
    const admin = await crearAdmin();
    await darDeAlta(admin);

    for (let i = 0; i < UMBRAL; i++) {
      const { body: l } = await login(admin.email);
      await post2fa('verify', l.challengeToken, { code: '000000' });
    }

    const res = await login(admin.email);

    expect(res.status).toBe(401);
    expect(res.body.challengeToken).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    expect(await AccessLog.findOne({ outcome: 'blocked', factor: 'password' }).lean()).toBeTruthy();
  });

  test('una credencial intermedia emitida ANTES del bloqueo deja de servir', async () => {
    // El caso que importa de verdad: el operador pasó la contraseña y, mientras
    // buscaba el teléfono, otro origen agotó los intentos contra su cuenta. Si el
    // punto del segundo factor no comprobara el bloqueo por su cuenta, ese
    // intento a medio camino seguiría siendo una puerta abierta.
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);

    const { body: enCurso } = await login(admin.email);
    expect(enCurso.challengeToken).toBeTruthy();

    for (let i = 0; i < UMBRAL; i++) {
      await login(admin.email, 'contrasena-equivocada');
    }
    expect((await User.findById(admin._id).lean()).lockedUntil).toBeInstanceOf(Date);

    const res = await post2fa('verify', enCurso.challengeToken, { code: codigoSiguiente(secreto) });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOCKED_OUT');
    expect(res.body.token).toBeUndefined();
    expect(await AccessLog.findOne({ outcome: 'blocked', factor: 'totp' }).lean()).toBeTruthy();
  });

  test('el contador es el MISMO que el de contraseña: los fallos se suman entre ambos puntos', async () => {
    // Si el segundo factor llevara contador propio, se podrían gastar el umbral
    // completo en cada punto — el doble de intentos que la política declarada.
    const admin = await crearAdmin();
    await darDeAlta(admin);

    // Un fallo de contraseña…
    await login(admin.email, 'contrasena-equivocada');
    expect((await User.findById(admin._id).lean()).failedLoginAttempts).toBe(1);

    // …y uno de código: la racha continúa, no arranca de cero.
    const { body: l } = await login(admin.email);
    await post2fa('verify', l.challengeToken, { code: '000000' });
    expect((await User.findById(admin._id).lean()).failedLoginAttempts).toBe(2);
  });
});

// ─── Códigos de recuperación ──────────────────────────────────────────────────

describe('códigos de recuperación', () => {

  test('uno funciona la primera vez y falla la segunda', async () => {
    const admin = await crearAdmin();
    const { recoveryCodes } = await darDeAlta(admin);
    const codigo = recoveryCodes[0];

    const a = await login(admin.email);
    const primera = await post2fa('verify', a.body.challengeToken, { recoveryCode: codigo });
    expect(primera.status).toBe(200);
    expect(primera.body.token).toBeTruthy();
    expect(primera.body.recoveryRemaining).toBe(9);

    const b = await login(admin.email);
    const segunda = await post2fa('verify', b.body.challengeToken, { recoveryCode: codigo });
    expect(segunda.status).toBe(401);
    expect(segunda.body.token).toBeUndefined();
  });

  test('el consumo queda asentado en la bitácora de acciones administrativas', async () => {
    const admin = await crearAdmin();
    const { recoveryCodes } = await darDeAlta(admin);

    const { body: l } = await login(admin.email);
    await post2fa('verify', l.challengeToken, { recoveryCode: recoveryCodes[1] });

    const log = await AdminAuditLog.findOne({ action: 'admin_2fa.recovery_code_used' }).lean();
    expect(log).toBeTruthy();
    expect(String(log.actorId)).toBe(String(admin._id));
    expect(log.actorEmail).toBe(admin.email);
    expect(log.targetId).toBe(String(admin._id));
    expect(log.after.recoveryRemaining).toBe(9);
  });

  test('los otros códigos siguen sirviendo, y se acepta el formato tecleado a mano', async () => {
    const admin = await crearAdmin();
    const { recoveryCodes } = await darDeAlta(admin);

    const a = await login(admin.email);
    await post2fa('verify', a.body.challengeToken, { recoveryCode: recoveryCodes[0] });

    const b = await login(admin.email);
    const res = await post2fa('verify', b.body.challengeToken, {
      recoveryCode: ` ${recoveryCodes[1].toLowerCase().replace('-', '')} `,
    });

    expect(res.status).toBe(200);
    expect(res.body.recoveryRemaining).toBe(8);
  });

  test('un código inventado no vale', async () => {
    const admin = await crearAdmin();
    await darDeAlta(admin);

    const { body: l } = await login(admin.email);
    const res = await post2fa('verify', l.challengeToken, { recoveryCode: 'AAAAA-BBBBB' });

    expect(res.status).toBe(401);
    expect(await AccessLog.findOne({ reason: 'recovery_invalid' }).lean()).toBeTruthy();
  });

  test('se guardan hasheados: la base no contiene el código en claro', async () => {
    const admin = await crearAdmin();
    const { recoveryCodes } = await darDeAlta(admin);

    const guardado = await User.findById(admin._id).select('+twoFactor.recoveryCodes').lean();
    const serializado = JSON.stringify(guardado.twoFactor.recoveryCodes);

    for (const codigo of recoveryCodes) {
      expect(serializado).not.toContain(codigo);
      expect(serializado).not.toContain(codigo.replace('-', ''));
    }
    expect(guardado.twoFactor.recoveryCodes[0].hash).toMatch(/^\$2[aby]\$/);   // bcrypt
  });
});

// ─── Restablecimiento (apdo. 7.4.2) ───────────────────────────────────────────

describe('restablecimiento administrativo', () => {

  /** Devuelve una sesión de administrador con segundo factor acreditado. */
  async function sesionAdmin() {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);
    const { body: v } = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });
    return { admin, token: v.token };
  }

  const reset = (token, userId, body) => request(app)
    .post(`/api/v1/admin/users/${userId}/2fa/reset`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  test('sin motivo: rechazado, y el factor del objetivo queda intacto', async () => {
    const { token } = await sesionAdmin();
    const objetivo = await crearAdmin();
    await darDeAlta(objetivo);

    const res = await reset(token, objetivo._id, {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect((await User.findById(objetivo._id).lean()).twoFactor.enabled).toBe(true);
    expect(await AdminAuditLog.countDocuments({ action: 'admin_2fa.reset' })).toBe(0);
  });

  test('un motivo demasiado corto no cuenta como motivo', async () => {
    const { token } = await sesionAdmin();
    const objetivo = await crearAdmin();
    await darDeAlta(objetivo);

    const res = await reset(token, objetivo._id, { reason: '  perdí  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });

  test('con motivo: aceptado y asentado con autor, momento y motivo', async () => {
    const { admin, token } = await sesionAdmin();
    const objetivo = await crearAdmin();
    await darDeAlta(objetivo);

    const res = await reset(token, objetivo._id, { reason: MOTIVO });

    expect(res.status).toBe(200);
    expect(res.body.auditLogId).toBeTruthy();

    const log = await AdminAuditLog.findOne({ action: 'admin_2fa.reset' }).lean();
    expect(String(log.actorId)).toBe(String(admin._id));
    expect(log.actorEmail).toBe(admin.email);
    expect(log.actorRole).toBe('admin');
    expect(log.reason).toBe(MOTIVO);
    expect(log.targetId).toBe(String(objetivo._id));
    expect(log.before.enabled).toBe(true);
    expect(log.after.enabled).toBe(false);
    expect(log.createdAt).toBeInstanceOf(Date);
    // El estado anterior tiene que reflejar los códigos que realmente quedaban.
    expect(log.before.recoveryRemaining).toBe(10);
    expect(log.after.recoveryRemaining).toBe(0);
  });

  test('tras el restablecimiento el objetivo vuelve a tener que darse de alta', async () => {
    const { token } = await sesionAdmin();
    const objetivo = await crearAdmin();
    await darDeAlta(objetivo);

    await reset(token, objetivo._id, { reason: MOTIVO });

    const guardado = await User.findById(objetivo._id).select('+twoFactor.secretCiphertext').lean();
    expect(guardado.twoFactor.enabled).toBe(false);
    expect(guardado.twoFactor.secretCiphertext).toBeNull();
    expect(guardado.twoFactor.resetBy).toBeTruthy();

    const res = await login(objetivo.email);
    expect(res.body.enrollmentRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
  });

  test('el restablecimiento revoca las sesiones vivas del objetivo', async () => {
    // Si se pide porque se sospecha un acceso indebido, dejar viva la sesión en
    // curso vaciaría la medida.
    const { token } = await sesionAdmin();
    const objetivo = await crearAdmin();
    const { secreto } = await darDeAlta(objetivo);
    const { body: l } = await login(objetivo.email);
    const { body: v } = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });
    expect(v.token).toBeTruthy();

    await reset(token, objetivo._id, { reason: MOTIVO });

    expect((await User.findById(objetivo._id).lean()).tokenVersion).toBeGreaterThan(0);
  });

  test('nadie restablece su propio segundo factor', async () => {
    const { admin, token } = await sesionAdmin();

    const res = await reset(token, admin._id, { reason: MOTIVO });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_MUTATION_FORBIDDEN');
    expect((await User.findById(admin._id).lean()).twoFactor.enabled).toBe(true);
  });

  test('tampoco con el identificador propio en mayúsculas', async () => {
    const { admin, token } = await sesionAdmin();

    const res = await reset(token, String(admin._id).toUpperCase(), { reason: MOTIVO });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_MUTATION_FORBIDDEN');
  });

  test('un usuario sin privilegios no llega al endpoint', async () => {
    process.env.ADMIN_2FA_ENABLED = 'false';
    const user = await User.create({
      firstName: 'Ana', lastName: 'Quispe',
      email: `user_${++seq}_${Date.now()}@test.alyto.io`,
      password: await bcrypt.hash(PASSWORD, 10),
      role: 'user', legalEntity: 'SRL', kycStatus: 'approved',
      residenceCountry: 'BO', isActive: true,
      identityDocument: { type: 'ci_bolivia', number: '7654321', issuingCountry: 'BO' },
    });
    const { body } = await login(user.email);
    const objetivo = await crearAdmin();

    const res = await reset(body.token, objetivo._id, { reason: MOTIVO });

    expect(res.status).toBe(403);
  });
});

// ─── El secreto no está en claro en ningún lado ───────────────────────────────

describe('el secreto TOTP en reposo', () => {

  test('la base guarda ciphertext, no el secreto', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);

    // Se lee el documento CRUDO de la colección, sin pasar por Mongoose, para que
    // ningún select:false enmascare lo que hay realmente escrito en disco.
    const crudo = await mongoose.connection.db.collection('users').findOne({ _id: admin._id });
    const serializado = JSON.stringify(crudo);

    expect(serializado).not.toContain(secreto);
    expect(crudo.twoFactor.secretCiphertext).toMatch(/^v1:/);
    expect(crudo.twoFactor.secretCiphertext).not.toContain(secreto);
  });

  test('el ciphertext está atado al usuario: no se puede mover a otra cuenta', async () => {
    const admin = await crearAdmin();
    await darDeAlta(admin);
    const otro = await crearAdmin();

    const { twoFactor } = await User.findById(admin._id).select('+twoFactor.secretCiphertext').lean();

    expect(() => decryptField(twoFactor.secretCiphertext, aadForTotpSecret(otro._id))).toThrow();
  });

  test('el secreto no vuelve a salir en ninguna respuesta después del alta', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);
    const { body: v } = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });

    const me     = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${v.token}`);
    const users  = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${v.token}`);
    const detail = await request(app).get(`/api/v1/admin/users/${admin._id}`).set('Authorization', `Bearer ${v.token}`);

    for (const res of [me, users, detail]) {
      expect(JSON.stringify(res.body)).not.toContain(secreto);
      expect(JSON.stringify(res.body)).not.toContain('secretCiphertext');
    }
  });

  test('el registro de accesos no contiene el secreto ni el código presentado', async () => {
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const codigo = codigoSiguiente(secreto);
    const { body: l } = await login(admin.email);
    await post2fa('verify', l.challengeToken, { code: codigo });

    const asientos = JSON.stringify(await AccessLog.find({}).lean());
    expect(asientos).not.toContain(secreto);
    expect(asientos).not.toContain(codigo);
  });

  test('la bitácora de administración tampoco lo contiene', async () => {
    const admin = await crearAdmin();
    const { secreto, recoveryCodes } = await darDeAlta(admin);
    const { body: l } = await login(admin.email);
    await post2fa('verify', l.challengeToken, { recoveryCode: recoveryCodes[0] });

    const logs = JSON.stringify(await AdminAuditLog.find({}).lean());
    expect(logs).not.toContain(secreto);
    expect(logs).not.toContain(recoveryCodes[0]);
  });
});

// ─── Estado de alta del conjunto (para decidir el encendido en producción) ─────

describe('GET /admin/2fa/status', () => {

  test('informa quién falta y no se declara listo mientras quede alguien', async () => {
    // Encender la bandera con un operador sin alta lo dejaría fuera del panel.
    // Este endpoint es lo que evita descubrirlo después del despliegue.
    const admin = await crearAdmin();
    const { secreto } = await darDeAlta(admin);
    const rezagado = await crearAdmin();
    const { body: l } = await login(admin.email);
    const { body: v } = await post2fa('verify', l.challengeToken, { code: codigoSiguiente(secreto) });

    const res = await request(app).get('/api/v1/admin/2fa/status')
      .set('Authorization', `Bearer ${v.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.enrolled).toBe(1);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].email).toBe(rezagado.email);
    expect(res.body.readyToEnforce).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(secreto);
  });
});
