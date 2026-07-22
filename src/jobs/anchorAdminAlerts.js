/**
 * anchorAdminAlerts.js — AnchorAdmin, alertas activas (Bloque 2)
 *
 * Vigila los indicadores críticos que la Fase 1 solo mostraba en pantalla y los
 * convierte en ALERTA ACTIVA (email admin + Sentry), como exige el spec §5:
 *   - Listener de pagos caído/con retraso (heartbeat obsoleto)  [gap real, no cubierto antes]
 *   - Horizon inalcanzable
 *   - Descuadre en la reconciliación del dual ledger
 *
 * NO duplica el saldo XLM bajo del channel account (ya lo alerta monitorChannelXLM).
 * NO alerta solvencia (identidad contable sin confirmar — solo endpoint de lectura).
 *
 * Cadencia: el chequeo del listener es barato y corre en cada ciclo (agresivo, §4.2).
 * La reconciliación es O(wallets) contra Horizon, así que se limita a una sub-cadencia
 * más lenta (ANCHOR_ALERT_RECON_INTERVAL_MS).
 *
 * Cooldown por severidad para no saturar el email: crítico re-alerta más seguido que aviso.
 * Gated por ANCHOR_ADMIN_ENABLED (rollback inmediato).
 */

import * as Sentry from '@sentry/node'

import {
  getListenerStatus,
  reconcileDualLedger,
  getSolvencySnapshot,
  evaluateAnchorAlerts,
} from '../services/anchorAdminService.js'
import { sendRawEmail } from '../services/email.js'

// ── Config ────────────────────────────────────────────────────────────────────
const RECON_INTERVAL_MS = parseInt(process.env.ANCHOR_ALERT_RECON_INTERVAL_MS ?? String(30 * 60 * 1000), 10) // 30 min
const RECON_LIMIT       = parseInt(process.env.ANCHOR_ALERT_RECON_LIMIT ?? '500', 10)

// Cooldown por severidad (ms) — evita spam de email del mismo tipo de alerta.
const COOLDOWN = {
  critical: parseInt(process.env.ANCHOR_ALERT_COOLDOWN_CRITICAL_MS ?? String(30 * 60 * 1000), 10), // 30 min
  warning:  parseInt(process.env.ANCHOR_ALERT_COOLDOWN_WARNING_MS  ?? String(6 * 60 * 60 * 1000), 10), // 6h
}

// ── Estado in-module ───────────────────────────────────────────────────────────
const _lastAlertAt = {}
let   _lastReconAt = 0
let   _running     = false

function _shouldAlert(key, cooldownMs) {
  const last = _lastAlertAt[key] ?? 0
  if (Date.now() - last > cooldownMs) {
    _lastAlertAt[key] = Date.now()
    return true
  }
  return false
}

function _adminEmail() {
  return process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app'
}

async function _sendAlertEmail(alerts) {
  const hasCritical = alerts.some(a => a.severity === 'critical')
  const subject = hasCritical
    ? '🚨 CRÍTICO: AnchorAdmin detectó un problema en el anchor'
    : '⚠️ AnchorAdmin: aviso en el anchor'

  const rows = alerts.map(a => `
    <li>
      <strong>${a.severity === 'critical' ? '🚨' : '⚠️'} ${a.title}</strong><br>
      <span style="color:#4A5568">${a.detail}</span>
    </li>`).join('')

  const html = `
<h2>${subject}</h2>
<p>El monitor de AnchorAdmin detectó los siguientes indicadores fuera de rango:</p>
<ul>${rows}</ul>
<p><small>Cooldown por tipo: crítico ${Math.round(COOLDOWN.critical / 60000)} min · aviso ${Math.round(COOLDOWN.warning / 3600000)}h.
Umbrales configurables por variables de entorno ANCHOR_ALERT_*.</small></p>
  `.trim()

  await sendRawEmail(_adminEmail(), subject, html)
}

// ── Job principal ───────────────────────────────────────────────────────────────

export async function anchorAdminAlerts() {
  if (process.env.ANCHOR_ADMIN_ENABLED !== 'true') return
  if (_running) {
    console.warn('[AnchorAdmin Alerts] ciclo anterior aún en ejecución — skip')
    return
  }
  _running = true

  try {
    // Chequeo barato del listener en cada ciclo.
    const listener = await getListenerStatus().catch((err) => {
      console.error('[AnchorAdmin Alerts] getListenerStatus falló:', err.message)
      return null
    })

    // Reconciliación + solvencia solo en su sub-cadencia más lenta (ambas O(wallets)
    // contra Horizon). La solvencia agregada es la red de seguridad real del modelo
    // ledger-only; la reconciliación por-wallet solo escala descuadres direccionales.
    let reconciliation = null
    let solvency = null
    if (Date.now() - _lastReconAt > RECON_INTERVAL_MS) {
      reconciliation = await reconcileDualLedger({ limit: RECON_LIMIT }).catch((err) => {
        console.error('[AnchorAdmin Alerts] reconcileDualLedger falló:', err.message)
        return null
      })
      solvency = await getSolvencySnapshot({ limit: RECON_LIMIT }).catch((err) => {
        console.error('[AnchorAdmin Alerts] getSolvencySnapshot falló:', err.message)
        return null
      })
      _lastReconAt = Date.now()
    }

    const alerts = evaluateAnchorAlerts({ listener, reconciliation, solvency })
    const toFire = alerts.filter(a => _shouldAlert(a.key, COOLDOWN[a.severity] ?? COOLDOWN.warning))

    if (toFire.length === 0) return

    // Sentry — una entrada por alerta.
    for (const a of toFire) {
      Sentry.captureMessage(`[AnchorAdmin] ${a.title}`, {
        level: a.severity === 'critical' ? 'error' : 'warning',
        tags:  { job: 'anchorAdminAlerts', alert: a.key },
        extra: { detail: a.detail },
      })
    }

    // Email consolidado (best-effort, no aborta el ciclo).
    try {
      await _sendAlertEmail(toFire)
      console.warn('[AnchorAdmin Alerts] alertas disparadas:', toFire.map(a => a.key).join(', '))
    } catch (e) {
      console.error('[AnchorAdmin Alerts] error enviando email:', e.message)
    }

  } catch (err) {
    console.error('[AnchorAdmin Alerts] error de ciclo:', err.message)
    Sentry.captureException(err, { tags: { job: 'anchorAdminAlerts' } })
  } finally {
    _running = false
  }
}
