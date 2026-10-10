/**
 * harborPreflight.test.js
 *
 * Cierra la última causa de las 7 operaciones por Bs 3.506: dos murieron con
 * `code=3006 "On behalf of customer is not active"`, con el dinero ya cobrado.
 * Ese error mata el riel entero, no una operación, así que el segundo intento
 * iba a fallar igual que el primero.
 *
 * Se prueba contra una base real porque el breaker es persistente a propósito:
 * uno en memoria se olvida en cada deploy, y eso ya nos pasó con el cooldown de
 * `anchorAdminAlerts`.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/harborPreflight.test.js
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const SystemConfig = (await import('../../src/models/SystemConfig.js')).default;
const { verificarRielHarbor, marcarCustomerInactivo, marcarCustomerActivo, _resetCache } =
  await import('../../src/services/harborPreflight.js');
const { mapHarborError } = await import('../../src/utils/harborErrorMapper.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await SystemConfig.deleteMany({});
  _resetCache();
  delete process.env.HARBOR_PREFLIGHT_ENABLED;
});

const harbor = { corridorId: 'bo-us', payoutMethod: 'owlPay' };
const vita   = { corridorId: 'bo-cl', payoutMethod: 'vitaWallet' };

describe('el error real de junio queda clasificado', () => {
  test('code 3006 ya no cae en "Error no clasificado"', async () => {
    // Texto exacto de ALY-C-1781758486156-OFPT44 y ...-4ZUHE3.
    const m = mapHarborError({ code: 3006, status: 400, message: 'On behalf of customer is not active' });

    expect(m.category).toBe('CUSTOMER_NOT_ACTIVE');
    expect(m.rielCaido).toBe(true);      // la señal que levanta el breaker
    expect(m.retryable).toBe(false);
    expect(m.adminMessage).not.toMatch(/no clasificado/i);
  });

  test('lo reconoce también por el mensaje, sin depender del código', async () => {
    const m = mapHarborError({ status: 400, message: 'On behalf of customer is not active' });
    expect(m.category).toBe('CUSTOMER_NOT_ACTIVE');
  });

  test('otros errores de Harbor NO levantan el breaker', async () => {
    expect(mapHarborError({ code: 3018, status: 400, message: 'corridor' }).rielCaido).toBeUndefined();
    expect(mapHarborError({ code: 2005, status: 422, message: 'schema' }).rielCaido).toBeUndefined();
  });
});

describe('ciclo del breaker', () => {
  test('sin bandera, el riel pasa', async () => {
    await expect(verificarRielHarbor({ corridor: harbor })).resolves.toMatchObject({ ok: true });
  });

  test('tras un fallo por customer inactivo, bloquea', async () => {
    await marcarCustomerInactivo('LLC', 'On behalf of customer is not active');
    _resetCache();

    const r = await verificarRielHarbor({ corridor: harbor });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('harbor-customer-inactivo');
    expect(r.detalle.detalle).toMatch(/not active/i);
  });

  test('un payout exitoso lo levanta solo', async () => {
    await marcarCustomerInactivo('LLC', 'inactivo');
    _resetCache();
    await expect(verificarRielHarbor({ corridor: harbor })).resolves.toMatchObject({ ok: false });

    await marcarCustomerActivo('LLC');     // lo que hace createOwlPayTransfer al salir bien
    _resetCache();
    await expect(verificarRielHarbor({ corridor: harbor })).resolves.toMatchObject({ ok: true });
  });

  test('el estado sobrevive al reinicio del proceso', async () => {
    // Es la razón de que viva en SystemConfig y no en memoria.
    await marcarCustomerInactivo('LLC', 'inactivo');
    _resetCache();                          // simula arranque nuevo: caché vacía
    await expect(verificarRielHarbor({ corridor: harbor })).resolves.toMatchObject({ ok: false });
  });
});

describe('dónde NO debe bloquear', () => {
  test('no toca el riel de Vita', async () => {
    await marcarCustomerInactivo('LLC', 'inactivo');
    _resetCache();
    await expect(verificarRielHarbor({ corridor: vita })).resolves.toMatchObject({ ok: true });
  });

  test('sin corredor deja pasar', async () => {
    await marcarCustomerInactivo('LLC', 'inactivo');
    _resetCache();
    await expect(verificarRielHarbor({ corridor: null })).resolves.toMatchObject({ ok: true });
  });

  test('HARBOR_PREFLIGHT_ENABLED=false restaura el comportamiento previo', async () => {
    await marcarCustomerInactivo('LLC', 'inactivo');
    _resetCache();
    process.env.HARBOR_PREFLIGHT_ENABLED = 'false';
    await expect(verificarRielHarbor({ corridor: harbor })).resolves.toMatchObject({ ok: true });
  });

  test('si la base falla, deja pasar', async () => {
    const original = SystemConfig.getValue;
    SystemConfig.getValue = () => { throw new Error('mongo caído'); };
    try {
      _resetCache();
      await expect(verificarRielHarbor({ corridor: harbor })).resolves.toMatchObject({ ok: true });
    } finally {
      SystemConfig.getValue = original;
    }
  });
});
