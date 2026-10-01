/**
 * adminAlertThrottle.test.js
 *
 * Fija el comportamiento de la antirrepetición de alertas admin contra una base
 * real (mongodb-memory-server), porque lo que importa acá es el índice único y
 * la atomicidad del upsert, y eso con un mock no se prueba.
 *
 * Origen: el 2026-10-01 salieron 12 correos de "Payout bloqueado" para 2
 * transacciones, 10 del monitor de KYC y 8 de AnchorAdmin pese a tener cooldown
 * de 6 h, porque ese cooldown vivía en memoria y hubo tres deploys ese día.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/adminAlertThrottle.test.js
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { debeAlertar, estadoAlerta } = await import('../../src/services/adminAlertThrottle.js');
const AdminAlertThrottle = (await import('../../src/models/AdminAlertThrottle.js')).default;

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await AdminAlertThrottle.syncIndexes();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AdminAlertThrottle.deleteMany({});
});

const UNA_HORA = 60 * 60 * 1000;

describe('debeAlertar', () => {
  test('la primera vez deja pasar', async () => {
    await expect(debeAlertar('alerta-x', UNA_HORA)).resolves.toBe(true);
  });

  test('la segunda, dentro del cooldown, no', async () => {
    await debeAlertar('alerta-x', UNA_HORA);
    await expect(debeAlertar('alerta-x', UNA_HORA)).resolves.toBe(false);
    await expect(debeAlertar('alerta-x', UNA_HORA)).resolves.toBe(false);
  });

  test('vuelve a dejar pasar cuando el cooldown venció', async () => {
    await debeAlertar('alerta-x', UNA_HORA);
    // Envejecer el registro en vez de esperar una hora.
    await AdminAlertThrottle.updateOne(
      { key: 'alerta-x' },
      { $set: { lastSentAt: new Date(Date.now() - 2 * UNA_HORA) } },
    );
    await expect(debeAlertar('alerta-x', UNA_HORA)).resolves.toBe(true);
  });

  test('claves distintas no se estorban', async () => {
    await expect(debeAlertar('payout-corridor-missing:ALY-1', UNA_HORA)).resolves.toBe(true);
    await expect(debeAlertar('payout-corridor-missing:ALY-2', UNA_HORA)).resolves.toBe(true);
  });

  test('ante llamadas concurrentes solo UNA pasa', async () => {
    // Es el caso real: dos corridas del mismo job solapadas. Un patrón
    // leer-y-después-escribir dejaría pasar las dos.
    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => debeAlertar('concurrente', UNA_HORA)),
    );
    expect(resultados.filter(Boolean)).toHaveLength(1);
  });

  test('lleva la cuenta de enviadas y suprimidas', async () => {
    await debeAlertar('contada', UNA_HORA);
    await debeAlertar('contada', UNA_HORA);
    await debeAlertar('contada', UNA_HORA);

    const estado = await estadoAlerta('contada');
    expect(estado.enviadas).toBe(1);
    expect(estado.suprimidas).toBe(2);
  });

  test('un cooldown de 0 no bloquea nada', async () => {
    await expect(debeAlertar('sin-cooldown', 0)).resolves.toBe(true);
    await expect(debeAlertar('sin-cooldown', 0)).resolves.toBe(true);
  });

  test('sin clave deja pasar, no rompe al llamador', async () => {
    await expect(debeAlertar('', UNA_HORA)).resolves.toBe(true);
    await expect(debeAlertar(undefined, UNA_HORA)).resolves.toBe(true);
  });

  test('si la base falla, FALLA ABIERTO y deja enviar', async () => {
    // Perder una alerta por un problema de infraestructura es peor que mandarla
    // repetida: un duplicado se ignora, un silencio no se nota.
    const original = AdminAlertThrottle.findOneAndUpdate;
    AdminAlertThrottle.findOneAndUpdate = () => { throw new Error('mongo caído'); };
    try {
      await expect(debeAlertar('con-base-caida', UNA_HORA)).resolves.toBe(true);
    } finally {
      AdminAlertThrottle.findOneAndUpdate = original;
    }
  });

  test('programa el borrado por TTL más allá del cooldown', async () => {
    await debeAlertar('con-ttl', UNA_HORA);
    const doc = await AdminAlertThrottle.findOne({ key: 'con-ttl' }).lean();
    // Debe sobrevivir al cooldown; si expirara antes, la alerta volvería a pasar
    // apenas Mongo limpiara el documento.
    expect(doc.expiresAt.getTime()).toBeGreaterThan(doc.lastSentAt.getTime() + UNA_HORA);
  });
});
