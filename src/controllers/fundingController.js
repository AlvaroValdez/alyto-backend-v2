/**
 * fundingController.js — Gestión de Registros de Fondeo Manual
 *
 * Permite al admin registrar y consultar operaciones de fondeo de liquidez:
 * compras de USDC en Binance P2P, exchanges, transferencias bancarias, etc.
 *
 * Endpoints:
 *   POST /api/v1/admin/funding           — Registrar nuevo fondeo
 *   GET  /api/v1/admin/funding           — Listar fondeos con paginación y resumen
 *   GET  /api/v1/admin/funding/balance   — Balance estimado de liquidez por entidad
 *   GET  /api/v1/admin/funding/forecast  — Previsión USDC: balance Stellar vs compromisos pendientes
 */

import mongoose               from 'mongoose';
import FundingRecord          from '../models/FundingRecord.js';
import FundingIntent          from '../models/FundingIntent.js';
import Transaction            from '../models/Transaction.js';
import { getStellarUSDCBalance, getStellarXLMBalance } from '../services/stellarService.js';
import { generateStellarPayQR }  from '../services/qrService.js';
import { generarNumeroCorrelativo } from '../utils/correlativoService.js';
import { ASSETS }             from '../config/stellar.js';

// Dirección de tesorería por entidad (wallet Stellar corporativa).
const TREASURY_ADDRESS = {
  LLC: () => process.env.STELLAR_LLC_PUBLIC_KEY,
  SpA: () => process.env.STELLAR_SPA_PUBLIC_KEY,
  SRL: () => process.env.STELLAR_SRL_PUBLIC_KEY,
};

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

    // Cuando llega USDC confirmado, intentar liberar payouts en espera de liquidez
    if (asset === 'USDC' && record.status === 'confirmed') {
      setImmediate(() =>
        retryPendingFundingTransactions(entity).catch((e) =>
          console.error('[Funding] Auto-retry error post-fondeo:', e.message)
        )
      );
    }

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

    // Para SRL y LLC el disponible real viene de Stellar (blockchain es la verdad).
    // SpA usa Vita/USD — sigue usando el cálculo contable de FundingRecord.
    const STELLAR_ENTITIES = ['SRL', 'LLC'];
    const stellarPubKeys = {
      SRL: process.env.STELLAR_SRL_PUBLIC_KEY,
      LLC: process.env.STELLAR_LLC_PUBLIC_KEY,
    };

    const [fundingAgg, payoutAgg, ...stellarBalances] = await Promise.all([
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
            totalFundedUSDC: { $sum: { $cond: [{ $eq: ['$asset', 'USDC'] }, '$amount', 0] } },
            totalFundedUSDT: { $sum: { $cond: [{ $eq: ['$asset', 'USDT'] }, '$amount', 0] } },
            totalFundedUSD:  { $sum: '$usdEquivalent' },
            lastFunding:     { $max: '$createdAt' },
          },
        },
      ]),

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

      // Stellar live balance para cada entidad on-chain (en paralelo, silent si falla)
      ...STELLAR_ENTITIES
        .filter(e => !entity || e === entity)
        .map(e =>
          getStellarUSDCBalance(stellarPubKeys[e])
            .then(bal => ({ entity: e, balance: bal }))
            .catch(() => ({ entity: e, balance: null }))
        ),
    ]);

    const fundingByEntity = {};
    const payoutByEntity  = {};
    const stellarByEntity = {};

    for (const f of fundingAgg)   fundingByEntity[f._id]  = f;
    for (const p of payoutAgg)    payoutByEntity[p._id]   = p;
    for (const s of stellarBalances) stellarByEntity[s.entity] = s.balance;

    const balance = {};

    for (const ent of entities) {
      const f = fundingByEntity[ent] ?? {};
      const p = payoutByEntity[ent]  ?? {};

      const totalFundedUSD  = parseFloat((f.totalFundedUSD ?? 0).toFixed(4));
      const totalPaidOutUSD = parseFloat((p.totalPaidOut   ?? 0).toFixed(4));

      // SRL/LLC: disponible = balance Stellar live (fuente de verdad blockchain).
      // SpA: disponible = FundingRecord (no tiene wallet Stellar propia para pagos).
      const stellarLive = stellarByEntity[ent] ?? null;
      const available   = STELLAR_ENTITIES.includes(ent) && stellarLive !== null
        ? parseFloat(stellarLive.toFixed(4))
        : parseFloat((totalFundedUSD - totalPaidOutUSD).toFixed(4));

      balance[ent] = {
        totalFundedUSDC:  parseFloat((f.totalFundedUSDC ?? 0).toFixed(4)),
        totalFundedUSDT:  parseFloat((f.totalFundedUSDT ?? 0).toFixed(4)),
        totalFundedUSD,
        totalPaidOut:     totalPaidOutUSD,
        available,
        stellarLive,
        source:           STELLAR_ENTITIES.includes(ent) && stellarLive !== null ? 'stellar' : 'accounting',
        completedTxCount: p.txCount ?? 0,
        lastFunding:      f.lastFunding ?? null,
        alert:            available < 100 ? 'Saldo bajo — considerar fondeo' : null,
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

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Reintenta dispatchPayout en orden FIFO sobre todas las transacciones 'pending_funding'
 * de una entidad. Se llama async (setImmediate) tras registrar nuevo fondeo USDC confirmado.
 *
 * Se detiene en la primera tx que queda en pending_funding (balance aún insuficiente).
 */
export async function retryPendingFundingTransactions(entity) {
  const pendingTxs = await Transaction.find(
    { legalEntity: entity, status: 'pending_funding' },
    null,
    { sort: { createdAt: 1 } }
  );

  if (!pendingTxs.length) return;

  console.log(`[Funding] Auto-retry: ${pendingTxs.length} tx(s) pending_funding para ${entity}`);

  // Import dinámico para evitar dependencia circular en carga del módulo
  const { dispatchPayout } = await import('./ipnController.js');

  for (const tx of pendingTxs) {
    console.log('[Funding] Auto-retry → dispatchPayout:', tx.alytoTransactionId);
    try {
      // Re-armar el gate atómico: dispatchPayout SOLO procesa payin_confirmed —
      // llamarlo con status pending_funding era un no-op silencioso (audit 2026-06-11).
      const rearmed = await Transaction.findOneAndUpdate(
        { _id: tx._id, status: 'pending_funding' },
        { $set: { status: 'payin_confirmed' } },
        { returnDocument: 'after' },
      );
      if (!rearmed) continue; // otro proceso ya la tomó

      await dispatchPayout(rearmed);

      // dispatchPayout muta SU copia del documento — releer el estado real de la DB
      const fresh = await Transaction.findById(tx._id).select('status').lean();
      if (fresh?.status === 'pending_funding') {
        console.log('[Funding] Auto-retry: balance insuficiente, deteniendo cola FIFO');
        break;
      }
    } catch (err) {
      console.error('[Funding] Auto-retry error en dispatchPayout:', tx.alytoTransactionId, err.message);
      break;
    }
  }
}

// ─── GET /api/v1/admin/funding/forecast ──────────────────────────────────────

/**
 * Previsión de liquidez USDC para una entidad.
 *
 * Combina el balance real en Stellar (Horizon) con los compromisos en vuelo
 * y las transacciones bloqueadas por falta de fondos, devolviendo un diagnóstico
 * accionable con nivel de alerta y monto mínimo de fondeo recomendado.
 *
 * Query params:
 *   entity — 'SRL' (default) | 'LLC'
 *
 * alertLevel:
 *   'ok'       — balance suficiente por encima del umbral
 *   'warning'  — balance positivo pero bajo (< USDC_LOW_BALANCE_THRESHOLD)
 *   'critical' — balance insuficiente para cubrir transacciones en pending_funding
 */
export async function getUSDCForecast(req, res) {
  try {
    const entity    = req.query.entity ?? 'SRL';
    const threshold = parseFloat(process.env.USDC_LOW_BALANCE_THRESHOLD ?? '200');

    if (!['LLC', 'SRL'].includes(entity)) {
      return res.status(400).json({ error: 'entity inválido para forecast. Usar: SRL | LLC' });
    }

    const stellarPubKey = entity === 'SRL'
      ? process.env.STELLAR_SRL_PUBLIC_KEY
      : process.env.STELLAR_LLC_PUBLIC_KEY;

    // Balances reales en Stellar (USDC cacheado 30s; XLM para mostrar fees).
    const [stellarBalance, xlmBalance] = await Promise.all([
      getStellarUSDCBalance(stellarPubKey),
      getStellarXLMBalance(stellarPubKey).catch(() => null),
    ]);

    // Consultas paralelas: in-flight + pending_funding
    const [inflightAgg, pendingTxs] = await Promise.all([
      Transaction.aggregate([
        {
          $match: {
            legalEntity: entity,
            status: { $in: ['payout_pending_usdc_send', 'payout_in_transit', 'payout_sent'] },
          },
        },
        {
          $group: {
            _id:   null,
            total: { $sum: { $ifNull: ['$digitalAssetAmount', 0] } },
            count: { $sum: 1 },
          },
        },
      ]),
      Transaction.find(
        { legalEntity: entity, status: 'pending_funding' },
        'alytoTransactionId digitalAssetAmount statusReason destinationCountry corridorId createdAt'
      ).sort({ createdAt: 1 }).lean(),
    ]);

    const inflight      = inflightAgg[0]?.total ?? 0;
    const inflightCount = inflightAgg[0]?.count ?? 0;

    // +1 USDC por tx como reserva para fees de red Stellar (mismo que tryOwlPayV2)
    const pendingNeeds = pendingTxs.reduce(
      (sum, tx) => sum + (tx.digitalAssetAmount ?? 0) + 1,
      0
    );

    const availableNow  = Math.max(0, stellarBalance - inflight);
    const gap           = availableNow - pendingNeeds; // negativo = déficit
    const fundingNeeded = gap < 0 ? parseFloat(Math.abs(gap).toFixed(2)) : 0;

    let alertLevel = 'ok';
    if (gap < 0)                    alertLevel = 'critical';
    else if (availableNow < threshold) alertLevel = 'warning';

    const recommendation = fundingNeeded > 0
      ? `Fondea la wallet Stellar ${entity} con al menos ${fundingNeeded.toFixed(2)} USDC para liberar ${pendingTxs.length} pago(s) en espera.`
      : alertLevel === 'warning'
        ? `Saldo bajo (${availableNow.toFixed(2)} USDC). Fondea antes de que lleguen nuevas transacciones.`
        : `Liquidez suficiente (${availableNow.toFixed(2)} USDC disponibles).`;

    return res.status(200).json({
      entity,
      alertLevel,
      stellar: {
        balance:          parseFloat(stellarBalance.toFixed(4)),
        xlmBalance:       xlmBalance === null ? null : parseFloat(xlmBalance.toFixed(4)),
        publicKey:        stellarPubKey,
        network:          (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase() === 'mainnet' ? 'public' : 'testnet',
        stellarExpertUrl: `https://stellar.expert/explorer/${(process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase() === 'mainnet' ? 'public' : 'testnet'}/account/${stellarPubKey}`,
        note:             'Balance en tiempo real vía Horizon (cache 30s)',
      },
      committed: {
        amount: parseFloat(inflight.toFixed(4)),
        count:  inflightCount,
        note:   'USDC bloqueado en payouts en vuelo (payout_pending_usdc_send / payout_in_transit / payout_sent)',
      },
      availableNow: parseFloat(availableNow.toFixed(4)),
      pendingFunding: {
        needed: parseFloat(pendingNeeds.toFixed(4)),
        count:  pendingTxs.length,
        transactions: pendingTxs.map((t) => ({
          id:          t.alytoTransactionId,
          usdcNeeded:  parseFloat(((t.digitalAssetAmount ?? 0) + 1).toFixed(4)),
          country:     t.destinationCountry,
          corridor:    t.corridorId,
          reason:      t.statusReason,
          waitingSince: t.createdAt,
        })),
      },
      gap:           parseFloat(gap.toFixed(4)),
      fundingNeeded,
      threshold,
      recommendation,
      generatedAt:   new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Funding] Error al calcular USDC forecast:', err);
    return res.status(500).json({ error: 'Error al obtener forecast USDC' });
  }
}

// ─── POST /api/v1/admin/funding/intents ──────────────────────────────────────

/**
 * Crea una intención de fondeo de tesorería (Camino A, H3).
 *
 * Genera un correlativo atómico (FND-YYYYMM-N) que se usa como memo al retirar
 * USDC desde el exchange hacia la wallet de tesorería. Devuelve un QR SEP-7 con
 * la dirección + memo para minimizar el error de transcripción. El job
 * `reconcileTreasuryFunding` matchea el inflow on-chain con este intent.
 *
 * Body:
 *   entity         {String}  'LLC'|'SpA'|'SRL' (default 'SRL')
 *   expectedAmount {Number}  (opcional) USDC esperado
 *   sourceCurrency {String}  (opcional) ej 'BOB'
 *   sourceAmount   {Number}  (opcional) fiat pagado
 *   binanceOrderId {String}  (opcional)
 *   note           {String}  (opcional)
 */
export async function createFundingIntent(req, res) {
  try {
    const { entity = 'SRL', expectedAmount, sourceCurrency, sourceAmount, binanceOrderId, note } = req.body;

    if (!['LLC', 'SpA', 'SRL'].includes(entity)) {
      return res.status(400).json({ error: 'entity inválido. Usar: LLC | SpA | SRL' });
    }
    const treasuryAddress = TREASURY_ADDRESS[entity]?.();
    if (!treasuryAddress) {
      return res.status(500).json({ error: `Wallet de tesorería no configurada para ${entity}` });
    }

    const intentId = await generarNumeroCorrelativo('FND');

    const intent = await FundingIntent.create({
      intentId,
      entity,
      asset:           'USDC',
      treasuryAddress,
      memo:            intentId,
      expectedAmount:  expectedAmount ?? null,
      sourceCurrency:  sourceCurrency ?? null,
      sourceAmount:    sourceAmount ?? null,
      binanceOrderId:  binanceOrderId ?? null,
      note:            note ?? null,
      status:          'open',
      createdBy:       req.user._id,
    });

    const assetIssuer = ASSETS.USDC.issuer;
    const { uri, qrBase64 } = await generateStellarPayQR({
      destination: treasuryAddress,
      assetCode:   'USDC',
      assetIssuer,
      memo:        intentId,
    });

    return res.status(201).json({
      intentId:        intent.intentId,
      entity,
      asset:           'USDC',
      treasuryAddress,
      assetIssuer,
      memo:            intentId,
      expectedAmount:  intent.expectedAmount,
      status:          intent.status,
      sep7Uri:         uri,
      qr:              qrBase64,
      note: 'Retira el USDC a esta dirección usando el memo. El monto se reconcilia on-chain; ' +
            'no es necesario que el QR lleve el monto (el exchange no lo respeta).',
    });
  } catch (err) {
    console.error('[Funding] Error al crear intent de fondeo:', err);
    return res.status(500).json({ error: 'Error interno al crear intent de fondeo' });
  }
}

// ─── GET /api/v1/admin/funding/intents ───────────────────────────────────────

/**
 * Lista intents de fondeo con paginación y filtros (status, entity).
 */
export async function listFundingIntents(req, res) {
  try {
    const { entity, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (entity) filter.entity = entity;
    if (status) filter.status = status;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const [intents, total] = await Promise.all([
      FundingIntent.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate('createdBy', 'name email'),
      FundingIntent.countDocuments(filter),
    ]);

    return res.status(200).json({
      intents,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    console.error('[Funding] Error al listar intents:', err);
    return res.status(500).json({ error: 'Error interno al listar intents' });
  }
}

// ─── PATCH /api/v1/admin/funding/intents/:intentId/cancel ────────────────────

/**
 * Cancela un intent abierto (no reconciliado aún).
 */
export async function cancelFundingIntent(req, res) {
  try {
    const { intentId } = req.params;
    const intent = await FundingIntent.findOne({ intentId });
    if (!intent) return res.status(404).json({ error: 'Intent no encontrado' });
    if (intent.status !== 'open') {
      return res.status(400).json({ error: `No se puede cancelar un intent en estado '${intent.status}'` });
    }
    intent.status = 'cancelled';
    await intent.save();
    return res.status(200).json({ intentId, status: intent.status });
  } catch (err) {
    console.error('[Funding] Error al cancelar intent:', err);
    return res.status(500).json({ error: 'Error interno al cancelar intent' });
  }
}
