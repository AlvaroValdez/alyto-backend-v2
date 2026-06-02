/**
 * rosMonitor.js — Monitoreo Heurístico ROS / UIF Bolivia (Fase 36+)
 *
 * Analiza transacciones SRL completadas en busca de patrones de
 * lavado de dinero según las reglas de la UIF Bolivia.
 *
 * Reglas implementadas:
 *   1. single_tx_high      — una tx supera ROS_SINGLE_TX_BOB (default 50.000)
 *   2. daily_cumulative    — suma 24h por usuario supera ROS_DAILY_CUMUL_BOB (50.000)
 *   3. high_frequency      — >ROS_MAX_DAILY_COUNT txs en 24h (default 5)
 *   4. new_account_volume  — cuenta < ROS_NEW_ACCT_DAYS días + tx >= ROS_NEW_ACCT_BOB
 *   5. velocity_spike      — volumen diario 3x el promedio de 30 días del usuario
 *
 * Umbrales configurables via variables de entorno.
 * Cooldown: no genera alerta duplicada (mismo userId + rule) en 24h.
 *
 * Trigger:
 *   - setInterval en server.js cada 6h
 *   - POST /api/v1/admin/ros/run (manual desde admin)
 *
 * Compliance: ASFI RD 044/2021, DS N° 5384 (07/05/2025), Ley N° 170 UIF Bolivia.
 */

import * as Sentry   from '@sentry/node'
import Transaction   from '../models/Transaction.js'
import User          from '../models/User.js'
import ROSAlert      from '../models/ROSAlert.js'
import { sendRawEmail } from '../services/email.js'

// ─── Umbrales (configurables por env) ────────────────────────────────────────

function thresholds() {
  return {
    singleTxBob:     Number(process.env.ROS_SINGLE_TX_BOB     ?? 50_000),
    dailyCumulBob:   Number(process.env.ROS_DAILY_CUMUL_BOB   ?? 50_000),
    maxDailyCount:   Number(process.env.ROS_MAX_DAILY_COUNT   ?? 5),
    newAcctDays:     Number(process.env.ROS_NEW_ACCT_DAYS     ?? 30),
    newAcctBob:      Number(process.env.ROS_NEW_ACCT_BOB      ?? 15_000),
    velocityMultiple: Number(process.env.ROS_VELOCITY_MULTIPLE ?? 3),
  }
}

// ─── Ventana de análisis ──────────────────────────────────────────────────────

const WINDOW_24H_MS   = 24 * 60 * 60 * 1000
const WINDOW_30D_MS   = 30 * 24 * 60 * 60 * 1000
const ALERT_COOLDOWN  = WINDOW_24H_MS   // no duplicar alerta del mismo rule en 24h

let _isRunning = false

// ─── Job principal ────────────────────────────────────────────────────────────

export async function rosMonitor() {
  if (_isRunning) {
    console.warn('[ROS Monitor] Ciclo anterior aún en ejecución — skip')
    return
  }

  _isRunning = true
  const stats = { usersAnalyzed: 0, alertsCreated: 0, alertsSkipped: 0, errors: 0 }
  const now   = new Date()
  const since24h = new Date(now - WINDOW_24H_MS)
  const t = thresholds()

  try {
    // Obtener usuarios SRL con al menos una tx completada en las últimas 24h
    const activeUserIds = await Transaction.distinct('userId', {
      legalEntity:   'SRL',
      status:        'completed',
      originCurrency: 'BOB',
      createdAt:     { $gte: since24h },
    })

    for (const userId of activeUserIds) {
      stats.usersAnalyzed++
      try {
        await _analyzeUser(userId, now, since24h, t, stats)
      } catch (err) {
        stats.errors++
        console.error('[ROS Monitor] Error analizando usuario:', {
          userId: userId.toString(),
          error:  err.message,
        })
        Sentry.captureException(err, {
          tags:  { job: 'rosMonitor' },
          extra: { userId: userId.toString() },
        })
      }
    }

    if (stats.alertsCreated > 0 || stats.errors > 0) {
      console.info('[ROS Monitor] Ciclo completado:', stats)
      if (stats.alertsCreated > 0) {
        await _sendAdminSummary(stats, now)
      }
    }

  } catch (err) {
    console.error('[ROS Monitor] Error de ciclo:', err.message)
    Sentry.captureException(err, { tags: { job: 'rosMonitor', level: 'batch' } })
  } finally {
    _isRunning = false
  }

  return stats
}

