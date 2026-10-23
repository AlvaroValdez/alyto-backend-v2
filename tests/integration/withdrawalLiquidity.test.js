/**
 * withdrawalLiquidity.test.js
 *
 * El retiro validaba contra el saldo de la billetera del usuario y nada más.
 * Al 2026-10-10 el pasivo BOB era de Bs 4.227 contra Bs 1.047,61 en la cuenta:
 * un usuario con Bs 2.280 de saldo podía pedir el retiro, el sistema lo aceptaba
 * y reservaba, y recién al ir a transferir se descubría que no había con qué.
 *
 * Los números de estas pruebas son los reales de ese día.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/withdrawalLiquidity.test.js
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let saldoBanco = null;       // número, o Error para lanzar
let disponibleBec = true;

await jest.unstable_mockModule('../../src/services/bank/becAccountService.js', () => ({
  isAvailable: () => disponibleBec,
  getBalance:  async () => {
    if (saldoBanco instanceof Error) throw saldoBanco;
    return { available: saldoBanco, balance: saldoBanco, currency: 'BOB', status: 'ACTIVA' };
  },
}));

const WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default;
const { verificarLiquidezRetiro, _resetCache } = await import('../../src/services/withdrawalLiquidity.js');

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
  await WalletTransaction.deleteMany({});
  _resetCache();
  saldoBanco = 1047.61;          // el saldo real del 2026-10-10
  disponibleBec = true;
  delete process.env.WITHDRAWAL_LIQUIDITY_GUARD_ENABLED;
});

/** Retiro ya prometido y todavía no transferido. */
async function retiroPrometido(amount, status = 'pending') {
  return WalletTransaction.create({
    walletId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(),
    type: 'withdrawal', amount, balanceBefore: amount, balanceAfter: 0, status,
  });
}

describe('el caso real del 2026-10-10', () => {
  test('bloquea el retiro de Bs 2.280 con Bs 1.047,61 en la cuenta', async () => {
    const r = await verificarLiquidezRetiro({ amount: 2280 });

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('tesoreria-insuficiente');
    expect(r.detalle).toMatchObject({ solicitadoBob: 2280, saldoBancoBob: 1047.61 });
  });

  test('deja pasar un retiro que la cuenta sí cubre', async () => {
    await expect(verificarLiquidezRetiro({ amount: 500 })).resolves.toMatchObject({ ok: true });
  });

  test('tras fondear a Bs 4.227, el retiro grande pasa', async () => {
    // Es el plan de desarme: fondear primero, retirar después.
    saldoBanco = 4227;
    _resetCache();
    await expect(verificarLiquidezRetiro({ amount: 2280 })).resolves.toMatchObject({ ok: true });
  });
});

describe('descuenta lo ya prometido', () => {
  test('dos retiros que pasan por separado no vacían la cuenta entre los dos', async () => {
    // Sin esto, cada uno pasaría el control y juntos dejarían el banco en rojo.
    // Los retiros se ejecutan a mano, así que la ventana entre aceptar y
    // transferir es real.
    await retiroPrometido(800);
    _resetCache();

    const r = await verificarLiquidezRetiro({ amount: 800 });
    expect(r.ok).toBe(false);
    expect(r.detalle).toMatchObject({ prometidoBob: 800, disponibleBob: 247.61 });
  });

  test("'dispatched' también cuenta como prometido", async () => {
    await retiroPrometido(1000, 'dispatched');
    _resetCache();
    await expect(verificarLiquidezRetiro({ amount: 100 })).resolves.toMatchObject({ ok: false });
  });

  test('un retiro ya completado NO se descuenta dos veces', async () => {
    // Ya salió del banco, así que el saldo leído ya lo refleja.
    await retiroPrometido(1000, 'completed');
    _resetCache();
    await expect(verificarLiquidezRetiro({ amount: 900 })).resolves.toMatchObject({ ok: true });
  });
});

describe('dónde NO debe bloquear', () => {
  test('si el banco no responde, deja pasar', async () => {
    // Dejar a los usuarios sin acceso a su dinero porque la API de BANECO está
    // caída es peor que el problema. Además el retiro lo ejecuta un admin.
    saldoBanco = new Error('ETIMEDOUT');
    _resetCache();
    await expect(verificarLiquidezRetiro({ amount: 9999 })).resolves.toMatchObject({ ok: true });
  });

  test('sin credenciales de BANECO, deja pasar', async () => {
    disponibleBec = false;
    _resetCache();
    await expect(verificarLiquidezRetiro({ amount: 9999 })).resolves.toMatchObject({ ok: true });
  });

  test('un saldo ilegible deja pasar', async () => {
    saldoBanco = null;
    _resetCache();
    await expect(verificarLiquidezRetiro({ amount: 9999 })).resolves.toMatchObject({ ok: true });
  });

  test('no controla retiros en USDC: esa cuenta no es la del banco', async () => {
    await expect(verificarLiquidezRetiro({ amount: 9999, currency: 'USDC' })).resolves.toMatchObject({ ok: true });
  });

  test('monto inválido deja pasar', async () => {
    for (const m of [null, undefined, 0, NaN, -5]) {
      await expect(verificarLiquidezRetiro({ amount: m })).resolves.toMatchObject({ ok: true });
    }
  });

  test('WITHDRAWAL_LIQUIDITY_GUARD_ENABLED=false restaura el comportamiento previo', async () => {
    process.env.WITHDRAWAL_LIQUIDITY_GUARD_ENABLED = 'false';
    await expect(verificarLiquidezRetiro({ amount: 99999 })).resolves.toMatchObject({ ok: true });
  });

  test('por defecto está encendido', async () => {
    await expect(verificarLiquidezRetiro({ amount: 99999 })).resolves.toMatchObject({ ok: false });
  });
});
