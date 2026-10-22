/**
 * monitorAuthAnomalies.js — detecta reconocimiento contra el acceso y AVISA.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * El 2026-10-21 y 22 una sonda desde 133.223.59.4 hizo 16 intentos fallidos de
 * acceso contra ~10 cuentas distintas, incluida la de un admin, y barrió 10
 * endpoints de /admin. Nada funcionó: los dos controles de acceso aguantaron. Pero
 * **nadie se enteró durante 36 horas**, y se descubrió por casualidad revisando
 * otra cosa.
 *
 * Ninguno de los dos límites existentes podía verlo, y es importante entender por
 * qué para no volver a confundirlos:
 *
 *   - `failedStreak` por CUENTA (`AUTH_MAX_FAILED_ATTEMPTS`, 5): la sonda rotó
 *     entre diez cuentas, así que ninguna racha pasó de 2.
 *   - `loginLimiter` por IP (5 fallos / 15 min): su ráfaga más densa fueron 5
 *     fallos en 51 segundos, justo en el límite, sin un sexto que lo cruzara.
 *
 * El patrón delator no es "muchos fallos en una cuenta" ni "muchos fallos muy
 * rápido", sino **una IP tocando muchas cuentas distintas a lo largo de horas**.
 * Eso es lo que mide este job.
 *
 * ── Por qué AVISA y no bloquea ───────────────────────────────────────────────
 *
 * Deliberado. Los usuarios bolivianos comparten IP pública por CGNAT, y eso ya
 * causó un bug real: `loginLimiter` contaba también los accesos exitosos y varios
 * usuarios detrás de la misma IP se bloqueaban entre ellos (arreglado en el PR
 * #36). Una regla que BLOQUEE por IP entre cuentas distintas repetiría ese error
 * con otro disfraz y dejaría a un barrio entero sin entrar.
 *
 * Por eso esto es un control detectivo: mide, puntúa y deja la decisión en una
 * persona. El bloqueo, cuando corresponde, se pone a mano en
 * `/data/nginx/custom/server_proxy.conf` del contenedor nginx-proxy-manager.
 *
 * ── El dato que de verdad distingue ──────────────────────────────────────────
 *
 * `reason: 'user_not_found'` es el discriminante más fuerte. Un usuario legítimo
 * se equivoca en SU propia cuenta, que existe: falla con `bad_password`. Una IP
 * que acumula fallos contra direcciones que NO EXISTEN está adivinando nombres, y
 * eso no lo produce una multitud detrás de un CGNAT.
 */

import * as Sentry             from '@sentry/node';
import AccessLog               from '../models/AccessLog.js';
import { sendRawEmail }        from '../services/email.js';
import { debeAlertar }         from '../services/adminAlertThrottle.js';
import { logger }              from '../utils/logger.js';

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** Ventana de observación. Larga a propósito: el goteo lento es el que se escapa. */
const ventanaHoras = () => num(process.env.AUTH_ANOMALY_WINDOW_HOURS, 24);

/** Umbrales. Se leen por llamada, no al cargar el módulo (regla 21). */
const umbrales = () => ({
  minFallos:       num(process.env.AUTH_ANOMALY_MIN_FAILURES, 10),
  minCuentas:      num(process.env.AUTH_ANOMALY_MIN_ACCOUNTS, 3),
  minInexistentes: num(process.env.AUTH_ANOMALY_MIN_UNKNOWN, 3),
});

/** Una alerta por IP cada 6 h: el aviso tiene que ser accionable, no un goteo. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Decide qué IPs son anómalas. **Pura**: recibe las filas ya agregadas y no toca
 * la base, para poder probar los umbrales sin Mongo.
 *
 * @param {Array<{ip:string, fallos:number, correos:string[], cuentasExistentes:string[],
 *                 inexistentes:number, adminApuntado:boolean, agentes:string[]}>} filas
 * @param {{minFallos:number, minCuentas:number, minInexistentes:number}} u
 * @returns {Array<object>} filas marcadas, con sus señales, de más grave a menos
 */
