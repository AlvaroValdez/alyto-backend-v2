/**
 * kycIncompleteMonitor.js
 *
 * Detecta usuarios que iniciaron el registro pero no completaron la verificación
 * de identidad (KYC) con Stripe Identity en las últimas 24 h.
 *
 * Criterios de "KYC incompleto":
 *   - kycStatus === 'pending'
 *   - createdAt < (ahora - 24 h)
 *   - stripeVerificationSessionId ausente o null (nunca abrió el widget)
 *
 * Acción:
 *   - Resuelve antes las verificaciones colgadas ([kycStaleSessionSweeper])
 *   - Envía email de alerta al admin con listado de usuarios
 *
 * Cómo se programa:
 *   - Desde server.js cada 6 horas via setInterval
 *   - Manualmente via POST /api/v1/admin/kyc-monitor (si se expone)
 */

import User    from '../models/User.js';
import { kycStaleSessionSweeper } from './kycStaleSessionSweeper.js';
import * as Sentry from '@sentry/node';

const HOURS_THRESHOLD = 24;

/** Tiempo mínimo entre dos avisos de KYC incompleto, aunque el job corra más seguido. */
const COOLDOWN_AVISO_MS = 24 * 60 * 60 * 1000;

export async function kycIncompleteMonitor() {
  const startTime  = Date.now();
  const cutoffDate = new Date(Date.now() - HOURS_THRESHOLD * 60 * 60 * 1000);

  try {
    // Primero resolver lo resoluble. Un usuario colgado en 'in_review' no aparece
    // en el listado de abajo (que solo mira 'pending'), así que sin este paso
    // quedaba fuera del aviso Y fuera del flujo: invisible por partida doble.
    // Va acá, y no con su propia regla de EventBridge, porque este job ya tiene
    // una provisionada; un job sin regla queda huérfano con
    // JOBS_EXTERNAL_SCHEDULER=true (ver jobRegistry.js).
    await kycStaleSessionSweeper();

    const pendingUsers = await User.find({
      kycStatus: 'pending',
      createdAt: { $lt: cutoffDate },
    })
      .select('_id firstName lastName email legalEntity createdAt stripeVerificationSessionId')
      .lean();

    if (!pendingUsers.length) {
      console.info('[KYC Monitor] Sin usuarios con KYC incompleto.');
      return;
    }

    console.warn(`[KYC Monitor] ${pendingUsers.length} usuarios con KYC incompleto (>24h).`);

    // Un aviso cada 24 h alcanza: el listado es prácticamente el mismo entre
    // corridas y nadie va a actuar distinto por verlo cuatro veces el mismo día.
    // El 2026-10-01 este correo salió 10 veces, en parte porque cada recreación
    // de contenedor vuelve a disparar el job.
    const { debeAlertar } = await import('../services/adminAlertThrottle.js');
    if (!await debeAlertar('kyc-incompleto', COOLDOWN_AVISO_MS)) {
      console.info('[KYC Monitor] Aviso ya enviado dentro del cooldown — se omite el email.');
      return;
    }

    const { sendRawEmail } = await import('../services/email.js');

    const adminEmail = process.env.SENDGRID_ADMIN_EMAIL
      ?? process.env.ADMIN_EMAIL
      ?? 'admin@alyto.app';

    const rows = pendingUsers.map(u => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${u._id}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${u.firstName} ${u.lastName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${u.email}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${u.legalEntity}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${new Date(u.createdAt).toLocaleString('es-CL', { timeZone: 'America/Santiago' })}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${u.stripeVerificationSessionId ? 'Iniciado (sin webhook)' : 'No iniciado'}</td>
      </tr>`).join('');

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:700px;margin:0 auto;background:#F8FAFC;">
        <div style="background:#0B1526;padding:24px;text-align:center;">
          <h1 style="color:#FFFFFF;margin:0;font-size:20px;">Alyto — Alerta KYC</h1>
        </div>
        <div style="background:#FFFFFF;padding:24px;color:#0F1B2E;">
          <h2 style="margin:0 0 8px;font-size:16px;">Usuarios con KYC incompleto (&gt;${HOURS_THRESHOLD}h)</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#64748B;">
            Los siguientes ${pendingUsers.length} usuarios se registraron pero no completaron la verificación de identidad.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#0D1F3C;color:#FFFFFF;">
                <th style="padding:10px 12px;text-align:left;">ID</th>
                <th style="padding:10px 12px;text-align:left;">Nombre</th>
                <th style="padding:10px 12px;text-align:left;">Email</th>
                <th style="padding:10px 12px;text-align:left;">Entidad</th>
                <th style="padding:10px 12px;text-align:left;">Registro</th>
                <th style="padding:10px 12px;text-align:left;">Estado Stripe</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#94A3B8;">
            Generado: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })} · Alyto v2.0
          </p>
        </div>
      </div>`;

    await sendRawEmail(
      adminEmail,
      `[Alyto Admin] ${pendingUsers.length} usuarios con KYC incompleto`,
      html,
    );

    console.info(`[KYC Monitor] Email de alerta enviado a ${adminEmail}. Usuarios: ${pendingUsers.length}. (${Date.now() - startTime}ms)`);

  } catch (err) {
    console.error('[KYC Monitor] Error:', err.message);
    Sentry.captureException(err, { tags: { job: 'kycIncompleteMonitor' } });
  }
}
