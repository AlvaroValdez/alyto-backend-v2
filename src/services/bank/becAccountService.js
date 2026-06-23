/**
 * becAccountService.js — Consultas de cuenta Banco Económico (API Market v1.3.0 §8)
 *
 *   getBalance()             — saldo disponible de la cuenta de tesorería BOB
 *   getMovements(start, end) — extracto de movimientos por rango de fechas
 *   isAvailable()            — credenciales configuradas
 *
 * Endpoint: POST /api/accounts/queryMovements
 *   Request:  { accountCode (CIFRADO), startDate 'yyyy-MM-dd', endDate 'yyyy-MM-dd' }
 *   Response: { responseCode, message, accountHeader, accountDetailList, accountWithheldList }
 *
 * `accountCode` se cifra con AES (el doc marca el campo como "cifrado"). Usamos la
 * misma cuenta que recibe los QR de cobro (BEC_ACCOUNT_CREDIT) salvo que se defina
 * BEC_ACCOUNT_QUERY explícitamente.
 *
 * Habilita dos cosas que antes no teníamos del banco:
 *   1. Saldo real → pre-check de liquidez antes de dispersar (checkBOBLiquidity).
 *   2. Movimientos → conciliación automática de inflows BOB.
 */

import { logger } from '../../utils/logger.js';
import Sentry from '../sentry.js';
import { apiFetch, encryptAes, isAvailable as clientAvailable, isMockMode } from './becClient.js';

const queryAccount = () => process.env.BEC_ACCOUNT_QUERY ?? process.env.BEC_ACCOUNT_CREDIT;

// accountCode cifrado: no cambia dentro del proceso → cache tras el primer uso.
let _encryptedAccount = null;
function getEncryptedAccount() {
  if (!_encryptedAccount) _encryptedAccount = encryptAes(queryAccount());
  return _encryptedAccount;
}

/** @returns {boolean} credenciales + cuenta de consulta configuradas */
export function isAvailable() {
  return !!(clientAvailable() && queryAccount());
}

/** yyyy-MM-dd en hora local */
function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Consulta movimientos crudos por rango de fechas.
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<{ header: object|null, movements: object[], withheld: object[] }>}
 */
export async function getMovements(startDate, endDate) {
  if (isMockMode()) {
    logger.warn('[BEC] Mock mode — getMovements simulado (sin movimientos)');
    return { header: { balanceAvailable: null, currency: 'BOB', status: 'ACTIVA', _mock: true }, movements: [], withheld: [] };
  }

  const data = await apiFetch('/api/accounts/queryMovements', {
    method: 'POST',
    body:   JSON.stringify({
      accountCode: getEncryptedAccount(),
      startDate:   fmtDate(startDate),
      endDate:     fmtDate(endDate),
    }),
  });

  if (data.responseCode !== 0) throw new Error(`BEC queryMovements error: ${data.message}`);

  return {
    header:    data.accountHeader ?? null,
    movements: data.accountDetailList ?? [],
    withheld:  data.accountWithheldList ?? [],
  };
}

/**
 * Saldo disponible de la cuenta de tesorería BOB (consulta de movimientos del día,
 * el AccountHeader trae el saldo actual independientemente del rango).
 *
 * @returns {Promise<{ available: number|null, balance: number|null, currency: string|null, status: string|null, raw: object|null }>}
 */
export async function getBalance() {
  if (isMockMode()) {
    logger.warn('[BEC] Mock mode — getBalance simulado (available=null)');
    return { available: null, balance: null, currency: 'BOB', status: 'ACTIVA', raw: null, _mock: true };
  }

  const today = new Date();
  const { header } = await getMovements(today, today);
  if (!header) return { available: null, balance: null, currency: null, status: null, raw: null };

  return {
    available: header.balanceAvailable ?? null,  // saldo contable − reservado − retenido
    balance:   header.balance ?? null,
    currency:  header.currency ?? null,
    status:    header.status ?? null,
    raw:       header,
  };
}

/**
 * Lectura defensiva del saldo: nunca lanza (para usar en hooks fire-and-forget /
 * pre-checks que no deben romper el flujo si el banco no responde).
 * @returns {Promise<{ available: number|null, ok: boolean, error?: string }>}
 */
export async function tryGetAvailableBalance() {
  try {
    const { available } = await getBalance();
    return { available, ok: true };
  } catch (err) {
    Sentry.captureException(err, { tags: { service: 'becAccountService', fn: 'tryGetAvailableBalance' } });
    logger.error(`[BEC] tryGetAvailableBalance error: ${err.message}`);
    return { available: null, ok: false, error: err.message };
  }
}
