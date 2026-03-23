/**
 * seedAdmin.js — Seed de usuario administrador para pruebas del Backoffice
 *
 * Uso: node scripts/seedAdmin.js
 *
 * Crea (o recrea) el usuario admin@avfinance.com con rol 'admin'.
 * Si el usuario ya existe lo elimina primero para garantizar un estado limpio.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../src/models/User.js';

// ─── Configuración del admin a crear ─────────────────────────────────────────

const ADMIN_EMAIL = 'admin@avfinance.com';
const ADMIN_PASSWORD = 'AdminAlyto2026';

// ─── Conexión y seed ──────────────────────────────────────────────────────────

async function seedAdmin() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error('[seedAdmin] ERROR: MONGO_URI no está definida en el archivo .env');
    process.exit(1);
  }

  console.log('[seedAdmin] Conectando a MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('[seedAdmin] Conexión exitosa.');

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
  console.log(`  Password    : ${ADMIN_PASSWORD}`);
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