export function evaluarAnomalias(filas, u = umbrales()) {
  const marcadas = [];

  for (const f of filas ?? []) {
    if (!f?.ip) continue;
    const senales = [];

    // Enumeración: adivinar nombres de cuenta. La señal más limpia.
    if ((f.inexistentes ?? 0) >= u.minInexistentes) {
      senales.push(`enumeración de cuentas (${f.inexistentes} direcciones inexistentes)`);
    }

    // Rociado: pocos intentos por cuenta, muchas cuentas. Pasa por debajo de los
    // dos límites existentes justamente por ser disperso.
    const cuentas = (f.correos ?? []).length;
    if ((f.fallos ?? 0) >= u.minFallos && cuentas >= u.minCuentas) {
      senales.push(`rociado de contraseñas (${f.fallos} fallos sobre ${cuentas} cuentas)`);
    }

    // "Apuntó a un admin" es AGRAVANTE, no disparador. Probado contra los datos
    // reales de producción: como disparador autónomo marcaba la IP del propio
    // Alvaro equivocándose 9 veces su contraseña de admin en 72 h. Eso es ruido, y
    // además redundante: insistir sobre UNA cuenta ya lo frena `failedStreak`
    // (bloqueo a los 5). Lo que este job cubre es lo que ese límite no ve, que es
    // la DISPERSIÓN. Sin otra señal, un admin fallando no distingue al dueño
    // distraído de un atacante, y alarmar por eso cada semana mata la alerta.
    if (f.adminApuntado && senales.length) {
      senales.push('y apuntó a una cuenta ADMIN');
    }

    if (senales.length) marcadas.push({ ...f, senales, gravedad: senales.length });
  }

  return marcadas.sort((a, b) => b.gravedad - a.gravedad || b.fallos - a.fallos);
}

/** Agrega los fallos de la ventana por IP. */
async function agruparPorIp(desde) {
  const filas = await AccessLog.aggregate([
    {
      $match: {
        createdAt: { $gte: desde },
        outcome:   { $in: ['failed', 'blocked'] },
        ip:        { $nin: [null, ''] },
      },
    },
    {
      $group: {
        _id:               '$ip',
        fallos:            { $sum: 1 },
        correos:           { $addToSet: '$email' },
        cuentasExistentes: { $addToSet: '$userId' },
        // `user_not_found` = la dirección no existe → alguien está adivinando.
        inexistentes:      { $sum: { $cond: [{ $eq: ['$reason', 'user_not_found'] }, 1, 0] } },
        adminApuntado:     { $max: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] } },
        agentes:           { $addToSet: '$userAgent' },
        primero:           { $min: '$createdAt' },
        ultimo:            { $max: '$createdAt' },
      },
    },
  ]);

  return filas.map(f => ({
    ip:                f._id,
    fallos:            f.fallos,
    correos:           (f.correos ?? []).filter(Boolean),
    cuentasExistentes: (f.cuentasExistentes ?? []).filter(Boolean).length,
    inexistentes:      f.inexistentes,
    adminApuntado:     f.adminApuntado === 1,
    agentes:           (f.agentes ?? []).filter(Boolean),
    primero:           f.primero,
    ultimo:            f.ultimo,
  }));
}

