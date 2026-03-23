/**
 * db.js — Helpers de base de datos para tests
 *
 * Provee funciones para levantar/bajar MongoMemoryServer y sembrar
 * datos de prueba comunes (corredor CL→BO activo).
 *
 * Uso en cada describe:
 *   import { connectTestDb, disconnectTestDb, clearCollections, seedCorridor } from '../helpers/db.js'
 *
 *   beforeAll(async () => { await connectTestDb(); await seedCorridor(); })
 *   afterEach(async () => { await clearCollections(); })
 *   afterAll(async () => { await disconnectTestDb(); })
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod = null;

// ─── Conexión / Desconexión ───────────────────────────────────────────────────

export async function connectTestDb() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
}

export async function disconnectTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (mongod) await mongod.stop();
  mongod = null;
}

export async function clearCollections() {
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map(col => col.deleteMany({}))
  );
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

/**
 * Siembra el corredor CL→BO (fintoc → anchorBolivia) activo.
 * Es el corredor base para la mayoría de tests.
 */
export async function seedCorridor(overrides = {}) {
  // Importación dinámica para evitar que Mongoose se inicialice antes
  // de que Jest configure el entorno de test
  const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');

  const defaults = {
    corridorId:             'cl-bo-fintoc-anchorbolivia',
    originCountry:          'CL',
    destinationCountry:     'BO',
    originCurrency:         'CLP',
    destinationCurrency:    'BOB',
    payinMethod:            'fintoc',
    payoutMethod:           'anchorBolivia',
    legalEntity:            'SpA',
    routingScenario:        'B',
    alytoCSpread:           1.5,
    fixedFee:               0,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0,
    minAmountOrigin:        10000,
    maxAmountOrigin:        null,
    isActive:               true,
  };

  return TransactionConfig.create({ ...defaults, ...overrides });
}

/**
 * Siembra el corredor CL→CO (fintoc → vitaWallet) activo.
 */
export async function seedCorridorClCo(overrides = {}) {
  const { default: TransactionConfig } = await import('../../src/models/TransactionConfig.js');

  const defaults = {
    corridorId:             'cl-co-fintoc-vitawallet',
    originCountry:          'CL',
    destinationCountry:     'CO',
    originCurrency:         'CLP',
    destinationCurrency:    'COP',
    payinMethod:            'fintoc',
    payoutMethod:           'vitaWallet',
    legalEntity:            'SpA',
    routingScenario:        'B',
    alytoCSpread:           1.5,
    fixedFee:               500,
    payinFeePercent:        0,
    payoutFeeFixed:         200,
    profitRetentionPercent: 0,
    minAmountOrigin:        10000,
    maxAmountOrigin:        null,
    isActive:               true,
  };

  return TransactionConfig.create({ ...defaults, ...overrides });
}
