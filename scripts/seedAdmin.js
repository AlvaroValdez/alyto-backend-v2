/**
 * seedAdmin.js — Seed de usuario administrador para pruebas del Backoffice
 *
 * Uso: SEED_ADMIN_EMAIL=admin@... SEED_ADMIN_PASSWORD='...' node scripts/seedAdmin.js
 *
 * Siembra un usuario administrador en un entorno LIMPIO. Ése es su único uso.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  NO SIRVE PARA PROMOVER A UNA PERSONA.
 *
 * Crea un usuario nuevo con valores de siembra. Para elevar a alguien que ya
 * tiene cuenta: habilitar temporalmente `ADMIN_ROLE_MUTATION_ENABLED` y hacer
 * el cambio desde el panel consignando el motivo. Ésa es la vía auditada, y es
 * la única que produce el rastro que el apartado 7.4.2 del Informe Técnico
 * declara que el sistema produce: autor, momento y motivo.
 *
 * ── Por qué dejó de ser destructivo incondicional (23/08/2026) ──────────────
 *
 * Hasta esta corrección, el script hacía `deleteOne` sobre el correo indicado
 * antes de crear: identificador distinto, contraseña reemplazada, nombre y
 * documento pisados. Aplicado a una cuenta real le destruía la identidad y
 * dejaba su historial colgando de un identificador que ya no existe — y sin
 * asiento, porque tampoco escribía en la bitácora.
 *
 * Un modo destructivo incondicional, disponible en el entorno de trabajo, es un
 * riesgo por sí mismo: elimina precisamente el rastro que el expediente declara.
 * Ahora:
 *
 *   · Sobre una cuenta con ROL DE ADMINISTRACIÓN → rehúsa, sin excepción.
 *     No hay variable que lo habilite: esa cuenta se toca por la vía auditada.
 *   · Sobre cualquier otra cuenta existente → rehúsa, salvo `SEED_ADMIN_RECREATE=1`
 *     explícito. En un entorno limpio no hay cuenta previa, así que el camino
 *     legítimo nunca necesita la variable.
 *   · Al crear, deja asiento `admin.seeded` en la bitácora de acciones
 *     administrativas, para que la aparición de un administrador no sea invisible.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Seguridad (audit 2026-06-11):
 *  - La password NUNCA va hardcodeada — se exige vía SEED_ADMIN_PASSWORD.
 *  - Rehúsa correr contra la DB de producción (alyto-v2) o con NODE_ENV=production,
 *    salvo override explícito SEED_ADMIN_ALLOW_PROD=1 (recrea el admin: destruye el existente).
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../src/models/User.js';
import AdminAuditLog from '../src/models/AdminAuditLog.js';
import { decideSeedAction } from './seedAdminGuard.js';

// ─── Configuración del admin a crear ─────────────────────────────────────────

const ADMIN_EMAIL    = process.env.SEED_ADMIN_EMAIL    ?? 'admin@avfinance.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;

// ─── Conexión y seed ──────────────────────────────────────────────────────────

async function seedAdmin() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error('[seedAdmin] ERROR: MONGODB_URI no está definida en el archivo .env');
    process.exit(1);
  }
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    console.error('[seedAdmin] ERROR: define SEED_ADMIN_PASSWORD (mínimo 12 caracteres). Nunca se hardcodea.');
    process.exit(1);
  }

  console.log('[seedAdmin] Conectando a MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('[seedAdmin] Conexión exitosa.');

  // ── Guard anti-producción ─────────────────────────────────────────────────
  // La DB de producción se llama 'alyto-v2' (no contiene 'prod') — chequeo explícito.
  const dbName = mongoose.connection.db.databaseName?.toLowerCase() ?? '';
  const looksLikeProd = dbName === 'alyto-v2' || dbName.includes('prod') || process.env.NODE_ENV === 'production';
  if (looksLikeProd && process.env.SEED_ADMIN_ALLOW_PROD !== '1') {
    console.error(`[seedAdmin] FATAL: DB '${dbName}' parece producción. Este script ELIMINA y recrea el admin.`);
    console.error('[seedAdmin] Si realmente quieres correrlo aquí: SEED_ADMIN_ALLOW_PROD=1');
    await mongoose.connection.close();
    process.exit(1);
  }

  // ── Rehusar operar sobre una cuenta existente ─────────────────────────────
  //
  // El orden importa: primero el rol de administración, que no admite override,
  // y recién después el caso general. Así una cuenta con privilegios nunca cae
  // en la rama que una variable de entorno puede abrir.
  const existing = await User.findOne({ email: ADMIN_EMAIL });
  const decision = decideSeedAction(existing, process.env.SEED_ADMIN_RECREATE === '1');

  if (decision.reason === 'ADMIN_ACCOUNT_EXISTS') {
    console.error(`[seedAdmin] REHÚSA: ${ADMIN_EMAIL} ya existe y tiene rol de administración.`);
    console.error('[seedAdmin] Este script NO opera sobre cuentas con privilegios. No hay override.');
    console.error('[seedAdmin] Para modificarla, usar la vía auditada: ADMIN_ROLE_MUTATION_ENABLED');
    console.error('[seedAdmin] habilitada de forma temporal y el cambio hecho desde el panel con motivo.');
    await mongoose.connection.close();
    process.exit(1);
  }
  if (decision.reason === 'ACCOUNT_EXISTS') {
    console.error(`[seedAdmin] REHÚSA: ${ADMIN_EMAIL} ya existe (rol '${existing.role}').`);
    console.error('[seedAdmin] Recrearla destruye su identidad y deja su historial huérfano.');
    console.error('[seedAdmin] Si el entorno es de pruebas y eso es lo buscado: SEED_ADMIN_RECREATE=1');
    await mongoose.connection.close();
    process.exit(1);
  }
  if (decision.action === 'recreate') {
    await User.deleteOne({ email: ADMIN_EMAIL });
    console.log(`[seedAdmin] Usuario previo (${ADMIN_EMAIL}, rol '${existing.role}') eliminado por SEED_ADMIN_RECREATE=1.`);
  }

  // ── Hash de contraseña (mismo cost factor que authController) ────────────
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  // ── Crear usuario admin ───────────────────────────────────────────────────
  const admin = await User.create({
    firstName: 'Admin',
    lastName: 'AV Finance',
    email: ADMIN_EMAIL,
    password: passwordHash,
    role: 'admin',
    legalEntity: 'LLC',
    kycStatus: 'approved',
    residenceCountry: 'US',
    // identityDocument es requerido por el schema
    identityDocument: {
      type: 'passport',
      number: 'ADMIN-SEED-001',
      issuingCountry: 'US',
    },
  });

  // ── Asiento en la bitácora ────────────────────────────────────────────────
  //
  // No hay actor humano: la siembra la ejecuta el script. Se consigna así, en
  // lugar de omitir el asiento, para que la aparición de una cuenta con
  // privilegios no sea invisible en el registro que el apdo. 7.4.2 declara.
  try {
    await AdminAuditLog.create({
      actorId:    null,
      actorEmail: `script:seedAdmin (${process.env.USER ?? 'desconocido'})`,
      actorRole:  'script',
      action:     'admin.seeded',
      targetType: 'User',
      targetId:   String(admin._id),
      before:     null,
      after:      { email: admin.email, role: admin.role, legalEntity: admin.legalEntity },
      reason:     'Siembra de administrador en entorno limpio mediante scripts/seedAdmin.js',
      metadata:   { database: dbName, recreated: process.env.SEED_ADMIN_RECREATE === '1' },
      userAgent:  'script:seedAdmin',
      result:     'success',
    });
    console.log('[seedAdmin] Asiento `admin.seeded` registrado en la bitácora.');
  } catch (err) {
    console.warn(`[seedAdmin] ⚠️  No se pudo registrar el asiento: ${err.message}`);
    console.warn('[seedAdmin] El administrador quedó creado SIN rastro en la bitácora. Revisar.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n✅  Usuario admin creado exitosamente');
  console.log('────────────────────────────────────────');
  console.log(`  ID          : ${admin._id}`);
  console.log(`  Email       : ${admin.email}`);
  console.log(`  Rol         : ${admin.role}`);
  console.log(`  Entidad     : ${admin.legalEntity}`);
  console.log(`  KYC Status  : ${admin.kycStatus}`);
  console.log('────────────────────────────────────────\n');

  await mongoose.connection.close();
  console.log('[seedAdmin] Conexión cerrada. Script finalizado.');
}

seedAdmin().catch((err) => {
  console.error('[seedAdmin] Error fatal:', err.message);
  mongoose.connection.close();
  process.exit(1);
});
