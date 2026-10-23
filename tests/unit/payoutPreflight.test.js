/**
 * payoutPreflight.test.js
 *
 * Fija la regla "no cobrar lo que no vamos a poder pagar", y sobre todo fija
 * dónde NO debe bloquear: un pre-check que cierra la caja ante cualquier duda es
 * peor que el problema que resuelve.
 *
 * El caso que motivó reescribirlo: el 2026-10-09 la wallet de Vita tenía
 * USD 4,28 y CLP 466.110. La primera versión miraba solo `balances.usd` y habría
 * bloqueado los 17 corredores estando perfectamente fondeada, porque el saldo
 * que paga es el de CLP.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/payoutPreflight.test.js
 */

import { jest } from '@jest/globals';

let respWallets = null;   // objeto, o Error para lanzar
let respPrices  = null;

await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getWallets: async () => { if (respWallets instanceof Error) throw respWallets; return respWallets; },
  getPrices:  async () => { if (respPrices  instanceof Error) throw respPrices;  return respPrices;  },
}));

const { verificarPayoutEjecutable, _resetCache } = await import('../../src/services/payoutPreflight.js');

/** Forma real de Vita, verificada contra producción el 2026-10-09. */
const wallets = (balances) => ({
  wallets: [{ uuid: '4a2de283', type: 'business_wallet', attributes: { token: 'master', balances, is_master: true } }],
  total: 1, count: 1,
});

/** Tasas reales de Vita del 2026-10-09: 1 CLP ≈ 0.00102299 USD. */
const PRECIOS = {
  clp: { withdrawal: { prices: { attributes: { clp_sell: {
    peusd: 0.00100866, arusd: 0.00102299, us: 0.00101173, swiftusd: 0.00101582,
  } } } } },
  cop: { withdrawal: { prices: { attributes: { cop_sell: { arusd: 0.00031376, us: 0.00031219 } } } } },
};

/** El estado real del 2026-10-09. */
const SALDOS_REALES = { clp: 466110, usdc: 0, usd: 4.28, usdt: 0, cop: 13531 };

const vita = (extra = {}) => ({ corridorId: 'bo-cl', payoutMethod: 'vitaWallet', ...extra });

beforeEach(() => {
  _resetCache();
  respWallets = wallets(SALDOS_REALES);
  respPrices  = PRECIOS;
  delete process.env.PAYOUT_PREFLIGHT_ENABLED;
});

describe('el caso que rompió la primera versión', () => {
  test('con USD 4,28 pero CLP 466.110, NO bloquea un pago de USD 250', async () => {
    // CLP 466.110 × 0.00102299 ≈ USD 476. La versión anterior miraba usd=4,28
    // y habría bloqueado los 17 corredores con la wallet bien fondeada.
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 250 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('sí bloquea cuando ni el mejor saldo alcanza', async () => {
    const r = await verificarPayoutEjecutable({ corridor: vita(), usdAmount: 5000 });

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('vita-saldo-insuficiente');
    expect(r.detalle.disponibleUsd).toBeCloseTo(476.8, 0);
    expect(r.detalle.moneda).toBe('auto');
  });

  test('con todos los saldos en cero, bloquea', async () => {
    // Cero es medible. Esto no debe confundirse con "no se pudo medir".
    respWallets = wallets({ clp: 0, usd: 0, cop: 0 });
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 10 }))
      .resolves.toMatchObject({ ok: false });
  });
});

describe('de qué saldo sale el pago', () => {
  test("'auto' usa el mejor saldo, no el de USD", async () => {
    await expect(verificarPayoutEjecutable({ corridor: vita({ vitaPayoutCurrency: 'auto' }), usdAmount: 400 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('una moneda explícita se mide contra ESE saldo', async () => {
    // Con USD explícito el saldo es 4,28: 400 no entra, aunque haya CLP de sobra.
    await expect(verificarPayoutEjecutable({ corridor: vita({ vitaPayoutCurrency: 'USD' }), usdAmount: 400 }))
      .resolves.toMatchObject({ ok: false, detalle: { moneda: 'usd' } });

    await expect(verificarPayoutEjecutable({ corridor: vita({ vitaPayoutCurrency: 'CLP' }), usdAmount: 400 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('sin vitaPayoutCurrency se comporta como auto', async () => {
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 400 }))
      .resolves.toMatchObject({ ok: true });
  });
});

describe('dónde NO debe bloquear', () => {
  test('si Vita no responde, deja pasar', async () => {
    respWallets = new Error('ETIMEDOUT');
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('un saldo positivo sin tasa se omite, no se asume cero', async () => {
    respPrices  = {};
    respWallets = wallets({ clp: 466110 });
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('una moneda explícita que no se pudo medir deja pasar', async () => {
    respPrices = {};
    await expect(verificarPayoutEjecutable({ corridor: vita({ vitaPayoutCurrency: 'CLP' }), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('respuesta con forma inesperada deja pasar', async () => {
    respWallets = { algo: 'distinto' };
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('sin monto confiable deja pasar', async () => {
    for (const m of [null, undefined, 0, NaN, -5]) {
      await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: m }))
        .resolves.toMatchObject({ ok: true });
    }
  });

  test('no toca Harbor', async () => {
    respWallets = wallets({ clp: 0, usd: 0 });
    await expect(verificarPayoutEjecutable({ corridor: { corridorId: 'bo-us', payoutMethod: 'owlPay' }, usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('sin corredor deja pasar', async () => {
    await expect(verificarPayoutEjecutable({ corridor: null, usdAmount: 100 }))
      .resolves.toMatchObject({ ok: true });
  });
});

describe('kill switch y caché', () => {
  test('PAYOUT_PREFLIGHT_ENABLED=false restaura el comportamiento previo', async () => {
    process.env.PAYOUT_PREFLIGHT_ENABLED = 'false';
    respWallets = wallets({ clp: 0, usd: 0 });
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('por defecto está encendido', async () => {
    respWallets = wallets({ clp: 0, usd: 0 });
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: false });
  });

  test('no consulta a Vita en cada llamada', async () => {
    await verificarPayoutEjecutable({ corridor: vita(), usdAmount: 10 });
    respWallets = wallets({ clp: 0, usd: 0 });   // si reconsultara, bloquearía
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 10 }))
      .resolves.toMatchObject({ ok: true });
  });

  test('un fallo no se cachea: la siguiente vuelve a intentar', async () => {
    respWallets = new Error('ETIMEDOUT');
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: true });

    respWallets = wallets({ clp: 0, usd: 0 });
    await expect(verificarPayoutEjecutable({ corridor: vita(), usdAmount: 9999 }))
      .resolves.toMatchObject({ ok: false });
  });
});
