/**
 * clientDuplicateAlert.js — Avisa a administración cuando una cuenta nueva es, con
 * alta probabilidad, una persona que ya tiene cuenta.
 *
 * ── Por qué avisa y no bloquea ──────────────────────────────────────────────
 *
 * Un documento repetido casi siempre es la misma persona registrándose otra vez,
 * pero no siempre: un CI mal tecleado por dos usuarios distintos, una cuenta
 * business y la personal de su representante, un número de teléfono reasignado
 * por la operadora. Rechazar el alta convertiría cada uno de esos casos en un
 * usuario que no puede entrar y que nadie ve. Avisar los pone todos sobre la mesa
 * de alguien que puede decidir, y el costo de un falso positivo es un correo.
 *
 * ── Por qué el usuario no se entera ─────────────────────────────────────────
 *
 * La respuesta al registro NO cambia: ni un mensaje, ni un código de error, ni una
 * demora distinta. Decirle "ese documento ya está registrado" convierte el
 * formulario en un oráculo de pertenencia: cualquiera podría probar números de CI
 * y averiguar quién es cliente de Alyto. El aviso va hacia adentro; hacia afuera
 * el alta se comporta exactamente igual que siempre.
 *
 * ── Qué se considera señal ──────────────────────────────────────────────────
 *
 *   documento → huella HMAC del número normalizado. Señal FUERTE: el CI identifica
 *               a la persona y lo declara ella misma.
 *   teléfono  → últimos dígitos. Señal MEDIA: se comparte en familia y las
 *               operadoras reasignan números, pero fue justo lo que delató el caso
 *               real del 2026-10-10.
 *
 * Las dos juntas, en cuentas aprobadas, son prácticamente concluyentes.
 *
 * ── El caso que lo motivó ───────────────────────────────────────────────────
 *
 * Una persona con dos cuentas aprobadas (03-oct y 10-oct), dos verificaciones de
 * Stripe pagadas y verificadas al primer intento, y dos cuentas custodiales con su
 * propio par de claves. Nada en el sistema lo señaló: se descubrió revisando a
 * mano el panel de Stripe. Importa más allá del costo, porque cada cuenta cuenta
 * como un consumidor distinto contra el tope del Entorno Controlado de Pruebas.
 */

import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import { documentFingerprint, phoneTail } from './clientIdentityIndex.js';

function config() {
  // Dentro de la función (regla 21): en el ámbito del módulo tomaría los valores
  // anteriores a la carga de secretos.
  return {
    activo:     process.env.CLIENT_DUPLICATE_ALERT_ENABLED !== 'false',
    cooldownMs: Number(process.env.CLIENT_DUPLICATE_COOLDOWN_HORAS || 24) * 60 * 60 * 1000,
  };
}

/** Campos mínimos para describir la cuenta que ya existía, sin exponer el CI. */
const PROYECCION = 'email firstName lastName phone legalEntity kycStatus kycApprovedAt createdAt deletionStatus';

/**
 * Busca otras cuentas que compartan documento o teléfono con la indicada.
 *
 * Separada de la alerta para poder ejercitar la detección sin montar el correo, y
 * para que el script de conciliación reutilice exactamente el mismo criterio —si
 * el script y el registro divergen, el informe deja de describir lo que el sistema
 * detecta.
 *
 * @param {{_id: any}} user
 * @param {{documentNumber?: string|null, phone?: string|null}} valores
 *        Valores ENTRANTES. Se pasan explícitos (y no se leen del documento ya
 *        guardado) porque la detección corre justo después de escribirlos y el
 *        objeto en memoria puede no tenerlos: `protect` no selecciona la huella.
 * @returns {Promise<{motivos: string[], coincidencias: object[]}>}
 */
