/**
 * walletFeeController.js — Admin: configuración de comisiones de wallet (P3)
 *
 * CRUD del singleton WalletFeeConfig + consulta de revenue acumulada.
 * Endpoints (bajo /api/v1/admin/wallet-fees, protect + checkAdmin):
 *   GET  /                — config actual
 *   PUT  /                — actualizar parámetros de comisión
 *   GET  /revenue         — revenue acumulada + verificación contra WalletTransaction
 *   POST /harvest-revenue — cosecha revenue hacia tesorería SRL vía on-chain Stellar
 */

import WalletFeeConfig        from '../models/WalletFeeConfig.js'
import WalletTransaction       from '../models/WalletTransaction.js'
import WalletUSDC              from '../models/WalletUSDC.js'
import FundingRecord           from '../models/FundingRecord.js'
import User                   from '../models/User.js'
import Sentry                 from '../services/sentry.js'
import { sendCustodialUSDC }  from '../services/custodyService.js'
import { horizonServer, ASSETS } from '../config/stellar.js'
import { logger }             from '../utils/logger.js'

const EDITABLE = [
  'usdcP2pEnabled',
  'usdcP2pFeePercent',
  'usdcP2pFeeFixed',
  'usdcP2pFeeMin',
  'usdcP2pFeeMax',
  'usdcP2pFreeBelow',
  'businessUsdcP2pFeePercent',
  'businessUsdcP2pFeeFixed',
  'usdcP2pMinPerTx',
  'usdcP2pMaxPerTx',
  'usdcP2pMaxDaily',
  'businessUsdcP2pMaxPerTx',
  'businessUsdcP2pMaxDaily',
]

// ─── GET /api/v1/admin/wallet-fees ───────────────────────────────────────────

export async function getWalletFeeConfig(req, res) {
  try {
    const cfg = await WalletFeeConfig.getSingleton()
    return res.json(cfg)
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletFeeController', fn: 'getWalletFeeConfig' } })
    return res.status(500).json({ error: 'Error al obtener la configuración de comisiones.' })
  }
}

// ─── PUT /api/v1/admin/wallet-fees ───────────────────────────────────────────

export async function updateWalletFeeConfig(req, res) {
  try {
    const update = {}
    for (const key of EDITABLE) {
      if (req.body[key] === undefined) continue
      if (key === 'usdcP2pEnabled') {
        update[key] = Boolean(req.body[key])
        continue
      }
      // usdcP2pFeeMax admite null (sin techo)
      if (key === 'usdcP2pFeeMax' && (req.body[key] === null || req.body[key] === '')) {
        update[key] = null
        continue
      }
      const n = Number(req.body[key])
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: `Valor inválido para ${key} (debe ser número >= 0).` })
      }
      update[key] = n
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No hay campos editables en el body.' })
    }
    update.updatedBy = req.user._id

    await WalletFeeConfig.updateOne({ _id: 'singleton' }, { $set: update }, { upsert: true })
    const cfg = await WalletFeeConfig.getSingleton()
    return res.json(cfg)
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletFeeController', fn: 'updateWalletFeeConfig' } })
    return res.status(500).json({ error: 'Error al actualizar la configuración de comisiones.' })
  }
}

// ─── GET /api/v1/admin/wallet-fees/revenue ───────────────────────────────────

