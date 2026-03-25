/**
 * fundingController.js — Gestión de Registros de Fondeo Manual
 *
 * Permite al admin registrar y consultar operaciones de fondeo de liquidez:
 * compras de USDC en Binance P2P, exchanges, transferencias bancarias, etc.
 *
 * Endpoints:
 *   POST /api/v1/admin/funding          — Registrar nuevo fondeo
 *   GET  /api/v1/admin/funding          — Listar fondeos con paginación y resumen
 *   GET  /api/v1/admin/funding/balance  — Balance estimado de liquidez por entidad
 */

import mongoose          from 'mongoose';
import FundingRecord     from '../models/FundingRecord.js';
import Transaction       from '../models/Transaction.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Genera un fundingId único con formato FUND-{ENTITY}-{timestamp}-{random}.
 */
function generateFundingId(entity) {
  const ts     = Date.now();
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FUND-${entity}-${ts}-${suffix}`;
}

/**
 * Calcula el equivalente en USD según el activo.
 * USDC/USDT/USD → 1:1. XLM → usa tasa de entorno o 0.12 como fallback.
 */
function calcUsdEquivalent(asset, amount, exchangeRate) {
  if (['USDC', 'USDT', 'USD'].includes(asset)) {
    return { usdEquivalent: amount, rate: 1 };
  }
  const rate = exchangeRate ?? parseFloat(process.env.XLM_USD_RATE ?? '0.12');
  return { usdEquivalent: parseFloat((amount * rate).toFixed(4)), rate };
}

// ─── POST /api/v1/admin/funding ──────────────────────────────────────────────

/**
 * Registra un nuevo fondeo de liquidez.
 *
 * Body:
 *   entity         {String}  — 'LLC' | 'SpA' | 'SRL'
 *   type           {String}  — 'binance_p2p' | 'exchange' | 'bank_transfer' | 'internal' | 'other'
 *   asset          {String}  — 'USDC' | 'USDT' | 'XLM' | 'USD'  (default: 'USDC')
 *   amount         {Number}  — Cantidad del activo digital recibida
 *   exchangeRate   {Number}  — (Opcional) Tasa para calcular usdEquivalent (solo para XLM)
 *   sourceCurrency {String}  — (Opcional) Moneda fiat de origen (ej. 'BOB')
 *   sourceAmount   {Number}  — (Opcional) Monto fiat pagado
 *   stellarTxId    {String}  — (Opcional) TXID Stellar
 *   binanceOrderId {String}  — (Opcional) ID orden Binance P2P
 *   bankReference  {String}  — (Opcional) Referencia transferencia bancaria
 *   note           {String}  — (Opcional) Nota descriptiva
 *   status         {String}  — (Opcional) 'confirmed' | 'pending' (default: 'confirmed')
 */
export async function createFunding(req, res) {
  try {
    const {
      entity,
      type,
      asset = 'USDC',
      amount,
      exchangeRate,
      sourceCurrency,
      sourceAmount,
      stellarTxId,
      binanceOrderId,
      bankReference,
      note,
      status = 'confirmed',
    } = req.body;

    // Validaciones básicas
    if (!entity || !type || amount == null) {
      return res.status(400).json({
        error: 'Faltan campos requeridos: entity, type, amount',
      });
    }

    if (!['LLC', 'SpA', 'SRL'].includes(entity)) {
      return res.status(400).json({ error: 'entity inválido. Usar: LLC | SpA | SRL' });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'amount debe ser mayor a 0' });
    }

    const { usdEquivalent, rate } = calcUsdEquivalent(asset, amount, exchangeRate);
    const fundingId = generateFundingId(entity);

    const record = await FundingRecord.create({
      fundingId,
      entity,
      type,
      asset,
      amount,
      usdEquivalent,
      exchangeRate: rate,
      sourceCurrency: sourceCurrency?.toUpperCase(),
      sourceAmount,
      stellarTxId,
      binanceOrderId,
      bankReference,
      note,
      registeredBy: req.user._id,
      status,
    });

    return res.status(201).json({
      success:    true,
      fundingId:  record.fundingId,
      entity:     record.entity,
      asset:      record.asset,
      amount:     record.amount,
      usdEquivalent: record.usdEquivalent,
      status:     record.status,
      createdAt:  record.createdAt,
    });
  } catch (err) {
    console.error('[Funding] Error al crear registro:', err);
    return res.status(500).json({ error: 'Error interno al registrar fondeo' });
  }
}

// ─── GET /api/v1/admin/funding ───────────────────────────────────────────────

/**
 * Lista fondeos con paginación, filtros y resumen agregado.
 *
 * Query params:
 *   entity     — 'LLC' | 'SpA' | 'SRL'
 *   asset      — 'USDC' | 'USDT' | 'XLM' | 'USD'
 *   type       — tipo de fondeo
 *   status     — 'confirmed' | 'pending' | 'cancelled'
 *   startDate  — ISO 8601
 *   endDate    — ISO 8601
 *   page       — default 1
 *   limit      — default 20, máx 100
 */
export async function listFunding(req, res) {
  try {
    const {
      entity,
      asset,
      type,
      status,
      startDate,
      endDate,
      page  = 1,
      limit = 20,
    } = req.query;

    const filter = {};
    if (entity)    filter.entity = entity;
    if (asset)     filter.asset  = asset;
    if (type)      filter.type   = type;
    if (status)    filter.status = status;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate)   filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    }

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [records, total, summary] = await Promise.all([
      FundingRecord.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('registeredBy', 'name email'),

      FundingRecord.countDocuments(filter),

      // Resumen solo sobre registros confirmados (con el mismo filtro de fechas/entidad)
      FundingRecord.aggregate([
        { $match: { ...filter, status: 'confirmed' } },
        {
          $group: {
            _id:            '$asset',
            totalAmount:    { $sum: '$amount' },
            totalUsdEquiv:  { $sum: '$usdEquivalent' },
            count:          { $sum: 1 },
          },
        },
      ]),
    ]);

    // Formatear resumen en objeto por asset
    const summaryByAsset = {};
    for (const s of summary) {
      summaryByAsset[s._id] = {
        totalAmount:   parseFloat(s.totalAmount.toFixed(4)),
        totalUsdEquiv: parseFloat(s.totalUsdEquiv.toFixed(4)),
        count:         s.count,
      };
    }

    return res.status(200).json({
      funding: records,
      pagination: {
        total,
        page:       pageNum,
        limit:      limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
      summary: {
        byAsset: summaryByAsset,
        totalFundedUSD: Object.values(summaryByAsset)
          .reduce((acc, s) => acc + s.totalUsdEquiv, 0),
      },
    });
  } catch (err) {
    console.error('[Funding] Error al listar registros:', err);
    return res.status(500).json({ error: 'Error interno al listar fondeos' });
  }
}

// ─── GET /api/v1/admin/funding/balance ──────────────────────────────────────

/**
 * Balance estimado de liquidez por entidad.
 *
 * Calcula:
 *   totalFunded  — suma de FundingRecords confirmados (USDC/USDT)
 *   totalPaidOut — suma de digitalAssetAmount en Transactions completadas
 *   available    — totalFunded - totalPaidOut
 *
 * Query params:
 *   entity — (Opcional) filtrar por entidad específica
 */
export async function getFundingBalance(req, res) {
  try {
    const { entity } = req.query;
    const entities = entity ? [entity] : ['LLC', 'SpA', 'SRL'];

    const [fundingAgg, payoutAgg] = await Promise.all([
      // Total fondeado confirmado por entidad y asset
      FundingRecord.aggregate([
        {
          $match: {
            status: 'confirmed',
            asset:  { $in: ['USDC', 'USDT', 'USD'] },
            ...(entity ? { entity } : {}),
          },
        },
        {
          $group: {
            _id:           '$entity',
            totalFundedUSDC: {
              $sum: {
                $cond: [{ $eq: ['$asset', 'USDC'] }, '$amount', 0],
              },
            },
            totalFundedUSDT: {
              $sum: {
                $cond: [{ $eq: ['$asset', 'USDT'] }, '$amount', 0],
              },
            },
            totalFundedUSD: {
              $sum: '$usdEquivalent',
            },
            lastFunding: { $max: '$createdAt' },
          },
        },
      ]),

      // Total pagado vía transacciones completadas por entidad
      Transaction.aggregate([
        {
          $match: {
            status: 'completed',
            ...(entity ? { legalEntity: entity } : {}),
          },
        },
        {
          $group: {
            _id:          '$legalEntity',
            totalPaidOut: { $sum: '$digitalAssetAmount' },
            txCount:      { $sum: 1 },
          },
        },
      ]),
    ]);

    // Indexar por entidad para lookup O(1)
    const fundingByEntity  = {};
    const payoutByEntity   = {};

    for (const f of fundingAgg)  fundingByEntity[f._id]  = f;
    for (const p of payoutAgg)   payoutByEntity[p._id]   = p;

    // Construir balance por entidad
    const balance = {};

    for (const ent of entities) {
      const f = fundingByEntity[ent]  ?? {};
      const p = payoutByEntity[ent]   ?? {};

      const totalFundedUSD  = parseFloat((f.totalFundedUSD  ?? 0).toFixed(4));
      const totalPaidOutUSD = parseFloat((p.totalPaidOut    ?? 0).toFixed(4));
      const available       = parseFloat((totalFundedUSD - totalPaidOutUSD).toFixed(4));

      balance[ent] = {
        totalFundedUSDC: parseFloat((f.totalFundedUSDC ?? 0).toFixed(4)),
        totalFundedUSDT: parseFloat((f.totalFundedUSDT ?? 0).toFixed(4)),
        totalFundedUSD,
        totalPaidOut:    totalPaidOutUSD,
        available,
        completedTxCount: p.txCount ?? 0,
        lastFunding:      f.lastFunding ?? null,
        alert: available < 0 ? 'DEFICIT — fondeo insuficiente para cubrir payouts' : null,
      };
    }

    return res.status(200).json({
      balance,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Funding] Error al calcular balance:', err);
    return res.status(500).json({ error: 'Error interno al calcular balance' });
  }
}