// ─── Análisis por usuario ─────────────────────────────────────────────────────

async function _analyzeUser(userId, now, since24h, t, stats) {
  // Txs completadas en BOB en las últimas 24h
  const txs24h = await Transaction.find({
    userId,
    legalEntity:    'SRL',
    status:         'completed',
    originCurrency: 'BOB',
    createdAt:      { $gte: since24h },
  }, 'originalAmount createdAt _id').lean()

  if (txs24h.length === 0) return

  const totalBob24h = txs24h.reduce((s, t) => s + t.originalAmount, 0)
  const maxSingle   = Math.max(...txs24h.map(t => t.originalAmount))
  const txIds       = txs24h.map(t => t._id)

  const alerts = []

  // ── Regla 1: tx individual alta ──────────────────────────────────────────
  const highTxs = txs24h.filter(tx => tx.originalAmount >= t.singleTxBob)
  if (highTxs.length > 0) {
    alerts.push({
      rule:     'single_tx_high',
      severity: maxSingle >= t.singleTxBob * 2 ? 'high' : 'medium',
      txIds:    highTxs.map(tx => tx._id),
      details:  { maxSingleBob: maxSingle, threshold: t.singleTxBob },
    })
  }

  // ── Regla 2: acumulado diario alto ───────────────────────────────────────
  if (totalBob24h >= t.dailyCumulBob && highTxs.length === 0) {
    // Solo emitir si no ya cubierto por regla 1 (mismas txs)
    alerts.push({
      rule:     'daily_cumulative',
      severity: totalBob24h >= t.dailyCumulBob * 1.5 ? 'high' : 'medium',
      txIds,
      details:  { totalBob24h, txCount: txs24h.length, threshold: t.dailyCumulBob },
    })
  }

  // ── Regla 3: alta frecuencia ─────────────────────────────────────────────
  if (txs24h.length > t.maxDailyCount) {
    alerts.push({
      rule:     'high_frequency',
      severity: txs24h.length >= t.maxDailyCount * 2 ? 'high' : 'low',
      txIds,
      details:  { txCount: txs24h.length, threshold: t.maxDailyCount, totalBob: totalBob24h },
    })
  }

  // ── Regla 4: cuenta nueva con volumen inusual ─────────────────────────────
  const user = await User.findById(userId, 'createdAt firstName lastName email').lean()
  if (user) {
    const accountAgeDays = (now - new Date(user.createdAt)) / (24 * 60 * 60 * 1000)
    if (accountAgeDays < t.newAcctDays && maxSingle >= t.newAcctBob) {
      alerts.push({
        rule:     'new_account_volume',
        severity: 'high',
        txIds:    highTxs.length > 0 ? highTxs.map(t => t._id) : txIds,
        details:  {
          accountAgeDays: Math.round(accountAgeDays),
          maxSingleBob:   maxSingle,
          totalBob24h,
          threshold:      t.newAcctBob,
        },
      })
    }
  }

  // ── Regla 5: spike de velocidad vs promedio 30 días ──────────────────────
  const since30d = new Date(now - WINDOW_30D_MS)
  const txs30d   = await Transaction.find({
    userId,
    legalEntity:    'SRL',
    status:         'completed',
    originCurrency: 'BOB',
    createdAt:      { $gte: since30d, $lt: since24h },  // solo los días 2-30 (excluye la ventana de 24h)
  }, 'originalAmount').lean()

  if (txs30d.length >= 5) {  // mínimo histórico para que el promedio sea significativo
    const avgDailyBob = txs30d.reduce((s, t) => s + t.originalAmount, 0) / 29  // ≈ promedio diario 29 días
    if (avgDailyBob > 0 && totalBob24h >= avgDailyBob * t.velocityMultiple) {
      alerts.push({
        rule:     'velocity_spike',
        severity: totalBob24h >= avgDailyBob * (t.velocityMultiple * 2) ? 'high' : 'medium',
        txIds,
        details:  {
          totalBob24h,
          avgDailyBob30d: Math.round(avgDailyBob),
          multiple:       +(totalBob24h / avgDailyBob).toFixed(1),
          threshold:      t.velocityMultiple,
        },
      })
    }
  }

  // ── Persistir alertas (con cooldown anti-duplicado) ───────────────────────
  for (const alert of alerts) {
    const cooldownSince = new Date(now - ALERT_COOLDOWN)
    const existing = await ROSAlert.exists({
      userId,
      rule:      alert.rule,
      status:    'open',
      createdAt: { $gte: cooldownSince },
    })

    if (existing) {
      stats.alertsSkipped++
      continue
    }

    await ROSAlert.create({
      userId,
      rule:           alert.rule,
      severity:       alert.severity,
      transactionIds: alert.txIds,
      details:        alert.details,
    })
    stats.alertsCreated++

    console.warn('[ROS Monitor] ⚠️ Alerta ROS creada:', {
      userId:   userId.toString(),
      rule:     alert.rule,
      severity: alert.severity,
      details:  alert.details,
    })
  }
}

