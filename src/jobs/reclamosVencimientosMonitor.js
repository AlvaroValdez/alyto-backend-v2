/**
 * reclamosVencimientosMonitor.js — Vigila el plazo regulatorio de los reclamos
 * PRILI (10 días hábiles, ASFI) y avisa a administración ANTES de que se venza
 * y, con más insistencia, cuando ya se venció.
 *
 * BRECHA QUE CIERRA (revisión 2026-10-05): `plazoVence` se calcula y se indexa
 * desde la Fase 27, y el panel tiene `GET /admin/reclamos/vencimientos` — pero
 * ningún proceso lo miraba solo. El cumplimiento del plazo dependía de que un
 * humano abriera el panel a tiempo; este job convierte el compromiso declarado
 * ante ASFI en una alerta operativa.
 *
 * QUÉ HACE: clasifica los reclamos ABIERTOS (recibido / en_revision) en
 *   - vencidos:   plazoVence < ahora          → incumplimiento en curso
 *   - por vencer: vencen dentro de la ventana → RECLAMOS_AVISO_DIAS (default 3)
 * y avisa por SSE al panel (siempre, no cuesta cuota) + email al admin.
 *
 * QUÉ NO HACE a propósito: NO escala automáticamente a 'escalado_asfi'. Escalar
 * es un acto con significado regulatorio que exige decisión humana — el job
 * alerta, el admin actúa (misma filosofía que el checkpoint de los retiros).
 *
 * EMAIL CON FRENO PERSISTENTE (adminAlertThrottle, sobrevive reinicios de
 * contenedor — lección del 2026-10-01, cuando un aviso salió 10 veces):
 *   - con VENCIDOS:     cooldown corto (RECLAMOS_ALERTA_VENCIDOS_HORAS, def. 12 h)
 *   - solo por vencer:  cooldown de 24 h — el listado casi no cambia entre
 *     corridas y nadie actúa distinto por verlo cuatro veces el mismo día.
 * Dos llaves de freno separadas: que el aviso suave de ayer no silencie el
 * crítico de hoy.
 */

import Reclamo from '../models/Reclamo.js';

const DIA_MS = 24 * 60 * 60 * 1000;

