/**
 * adminUserSensitiveFields.test.js — Campos sensibles del PATCH /admin/users/:userId
 * (DEFECTO 3) + los dos bonus de trazabilidad.
 *
 * `role`, `kycStatus` y `sanctionsFlag` eran editables como cualquier otro campo:
 * un admin podía auto-promoverse, promover cuentas a admin, dar por aprobado un
 * KYC sin pasar por Stripe Identity y levantar un bloqueo AML — y nada de eso
 * dejaba un AdminAuditLog.
 *
 * Se cubre: `role` fuera de la API por defecto, prohibición de auto-modificación,
 * motivo obligatorio persistido, auditoría de todo cambio sensible, y que el
 * panel siga funcionando cuando manda el formulario completo sin cambios.
 *
 * Bonus cubiertos:
 *   - clearSanctionsFlag persiste la `note` (antes solo iba a console.info)
 *   - updateCorridor ya no deja borrar el `changeLog` de comisiones
 */

import '../setup.env.js';
import { connectTestDb, disconnectTestDb, clearCollections, seedCorridor } from '../helpers/db.js';
import { createAdminUser, createSRLUser } from '../helpers/auth.js';

const { default: app }              = await import('../../src/server.js');
const { default: request }          = await import('supertest');
const { default: User }             = await import('../../src/models/User.js');
const { default: AdminAuditLog }    = await import('../../src/models/AdminAuditLog.js');
const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');

const ORIGINAL_ROLE_FLAG = process.env.ADMIN_ROLE_MUTATION_ENABLED;
const MOTIVO = 'Revisión manual del Oficial de Cumplimiento, expediente 2026-114';

beforeAll(async () => { await connectTestDb(); });

afterEach(async () => {
  if (ORIGINAL_ROLE_FLAG === undefined) delete process.env.ADMIN_ROLE_MUTATION_ENABLED;
  else process.env.ADMIN_ROLE_MUTATION_ENABLED = ORIGINAL_ROLE_FLAG;
  await clearCollections();
});

afterAll(async () => { await disconnectTestDb(); });

const patchUser = (token, userId, body) => request(app)
  .patch(`/api/v1/admin/users/${userId}`)
  .set('Authorization', `Bearer ${token}`)
  .send(body);

// ─── role: fuera de la API por defecto ────────────────────────────────────────

