/**
 * kycBlockedAlert.js — Avisa a administración cuando un usuario no logra pasar
 * la verificación de identidad por un fallo que no es suyo.
 *
 * ── Cómo se detecta, y por qué así ──────────────────────────────────────────
 *
 * El problema de fondo de todo este flujo es que una sesión de Stripe recién
 * creada y una cuyo alojado nunca cargó se ven IDÉNTICAS desde la API: ambas en
 * 'requires_input' sin error. Por eso el barrido necesita esperar 15 minutos
 * antes de concluir nada.
 *
 * Pero hay una señal que no es ambigua: **que el usuario lance una sesión nueva**.
 * Para hacerlo tuvo que volver a la aplicación y pulsar el botón otra vez, lo que
 * sólo ocurre si la anterior no llegó a término. No hace falta esperar ni suponer;
 * el propio acto del usuario cierra el caso de la sesión anterior.
 *
 * Así que la cuenta es: al abrir un intento, cuántos intentos consecutivos
 * inmediatamente anteriores quedaron sin retorno del alojado de Stripe
 * (`returnedAt` nulo). Uno es ruido: una conexión que se cayó, alguien que cambió
 * de idea. Dos seguidos ya es un patrón, y es el momento de que una persona mire.
 *
 * ── Por qué una alerta y no otro correo al usuario ──────────────────────────
 *
 * A quien falla una vez se le invita a reintentar ([kycRetryNudge]). A quien falla
 * dos veces seguidas, repetirle "vuelve a intentarlo" es inútil: ya lo intentó, y
 * no funciona. Ese caso necesita que alguien lo contacte, no otro recordatorio.
 *
 * El 2026-10-02 esto habría avisado el mismo día en lugar de depender de que el
 * usuario se quejara por otro canal.
 */

import KycAttempt from '../models/KycAttempt.js';
import { logger } from '../utils/logger.js';

function config() {
  // Dentro de la función (regla 21): en el ámbito del módulo tomaría los valores
  // anteriores a la carga de secretos.
  return {
    umbral:     Number(process.env.KYC_BLOQUEO_INTENTOS || 2),
    cooldownMs: Number(process.env.KYC_BLOQUEO_COOLDOWN_HORAS || 24) * 60 * 60 * 1000,
  };
}

/**
 * Cuenta los intentos consecutivos sin retorno inmediatamente anteriores a uno dado.
 *
 * La racha se corta en el primer intento que SÍ volvió del alojado de Stripe: ese
 * usuario llegó a ver la pantalla, así que lo que vino antes es historia distinta.
 * Exportada para poder ejercitar el conteo sin montar la alerta entera.
 *
 * @param {Array<{returnedAt: Date|null}>} anteriores — del más reciente al más antiguo
 */
export function contarFallosConsecutivos(anteriores) {
  let n = 0;
  for (const intento of anteriores) {
    if (intento.returnedAt) break;
    n += 1;
  }
  return n;
}

/**
 * Evalúa el historial del usuario tras abrir un intento nuevo y, si procede,
 * avisa a administración.
 *
 * Pensada para invocarse fire-and-forget (regla 13): un fallo acá jamás puede
 * impedir que el usuario inicie su verificación.
 *
 * @param {{_id: any, email?: string, firstName?: string, legalEntity?: string}} user
 * @param {string} sessionIdNuevo — intento recién abierto, excluido del conteo
 */
export async function revisarBloqueoKyc(user, sessionIdNuevo) {
  const cfg = config();

  const anteriores = await KycAttempt.find({
    userId:    user._id,
    sessionId: { $ne: sessionIdNuevo },
  })
    .select('sessionId returnedAt platform createdAt ip userAgent outcome')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  const fallos = contarFallosConsecutivos(anteriores);
  if (fallos < cfg.umbral) return { alertado: false, fallos };

  // Una alerta por usuario por día. El cooldown es persistente, así que sobrevive
  // a los redespliegues (ver adminAlertThrottle).
  const { debeAlertar } = await import('./adminAlertThrottle.js');
  if (!await debeAlertar(`kyc-bloqueo-${user._id}`, cfg.cooldownMs)) {
    logger.info('[KYC Bloqueo] Dentro del cooldown, no se repite el aviso', {
      userId: String(user._id), fallos,
    });
    return { alertado: false, fallos, motivo: 'cooldown' };
  }

  const ultimo = anteriores[0] ?? {};
  const detalle = {
    email:       user.email,
    nombre:      user.firstName,
    entidad:     user.legalEntity,
    fallos,
    plataforma:  ultimo.platform,
    ultimaIp:    ultimo.ip,
    ultimoAgente: ultimo.userAgent,
    sesiones:    anteriores.slice(0, fallos).map(a => a.sessionId),
  };

  const { notifyAdmins } = await import('./notifications.js');
  await notifyAdmins({
    title: 'Usuario bloqueado en la verificación de identidad',
    body:  `${user.email} lanzó la verificación ${fallos + 1} veces y la pantalla de Stripe no llegó a cargarle ninguna de las ${fallos} anteriores.`,
    data:  { type: 'admin_kyc_bloqueado', userId: String(user._id), fallos: String(fallos) },
  });

  await enviarCorreoAdmin(user, detalle);

  logger.warn('[KYC Bloqueo] Aviso enviado a administración', detalle);
  return { alertado: true, fallos };
}

async function enviarCorreoAdmin(user, d) {
  const { sendRawEmail } = await import('./email.js');
  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL
    ?? process.env.ADMIN_EMAIL
    ?? 'admin@alyto.app';

  const fila = (k, v) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #E2E8F0;color:#64748B;">${k}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #E2E8F0;color:#0F1B2E;">${v ?? '—'}</td>
    </tr>`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#F8FAFC;">
      <div style="background:#0B1526;padding:24px;text-align:center;">
        <h1 style="color:#FFFFFF;margin:0;font-size:20px;">Alyto — Verificación bloqueada</h1>
      </div>
      <div style="background:#FFFFFF;padding:24px;color:#0F1B2E;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
          <strong>${d.email}</strong> intentó verificar su identidad varias veces seguidas y la
          pantalla alojada de Stripe no llegó a cargarle en ninguna: el navegador nunca volvió
          a la aplicación.
        </p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#3B4A63;">
          No es un abandono. Enviarle otro recordatorio automático no sirve, porque ya lo está
          intentando. Conviene contactarlo y, si hace falta, acompañarlo desde otro dispositivo
          o conexión.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${fila('Usuario', `${d.nombre ?? ''} (${d.email})`)}
          ${fila('Entidad', d.entidad)}
          ${fila('Intentos fallidos seguidos', d.fallos)}
          ${fila('Plataforma', d.plataforma)}
          ${fila('Última IP', d.ultimaIp)}
          ${fila('Navegador', d.ultimoAgente)}
          ${fila('Sesiones Stripe', (d.sesiones ?? []).join('<br>'))}
        </table>
        <p style="margin:20px 0 0;font-size:13px;color:#64748B;">
          Historial completo:
          <code>GET /api/v1/admin/kyc-attempts?email=${encodeURIComponent(d.email ?? '')}</code>
        </p>
      </div>
      <div style="padding:16px 24px;text-align:center;font-size:12px;color:#94A3B8;">
        Generado: ${new Date().toLocaleString('es-CL', { timeZone: 'America/La_Paz' })} · Alyto v2.0
      </div>
    </div>`;

  await sendRawEmail(adminEmail, `[Alyto Admin] Verificación bloqueada: ${d.email}`, html);
}

export default { revisarBloqueoKyc, contarFallosConsecutivos };