function ventanaAvisoDias() {
  const n = Number(process.env.RECLAMOS_AVISO_DIAS);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function cooldownVencidosMs() {
  const h = Number(process.env.RECLAMOS_ALERTA_VENCIDOS_HORAS);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 60 * 60 * 1000;
}

const resumen = (r, ahora) => ({
  reclamoId:  r.reclamoId,
  tipo:       r.tipo,
  status:     r.status,
  plazoVence: r.plazoVence,
  diasRestantes: Math.ceil((new Date(r.plazoVence) - ahora) / DIA_MS),
});

export async function reclamosVencimientosMonitor() {
  try {
    const ahora  = new Date();
    const limite = new Date(ahora.getTime() + ventanaAvisoDias() * DIA_MS);

    const abiertos = await Reclamo.find({
      status:     { $in: ['recibido', 'en_revision'] },
      plazoVence: { $lte: limite },
    }).select('reclamoId tipo status plazoVence userId').lean();

    if (!abiertos.length) {
      console.info('[Reclamos Monitor] Sin reclamos vencidos ni por vencer.');
      return { vencidos: 0, porVencer: 0 };
    }

    const vencidos  = abiertos.filter(r => new Date(r.plazoVence) <  ahora).map(r => resumen(r, ahora));
    const porVencer = abiertos.filter(r => new Date(r.plazoVence) >= ahora).map(r => resumen(r, ahora));

    console.warn(`[Reclamos Monitor] ${vencidos.length} reclamo(s) VENCIDOS, ${porVencer.length} por vencer (≤${ventanaAvisoDias()} días).`);

    // SSE al panel — siempre: no consume cuota de correo y el tab Accionables
    // es donde el admin vive durante el día.
    try {
      const { broadcastToAdmins } = await import('../routes/adminSSE.js');
      broadcastToAdmins('reclamos_vencimientos', {
        vencidos, porVencer, ventanaDias: ventanaAvisoDias(),
      });
    } catch (e) { console.error('[Reclamos Monitor] SSE falló:', e.message); }

    // Email con freno persistente. La llave y el cooldown dependen de la
    // gravedad: un vencido es un incumplimiento EN CURSO del plazo ASFI.
    const hayVencidos = vencidos.length > 0;
    const llave       = hayVencidos ? 'reclamos-vencidos' : 'reclamos-por-vencer';
    const cooldown    = hayVencidos ? cooldownVencidosMs() : 24 * 60 * 60 * 1000;

    const { debeAlertar } = await import('../services/adminAlertThrottle.js');
    if (!await debeAlertar(llave, cooldown)) {
      console.info('[Reclamos Monitor] Aviso dentro del cooldown — se omite el email.');
      return { vencidos: vencidos.length, porVencer: porVencer.length, emailOmitido: true };
    }

    const { sendRawEmail } = await import('../services/email.js');
    const adminEmail = process.env.SENDGRID_ADMIN_EMAIL
      ?? process.env.ADMIN_EMAIL
      ?? 'admin@alyto.app';

    const fila = (r) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${r.reclamoId}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${r.tipo}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${r.status}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">${new Date(r.plazoVence).toISOString().slice(0, 10)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-weight:bold;color:${r.diasRestantes < 0 ? '#DC2626' : '#B45309'};">
          ${r.diasRestantes < 0 ? `VENCIDO hace ${-r.diasRestantes} día(s)` : `quedan ${r.diasRestantes} día(s)`}
        </td>
      </tr>`;

    const tabla = (titulo, lista) => lista.length ? `
      <h3 style="margin:18px 0 8px;font-size:14px;color:#0D1F3C;">${titulo}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#0D1F3C;color:#FFFFFF;">
          <th style="padding:10px 12px;text-align:left;">Reclamo</th>
          <th style="padding:10px 12px;text-align:left;">Tipo</th>
          <th style="padding:10px 12px;text-align:left;">Estado</th>
          <th style="padding:10px 12px;text-align:left;">Vence</th>
          <th style="padding:10px 12px;text-align:left;">Plazo</th>
        </tr></thead>
        <tbody>${lista.map(fila).join('')}</tbody>
      </table>` : '';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;">
        ${tabla(`⛔ Plazo de 10 días hábiles VENCIDO (${vencidos.length})`, vencidos)}
        ${tabla(`⏳ Por vencer en ≤${ventanaAvisoDias()} días (${porVencer.length})`, porVencer)}
        <p style="margin:16px 0 0;font-size:13px;">
          <a href="${process.env.APP_ADMIN_URL ?? 'https://alyto.app/admin'}/reclamos">Abrir el panel de reclamos</a>
        </p>
        <p style="margin:12px 0 0;font-size:12px;color:#94A3B8;">
          El escalamiento a ASFI es decisión del operador — este aviso no cambia estados.
          · Generado: ${new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' })} · Alyto v2.0
        </p>
      </div>`;

    await sendRawEmail(
      adminEmail,
      hayVencidos
        ? `⛔ PRILI: ${vencidos.length} reclamo(s) con plazo VENCIDO`
        : `⏳ PRILI: ${porVencer.length} reclamo(s) por vencer`,
      html,
    );
    console.info('[Reclamos Monitor] Email de vencimientos enviado a', adminEmail);

    return { vencidos: vencidos.length, porVencer: porVencer.length, emailEnviado: true };
  } catch (err) {
    // Un monitor jamás tumba el proceso: registrar y seguir.
    console.error('[Reclamos Monitor] Error:', err.message);
    try {
      const { default: Sentry } = await import('../services/sentry.js');
      Sentry.captureException(err, { tags: { job: 'reclamosVencimientosMonitor' } });
    } catch { /* sin Sentry no hay nada más que hacer */ }
    return { error: err.message };
  }
}

export default reclamosVencimientosMonitor;