export async function getWalletFeeRevenue(req, res) {
  try {
    const cfg = await WalletFeeConfig.getSingleton()
    // Verificación cruzada: suma de WalletTransaction type:'fee' USDC de revenue P2P
    const agg = await WalletTransaction.aggregate([
      { $match: { type: 'fee', currency: 'USDC', 'metadata.kind': 'p2p_revenue' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])
    const fromTx = agg[0]?.total ?? 0
    return res.json({
      revenueAccruedUsdc: cfg.revenueAccruedUsdc,
      verification: {
        sumFeeTransactions: parseFloat(fromTx.toFixed(6)),
        count:              agg[0]?.count ?? 0,
        matches:            Math.abs((cfg.revenueAccruedUsdc ?? 0) - fromTx) < 1e-6,
      },
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletFeeController', fn: 'getWalletFeeRevenue' } })
    return res.status(500).json({ error: 'Error al obtener la revenue de comisiones.' })
  }
}

// ─── POST /api/v1/admin/wallet-fees/harvest-revenue ──────────────────────────

/**
 * Cosecha el revenue acumulado de comisiones P2P hacia la tesorería SRL.
 *
 * Mecanismo: las transferencias P2P son ledger-only (sin movimiento Stellar).
 * El fee cobrado al remitente queda como surplus on-chain en su wallet custodial
 * (on-chain > ledger MongoDB). Este endpoint barre esas wallets y envía el surplus
 * acumulado a STELLAR_SRL_PUBLIC_KEY, creando un FundingRecord por cada tx.
 *
 * Query param: ?dryRun=true — devuelve las wallets fuente sin ejecutar ninguna tx.
 */
export async function harvestRevenueToTreasury(req, res) {
  const dryRun = req.query.dryRun === 'true'

  try {
    const cfg          = await WalletFeeConfig.getSingleton()
    const revenueTotal = parseFloat((cfg.revenueAccruedUsdc ?? 0).toFixed(7))

    if (revenueTotal < 0.0001) {
      return res.json({ harvested: 0, message: 'Sin revenue que cosechar (< 0.0001 USDC).', dryRun })
    }

    const srlTreasury = process.env.STELLAR_SRL_PUBLIC_KEY
    if (!srlTreasury) {
      return res.status(500).json({ error: 'STELLAR_SRL_PUBLIC_KEY no configurado.' })
    }

    // 1. Usuarios con keypair custodial registrado
    const users = await User.find({
      'stellarAccount.publicKey':           { $exists: true, $ne: null },
      'stellarAccount.secretKeyCiphertext': { $exists: true, $ne: null },
    }).select('_id stellarAccount.publicKey').lean()

    if (users.length === 0) {
      return res.json({ harvested: 0, message: 'No hay wallets custodiales registradas.', dryRun })
    }

    // 2. Saldos ledger (MongoDB)
    const walletDocs = await WalletUSDC.find({
      userId: { $in: users.map(u => u._id) },
    }).select('userId balance').lean()

    const ledgerMap = new Map(walletDocs.map(w => [String(w.userId), w.balance ?? 0]))

    // 3. Consultar Horizon y calcular surplus (on-chain − ledger)
    const USDC_ISSUER = ASSETS.USDC.issuer
    const sources     = []

    for (const user of users) {
      try {
        const account = await horizonServer.loadAccount(user.stellarAccount.publicKey)
        const usdcBal = account.balances.find(
          b => b.asset_type !== 'native' && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
        )
        const onChain = parseFloat(usdcBal?.balance ?? '0')
        const ledger  = ledgerMap.get(String(user._id)) ?? 0
        const surplus = parseFloat((onChain - ledger).toFixed(7))
        if (surplus >= 0.0000001) {
          sources.push({ userId: user._id, publicKey: user.stellarAccount.publicKey, surplus, onChain, ledger })
        }
      } catch {
        // wallet aún no fondeada en Stellar — ignorar
      }
    }

    if (sources.length === 0) {
      return res.json({ harvested: 0, message: 'No hay wallets con surplus disponible.', dryRun })
    }

    // Ordenar por mayor surplus primero para minimizar número de txs
    sources.sort((a, b) => b.surplus - a.surplus)

    if (dryRun) {
      return res.json({
        dryRun:       true,
        revenueTotal,
        sourcesFound: sources.length,
        sources:      sources.map(s => ({
          publicKey: s.publicKey,
          surplus:   s.surplus,
          onChain:   s.onChain,
          ledger:    s.ledger,
        })),
      })
    }

    // 4. Sweep: enviar USDC desde cada wallet con surplus → tesorería SRL
    let remaining      = revenueTotal
    const harvested    = []

    for (const src of sources) {
      if (remaining <= 0) break

      const amount    = parseFloat(Math.min(remaining, src.surplus).toFixed(7))
      const amountStr = amount.toFixed(7)

      try {
        const stellarTxId = await sendCustodialUSDC(
          src.userId,
          src.publicKey,
          srlTreasury,
          amountStr,
        )

        const fundingId = `FUND-SRL-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
        await FundingRecord.create({
          fundingId,
          entity:       'SRL',
          type:         'internal',
          asset:        'USDC',
          amount,
          usdEquivalent: amount,
          exchangeRate: 1,
          stellarTxId,
          note:         `Revenue harvest P2P — wallet custodial ${src.publicKey}`,
          registeredBy: req.user._id,
          status:       'confirmed',
        })

        // Decrementar atómicamente para que cada tx exitosa ya sea duradera
        await WalletFeeConfig.updateOne(
          { _id: 'singleton' },
          { $inc: { revenueAccruedUsdc: -amount } },
        )

        harvested.push({ stellarTxId, amount, sourcePublicKey: src.publicKey })
        remaining = parseFloat((remaining - amount).toFixed(7))

      } catch (sweepErr) {
        logger.error('[harvest] Error al enviar desde wallet custodial', {
          userId:    String(src.userId),
          publicKey: src.publicKey,
          amount:    amountStr,
          err:       sweepErr.message,
        })
        Sentry.captureException(sweepErr, { tags: { fn: 'harvestRevenueToTreasury' } })
        // Continuar con la siguiente wallet
      }
    }

    const totalHarvested = parseFloat(harvested.reduce((s, h) => s + h.amount, 0).toFixed(7))

    return res.json({
      harvested:        totalHarvested,
      remainingRevenue: parseFloat(remaining.toFixed(7)),
      transactions:     harvested,
      incomplete:       remaining > 0.0001,
      message:          remaining > 0.0001
        ? `Harvest parcial: faltan ${remaining.toFixed(4)} USDC (surplus insuficiente o error en alguna wallet).`
        : 'Harvest completo.',
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletFeeController', fn: 'harvestRevenueToTreasury' } })
    return res.status(500).json({ error: 'Error al ejecutar el harvest de revenue.' })
  }
}