describe('PATCH /admin/users/:userId — campo role', () => {

  test('403 ROLE_MUTATION_DISABLED — promover a otro usuario a admin', async () => {
    const { token }  = await createAdminUser();
    const { user }   = await createSRLUser();

    const res = await patchUser(token, user._id, { role: 'admin', reason: MOTIVO });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROLE_MUTATION_DISABLED');
    expect((await User.findById(user._id).lean()).role).toBe('user');
  });

  test('403 — un admin no puede auto-promoverse ni con el break-glass activo', async () => {
    process.env.ADMIN_ROLE_MUTATION_ENABLED = 'true';
    const { user: adminUser, token } = await createAdminUser();

    const res = await patchUser(token, adminUser._id, { role: 'user', reason: MOTIVO });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_MUTATION_FORBIDDEN');
    expect((await User.findById(adminUser._id).lean()).role).toBe('admin');
  });

  test('el bloqueo de auto-modificación no se esquiva con el hex del _id en MAYÚSCULAS', async () => {
    // ObjectId acepta hex en mayúsculas y castea al MISMO documento, pero
    // String(req.user._id) sale siempre en minúsculas: comparar los strings
    // crudos dejaba pasar la auto-promoción vía /admin/users/6A80E6…
    process.env.ADMIN_ROLE_MUTATION_ENABLED = 'true';
    const { user: adminUser, token } = await createAdminUser();
    const idMayus = String(adminUser._id).toUpperCase();
    expect(idMayus).not.toBe(String(adminUser._id));   // el _id tiene letras

    const res = await patchUser(token, idMayus, { role: 'user', reason: MOTIVO });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_MUTATION_FORBIDDEN');
    expect((await User.findById(adminUser._id).lean()).role).toBe('admin');
  });

  test('el targetId auditado queda canonicalizado, no como lo mandó el cliente', async () => {
    // Si se persistiera el hex en mayúsculas, una consulta de auditoría por el
    // _id normal del usuario no devolvería el registro.
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'pending' });

    await patchUser(token, String(user._id).toUpperCase(), { kycStatus: 'approved', reason: MOTIVO });

    const log = await AdminAuditLog.findOne({ action: 'user.sensitive_update' }).lean();
    expect(log.targetId).toBe(String(user._id));   // minúsculas canónicas
  });

  test('con el break-glass activo, promover a OTRO exige motivo y queda auditado', async () => {
    process.env.ADMIN_ROLE_MUTATION_ENABLED = 'true';
    const { user: adminUser, token } = await createAdminUser();
    const { user } = await createSRLUser();

    const sinMotivo = await patchUser(token, user._id, { role: 'admin' });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.code).toBe('REASON_REQUIRED');
    expect((await User.findById(user._id).lean()).role).toBe('user');

    const conMotivo = await patchUser(token, user._id, { role: 'admin', reason: MOTIVO });
    expect(conMotivo.status).toBe(200);
    expect((await User.findById(user._id).lean()).role).toBe('admin');

    const log = await AdminAuditLog.findOne({ action: 'user.sensitive_update' }).lean();
    expect(log).toBeTruthy();
    expect(String(log.actorId)).toBe(String(adminUser._id));
    expect(log.actorEmail).toBe(adminUser.email);
    expect(log.before.role).toBe('user');
    expect(log.after.role).toBe('admin');
    expect(log.reason).toBe(MOTIVO);
    expect(log.targetId).toBe(String(user._id));
  });

  test('un motivo demasiado corto no cuenta como motivo', async () => {
    process.env.ADMIN_ROLE_MUTATION_ENABLED = 'true';
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser();

    const res = await patchUser(token, user._id, { role: 'admin', reason: '   ok   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });
});

// ─── kycStatus y sanctionsFlag ────────────────────────────────────────────────

describe('PATCH /admin/users/:userId — kycStatus y sanctionsFlag', () => {

  test('400 sin motivo — aprobar KYC sin pasar por Stripe Identity', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'pending' });

    const res = await patchUser(token, user._id, { kycStatus: 'approved' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect(res.body.fields).toEqual(['kycStatus']);
    expect((await User.findById(user._id).lean()).kycStatus).toBe('pending');
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('200 con motivo — el cambio de kycStatus queda auditado', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'pending' });

    const res = await patchUser(token, user._id, { kycStatus: 'approved', reason: MOTIVO });

    expect(res.status).toBe(200);
    expect(res.body.auditLogId).toBeTruthy();

    const log = await AdminAuditLog.findOne({ action: 'user.sensitive_update' }).lean();
    expect(log.before.kycStatus).toBe('pending');
    expect(log.after.kycStatus).toBe('approved');
    expect(log.reason).toBe(MOTIVO);
  });

  test('400 sin motivo — levantar un bloqueo AML (sanctionsFlag)', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ sanctionsFlag: true });

    const res = await patchUser(token, user._id, { sanctionsFlag: false });

    expect(res.status).toBe(400);
    expect((await User.findById(user._id).lean()).sanctionsFlag).toBe(true);
  });

  test('un admin no puede levantarse su propio flag AML ni aprobarse el KYC', async () => {
    const { user: adminUser, token } = await createAdminUser({ sanctionsFlag: true });

    const res = await patchUser(token, adminUser._id, { sanctionsFlag: false, reason: MOTIVO });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_MUTATION_FORBIDDEN');
    expect((await User.findById(adminUser._id).lean()).sanctionsFlag).toBe(true);
  });

  test('varios campos sensibles a la vez: un solo registro con todos', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'pending', sanctionsFlag: true });

    const res = await patchUser(token, user._id, {
      kycStatus: 'approved', sanctionsFlag: false, reason: MOTIVO,
    });

    expect(res.status).toBe(200);
    const logs = await AdminAuditLog.find({ action: 'user.sensitive_update' }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].before).toEqual({ kycStatus: 'pending', sanctionsFlag: true });
    expect(logs[0].after).toEqual({ kycStatus: 'approved', sanctionsFlag: false });
  });
});

