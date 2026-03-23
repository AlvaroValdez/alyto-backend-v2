/**
 * auth.js — Helpers de autenticación para tests
 *
 * Crea usuarios de prueba y genera tokens JWT válidos.
 * Usa el mismo JWT_SECRET configurado en las variables de entorno de test.
 */

import jwt from 'jsonwebtoken';

// Asegurar JWT_SECRET disponible en tests
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'alyto_test_jwt_secret';
}

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Crea un usuario SpA (Chile) con KYC aprobado y devuelve { user, token }.
 * Útil para tests de payins Fintoc (Escenario B).
 */
export async function createSpAUser(overrides = {}) {
  const { default: User } = await import('../../src/models/User.js');

  const userData = {
    firstName:        'Test',
    lastName:         'SpA',
    email:            `spa_${Date.now()}@test.alyto.io`,
    password:         '$2b$10$hashedpassword.for.testing.only',
    legalEntity:      'SpA',
    kycStatus:        'approved',
    kycApprovedAt:    new Date(),
    kycProvider:      'test_mock',
    residenceCountry: 'CL',
    identityDocument: { type: 'rut', number: '12345678-9', issuingCountry: 'CL' },
    address:          { street: 'Av. Test 123', city: 'Santiago', country: 'CL' },
    dateOfBirth:      new Date('1990-01-01'),
    isActive:         true,
    ...overrides,
  };

  const user  = await User.create(userData);
  const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: '1h' });

  return { user, token };
}

/**
 * Crea un usuario SRL (Bolivia) con KYC aprobado y devuelve { user, token }.
 */
export async function createSRLUser(overrides = {}) {
  const { default: User } = await import('../../src/models/User.js');

  const userData = {
    firstName:        'Test',
    lastName:         'SRL',
    email:            `srl_${Date.now()}@test.alyto.io`,
    password:         '$2b$10$hashedpassword.for.testing.only',
    legalEntity:      'SRL',
    kycStatus:        'approved',
    kycApprovedAt:    new Date(),
    kycProvider:      'test_mock',
    residenceCountry: 'BO',
    taxId:            '1023456789',
    identityDocument: { type: 'ci_bolivia', number: '7654321', issuingCountry: 'BO' },
    address:          { street: 'Calle Comercio 456', city: 'La Paz', country: 'BO' },
    dateOfBirth:      new Date('1985-06-15'),
    isActive:         true,
    ...overrides,
  };

  const user  = await User.create(userData);
  const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: '1h' });

  return { user, token };
}

/**
 * Crea un usuario admin con KYC aprobado y devuelve { user, token }.
 */
export async function createAdminUser(overrides = {}) {
  const { default: User } = await import('../../src/models/User.js');

  const userData = {
    firstName:        'Admin',
    lastName:         'Alyto',
    email:            `admin_${Date.now()}@test.alyto.io`,
    password:         '$2b$10$hashedpassword.for.testing.only',
    role:             'admin',
    legalEntity:      'LLC',
    kycStatus:        'approved',
    kycApprovedAt:    new Date(),
    kycProvider:      'test_mock',
    residenceCountry: 'US',
    identityDocument: { type: 'passport', number: 'TEST123456', issuingCountry: 'US' },
    address:          { street: '123 Test St', city: 'Wilmington', state: 'DE', country: 'US' },
    dateOfBirth:      new Date('1985-03-15'),
    isActive:         true,
    ...overrides,
  };

  const user  = await User.create(userData);
  const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: '1h' });

  return { user, token };
}

/**
 * Genera un token JWT válido para un userId dado (sin crear usuario en DB).
 * Útil para tests de autorización con usuarios ya creados.
 */
export function generateToken(userId, expiresIn = '1h') {
  return jwt.sign({ id: userId.toString() }, JWT_SECRET, { expiresIn });
}
