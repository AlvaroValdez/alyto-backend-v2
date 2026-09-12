/**
 * stellarRetry.test.js — Reintento del sello on-chain.
 *
 * Acredita el endurecimiento declarado ante ASFI: el sello de existencia en la red no
 * se rinde ante un fallo transitorio de Horizon. Prueba la clasificación de errores y
 * el motor de reintento de forma pura (sin red ni temporizadores reales).
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const { submitWithRetry, isRetriableStellarError } =
  await import('../../src/services/stellarService.js');

const mkTxCode = (t) => ({ response: { status: 400, data: { extras: { result_codes: { transaction: t } } } } });
const noSleep  = () => Promise.resolve();

describe('isRetriableStellarError — transitorio vs permanente', () => {
  it('fallo de red sin respuesta HTTP es transitorio', () => {
    expect(isRetriableStellarError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetriableStellarError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetriableStellarError({ message: 'socket hang up' })).toBe(true);
  });

  it('429 y 5xx son transitorios', () => {
    expect(isRetriableStellarError({ response: { status: 429 } })).toBe(true);
    expect(isRetriableStellarError({ response: { status: 503 } })).toBe(true);
  });

  it('tx_bad_seq / tx_too_late / tx_insufficient_fee son transitorios', () => {
    expect(isRetriableStellarError(mkTxCode('tx_bad_seq'))).toBe(true);
    expect(isRetriableStellarError(mkTxCode('tx_too_late'))).toBe(true);
    expect(isRetriableStellarError(mkTxCode('tx_insufficient_fee'))).toBe(true);
  });

  it('tx_bad_auth, malformados y falta de saldo son permanentes', () => {
    expect(isRetriableStellarError(mkTxCode('tx_bad_auth'))).toBe(false);
    expect(isRetriableStellarError(mkTxCode('tx_failed'))).toBe(false);
    expect(isRetriableStellarError(mkTxCode('tx_insufficient_balance'))).toBe(false);
    expect(isRetriableStellarError({ response: { status: 400 } })).toBe(false);
    expect(isRetriableStellarError(null)).toBe(false);
  });
});

describe('submitWithRetry — reintenta transitorios, no permanentes', () => {
  it('éxito al primer intento: una sola llamada', async () => {
    const fn = jest.fn().mockResolvedValue({ hash: 'ok' });
    const r = await submitWithRetry(fn, { sleep: noSleep });
    expect(r.hash).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('un transitorio y luego éxito: reintenta y devuelve el resultado', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue({ hash: 'ok2' });
    const r = await submitWithRetry(fn, { sleep: noSleep, maxAttempts: 3 });
    expect(r.hash).toBe('ok2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('error permanente: NO reintenta y repropaga', async () => {
    const err = mkTxCode('tx_bad_auth');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(submitWithRetry(fn, { sleep: noSleep, maxAttempts: 3 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('transitorio persistente: agota maxAttempts y repropaga el último error', async () => {
    const err = { code: 'ECONNRESET' };
    const fn = jest.fn().mockRejectedValue(err);
    await expect(submitWithRetry(fn, { sleep: noSleep, maxAttempts: 3 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