// ─── Compatibilidad con el panel ──────────────────────────────────────────────

describe('PATCH /admin/users/:userId — el panel sigue funcionando', () => {

  test('el formulario completo sin cambios reales no exige motivo ni audita', async () => {
    // UsersPage.jsx manda SIEMPRE el form entero (role, kycStatus, sanctionsFlag
    // incluidos). Si un campo sensible presente pero sin cambio exigiera motivo,
    // el panel quedaría inutilizable para cualquier edición.
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'approved', sanctionsFlag: false });

    const res = await patchUser(token, user._id, {
      accountType:   user.accountType,
      legalEntity:   'SRL',
      kycStatus:     'approved',
      role:          'user',
      isActive:      true,
      sanctionsFlag: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('cambiar solo un campo NO sensible no exige motivo (mandando el form entero)', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'approved', accountType: 'personal' });

    const res = await patchUser(token, user._id, {
      accountType:   'business',
      legalEntity:   'SRL',
      kycStatus:     'approved',   // sin cambio → no debe pedir motivo
      role:          'user',       // sin cambio → no debe disparar el gate de role
      isActive:      true,
      sanctionsFlag: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.user.accountType).toBe('business');
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('desactivar una cuenta sigue invalidando sus tokens', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser();

    const res = await patchUser(token, user._id, { isActive: false });

    expect(res.status).toBe(200);
    expect((await User.findById(user._id).lean()).tokenVersion).toBe(1);
  });

  test("booleanos como string ('false') se normalizan, no se toman como cambio espurio", async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ sanctionsFlag: false });

    const res = await patchUser(token, user._id, { sanctionsFlag: 'false', isActive: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('400 con un valor fuera del enum, y sin dejar registro de auditoría fantasma', async () => {
    // El audit se escribe ANTES de mutar; un valor que el schema va a rechazar
    // no debe dejar un registro de un cambio que nunca ocurrió.
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ kycStatus: 'pending' });

    const res = await patchUser(token, user._id, { kycStatus: 'aprobadisimo', reason: MOTIVO });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('kycStatus');
    expect((await User.findById(user._id).lean()).kycStatus).toBe('pending');
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('404 si el usuario objetivo no existe', async () => {
    const { token } = await createAdminUser();
    const res = await patchUser(token, '507f1f77bcf86cd799439011', { accountType: 'business' });
    expect(res.status).toBe(404);
  });

  test('403 — un usuario normal no llega al endpoint', async () => {
    const { token } = await createSRLUser();
    const { user }  = await createSRLUser();
    const res = await patchUser(token, user._id, { role: 'admin', reason: MOTIVO });
    expect(res.status).toBe(403);
  });
});

// ─── BONUS 1: la note del levantamiento de flag AML se persiste ───────────────

describe('POST /admin/sanctions/flagged-users/:userId/clear — la note se persiste', () => {

  test('la note queda en AdminAuditLog, no solo en console.info', async () => {
    const { user: adminUser, token } = await createAdminUser();
    const { user } = await createSRLUser({ sanctionsFlag: true });

    const res = await request(app)
      .post(`/api/v1/admin/sanctions/flagged-users/${user._id}/clear`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'Falso positivo: homónimo verificado contra lista OFAC, oficio 2026-77' });

    expect(res.status).toBe(200);
    expect(res.body.auditLogId).toBeTruthy();
    expect((await User.findById(user._id).lean()).sanctionsFlag).toBe(false);

    const log = await AdminAuditLog.findOne({ action: 'sanctions.flag_cleared' }).lean();
    expect(log.reason).toContain('Falso positivo');
    expect(String(log.actorId)).toBe(String(adminUser._id));
    expect(log.before.sanctionsFlag).toBe(true);
    expect(log.after.sanctionsFlag).toBe(false);
    expect(log.targetId).toBe(String(user._id));
  });

  test('403 — un admin flagueado NO puede levantarse su propio bloqueo AML por esta ruta', async () => {
    // Ruta paralela que muta el mismo campo que PATCH /admin/users: si no
    // replicara la segregación de funciones, sería el bypass del otro camino.
    const { user: adminUser, token } = await createAdminUser({ sanctionsFlag: true });

    const res = await request(app)
      .post(`/api/v1/admin/sanctions/flagged-users/${adminUser._id}/clear`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'Me reviso a mí mismo y decido que estoy limpio' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_MUTATION_FORBIDDEN');
    expect((await User.findById(adminUser._id).lean()).sanctionsFlag).toBe(true);
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });

  test('403 — tampoco con el _id propio en mayúsculas', async () => {
    const { user: adminUser, token } = await createAdminUser({ sanctionsFlag: true });

    const res = await request(app)
      .post(`/api/v1/admin/sanctions/flagged-users/${String(adminUser._id).toUpperCase()}/clear`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'Motivo suficientemente largo para pasar el umbral' });

    expect(res.status).toBe(403);
    expect((await User.findById(adminUser._id).lean()).sanctionsFlag).toBe(true);
  });

  test('400 — una note de un carácter no cuenta como motivo (mismo umbral que updateUser)', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ sanctionsFlag: true });

    const res = await request(app)
      .post(`/api/v1/admin/sanctions/flagged-users/${user._id}/clear`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect((await User.findById(user._id).lean()).sanctionsFlag).toBe(true);
  });

  test('400 sin note — y el flag no se toca', async () => {
    const { token } = await createAdminUser();
    const { user }  = await createSRLUser({ sanctionsFlag: true });

    const res = await request(app)
      .post(`/api/v1/admin/sanctions/flagged-users/${user._id}/clear`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: '   ' });

    expect(res.status).toBe(400);
    expect((await User.findById(user._id).lean()).sanctionsFlag).toBe(true);
    expect(await AdminAuditLog.countDocuments()).toBe(0);
  });
});