/** Arma el cuerpo del aviso. El runbook va adentro: quien lo lee tiene que poder actuar. */
export function construirAviso(ip, d, horas) {
  return `
[Alyto] ACTIVIDAD ANÓMALA DE ACCESO

IP:        ${ip}
Señales:   ${d.senales.join(' · ')}
Ventana:   últimas ${horas} h  (${d.primero?.toISOString?.() ?? '?'} → ${d.ultimo?.toISOString?.() ?? '?'})

Intentos fallidos:        ${d.fallos}
Cuentas distintas:        ${d.correos.length}
De ellas, existentes:     ${d.cuentasExistentes}
Direcciones inexistentes: ${d.inexistentes}
Cuenta admin apuntada:    ${d.adminApuntado ? 'SÍ' : 'no'}

User agents:
${d.agentes.slice(0, 5).map(a => `  - ${String(a).slice(0, 100)}`).join('\n') || '  (ninguno)'}

Cuentas intentadas:
${d.correos.slice(0, 15).map(c => `  - ${c}`).join('\n')}${d.correos.length > 15 ? `\n  … y ${d.correos.length - 15} más` : ''}

Cómo leerlo:
  · Muchas direcciones INEXISTENTES desde una sola IP es casi conclusivo: alguien
    está adivinando nombres de cuenta. Una multitud legítima detrás de un CGNAT
    falla con 'bad_password' en cuentas que SÍ existen.
  · Si las cuentas existen y los fallos están repartidos, puede ser CGNAT: varios
    usuarios reales compartiendo IP pública. Mirar los user agents antes de decidir.

Si corresponde bloquear:
  docker exec nginx-proxy-manager sh -c 'echo "deny ${ip};" >> /data/nginx/custom/server_proxy.conf'
  docker exec nginx-proxy-manager nginx -t && docker exec nginx-proxy-manager nginx -s reload
  (ese archivo vive en el volumen /data, así que sobrevive a los redespliegues)

Alyto Backend — ${new Date().toISOString()}
`.trim();
}

/**
 * Job principal. Nunca lanza.
 * @returns {Promise<{revisadas:number, marcadas:number, avisadas:number}>}
 */
export async function monitorAuthAnomalies() {
  const stats = { revisadas: 0, marcadas: 0, avisadas: 0 };

  try {
    const horas = ventanaHoras();
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);

    const filas = await agruparPorIp(desde);
    stats.revisadas = filas.length;

    const marcadas = evaluarAnomalias(filas);
    stats.marcadas = marcadas.length;
    if (!marcadas.length) return stats;

    const destinatario = process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app';

    for (const d of marcadas) {
      // Sentry SIEMPRE: no depende de la cuota de correo, que es de 100/día y ya
      // bloqueó un aviso de cumplimiento antes.
      Sentry.captureMessage(`Acceso: actividad anómala desde ${d.ip}`, {
        level: 'warning',
        extra: {
          ip: d.ip, senales: d.senales, fallos: d.fallos,
          cuentas: d.correos.length, inexistentes: d.inexistentes,
          adminApuntado: d.adminApuntado, agentes: d.agentes.slice(0, 5),
        },
      });

      logger.warn('[AuthAnomaly] Actividad anómala de acceso', {
        ip: d.ip, senales: d.senales, fallos: d.fallos,
        cuentas: d.correos.length, inexistentes: d.inexistentes,
        adminApuntado: d.adminApuntado,
      });

      // El correo sí se limita: una IP insistente generaría un aviso por corrida.
      if (!(await debeAlertar(`auth-anomaly:${d.ip}`, COOLDOWN_MS))) continue;

      try {
        await sendRawEmail(
          destinatario,
          `[Alyto] ⚠️ Acceso anómalo desde ${d.ip}${d.adminApuntado ? ' — APUNTÓ A UN ADMIN' : ''}`,
          `<pre style="font-family:monospace;white-space:pre-wrap">${construirAviso(d.ip, d, horas)}</pre>`,
        );
        stats.avisadas++;
      } catch (err) {
        logger.error('[AuthAnomaly] No se pudo enviar el aviso', { ip: d.ip, error: err.message });
      }
    }

    logger.info('[AuthAnomaly] Resultado', stats);
  } catch (err) {
    logger.error('[AuthAnomaly] Error inesperado en el job', { error: err.message });
  }

  return stats;
}

export default monitorAuthAnomalies;
