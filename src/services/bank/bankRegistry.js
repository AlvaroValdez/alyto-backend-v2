/**
 * bankRegistry.js — Registro de adapters bancarios (bank-agnostic)
 *
 * Espejo de `bankQrRegistry`/`providerRegistry`: una capa de indirección para que
 * el código de admin/monitoreo NO sepa de BANECO en particular. Cada banco
 * implementa una interfaz común; sumar un banco = un archivo adapter + una línea acá.
 *
 * Interfaz del adapter:
 *   provider            : string
 *   isAvailable()       : boolean         — credenciales configuradas
 *   isMock()            : boolean         — opera en modo simulado
 *   getBalance()        : Promise<{ available, balance, currency, status, raw }>
 *   getMovements(a, b)  : Promise<{ header, movements[], withheld[] }>
 *   normalizeMovement(m): { externalTxId, date, time, direction, amount, currency, documentNumber, description, note, raw }
 *   capabilities        : { balance, movements, disburse }
 *
 * `normalizeMovement` traduce el formato crudo de cada banco a una forma común, para
 * que el extracto se muestre y se concilie igual sin importar el banco.
 */

import * as becAccount from './becAccountService.js';
import { isMockMode as becIsMock } from './becClient.js';

// ── Adapter: Banco Económico (BANECO / BEC) ─────────────────────────────────────
const banecoAdapter = {
  provider: 'baneco',
  capabilities: { balance: true, movements: true, disburse: false },

  isAvailable: () => becAccount.isAvailable(),
  isMock:      () => becIsMock(),
  getBalance:  () => becAccount.getBalance(),
  getMovements: (start, end) => becAccount.getMovements(start, end),

  /** Mapea un movimiento crudo de §8 queryMovements a la forma normalizada. */
  normalizeMovement(m, currency = 'BOB') {
    return {
      externalTxId:   m.transactionId ?? null,
      date:           m.date ?? null,
      time:           m.time ?? null,
      direction:      m.transactionType === 'C' ? 'credit' : 'debit',
      amount:         typeof m.amount === 'number' ? Math.abs(m.amount) : m.amount,
      signedAmount:   m.amount ?? null,
      currency,
      documentNumber: m.documentNumber ?? null,
      description:    m.description ?? null,
      note:           m.clienteNote ?? null,
      raw:            m,
    };
  },
};

// ── Registro ────────────────────────────────────────────────────────────────────
const adapters = {
  baneco: banecoAdapter,
};

/** @returns {object|null} adapter del proveedor, o null si no existe. */
export function getBankAdapter(provider) {
  return adapters[provider] ?? null;
}

/** @returns {string[]} proveedores con adapter implementado. */
export function listProviders() {
  return Object.keys(adapters);
}
