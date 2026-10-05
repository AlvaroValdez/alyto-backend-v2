/**
 * vitaRailResolver.test.js — Elección del riel de pago de Vita (usd | clp | auto)
 *
 * Sin BD ni HTTP: el resolver recibe la respuesta de /prices como argumento.
 * Los valores del fixture son del orden de los reales medidos el 2026-10-05,
 * elegidos para que el cruce de Costa Rica caiga en un monto cómodo de testear.
 */

import { jest } from '@jest/globals';
import '../setup.env.js';
import { resolveVitaRail, applyVitaRail } from '../../src/services/vitaRailResolver.js';

// 1 USD = 1000 CLP (clp_sell.us = 0.001)
//
//   CO  → vía CLP 3250,0 / vía USD 3219,25   → CLP gana por tasa Y por fijo
//   CR  → vía CLP  448,5 / vía USD  449,5343 → USD gana por tasa, CLP por fijo
//         (cruce ≈ 222 USD: debajo gana CLP, encima gana USD)
//   PL  → destino vita_sent: debe leerse de la sección vita_sent, no withdrawal
const PRICES = {
  clp: {
    withdrawal: { prices: { attributes: {
      valid_until: '2026-10-05T02:30:00.000Z',
      clp_sell:   { us: 0.001, co: 3.25, cr: 0.4485, cn: 7.0 },
      fixed_cost: { co: 3000, cr: 400, cn: 0 },
    } } },
    vita_sent: { prices: { attributes: {
      valid_until: '2026-10-05T02:30:00.000Z',
      clp_sell:   { pl: 0.00366 },
      fixed_cost: { pl: 5 },
    } } },
  },
  usd: {
    withdrawal: { prices: { attributes: {
      valid_until: '2026-10-05T02:30:00.000Z',
      usd_sell:   { co: 3219.25, cr: 449.5343, cnusd: 1.0 },
      fixed_cost: { co: 3495, cr: 630, cnusd: 1 },
    } } },
    vita_sent: { prices: { attributes: {
      valid_until: '2026-10-05T02:30:00.000Z',
      usd_sell:   { pl: 3.6 },
      fixed_cost: { pl: 5 },
    } } },
  },
};

const base = { destinationCountry: 'CO', destinationCurrency: 'COP', prices: PRICES };

describe('resolveVitaRail — modos fijos', () => {
  it("mode 'usd' usa la sección usd y su costo fijo", () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'usd' });
    expect(r.currency).toBe('usd');
    expect(r.rate).toBeCloseTo(3219.25, 4);
    expect(r.fixedCost).toBe(3495);
    expect(r.amountInCurrency).toBe(100);
    expect(r.netDestination).toBeCloseTo(100 * 3219.25 - 3495, 2);
  });

  it("mode 'clp' normaliza la tasa a destino-por-USD y convierte el monto a CLP", () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'clp' });
    expect(r.currency).toBe('clp');
    expect(r.rate).toBeCloseTo(3250, 4);          // 3.25 / 0.001
    expect(r.fixedCost).toBe(3000);
    expect(r.amountInCurrency).toBe(100000);      // 100 USD a 1000 CLP/USD
    expect(r.netDestination).toBeCloseTo(100 * 3250 - 3000, 2);
  });

  it('el default es usd — sin tocar nada, el comportamiento no cambia', () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100 });
    expect(r.currency).toBe('usd');
  });
});

describe('resolveVitaRail — auto compara el neto, no la tasa', () => {
  it('elige clp cuando gana por tasa y por fijo', () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'auto' });
    expect(r.currency).toBe('clp');
  });

  it('en CR elige clp con monto bajo, aunque la tasa sea peor', () => {
    const r = resolveVitaRail({
      ...base, destinationCountry: 'CR', destinationCurrency: 'CRC',
      amountUSD: 100, mode: 'auto',
    });
    expect(r.currency).toBe('clp');
    // 44.450 CRC vía CLP contra 44.323,43 vía USD
    expect(r.netDestination).toBeGreaterThan(
      r.considered.find(c => c.currency === 'usd').netDestination,
    );
  });

  it('en CR cambia a usd con monto alto — el fijo deja de compensar', () => {
    const r = resolveVitaRail({
      ...base, destinationCountry: 'CR', destinationCurrency: 'CRC',
      amountUSD: 1000, mode: 'auto',
    });
    expect(r.currency).toBe('usd');
  });

  it('deja traza de los dos rieles evaluados', () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'auto' });
    expect(r.considered.map(c => c.currency).sort()).toEqual(['clp', 'usd']);
  });
});

