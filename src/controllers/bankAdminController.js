/**
 * bankAdminController.js — Monitoreo bancario en admin (Fase 1, read-only)
 *
 * Expone en el panel admin TODO lo concerniente a los bancos de tesorería (hoy
 * Banco Económico), de forma bank-agnostic vía `bankRegistry`:
 *   - GET  /admin/banks                       — registro de cuentas bancarias
 *   - GET  /admin/banks/:code/balance         — saldo en vivo (§8, cacheado)
 *   - GET  /admin/banks/:code/movements       — extracto normalizado (§8)
 *   - GET  /admin/treasury/coverage           — tesorería vs pasivo a usuarios (BOB+USDC)
 *   - GET  /admin/users/:userId/wallet-summary — saldos + movimientos del usuario
 *
 * Atribución por usuario: la verdad de "qué le corresponde a cada usuario" vive en
 * WalletBOB/WalletUSDC/WalletTransaction. El banco es una pool única; la vista de
 * cobertura enfrenta el saldo del banco contra la suma de saldos de los usuarios
 * (solvencia/colateralización — compromiso dual-ledger ASFI).
 *
 * Read-only: ninguna acción muta saldos. Diseñado para reusarse con otros bancos
 * (visión anchor on-ramp / off-ramp Bolivia) — sumar banco = fila BankAccount + adapter.
 */

import mongoose from 'mongoose';
import Sentry from '../services/sentry.js';
import { logger } from '../utils/logger.js';
import BankAccount from '../models/BankAccount.js';
import WalletBOB from '../models/WalletBOB.js';
import WalletUSDC from '../models/WalletUSDC.js';
import WalletTransaction from '../models/WalletTransaction.js';
import { getBankAdapter } from '../services/bank/bankRegistry.js';

// ── Cache de saldo (evita martillar la API del banco) ───────────────────────────
const BALANCE_TTL_MS = Number(process.env.BANK_BALANCE_CACHE_MS ?? 30_000);
const _balanceCache = new Map(); // code → { data, exp }

/**
 * Seed idempotente del registro BANECO. Se ejecuta lazy (al listar bancos) para no
 * requerir migración. La cuenta se toma de las env de BANECO ya configuradas.
 */
export async function ensureDefaultBankAccounts() {
  const accountNumber = process.env.BEC_ACCOUNT_QUERY ?? process.env.BEC_ACCOUNT_CREDIT ?? null;
  await BankAccount.updateOne(
    { code: 'BEC-SRL-BOB' },
    {
      $setOnInsert: {
        code:          'BEC-SRL-BOB',
        provider:      'baneco',
        bankName:      process.env.SRL_BANK_NAME ?? 'Banco Económico',
        bankCode:      process.env.BEC_BANK_CODE ?? null,
        accountNumber: accountNumber ?? '—',
        accountType:   'CA',
        currency:      'BOB',
        country:       'BO',
        legalEntity:   'SRL',
        roles:         ['treasury', 'onramp'], // off-ramp aún no (BANECO sin dispersión)
        capabilities:  { balance: true, movements: true, disburse: false, payinQr: true },
        status:        'active',
      },
    },
    { upsert: true },
  );
}

// ── GET /admin/banks ────────────────────────────────────────────────────────────
export async function listBanks(req, res) {
  try {
    await ensureDefaultBankAccounts();
    const banks = await BankAccount.find().sort({ createdAt: 1 }).lean();

    // Adjunta estado del adapter (disponible / mock) sin consultar saldo.
    const enriched = banks.map((b) => {
      const adapter = getBankAdapter(b.provider);
      return {
        ...b,
        adapter: adapter
          ? { available: adapter.isAvailable(), mock: adapter.isMock(), capabilities: adapter.capabilities }
          : { available: false, mock: true, capabilities: null, missing: true },
      };
    });

    return res.json({ banks: enriched });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'bankAdminController', fn: 'listBanks' } });
    logger.error(`[bankAdmin] listBanks: ${err.message}`);
    return res.status(500).json({ error: 'Error al listar bancos.' });
  }
}

/** Resuelve la cuenta bancaria + adapter o responde el error correspondiente. */
async function resolveBankOr404(code, res) {
  const bank = await BankAccount.findOne({ code }).lean();
  if (!bank) {
    res.status(404).json({ error: 'Cuenta bancaria no encontrada.' });
    return null;
  }
  const adapter = getBankAdapter(bank.provider);
  if (!adapter) {
    res.status(501).json({ error: `Sin adapter para el proveedor '${bank.provider}'.` });
    return null;
  }
  return { bank, adapter };
}