// ─── Email resumen al admin ───────────────────────────────────────────────────

async function _sendAdminSummary(stats, now) {
  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL
                  ?? process.env.ADMIN_EMAIL
                  ?? 'admin@alyto.app'

  const openAlerts = await ROSAlert.find({ status: 'open' })
    .sort({ severity: -1, createdAt: -1 })
    .limit(20)
    .lean()

  const rows = openAlerts.map(a => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${a.alertId}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${a.userId}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${a.rule}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${a.severity === 'high' ? '#dc2626' : a.severity === 'medium' ? '#d97706' : '#059669'}">${a.severity.toUpperCase()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px">${JSON.stringify(a.details)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${new Date(a.createdAt).toLocaleString('es-BO', { timeZone: 'America/La_Paz' })}</td>
    </tr>`).join('')

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px">
      <h2 style="color:#1e3a5f">⚠️ Alertas ROS/UIF Bolivia — AV Finance SRL</h2>
      <p>El monitor heurístico detectó <strong>${stats.alertsCreated} nueva(s) alerta(s)</strong> en el ciclo de ${now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' })}.</p>
      <p>Resumen: ${stats.usersAnalyzed} usuarios analizados, ${openAlerts.length} alertas abiertas en total.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#1e3a5f;color:#fff">
            <th style="padding:8px 10px;text-align:left">Alert ID</th>
            <th style="padding:8px 10px;text-align:left">User ID</th>
            <th style="padding:8px 10px;text-align:left">Regla</th>
            <th style="padding:8px 10px;text-align:left">Severidad</th>
            <th style="padding:8px 10px;text-align:left">Detalles</th>
            <th style="padding:8px 10px;text-align:left">Fecha</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#666">
        Revisar y gestionar en: ${process.env.APP_ADMIN_URL ?? 'https://alyto-frontend-v2.onrender.com/admin'}/ros-alerts<br>
        Las alertas deben revisarse dentro de los plazos legales (ASFI RD 044/2021).<br>
        Reportar a UIF Bolivia si corresponde: <a href="https://www.uif.gob.bo">www.uif.gob.bo</a>
      </p>
    </div>`

  try {
    await sendRawEmail(
      adminEmail,
      `[Alyto ROS] ${stats.alertsCreated} alerta(s) nueva(s) — ${now.toLocaleDateString('es-BO')}`,
      html,
    )
  } catch (err) {
    console.warn('[ROS Monitor] No se pudo enviar email de resumen:', err.message)
  }
}
