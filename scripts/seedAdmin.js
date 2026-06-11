/**
 * seedAdmin.js — Seed de usuario administrador para pruebas del Backoffice
 *
 * Uso: SEED_ADMIN_EMAIL=admin@... SEED_ADMIN_PASSWORD='...' node scripts/seedAdmin.js
 *
 * Crea (o recrea) el usuario admin con rol 'admin'.
 * Si el usuario ya existe lo elimina primero para garantizar un estado limpio.
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

  // ── Limpiar usuario previo ────────────────────────────────────────────────
  const existing = await User.findOne({ email: ADMIN_EMAIL });
  if (existing) {
    await User.deleteOne({ email: ADMIN_EMAIL });
    console.log(`[seedAdmin] Usuario previo (${ADMIN_EMAIL}) eliminado para test limpio.`);
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