// ── GET /admin/banks/:code/balance ──────────────────────────────────────────────
export async function getBankBalance(req, res) {
  try {
    const { code } = req.params;
    const resolved = await resolveBankOr404(code, res);
    if (!resolved) return;
    const { bank, adapter } = resolved;

    if (!adapter.capabilities.balance) {
      return res.status(400).json({ error: `El banco ${bank.bankName} no expone consulta de saldo.` });
    }

    // Cache corto salvo ?fresh=1
    const cached = _balanceCache.get(code);
    if (!req.query.fresh && cached && Date.now() < cached.exp) {
      return res.json({ ...cached.data, cached: true });
    }

    const bal = await adapter.getBalance();
    const data = {
      bank:       { code: bank.code, bankName: bank.bankName, accountNumber: bank.accountNumber, currency: bank.currency },
      available:  bal.available,
      balance:    bal.balance,
      reserved:   bal.raw?.balanceReserved ?? null,
      retained:   bal.raw?.balanceRetained ?? null,
      currency:   bal.currency ?? bank.currency,
      status:     bal.status,
      mock:       adapter.isMock(),
      checkedAt:  new Date().toISOString(),
    };
    _balanceCache.set(code, { data, exp: Date.now() + BALANCE_TTL_MS });
    return res.json({ ...data, cached: false });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'bankAdminController', fn: 'getBankBalance' } });
    logger.error(`[bankAdmin] getBankBalance: ${err.message}`);
    return res.status(502).json({ error: 'Error consultando saldo del banco.' });
  }
}

// ── GET /admin/banks/:code/movements?from=&to= ──────────────────────────────────
export async function getBankMovements(req, res) {
  try {
    const { code } = req.params;
    const resolved = await resolveBankOr404(code, res);
    if (!resolved) return;
    const { bank, adapter } = resolved;

    if (!adapter.capabilities.movements) {
      return res.status(400).json({ error: `El banco ${bank.bankName} no expone extracto de movimientos.` });
    }

    // Rango: por defecto últimos 7 días. Tope defensivo de 90 días.
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Parámetros from/to inválidos (usar yyyy-MM-dd).' });
    }

    const { header, movements, withheld } = await adapter.getMovements(from, to);
    const normalized = movements.map((m) => adapter.normalizeMovement(m, bank.currency));

    // Totales del rango (créditos/débitos) para la cabecera del extracto.
    const totals = normalized.reduce(
      (acc, m) => {
        if (m.direction === 'credit') { acc.credits += m.amount; acc.creditCount++; }
        else { acc.debits += m.amount; acc.debitCount++; }
        return acc;
      },
      { credits: 0, debits: 0, creditCount: 0, debitCount: 0 },
    );

    return res.json({
      bank:       { code: bank.code, bankName: bank.bankName, accountNumber: bank.accountNumber, currency: bank.currency },
      range:      { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      header,
      totals,
      count:      normalized.length,
      movements:  normalized,
      withheld,
      mock:       adapter.isMock(),
      checkedAt:  new Date().toISOString(),
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'bankAdminController', fn: 'getBankMovements' } });
    logger.error(`[bankAdmin] getBankMovements: ${err.message}`);
    return res.status(502).json({ error: 'Error consultando movimientos del banco.' });
  }
}

