/**
 * disposableEmail.js — direcciones a las que no vale la pena mandar correo.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * La cuenta de SendGrid tiene tope DURO de 100 correos al día y una sonda
 * automatizada se da de alta en producción a ~1 por hora. Cada alta dispara tres
 * correos (código de verificación, bienvenida y aviso de baja), así que el sondeo
 * solo consume unos 3 créditos por ciclo y entre eso y las alertas internas dejó
 * el cupo en 108/100 el 2026-10-22, con **un único correo de usuario real** ese
 * día. El 23 ya no salía ninguno.
 *
 * Bloquear la IP no alcanza: se rotó de `133.223.59.4` a `32.196.243.11` en
 * horas. El dominio del destinatario, en cambio, no se rota tan fácil, y además
 * son direcciones que **no pueden recibir nada**.
 *
 * ── Qué NO hace ──────────────────────────────────────────────────────────────
 *
 * No impide registrarse. Quién puede abrir cuenta es una decisión de producto y de
 * compliance, no de este archivo. Esto solo evita gastar cupo en buzones que no
 * existen. Efecto colateral a tener presente: una cuenta con dominio descartable
 * **no va a poder verificarse**, porque el código de verificación no sale.
 *
 * ── Dos listas, a propósito ──────────────────────────────────────────────────
 *
 * 1. `NUNCA_ENTREGABLES`: reservados por RFC o servicios de correo temporal. Son
 *    seguros de bloquear porque no pueden pertenecer a una persona real.
 * 2. `OBSERVADOS_EN_SONDEO`: dominios que solo vi usados por la sonda pero que
 *    **podrían ser de alguien**. Van separados para que se puedan quitar sin
 *    tocar la lista segura si algún día aparece un usuario legítimo.
 *
 * Y `DISPOSABLE_EMAIL_DOMAINS` permite sumar más por variable de entorno, sin
 * desplegar, cuando la sonda estrene dominio.
 */

/**
 * TLD reservados que NUNCA pueden existir en internet (RFC 2606 y RFC 6761).
 * Cualquier dirección bajo estos es inválida por definición.
 */
const TLD_RESERVADOS = ['test', 'invalid', 'localhost', 'example'];

/** Dominios que no pueden pertenecer a una persona real. */
const NUNCA_ENTREGABLES = [
  'example.com', 'example.org', 'example.net',  // RFC 2606, reservados para documentación
  'test.alyto.io',                               // nuestro, sin registro MX
  'oast.online', 'oast.fun', 'oastify.com',      // Interactsh: canal lateral de escáneres
  'mailinator.com', 'maildrop.cc',               // correo temporal clásico
  'emailhook.site',                              // buzón desechable por webhook
];

/**
 * Observados SOLO en el sondeo, pero no demostrablemente descartables.
 * Si aparece un usuario legítimo con uno de estos, quitarlo de acá.
 */
const OBSERVADOS_EN_SONDEO = [
  'maxxspace.com',
  'westcast-systems.com',
];

/** Lista adicional por entorno, para reaccionar sin desplegar. */
function extras() {
  return String(process.env.DISPOSABLE_EMAIL_DOMAINS ?? '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * ¿Mandarle correo a esta dirección es tirar cupo a la basura?
 *
 * Compara el dominio completo Y sus dominios padre, porque la sonda usa
 * subdominios generados: `dbda9pups0ls6845t40g3t8z74mxrxij6.oast.online` tiene que
 * casar con `oast.online`. Un `endsWith` pelado no sirve: `notoast.online`
 * terminaría en `oast.online` sin serlo, así que se compara por etiquetas.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function esCorreoDescartable(email) {
  const dir = String(email ?? '').trim().toLowerCase();
  const arroba = dir.lastIndexOf('@');
  if (arroba < 1 || arroba === dir.length - 1) return false;  // sin dominio: que lo rechace la validación normal

  const dominio = dir.slice(arroba + 1);
  const etiquetas = dominio.split('.').filter(Boolean);
  if (etiquetas.length < 1) return false;

  // TLD reservado: inválido por definición, sin importar el resto.
  if (TLD_RESERVADOS.includes(etiquetas.at(-1))) return true;

  const lista = new Set([...NUNCA_ENTREGABLES, ...OBSERVADOS_EN_SONDEO, ...extras()]);

  // El dominio y cada uno de sus padres, por etiquetas completas.
  for (let i = 0; i < etiquetas.length; i++) {
    if (lista.has(etiquetas.slice(i).join('.'))) return true;
  }
  return false;
}

/** Para diagnóstico: qué dominios están activos ahora mismo. */
export function dominiosDescartables() {
  return {
    tldReservados:     [...TLD_RESERVADOS],
    nuncaEntregables:  [...NUNCA_ENTREGABLES],
    observadosEnSondeo:[...OBSERVADOS_EN_SONDEO],
    extrasPorEntorno:  extras(),
  };
}

export default esCorreoDescartable;
