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
 *   tryGetAvailableBalance() : Promise<{ available, ok }>  — variante que no lanza
 *   getMovements(a, b)  : Promise<{ header, movements[], withheld[] }>
 *   normalizeMovement(m): { externalTxId, date, time, direction, amount, currency, documentNumber, description, note, raw }
 *   capabilities        : { balance, movements, disburse }
 *   disbursement        : bloque OPCIONAL de salida de dinero (ver abajo)
 *
 * `normalizeMovement` traduce el formato crudo de cada banco a una forma común, para
 * que el extracto se muestre y se concilie igual sin importar el banco.
 *
 * ── Bloque `disbursement` (opcional) ────────────────────────────────────────────
 *   transfer(p)           : Promise<{ bankBatchId, _mock? }>  — ordena la salida
 *   verifyNotifyStatus(r) : { ok, reason }                    — autentica el webhook
 *   mapNotifyStatus(s)    : 'accepted' | 'rejected' | 'unknown'
 *   isAvailable()         : boolean — credenciales + cuenta de débito
 *   isEnabled()           : boolean — gate de dispersión REAL (si no, simula)
 *
 * ⚠️ `capabilities.disburse` y la presencia de `disbursement` responden preguntas
 * DISTINTAS y pueden no coincidir:
 *   - `capabilities.disburse` = ¿el banco ofrece hoy el riel de dispersión?
 *     Gobierna qué acciones muestra el admin. BANECO = false: confirmó el 2026-06-25
 *     que §9 Planillas no está desarrollada, sin fecha (ver docs/ADMIN_BANK_MONITORING.md).
 *   - `disbursement` presente = ¿tenemos el cliente escrito para hablar ese riel?
 *     BANECO sí lo tiene (becDisbursementService, gated OFF + mock), y es lo que permite
 *     ejercitar el flujo completo de retiro en staging sin mover dinero.
 * El despacho de un retiro resuelve por el bloque `disbursement`; el gate de dinero
 * real sigue siendo `isEnabled()` dentro de cada servicio.
 */

import * as becAccount from './becAccountService.js';
import * as becDisbursement from './becDisbursementService.js';
import { isMockMode as becIsMock } from './becClient.js';
import * as redenlaceDisbursement from './redenlaceDisbursementService.js';
import { isMockMode as redenlaceIsMock } from './redenlaceClient.js';

// ── Adapter: Banco Económico (BANECO / BEC) ─────────────────────────────────────
const banecoAdapter = {
  provider: 'baneco',
  capabilities: { balance: true, movements: true, disburse: false },

  isAvailable: () => becAccount.isAvailable(),
  isMock:      () => becIsMock(),
  getBalance:  () => becAccount.getBalance(),
  tryGetAvailableBalance: () => becAccount.tryGetAvailableBalance(),
  getMovements: (start, end) => becAccount.getMovements(start, end),

  /** §9 Planillas — escrito y validado en mock; el riel del banco aún no existe. */
  disbursement: {
    transfer:           (p)   => becDisbursement.transfer(p),
    verifyNotifyStatus: (req) => becDisbursement.verifyNotifyStatus(req),
    mapNotifyStatus:    (s)   => becDisbursement.mapNotifyStatus(s),
    isAvailable:        ()    => becDisbursement.isAvailable(),
    isEnabled:          ()    => becDisbursement.isEnabled(),
  },

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

// ── Adapter: ATC S.A. (Red Enlace) ─────────────────────────────────────────────
//
// Solo dispersión. El cobro por QR vive en el otro registro (`bankQrRegistry`),
// que es donde el resto del sistema lo busca.
//
// `balance` y `movements` quedan en false porque el producto que los da
// (`/cuentas-comercios/v1/*`, cuentas de comercio y saldos) todavía no está
// integrado. Cuando lo esté, el pre-check de liquidez del despacho pasa a
// consultar el `saldoDisponible` neto de retenciones, que es mejor número que
// el que da BANECO.
const redenlaceAdapter = {
  provider: 'redenlace',
  capabilities: { balance: false, movements: false, disburse: true },

  isAvailable: () => redenlaceDisbursement.isAvailable(),
  isMock:      () => redenlaceIsMock(),

  /** Pay Out Asíncrono — lote ACH a cuenta bancaria. */
  disbursement: {
    transfer:           (p)   => redenlaceDisbursement.transfer(p),
    verifyNotifyStatus: (req) => redenlaceDisbursement.verifyNotifyStatus(req),
    normalizeNotify:    (req) => redenlaceDisbursement.normalizeNotify(req),
    mapNotifyStatus:    (s)   => redenlaceDisbursement.mapNotifyStatus(s),
    isAvailable:        ()    => redenlaceDisbursement.isAvailable(),
    isEnabled:          ()    => redenlaceDisbursement.isEnabled(),
    listBanks:          ()    => redenlaceDisbursement.listBanks(),

    /**
     * Consulta autoritativa de estado. Es lo que BANECO no tiene, y por eso allá
     * la red de seguridad solo puede alertar a un admin, mientras que acá puede
     * resolver el retiro atascado preguntándole al banco.
     */
    getBatchStatus:     (p)   => redenlaceDisbursement.getBatchStatus(p),
  },
};

// ── Registro ────────────────────────────────────────────────────────────────────
const adapters = {
  baneco:    banecoAdapter,
  redenlace: redenlaceAdapter,
};

/** @returns {object|null} adapter del proveedor, o null si no existe. */
export function getBankAdapter(provider) {
  return adapters[provider] ?? null;
}

/** @returns {string[]} proveedores con adapter implementado. */
export function listProviders() {
  return Object.keys(adapters);
}

/**
 * Proveedor de dispersión por defecto para los retiros a cuenta bancaria.
 * Se lee dentro de la función (regla 21): un `const` de módulo capturaría el valor
 * previo a la carga de Secrets Manager y caería al default en silencio.
 * @returns {string}
 */
export function resolveDisbursementProvider() {
  return process.env.WALLET_DISBURSEMENT_PROVIDER || 'baneco';
}

/**
 * Resuelve el adapter que debe ejecutar una salida de dinero.
 * @param {string} [provider] — si se omite, usa `resolveDisbursementProvider()`.
 * @returns {{ provider: string, adapter: object, disbursement: object }|null}
 *          null si el proveedor no existe o no tiene cliente de dispersión escrito.
 */
export function getDisbursementAdapter(provider) {
  const name    = provider ?? resolveDisbursementProvider();
  const adapter = adapters[name];
  if (!adapter?.disbursement?.transfer) return null;
  return { provider: name, adapter, disbursement: adapter.disbursement };
}

/** @returns {string[]} proveedores con cliente de dispersión escrito. */
export function listDisbursementProviders() {
  return Object.keys(adapters).filter((k) => adapters[k]?.disbursement?.transfer);
}