// ── GET /admin/treasury/coverage ────────────────────────────────────────────────
// Enfrenta el saldo de tesorería (banco para BOB, Stellar para USDC) contra la suma
// de saldos de los usuarios → ratio de cobertura/solvencia (compromiso ASFI).
export async function getTreasuryCoverage(req, res) {
  try {
    const entity = req.query.entity ?? 'SRL';

    // Pasivo a usuarios (lo que Alyto debe): Σ saldos por moneda.
    const [bobAgg, usdcAgg] = await Promise.all([
      WalletBOB.aggregate([
        { $match: { legalEntity: entity } },
        { $group: {
            _id: null,
            balance:  { $sum: '$balance' },
            frozen:   { $sum: '$balanceFrozen' },
            reserved: { $sum: '$balanceReserved' },
            wallets:  { $sum: 1 },
        } },
      ]),
      WalletUSDC.aggregate([
        { $match: { legalEntity: entity } },
        { $group: {
            _id: null,
            balance:  { $sum: '$balance' },
            frozen:   { $sum: '$balanceFrozen' },
            reserved: { $sum: '$balanceReserved' },
            wallets:  { $sum: 1 },
        } },
      ]),
    ]);

    const bobLiab  = bobAgg[0]  ?? { balance: 0, frozen: 0, reserved: 0, wallets: 0 };
    const usdcLiab = usdcAgg[0] ?? { balance: 0, frozen: 0, reserved: 0, wallets: 0 };

    // Tesorería BOB: saldo en vivo del banco (best-effort, no rompe si el banco falla).
    let bobTreasury = { available: null, source: 'unavailable', mock: null };
    const bobBank = await BankAccount.findOne({ provider: 'baneco', currency: 'BOB', status: 'active' }).lean();
    if (bobBank) {
      const adapter = getBankAdapter(bobBank.provider);
      if (adapter?.capabilities.balance) {
        try {
          const bal = await adapter.getBalance();
          bobTreasury = { available: bal.available, balance: bal.balance, source: 'bank', mock: adapter.isMock(), account: bobBank.accountNumber };
        } catch (e) {
          bobTreasury = { available: null, source: 'bank-error', error: e.message };
        }
      }
    }

    // Tesorería USDC: saldo on-chain de la wallet Stellar de la entidad (best-effort).
    let usdcTreasury = { available: null, source: 'unavailable' };
    try {
      const { getStellarUSDCBalance } = await import('../services/stellarService.js');
      const pubKey = entity === 'LLC' ? process.env.STELLAR_LLC_PUBLIC_KEY : process.env.STELLAR_SRL_PUBLIC_KEY;
      if (pubKey) {
        const usdc = await getStellarUSDCBalance(pubKey);
        usdcTreasury = { available: usdc, source: 'stellar', publicKey: pubKey };
      }
    } catch (e) {
      usdcTreasury = { available: null, source: 'stellar-error', error: e.message };
    }

    const ratio = (treasury, liability) =>
      (treasury == null || liability == null || liability === 0) ? null : Number((treasury / liability).toFixed(4));

    // Estado de solvencia explícito por activo. 'undercollateralized' = la tesorería
    // NO alcanza a cubrir el pasivo a usuarios → alerta dura (compromiso dual-ledger
    // ASFI). 'unknown' = no pudimos leer la tesorería (banco/Stellar caído) → NO afirmar
    // que está cubierto. 'no_liability' = no hay saldo de usuarios que cubrir.
    const solvency = (treasuryAvail, liabBalance) => {
      if (treasuryAvail == null) return 'unknown';
      if (liabBalance === 0)     return 'no_liability';
      return treasuryAvail >= liabBalance ? 'covered' : 'undercollateralized';
    };

    const bobStatus  = solvency(bobTreasury.available,  bobLiab.balance);
    const usdcStatus = solvency(usdcTreasury.available, usdcLiab.balance);
    const undercollateralized = [bobStatus, usdcStatus].filter(s => s === 'undercollateralized');

    return res.json({
      entity,
      // Bandera de alerta agregada para que el FE (y futuros jobs/notifs) reaccionen.
      alert: undercollateralized.length > 0,
      bob: {
        treasury:    bobTreasury,
        liabilities: bobLiab,
        coverageRatio: ratio(bobTreasury.available, bobLiab.balance),
        surplus:       bobTreasury.available != null ? Number((bobTreasury.available - bobLiab.balance).toFixed(2)) : null,
        status:        bobStatus,
      },
      usdc: {
        treasury:    usdcTreasury,
        liabilities: usdcLiab,
        coverageRatio: ratio(usdcTreasury.available, usdcLiab.balance),
        surplus:       usdcTreasury.available != null ? Number((usdcTreasury.available - usdcLiab.balance).toFixed(6)) : null,
        status:        usdcStatus,
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'bankAdminController', fn: 'getTreasuryCoverage' } });
    logger.error(`[bankAdmin] getTreasuryCoverage: ${err.message}`);
    return res.status(500).json({ error: 'Error calculando cobertura de tesorería.' });
  }
}

// ── GET /admin/users/:userId/wallet-summary ─────────────────────────────────────
export async function getUserWalletSummary(req, res) {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'userId inválido.' });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10)));

    const [walletBOB, walletUSDC, movements] = await Promise.all([
      WalletBOB.findOne({ userId }).lean(),
      WalletUSDC.findOne({ userId }).lean(),
      WalletTransaction.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    // Acumulados de por-vida por moneda (entradas vs salidas confirmadas).
    const lifetime = await WalletTransaction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId), status: 'completed' } },
      { $group: { _id: { currency: '$currency', type: '$type' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    return res.json({
      userId,
      balances: {
        bob:  walletBOB  ? { balance: walletBOB.balance,  frozen: walletBOB.balanceFrozen,  reserved: walletBOB.balanceReserved,  status: walletBOB.status }  : null,
        usdc: walletUSDC ? { balance: walletUSDC.balance, frozen: walletUSDC.balanceFrozen, reserved: walletUSDC.balanceReserved, status: walletUSDC.status } : null,
      },
      lifetime,
      movements,
      count: movements.length,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'bankAdminController', fn: 'getUserWalletSummary' } });
    logger.error(`[bankAdmin] getUserWalletSummary: ${err.message}`);
    return res.status(500).json({ error: 'Error al obtener el resumen del usuario.' });
  }
}

export default {
  ensureDefaultBankAccounts,
  listBanks,
  getBankBalance,
  getBankMovements,
  getTreasuryCoverage,
  getUserWalletSummary,
};
