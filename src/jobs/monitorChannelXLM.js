/**
 * monitorChannelXLM.js — Alerta por saldo XLM bajo en cuentas corporativas
 *
 * Verifica periódicamente el saldo XLM de:
 *   1. Channel account (STELLAR_CHANNEL_SECRET / STELLAR_MASTER_SECRET)
 *      → paga TODAS las Fee Bump transactions. Si se agota, los pagos fallan.
 *   2. SRL account (STELLAR_SRL_PUBLIC_KEY)
 *      → paga sus propias tx directas (freeze/unfreeze, audit trail, sendUSDCToHarbor)
 *   3. SpA account (STELLAR_SPA_PUBLIC_KEY)
 *      → paga tx directas del corredor Chile (audit trail)
 *
 * Frecuencia: cada 1h (no migra a EventBridge — SRL-specific, corre siempre in-process)
 *
 * Umbrales (configurables via env):
 *   XLM_CHANNEL_LOW_THRESHOLD = 5   (XLM) — canal principal, umbral más alto
 *   XLM_ACCOUNT_LOW_THRESHOLD = 2   (XLM) — cuentas corporativas
 *
 * Alertas: email admin + Sentry capture + log warn
 * Acción sugerida al admin: fondear con script scripts/fund-xlm.mjs o desde Binance
 */

import { Keypair }             from '@stellar/stellar-sdk';
import * as Sentry             from '@sentry/node';
import { getXLMBalance }       from '../services/stellarService.js';
import { sendRawEmail }        from '../services/email.js';

const CHANNEL_LOW_THRESHOLD = parseFloat(process.env.XLM_CHANNEL_LOW_THRESHOLD ?? '5');
const ACCOUNT_LOW_THRESHOLD = parseFloat(process.env.XLM_ACCOUNT_LOW_THRESHOLD ?? '2');

// Intervalo mínimo entre alertas del mismo tipo para evitar spam de email (ms)
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const _lastAlertAt = {};

function _shouldAlert(key) {
  const last = _lastAlertAt[key] ?? 0;
  if (Date.now() - last > ALERT_COOLDOWN_MS) {
    _lastAlertAt[key] = Date.now();
    return true;
  }
  return false;
}

/**
 * Deriva la public key de un secret key de entorno.
 * Retorna null si la variable no está configurada o es inválida.
 */
function _publicKeyFromSecretEnv(envName) {
  const secret = process.env[envName];
  if (!secret || !secret.startsWith('S')) return null;
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}

export async function monitorChannelXLM() {
  const accounts = [
    {
      key:       'channel',
      label:     'Channel Account (Fee Bump)',
      publicKey: process.env.STELLAR_MASTER_PUBLIC
        ?? _publicKeyFromSecretEnv('STELLAR_CHANNEL_SECRET')
        ?? _publicKeyFromSecretEnv('STELLAR_MASTER_SECRET'),
      threshold: CHANNEL_LOW_THRESHOLD,
      critical:  true,
    },
    {
      key:       'srl',
      label:     'SRL Bolivia',
      publicKey: process.env.STELLAR_SRL_PUBLIC_KEY
        ?? _publicKeyFromSecretEnv('STELLAR_SRL_SECRET_KEY'),
      threshold: ACCOUNT_LOW_THRESHOLD,
      critical:  false,
    },
    {
      key:       'spa',
      label:     'SpA Chile',
      publicKey: process.env.STELLAR_SPA_PUBLIC_KEY
        ?? _publicKeyFromSecretEnv('STELLAR_SPA_SECRET_KEY'),
      threshold: ACCOUNT_LOW_THRESHOLD,
      critical:  false,
    },
  ];

  const lowAccounts = [];

  for (const acct of accounts) {
    if (!acct.publicKey) {
      console.warn(`[XLM Monitor] ${acct.label}: public key no configurada — skip`);
      continue;
    }

    const balance = await getXLMBalance(acct.publicKey);

    if (balance < acct.threshold) {
      const msg = `${acct.label} tiene ${balance.toFixed(2)} XLM (umbral: ${acct.threshold} XLM)`;
      console.warn(`[XLM Monitor] ⚠️ ${msg} | publicKey: ${acct.publicKey}`);

      Sentry.captureMessage(`[XLM Monitor] Saldo bajo: ${msg}`, {
        level: acct.critical ? 'error' : 'warning',
        tags:  { job: 'monitorChannelXLM', account: acct.key },
        extra: { balance, threshold: acct.threshold, publicKey: acct.publicKey },
      });

      lowAccounts.push({ ...acct, balance });
    } else {
      console.info(`[XLM Monitor] ${acct.label}: ${balance.toFixed(2)} XLM ✅`);
    }
  }

  if (lowAccounts.length === 0) return;

  // Consolidar alertas en un solo email para no saturar al admin
  if (!_shouldAlert(lowAccounts.map((a) => a.key).join(','))) return;

  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL
    ?? process.env.ADMIN_EMAIL
    ?? 'admin@alyto.app';

  const hasCritical = lowAccounts.some((a) => a.critical);
  const subject = hasCritical
    ? `🚨 CRÍTICO: Channel Account XLM bajo — transacciones Stellar fallarán`
    : `⚠️ Saldo XLM bajo en cuentas Stellar Alyto`;

  const rows = lowAccounts
    .map((a) => `<li><strong>${a.label}</strong>: ${a.balance.toFixed(4)} XLM (umbral: ${a.threshold} XLM)</li>`)
    .join('');

  const html = `
<h2>${subject}</h2>
<p>Las siguientes cuentas Stellar tienen saldo XLM por debajo del umbral configurado:</p>
<ul>${rows}</ul>
${hasCritical ? `
<p style="color:red"><strong>⚠️ ACCIÓN INMEDIATA REQUERIDA:</strong> La Channel Account paga los fees de TODAS las
transacciones Stellar. Si se agota, las trustlines, envíos de USDC y audit trails fallarán.</p>
` : ''}
<p><strong>Acción:</strong> Fondear con XLM desde Binance, Kraken u otro exchange usando las siguientes public keys:</p>
<ul>
  ${lowAccounts.map((a) => `<li>${a.label}: <code>${a.publicKey}</code></li>`).join('')}
</ul>
<p>Umbrales configurables en las variables de entorno:<br>
<code>XLM_CHANNEL_LOW_THRESHOLD</code> (actual: ${CHANNEL_LOW_THRESHOLD} XLM)<br>
<code>XLM_ACCOUNT_LOW_THRESHOLD</code> (actual: ${ACCOUNT_LOW_THRESHOLD} XLM)</p>
<p><small>Próxima alerta del mismo tipo en mínimo 6h.</small></p>
  `.trim();

  try {
    await sendRawEmail(adminEmail, subject, html);
    console.warn(`[XLM Monitor] Email de alerta enviado a ${adminEmail}`);
  } catch (e) {
    console.error('[XLM Monitor] Error enviando email de alerta:', e.message);
  }
}
