/**
 * vitaBalances.test.js — Lectura de saldos prefondeados de Vita
 *
 * Alimenta el pre-check de liquidez del pay-out: Vita no mueve USDC, debita un
 * saldo prefondeado y en la moneda que se le pide, así que mirar un total no
 * sirve — hay que mirar la moneda del riel.
 */

import '../setup.env.js';
import { extractVitaBalances } from '../../src/services/vitaWalletService.js';

// Forma real devuelta por GET /wallets el 2026-10-05
const WALLETS = {
  wallets: [{
    uuid: '4a2de283-7db9-4812-b822-3ef4bab1cfe0',
    type: 'business_wallet',
    attributes: {
      token: 'master',
      is_master: true,
      balances: { clp: 1306, usdc: 0, usd: 22.89, usdt: 0, cop: 13531 },
    },
  }],
  total: 1,
  count: 1,
};

describe('extractVitaBalances', () => {
  it('devuelve los saldos de la wallet maestra', () => {
    expect(extractVitaBalances(WALLETS)).toEqual({
      clp: 1306, usdc: 0, usd: 22.89, usdt: 0, cop: 13531,
    });
  });

  it('elige la maestra aunque no sea la primera', () => {
    const r = extractVitaBalances({
      wallets: [
        { attributes: { is_master: false, balances: { usd: 1 } } },
        { attributes: { is_master: true,  balances: { usd: 999 } } },
      ],
    });
    expect(r.usd).toBe(999);
  });

  it('cae a la primera si ninguna está marcada como maestra', () => {
    const r = extractVitaBalances({ wallets: [{ attributes: { balances: { usd: 7 } } }] });
    expect(r.usd).toBe(7);
  });

  it('acepta la respuesta envuelta en data', () => {
    const r = extractVitaBalances({ data: [{ attributes: { is_master: true, balances: { clp: 50 } } }] });
    expect(r.clp).toBe(50);
  });

  it('devuelve null si no hay wallets o la forma no es la esperada', () => {
    for (const v of [null, undefined, {}, { wallets: [] }, { wallets: 'nope' }]) {
      expect(extractVitaBalances(v)).toBeNull();
    }
  });

  it('devuelve null si la maestra no trae balances', () => {
    expect(extractVitaBalances({ wallets: [{ attributes: { is_master: true } }] })).toBeNull();
  });
});

describe('extractVitaBalances — el caso que motiva el pre-check', () => {
  it('con los saldos reales, un envío de 100 USD no alcanza por ninguna vía', () => {
    const b = extractVitaBalances(WALLETS);
    expect(b.usd).toBeLessThan(100);          // 22,89 USD
    expect(b.clp).toBeLessThan(100 * 986);    // 1.306 CLP contra ~98.600 necesarios
  });

  it('un saldo en cero es un saldo leído, no un fallo de lectura', () => {
    // Importa para el pre-check: 0 debe bloquear con pending_funding, no caer
    // al fail-open que se reserva para cuando NO se pudo leer.
    const b = extractVitaBalances(WALLETS);
    expect(b.usdc).toBe(0);
    expect(b.usdc).not.toBeNull();
  });
});
