/**
 * rosMonitorWallet.js — Monitoreo ROS/UIF sobre transferencias de WALLET (P4)
 *
 * El rosMonitor original solo vigila Transaction (cross-border). Este job cubre el
 * gap AML de las transferencias P2P de wallet (WalletTransaction type:'send', BOB y
 * USDC), aplicando las MISMAS 5 reglas heurísticas. Los montos USDC se convierten a
 * BOB-equivalente (tasa BOB/USDC) para unificar umbrales con el corredor.
 *
 * Reglas: single_tx_high, daily_cumulative, high_frequency, new_account_volume,
 * velocity_spike. Umbrales por env (mismos que rosMonitor). Reusa ROSAlert con
 * source:'wallet'. Cooldown 24h por (userId, rule, source).
 *
 * Trigger: setInterval cada 6h (server.js) + on-demand (jobRegistry).
 * Compliance: ASFI RD 044/2021, DS 5384, Ley 170 UIF Bolivia.
 */

import * as Sentry      from '@sentry/node'
import WalletTransaction from '../models/WalletTransaction.js'
import User             from '../models/User.js'
import ROSAlert         from '../models/ROSAlert.js'
import { sendRawEmail } from '../services/email.js'

function thresholds() {
  return {
    singleTxBob:      Number(process.env.ROS_SINGLE_TX_BOB     ?? 50_000),
    dailyCumulBob:    Number(process.env.ROS_DAILY_CUMUL_BOB   ?? 50_000),
    maxDailyCount:    Number(process.env.ROS_MAX_DAILY_COUNT   ?? 5),
    newAcctDays:      Number(process.env.ROS_NEW_ACCT_DAYS     ?? 30),
    newAcctBob:       Number(process.env.ROS_NEW_ACCT_BOB      ?? 15_000),
    velocityMultiple: Number(process.env.ROS_VELOCITY_MULTIPLE ?? 3),
  }
}

const WINDOW_24H_MS  = 24 * 60 * 60 * 1000
const WINDOW_30D_MS  = 30 * 24 * 60 * 60 * 1000
const ALERT_COOLDOWN = WINDOW_24H_MS

let _isRunning = false

async function getBobPerUsdc() {
  try {
    const { getBOBUSDCRate } = await import('../services/exchangeRateService.js')
    const r = await getBOBUSDCRate()
    return r > 0 ? r : Number(process.env.BOB_USD_RATE ?? 9.31)
  } catch {
    return Number(process.env.BOB_USD_RATE ?? 9.31)
  }
}

const SEND_MATCH = { type: 'send', status: 'completed' }

export async function rosMonitorWallet() {
  if (_isRunning) {
    console.warn('[ROS Wallet] Ciclo anterior aún en ejecución — skip')
    return
  }
  _isRunning = true
  const stats = { usersAnalyzed: 0, alertsCreated: 0, alertsSkipped: 0, errors: 0 }
  const now      = new Date()
  const since24h = new Date(now - WINDOW_24H_MS)
  const t        = thresholds()

  try {
    const rate = await getBobPerUsdc()
    const activeUserIds = await WalletTransaction.distinct('userId', {
      ...SEND_MATCH,
      createdAt: { $gte: since24h },
    })

    for (const userId of activeUserIds) {
      stats.usersAnalyzed++
      try {
        await _analyzeUser(userId, now, since24h, t, rate, stats)
      } catch (err) {
        stats.errors++
        console.error('[ROS Wallet] Error analizando usuario:', { userId: userId?.toString(), error: err.message })
        Sentry.captureException(err, { tags: { job: 'rosMonitorWallet' }, extra: { userId: userId?.toString() } })
      }
    }

    if (stats.alertsCreated > 0 || stats.errors > 0) {
      console.info('[ROS Wallet] Ciclo completado:', stats)
      if (stats.alertsCreated > 0) await _notifyAdmin(stats, now)
    }
  } catch (err) {
    console.error('[ROS Wallet] Error de ciclo:', err.message)
    Sentry.captureException(err, { tags: { job: 'rosMonitorWallet', level: 'batch' } })
  } finally {
    _isRunning = false
  }
  return stats
}