// ─── BONUS 2: el changeLog del corredor es inmutable vía PATCH ────────────────

describe('PATCH /admin/corridors/:corridorId — changeLog protegido', () => {

  test('un PATCH con changeLog: [] ya no borra el historial de comisiones', async () => {
    const { token } = await createAdminUser();
    const corridor  = await seedCorridor();

    // Primero generamos historial real cambiando una comisión.
    await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ alytoCSpread: 2.5 });

    const conHistorial = await TransactionConfig.findById(corridor._id).lean();
    expect(conHistorial.changeLog.length).toBeGreaterThan(0);

    // El ataque: mandar changeLog vacío junto a un cambio cualquiera.
    const res = await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ changeLog: [], alytoCSpread: 3 });

    expect(res.status).toBe(200);

    const despues = await TransactionConfig.findById(corridor._id).lean();
    expect(despues.changeLog.length).toBeGreaterThanOrEqual(conHistorial.changeLog.length);
    expect(despues.alytoCSpread).toBe(3);   // el resto del PATCH sí se aplica
  });

  test('un PATCH que SOLO trae changeLog no se considera actualización válida', async () => {
    const { token } = await createAdminUser();
    const corridor  = await seedCorridor();

    const res = await request(app)
      .patch(`/api/v1/admin/corridors/${corridor.corridorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ changeLog: [] });

    expect(res.status).toBe(400);
  });
});
