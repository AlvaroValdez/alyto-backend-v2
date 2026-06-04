/**
 * walletFeeController.js — Admin: configuración de comisiones de wallet (P3)
 *
 * CRUD del singleton WalletFeeConfig + consulta de revenue acumulada.
 * Endpoints (bajo /api/v1/admin/wallet-fees, protect + checkAdmin):
 *   GET  /            — config actual
 *   PUT  /            — actualizar parámetros de comisión
 *   GET  /revenue     — revenue acumulada + verificación contra WalletTransaction
 */

import WalletFeeConfig   from '../models/WalletFeeConfig.js'
import WalletTransaction from '../models/WalletTransaction.js'
import Sentry            from '../services/sentry.js'

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
