/**
 * harborPreflight.js — No cobrar para el riel Harbor cuando sabemos que no paga.
 *
 * Cierra la última causa de las 7 operaciones por Bs 3.506 regularizadas el
 * 2026-10-01. Dos murieron así, con el dinero del usuario ya cobrado:
 *
 *   Error no clasificado: code=3006 status=400
 *   msg="On behalf of customer is not active"
 *
 * El customer de la LLC en Harbor no estaba verificado. No es un problema del
 * beneficiario ni del monto: mientras dure, **ninguna** operación del riel puede
 * ejecutarse, y cada intento cobra plata que después hay que devolver.
 *
 * ── Por qué un breaker y no una sonda en cada cobro ─────────────────────────
 *
 * La única forma de preguntarle a Harbor si el customer está activo es
 * intentar algo con `on_behalf_of`; el más barato es un quote. Pero medido
 * contra producción el 2026-10-09, un quote tarda **~3,4 s**. Ponerlo en el
 * camino de cada inicio de pago le agregaría eso a todos los usuarios, todo el
 * tiempo, para detectar un estado que cambia una vez cada varios meses.
 *
 * Así que se invierte: no se pregunta antes, se **aprende del fallo real**.
 * Cuando un payout muere por customer inactivo, se levanta una bandera
 * persistente; a partir de ahí los cobros de ese riel se bloquean sin costo ni
 * latencia. El primer fallo no se evita —nada puede evitarlo— pero el segundo y
 * los siguientes sí. En junio fueron dos: esto habría evitado el segundo.
 *
 * Se levanta sola cuando un payout vuelve a salir bien, o a mano desde el admin.
 *
 * ── Por qué persistente ─────────────────────────────────────────────────────
 *
 * En `SystemConfig`, no en memoria. Un breaker que se olvida en cada deploy no
 * es un breaker: ya pasó con el cooldown de `anchorAdminAlerts`, que vivía en un
 * objeto de módulo y se reseteaba tres veces en un día de deploys.
 */

import SystemConfig from '../models/SystemConfig.js';
import { logger } from '../utils/logger.js';

/** Kill switch. `false` restaura el comportamiento previo. */
function habilitado() {
  return String(process.env.HARBOR_PREFLIGHT_ENABLED ?? 'true').toLowerCase() !== 'false';
}

const clave = (entity) => `harbor:customer-inactivo:${String(entity ?? 'LLC').toUpperCase()}`;

/**
 * Caché corta sobre la lectura. Esto corre en cada inicio de pago del riel y el
 * estado cambia muy rara vez; sin caché sería una consulta a Mongo por request.
 */
const TTL_MS = 60 * 1000;
const _cache = new Map();   // entity → { at, valor }

/** Solo para pruebas. */
export function _resetCache() { _cache.clear(); }

/**
 * Marca el riel como no ejecutable. Se llama desde el manejo del fallo de
 * payout, con el error real de Harbor.
 *
 * @param {string} entity   'LLC' | 'SRL' | 'SpA'
 * @param {string} detalle  mensaje de Harbor, para que el admin sepa qué pasó
 */
export async function marcarCustomerInactivo(entity, detalle) {
  try {
    await SystemConfig.setValue(clave(entity), {
      inactivo: true,
      desde:    new Date().toISOString(),
      detalle:  String(detalle ?? '').slice(0, 500),
    });
    _cache.delete(String(entity ?? 'LLC').toUpperCase());
    logger.error('[harborPreflight] Riel Harbor marcado NO ejecutable', { entity, detalle });
  } catch (err) {
    // No poder levantar la bandera no debe romper el manejo del fallo original.
    logger.warn('[harborPreflight] No se pudo marcar el customer inactivo', { error: err?.message });
  }
}

/**
 * Levanta la bandera. Se llama cuando un payout del riel sale bien: si pagó, el
 * customer está activo, y esa es mejor evidencia que cualquier sonda.
 */
export async function marcarCustomerActivo(entity) {
  const k = String(entity ?? 'LLC').toUpperCase();
  try {
    const actual = await SystemConfig.getValue(clave(entity));
    if (!actual?.inactivo) return;              // nada que limpiar
    await SystemConfig.setValue(clave(entity), { inactivo: false, desde: new Date().toISOString() });
    _cache.delete(k);
    logger.info('[harborPreflight] Riel Harbor habilitado de nuevo', { entity });
  } catch (err) {
    logger.warn('[harborPreflight] No se pudo limpiar la bandera', { error: err?.message });
  }
}

/**
 * ¿Podemos comprometernos a ejecutar un payout por Harbor?
 *
 * Falla ABIERTO: si no se puede leer el estado, deja pasar. Bloquear cobros
 * porque la base no responde cuesta más que el fallo que se quiere evitar.
 *
 * @param {object} params
 * @param {object} params.corridor — TransactionConfig del corredor
 * @returns {Promise<{ok: boolean, motivo?: string, detalle?: object}>}
 */
export async function verificarRielHarbor({ corridor } = {}) {
  if (!habilitado()) return { ok: true };
  if (!corridor) return { ok: true };
  if (corridor.payoutMethod !== 'owlPay') return { ok: true };

  // El `on_behalf_of` es siempre el de la LLC, con independencia de la entidad
  // operativa del corredor (MSA firmado con LLC). Ver §12 del CLAUDE.md.
  const entity = 'LLC';
  const k = entity;

  const cacheado = _cache.get(k);
  if (cacheado && Date.now() - cacheado.at < TTL_MS) {
    return cacheado.valor;
  }

  let estado;
  try {
    estado = await SystemConfig.getValue(clave(entity));
  } catch (err) {
    logger.warn('[harborPreflight] No se pudo leer el estado del riel, se deja pasar', {
      error: err?.message,
    });
    return { ok: true };
  }

  const resultado = estado?.inactivo
    ? {
        ok:     false,
        motivo: 'harbor-customer-inactivo',
        detalle: { desde: estado.desde, detalle: estado.detalle, corridorId: corridor.corridorId },
      }
    : { ok: true };

  _cache.set(k, { at: Date.now(), valor: resultado });
  return resultado;
}