describe('resolveVitaRail — destinos vita_sent', () => {
  it('lee la sección vita_sent y no withdrawal', () => {
    const r = resolveVitaRail({
      destinationCountry: 'PL', destinationCurrency: 'EUR',
      amountUSD: 100, mode: 'auto', prices: PRICES,
    });
    expect(r.currency).toBe('clp');
    expect(r.rate).toBeCloseTo(3.66, 4);   // 0.00366 / 0.001, de clp.vita_sent
  });

  it('usa la clave vita_sent del país, no el mapa eurozona', () => {
    // PL está mapeado a 'eu' en VITA_COUNTRY_KEY_MAP, pero vita_sent usa 'pl'.
    const r = resolveVitaRail({
      destinationCountry: 'PL', destinationCurrency: 'EUR',
      amountUSD: 100, mode: 'usd', prices: PRICES,
    });
    expect(r.rate).toBeCloseTo(3.6, 4);
  });
});

describe('resolveVitaRail — claves por moneda de destino', () => {
  it('CN con destino USD usa cnusd en el riel usd y cn en el riel clp', () => {
    const usd = resolveVitaRail({
      destinationCountry: 'CN', destinationCurrency: 'USD',
      amountUSD: 100, mode: 'usd', prices: PRICES,
    });
    expect(usd.rate).toBeCloseTo(1.0, 4);        // usd_sell.cnusd

    const clp = resolveVitaRail({
      destinationCountry: 'CN', destinationCurrency: 'CNY',
      amountUSD: 100, mode: 'clp', prices: PRICES,
    });
    expect(clp.rate).toBeCloseTo(7000, 4);       // clp_sell.cn / 0.001
  });
});

describe('resolveVitaRail — saldo de Vita', () => {
  it('auto descarta el riel sin saldo y marca el elegido como fondeado', () => {
    // clp ganaría por neto, pero 1.306 CLP no cubren los 100.000 que haría falta
    const r = resolveVitaRail({
      ...base, amountUSD: 100, mode: 'auto',
      balances: { clp: 1306, usd: 500 },
    });
    expect(r.currency).toBe('usd');
    expect(r.funded).toBe(true);
  });

  it('si ningún riel tiene saldo devuelve el mejor con funded=false, no null', () => {
    const r = resolveVitaRail({
      ...base, amountUSD: 100, mode: 'auto',
      balances: { clp: 1306, usd: 22.89 },   // los saldos reales del 2026-10-05
    });
    expect(r).not.toBeNull();
    expect(r.currency).toBe('clp');          // el mejor por neto
    expect(r.funded).toBe(false);
  });

  it('sin balances no evalúa saldo (funded null)', () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'auto' });
    expect(r.funded).toBeNull();
  });
});

describe('resolveVitaRail — tasa CLP/USD congelada para el pay-out', () => {
  it('devuelve clpPerUsd en los dos rieles, para poder persistirla', () => {
    const clp = resolveVitaRail({ ...base, amountUSD: 100, mode: 'clp' });
    const usd = resolveVitaRail({ ...base, amountUSD: 100, mode: 'usd' });
    expect(clp.clpPerUsd).toBeCloseTo(1000, 4);   // 1 / 0.001
    expect(usd.clpPerUsd).toBeCloseTo(1000, 4);
  });

  it('el monto en CLP coincide con usdcAmount × clpPerUsd — la cuenta que hace el dispatch', () => {
    for (const amountUSD of [1, 37.5, 100, 2500.75]) {
      const r = resolveVitaRail({ ...base, amountUSD, mode: 'clp' });
      expect(r.amountInCurrency).toBe(Math.round(amountUSD * r.clpPerUsd));
    }
  });

  it('clpPerUsd es null si Vita no publica la sección clp', () => {
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'usd', prices: { usd: PRICES.usd } });
    expect(r.clpPerUsd).toBeNull();
  });
});

