/**
 * payoutPreflight.test.js
 *
 * Fija la regla "no cobrar lo que no vamos a poder pagar", y sobre todo fija
 * dónde NO debe bloquear: un pre-check que cierra la caja ante cualquier duda
 * es peor que el problema que resuelve.
 *
 * Contexto: el 2026-10-01 se devolvieron Bs 3.506 de 7 operaciones cobradas y
 * nunca ejecutadas. Dos fallaron con "Insufficient balance business" porque la
 * wallet maestra de Vita estaba sin saldo, y se supo con el dinero ya adentro.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/payoutPreflight.test.js
 */

import { jest } from '@jest/globals';

let respuestaWallets = null;   // objeto a devolver, o un Error a lanzar

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getWallets: async () => {
    if (respuestaWallets instanceof Error) throw respuestaWallets;
    return respuestaWallets;
  },
}));

const { verificarPayoutEjecutable, _resetCache } = await import('../../src/services/payoutPreflight.js');

/** Forma real devuelta por Vita en producción (verificada 2026-10-01). */
const walletsConSaldo = (usd) => ({
  wallets: [{
    uuid: '4a2de283-7db9-4812-b822-3ef4bab1cfe0',
    type: 'business_wallet',
    attributes: { token: 'master', balances: { clp: 1306, usdc: 0, usd, usdt: 0, cop: 13531 }, is_master: true },
  }],
  total: 1, count: 1,
});

const corredorVita   = { corridorId: 'bo-cl', payoutMethod: 'vitaWallet' };
const corredorHarbor = { corridorId: 'bo-us', payoutMethod: 'owlPay' };

beforeEach(() => {
  _resetCache();
  respuestaWallets = null;
  delete process.env.PAYOUT_PREFLIGHT_ENABLED;
});

describe('verificarPayoutEjecutable — riel Vita', () => {
  test('bloquea cuando el saldo no alcanza', async () => {
    respuestaWallets = walletsConSaldo(22.89);   // el saldo real al implementarlo

    const r = await verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 });

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('vita-saldo-insuficiente');
    expect(r.detalle).toMatchObject({ saldoUsd: 22.89, requeridoUsd: 100 });
  });

  test('deja pasar cuando el saldo alcanza', async () => {
    respuestaWallets = walletsConSaldo(500);
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('el borde exacto (saldo == monto) pasa', async () => {
    respuestaWallets = walletsConSaldo(100);
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });
});

describe('verificarPayoutEjecutable — dónde NO debe bloquear', () => {
  test('si Vita no responde, DEJA PASAR', async () => {
    // Un proveedor de monitoreo caído no puede cerrar la caja: bloquear a todos
    // los usuarios por no poder leer un saldo es peor que un payout fallido,
    // que además tiene su propia red de contención.
    respuestaWallets = new Error('ETIMEDOUT');
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('si la respuesta viene con una forma inesperada, DEJA PASAR', async () => {
    respuestaWallets = { algo: 'distinto' };
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('sin monto confiable DEJA PASAR (dispatchPayout lo recalcula al despachar)', async () => {
    respuestaWallets = walletsConSaldo(1);
    for (const monto of [null, undefined, 0, NaN, -5]) {
      await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: monto }))
        .resolves.toMatchObject({ ok: true });
    }
  });

  test('no toca el riel de Harbor', async () => {
    // Harbor degrada distinto: ante falta de liquidez queda en pending_funding y
    // se reintenta solo. No es una pérdida, así que no se bloquea el cobro.
    respuestaWallets = walletsConSaldo(0);
    await expect(verificarPayoutEjecutable({ corridor: corredorHarbor, usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('sin corredor DEJA PASAR', async () => {
    await expect(verificarPayoutEjecutable({ corridor: null, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });
});

describe('kill switch y caché', () => {
  test('PAYOUT_PREFLIGHT_ENABLED=false restaura el comportamiento previo', async () => {
    process.env.PAYOUT_PREFLIGHT_ENABLED = 'false';
    respuestaWallets = walletsConSaldo(0);
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('por defecto está encendido', async () => {
    respuestaWallets = walletsConSaldo(0);
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: false });
  });

  test('no consulta a Vita en cada llamada', async () => {
    // Esto corre en el camino de cada inicio de pago: sin caché, Vita recibiría
    // una consulta por request.
    respuestaWallets = walletsConSaldo(500);
    await verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 10 });

    // Si volviera a consultar, este saldo nuevo bloquearía.
    respuestaWallets = walletsConSaldo(1);

    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 10 }))
      .resolves.toMatchObject({ ok: true });   // sigue usando el saldo cacheado
  });

  test('un fallo no se cachea: la siguiente llamada vuelve a intentar', async () => {
    respuestaWallets = new Error('ETIMEDOUT');
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });

    respuestaWallets = walletsConSaldo(5);
    await expect(verificarPayoutEjecutable({ corridor: corredorVita, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: false });   // ya pudo leer: bloquea
  });
});