async function _analyzeUser(userId, now, since24h, t, rate, stats) {
  const txs24h = await WalletTransaction.find(
    { userId, ...SEND_MATCH, createdAt: { $gte: since24h } },
    'amount currency createdAt _id',
  ).lean()
  if (txs24h.length === 0) return

  const bobOf = (tx) => (tx.currency === 'USDC' ? tx.amount * rate : tx.amount)
  const totalBob24h = txs24h.reduce((s, tx) => s + bobOf(tx), 0)
  const maxSingle   = Math.max(...txs24h.map(bobOf))
  const txIds       = txs24h.map(tx => tx._id)
  const alerts      = []

  // Regla 1 — tx individual alta (BOB-equivalente)
  const highTxs = txs24h.filter(tx => bobOf(tx) >= t.singleTxBob)
  if (highTxs.length > 0) {
    alerts.push({
      rule:     'single_tx_high',
      severity: maxSingle >= t.singleTxBob * 2 ? 'high' : 'medium',
      txIds:    highTxs.map(tx => tx._id),
      details:  { maxSingleBobEq: Math.round(maxSingle), threshold: t.singleTxBob, channel: 'wallet' },
    })
  }

  // Regla 2 — acumulado diario alto (si no cubierto por regla 1)
  if (totalBob24h >= t.dailyCumulBob && highTxs.length === 0) {
    alerts.push({
      rule:     'daily_cumulative',
      severity: totalBob24h >= t.dailyCumulBob * 1.5 ? 'high' : 'medium',
      txIds,
      details:  { totalBobEq24h: Math.round(totalBob24h), txCount: txs24h.length, threshold: t.dailyCumulBob, channel: 'wallet' },
    })
  }

  // Regla 3 — alta frecuencia
  if (txs24h.length > t.maxDailyCount) {
    alerts.push({
      rule:     'high_frequency',
      severity: txs24h.length >= t.maxDailyCount * 2 ? 'high' : 'low',
      txIds,
      details:  { txCount: txs24h.length, threshold: t.maxDailyCount, totalBobEq: Math.round(totalBob24h), channel: 'wallet' },
    })
  }

  // Regla 4 — cuenta nueva con volumen inusual
  const user = await User.findById(userId, 'createdAt').lean()
  if (user) {
    const accountAgeDays = (now - new Date(user.createdAt)) / WINDOW_24H_MS
    if (accountAgeDays < t.newAcctDays && maxSingle >= t.newAcctBob) {
      alerts.push({
        rule:     'new_account_volume',
        severity: 'high',
        txIds:    highTxs.length > 0 ? highTxs.map(tx => tx._id) : txIds,
        details:  { accountAgeDays: Math.round(accountAgeDays), maxSingleBobEq: Math.round(maxSingle), totalBobEq24h: Math.round(totalBob24h), threshold: t.newAcctBob, channel: 'wallet' },
      })
    }
  }

  // Regla 5 — spike de velocidad vs promedio 30 días
  const since30d = new Date(now - WINDOW_30D_MS)
  const txs30d   = await WalletTransaction.find(
    { userId, ...SEND_MATCH, createdAt: { $gte: since30d, $lt: since24h } },
    'amount currency',
  ).lean()
  if (txs30d.length >= 5) {
    const avgDailyBob = txs30d.reduce((s, tx) => s + bobOf(tx), 0) / 29
    if (avgDailyBob > 0 && totalBob24h >= avgDailyBob * t.velocityMultiple) {
      alerts.push({
        rule:     'velocity_spike',
        severity: totalBob24h >= avgDailyBob * (t.velocityMultiple * 2) ? 'high' : 'medium',
        txIds,
        details:  { totalBobEq24h: Math.round(totalBob24h), avgDailyBobEq30d: Math.round(avgDailyBob), multiple: +(totalBob24h / avgDailyBob).toFixed(1), threshold: t.velocityMultiple, channel: 'wallet' },
      })
    }
  }

  // Persistir con cooldown anti-duplicado (mismo userId + rule + source en 24h)
  for (const alert of alerts) {
    const cooldownSince = new Date(now - ALERT_COOLDOWN)
    const existing = await ROSAlert.exists({
      userId, rule: alert.rule, source: 'wallet', status: 'open', createdAt: { $gte: cooldownSince },
    })
    if (existing) { stats.alertsSkipped++; continue }

    await ROSAlert.create({
      userId,
      rule:           alert.rule,
      severity:       alert.severity,
      source:         'wallet',
      transactionIds: alert.txIds,
      details:        alert.details,
    })
    stats.alertsCreated++
    console.warn('[ROS Wallet] ⚠️ Alerta ROS (wallet) creada:', { userId: userId.toString(), rule: alert.rule, severity: alert.severity, details: alert.details })
  }
}

async function _notifyAdmin(stats, now) {
  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app'
  const html = `<div style="font-family:Arial,sans-serif">
    <h2 style="color:#1e3a5f">⚠️ Alertas ROS/UIF — Transferencias de Wallet (P2P)</h2>
    <p>El monitor de wallet detectó <strong>${stats.alertsCreated} nueva(s) alerta(s)</strong> en el ciclo de ${now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' })}.</p>
    <p>Usuarios analizados: ${stats.usersAnalyzed}. Revisar en el panel admin → ROS Alerts (origen: wallet).</p>
    <p style="font-size:12px;color:#666">ASFI RD 044/2021 · Reportar a UIF si corresponde.</p>
  </div>`
  try {
    await sendRawEmail(adminEmail, `[Alyto ROS Wallet] ${stats.alertsCreated} alerta(s) nueva(s)`, html)
  } catch (err) {
    console.warn('[ROS Wallet] No se pudo enviar email de resumen:', err.message)
  }
}