describe('resolveVitaRail — bordes', () => {
  it('cae al otro riel si Vita no publica la sección pedida', () => {
    const soloUsd = { usd: PRICES.usd };
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'clp', prices: soloUsd });
    expect(r.currency).toBe('usd');
  });

  it('auto sin monto válido no adivina: usa usd', () => {
    for (const amountUSD of [0, -5, NaN, undefined]) {
      const r = resolveVitaRail({ ...base, amountUSD, mode: 'auto' });
      expect(r.currency).toBe('usd');
    }
  });

  it('devuelve null si el destino no existe en los precios', () => {
    const r = resolveVitaRail({
      destinationCountry: 'ZZ', destinationCurrency: 'ZZZ',
      amountUSD: 100, mode: 'auto', prices: PRICES,
    });
    expect(r).toBeNull();
  });

  it('devuelve null sin país o sin precios', () => {
    expect(resolveVitaRail({ destinationCountry: '', amountUSD: 100, prices: PRICES })).toBeNull();
    expect(resolveVitaRail({ destinationCountry: 'CO', amountUSD: 100, prices: null })).toBeNull();
  });

  it('ignora un clp_sell.us ausente o cero en vez de dividir por cero', () => {
    const roto = {
      ...PRICES,
      clp: { ...PRICES.clp, withdrawal: { prices: { attributes: {
        clp_sell: { us: 0, co: 3.25 }, fixed_cost: { co: 3000 },
      } } } },
    };
    const r = resolveVitaRail({ ...base, amountUSD: 100, mode: 'clp', prices: roto });
    expect(r.currency).toBe('usd');   // el riel clp quedó inválido
  });
});

describe('applyVitaRail — segunda pasada compartida por el WS y los dos REST', () => {
  const corridorVita = {
    payoutMethod: 'vitaWallet', destinationCurrency: 'COP', vitaPayoutCurrency: 'clp',
  };
  // Primera pasada: cotizada con el riel usd (3219.25 / fija 3495)
  const quoteUsd = { digitalAssetAmount: 100, destinationAmount: 100 * 3219.25 - 3495 };
  const comun = {
    destinationCountry: 'CO', prices: PRICES,
    rate: 3219.25, fixedCost: 3495, validUntil: 'v1',
  };

  it('re-cotiza con el riel elegido y devuelve sus valores', () => {
    const rerun = (rate, fixedFee) => ({ digitalAssetAmount: 100, destinationAmount: 100 * rate - fixedFee });
    const out = applyVitaRail({ ...comun, quote: quoteUsd, corridor: corridorVita, rerun });
    expect(out.rail.currency).toBe('clp');
    expect(out.rate).toBeCloseTo(3250, 4);
    expect(out.fixedCost).toBe(3000);
    expect(out.quote.destinationAmount).toBeCloseTo(100 * 3250 - 3000, 2);
    expect(out.validUntil).toBe('2026-10-05T02:30:00.000Z');  // el del riel
  });

  it('no toca nada si el corredor no es vitaWallet', () => {
    const rerun = jest.fn();
    const out = applyVitaRail({
      ...comun, quote: quoteUsd, rerun,
      corridor: { payoutMethod: 'anchorBolivia', destinationCurrency: 'BOB' },
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(out.quote).toBe(quoteUsd);
    expect(out.rail).toBeNull();
  });

  it('no re-cotiza si el riel resuelto coincide con el ya usado', () => {
    const rerun = jest.fn();
    const out = applyVitaRail({
      ...comun, quote: quoteUsd, rerun,
      corridor: { ...corridorVita, vitaPayoutCurrency: 'usd' },
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(out.quote).toBe(quoteUsd);
    expect(out.rail.currency).toBe('usd');
  });

  it('mantiene la cotización anterior si el re-cálculo lanza', () => {
    const out = applyVitaRail({
      ...comun, quote: quoteUsd, corridor: corridorVita,
      rerun: () => { throw new Error('monto insuficiente'); },
    });
    expect(out.quote).toBe(quoteUsd);
    expect(out.rate).toBe(3219.25);
  });

  it('mantiene la anterior si el re-cálculo deja destino <= 0', () => {
    const out = applyVitaRail({
      ...comun, quote: quoteUsd, corridor: corridorVita,
      rerun: () => ({ digitalAssetAmount: 100, destinationAmount: 0 }),
    });
    expect(out.quote).toBe(quoteUsd);
    expect(out.rate).toBe(3219.25);
  });

  it('no hace nada sin USDC neto en la primera pasada', () => {
    const rerun = jest.fn();
    const out = applyVitaRail({
      ...comun, corridor: corridorVita, rerun,
      quote: { digitalAssetAmount: 0, destinationAmount: 0 },
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(out.rail).toBeNull();
  });

  it('traza la decisión por onLog', () => {
    const onLog = jest.fn();
    applyVitaRail({
      ...comun, quote: quoteUsd, corridor: corridorVita, onLog,
      rerun: (rate, fixedFee) => ({ digitalAssetAmount: 100, destinationAmount: 100 * rate - fixedFee }),
    });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('clp'), expect.objectContaining({ rate: 3250 }));
  });
});