export async function buscarCoincidencias(user, valores = {}) {
  const fingerprint = await documentFingerprint(valores.documentNumber ?? null);
  const tail        = phoneTail(valores.phone ?? null);

  const claves = [];
  if (fingerprint) claves.push({ 'identityDocument.numberFingerprint': fingerprint });
  if (tail)        claves.push({ phoneTail: tail });
  if (!claves.length) return { motivos: [], coincidencias: [] };

  const otras = await User.find({ _id: { $ne: user._id }, $or: claves })
    .select(`${PROYECCION} +identityDocument.numberFingerprint +phoneTail`)
    .sort({ createdAt: 1 })
    .limit(10)
    .lean();

  if (!otras.length) return { motivos: [], coincidencias: [] };

  const coincidencias = otras.map(o => ({
    _id:         o._id,
    email:       o.email,
    nombre:      `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim(),
    telefono:    o.phone ?? null,
    entidad:     o.legalEntity,
    kycStatus:   o.kycStatus,
    creada:      o.createdAt,
    eliminada:   o.deletionStatus && o.deletionStatus !== 'active' ? o.deletionStatus : null,
    porDocumento: Boolean(fingerprint) && o.identityDocument?.numberFingerprint === fingerprint,
    porTelefono:  Boolean(tail) && o.phoneTail === tail,
  }));

  const motivos = [];
  if (coincidencias.some(c => c.porDocumento)) motivos.push('documento');
  if (coincidencias.some(c => c.porTelefono))  motivos.push('telefono');

  return { motivos, coincidencias };
}

/**
 * Evalúa una cuenta recién creada o recién actualizada y, si comparte identidad con
 * otra, avisa a administración.
 *
 * Pensada para invocarse fire-and-forget (regla 13): un fallo acá jamás puede
 * impedir que alguien se registre o complete su perfil de cumplimiento. Por eso
 * atrapa todo y no relanza.
 *
 * @param {{_id: any, email?: string, firstName?: string, lastName?: string, legalEntity?: string}} user
 * @param {{documentNumber?: string|null, phone?: string|null, origen?: string}} valores
 * @returns {Promise<{duplicado: boolean, motivos?: string[], alertado?: boolean}>}
 */
export async function revisarClienteDuplicado(user, valores = {}) {
  const cfg = config();
  if (!cfg.activo) return { duplicado: false };

  try {
    const { motivos, coincidencias } = await buscarCoincidencias(user, valores);
    if (!motivos.length) return { duplicado: false };

    const detalle = {
      userId:  String(user._id),
      email:   user.email,
      origen:  valores.origen ?? 'desconocido',
      motivos,
      cuentas: coincidencias.map(c => c.email),
    };

    // Un aviso por cuenta y motivo por día. La clave incluye el motivo a propósito:
    // el registro suele coincidir solo por teléfono y el CI llega después, en el
    // perfil de cumplimiento. Con una clave por usuario, esa segunda señal —que es
    // la fuerte— quedaría silenciada por el cooldown de la primera.
    const { debeAlertar } = await import('./adminAlertThrottle.js');
    const clave = `cliente-duplicado-${user._id}-${motivos.join('+')}`;
    if (!await debeAlertar(clave, cfg.cooldownMs)) {
      logger.info('[Duplicado] Dentro del cooldown, no se repite el aviso', detalle);
      return { duplicado: true, motivos, alertado: false };
    }

    const { notifyAdmins } = await import('./notifications.js');
    await notifyAdmins({
      title: 'Posible cuenta duplicada',
      body:  `${user.email} comparte ${motivos.join(' y ')} con ${coincidencias.length === 1 ? 'la cuenta' : 'las cuentas'} ${coincidencias.map(c => c.email).join(', ')}.`,
      data:  { type: 'admin_cliente_duplicado', userId: String(user._id) },
    });

    await enviarCorreoAdmin(user, { motivos, coincidencias, origen: detalle.origen });

    logger.warn('[Duplicado] Aviso enviado a administración', detalle);
    return { duplicado: true, motivos, alertado: true };

  } catch (err) {
    // El registro ya respondió 201: acá no hay nada que salvar más que el rastro.
    logger.error('[Duplicado] La detección falló y se descartó', {
      userId: String(user?._id), err: err.message,
    });
    return { duplicado: false };
  }
}

/**
 * Correo a administración.
 *
 * ⚠️ NO incluye el número de documento, ni el de la cuenta nueva ni el de la vieja.
 * Que coincidan es toda la información que hace falta para actuar, y un CI en una
 * bandeja de correo es PII fuera del perímetro cifrado. El teléfono sí va: ya se
 * muestra en el panel y sin él el aviso no es verificable.
 */
async function enviarCorreoAdmin(user, { motivos, coincidencias, origen }) {
  const { sendRawEmail } = await import('./email.js');
  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL
    ?? process.env.ADMIN_EMAIL
    ?? 'admin@alyto.app';

  const SENAL = {
    documento: 'mismo número de documento declarado',
    telefono:  'mismo teléfono',
  };

  const filaCuenta = (c) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;color:#0F1B2E;">
        ${c.nombre || '—'}<br>
        <span style="color:#64748B;font-size:12px;">${c.email}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;color:#3B4A63;font-size:12px;">
        ${c.entidad ?? '—'} · ${c.kycStatus ?? '—'}${c.eliminada ? ` · ${c.eliminada}` : ''}<br>
        ${c.telefono ?? '—'}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;color:#3B4A63;font-size:12px;">
        ${c.creada ? new Date(c.creada).toLocaleDateString('es-BO', { timeZone: 'America/La_Paz' }) : '—'}<br>
        ${[c.porDocumento ? 'documento' : null, c.porTelefono ? 'teléfono' : null].filter(Boolean).join(' + ')}
      </td>
    </tr>`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#F8FAFC;">
      <div style="background:#0B1526;padding:24px;text-align:center;">
        <h1 style="color:#FFFFFF;margin:0;font-size:20px;">Alyto — Posible cuenta duplicada</h1>
      </div>
      <div style="background:#FFFFFF;padding:24px;color:#0F1B2E;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
          La cuenta <strong>${user.email}</strong> comparte
          ${motivos.map(m => SENAL[m] ?? m).join(' y ')}
          con ${coincidencias.length === 1 ? 'otra cuenta existente' : `${coincidencias.length} cuentas existentes`}.
        </p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#3B4A63;">
          El registro se completó con normalidad: el usuario no recibió ningún aviso y puede operar.
          Esto es para que alguien decida qué cuenta se conserva. Mientras las dos sigan activas,
          cada una cuenta como un consumidor distinto y cada una paga su propia verificación de identidad.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#F1F5F9;">
              <th style="padding:8px 12px;text-align:left;color:#64748B;font-weight:600;">Cuenta existente</th>
              <th style="padding:8px 12px;text-align:left;color:#64748B;font-weight:600;">Entidad · KYC · Teléfono</th>
              <th style="padding:8px 12px;text-align:left;color:#64748B;font-weight:600;">Alta · Coincide por</th>
            </tr>
          </thead>
          <tbody>${coincidencias.map(filaCuenta).join('')}</tbody>
        </table>
        <p style="margin:20px 0 0;font-size:13px;color:#64748B;">
          Detectado en: <strong>${origen}</strong>. Informe completo del padrón:
          <code>node scripts/duplicados-clientes.mjs</code>
        </p>
      </div>
      <div style="padding:16px 24px;text-align:center;font-size:12px;color:#94A3B8;">
        Generado: ${new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' })} · Alyto v2.0
      </div>
    </div>`;

  await sendRawEmail(adminEmail, `[Alyto Admin] Posible cuenta duplicada: ${user.email}`, html);
}

export default { revisarClienteDuplicado, buscarCoincidencias };
