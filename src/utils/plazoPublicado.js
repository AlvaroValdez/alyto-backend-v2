/**
 * plazoPublicado.js — Plazo de liquidación que se le informa al consumidor.
 *
 * Resuelve el conflicto entre dos plazos que miden cosas distintas:
 *
 *   - El TRAMO del Entorno Controlado de Pruebas (`ecpTramos.js`) depende del
 *     MONTO: Bs 400–20.000 mismo día, 20.001–70.000 un día, 70.001–120.000 dos días.
 *   - El plazo REAL del proveedor depende del CORREDOR y del RIEL: Vita liquida en
 *     horas, Harbor por WIRE o BANK-TRANSFER puede tardar días.
 *
 * Al ser ejes distintos no coinciden, y la combinación peligrosa es un monto chico
 * en un corredor lento: Bs 5.000 a Nigeria cae en el tramo "Estándar / mismo día
 * hábil" y el proveedor tarda hasta tres días.
 *
 * ── Regla (decisión de Alvaro, 2026-10-10) ──────────────────────────────────────
 *
 * **Manda el plazo del proveedor, que es el real.** El tramo del ECP solo cubre el
 * hueco cuando el corredor no tiene el dato configurado.
 *
 * Aplica en las dos direcciones. Si el proveedor es más lento que el tramo,
 * publicar el tramo es una promesa incumplible. Si es más rápido, publicar el tramo
 * también es falso: le oculta al usuario que su pago llega antes.
 *
 * ── Y se expresa APROXIMADO, nunca como número cerrado ──────────────────────────
 *
 * Un plazo de liquidación no es determinista: depende del banco destino, del riel y
 * de la hora de corte. Publicar "1 día hábil" lo convierte en una promesa exacta
 * que nadie puede sostener. Por eso el dato es un RANGO y el texto es aproximado,
 * con las formas que ya usan los Términos §7:
 *
 *     pocas horas
 *     pocas horas a 1 día hábil
 *     aproximadamente 1 día hábil
 *     1 a 3 días hábiles
 *
 * ── Dos números distintos, a propósito ──────────────────────────────────────────
 *
 * Lo que se MUESTRA es el rango aproximado. Lo que se MIDE internamente es la
 * fecha límite derivada del MÁXIMO (`plazoLiquidacionHasta`), que es contra la que
 * se evalúa el cumplimiento. Mostrar aproximado no significa no comprometerse:
 * significa no fingir una precisión que no existe.
 *
 * ── Qué pasa si falta el dato ───────────────────────────────────────────────────
 *
 * Sin el rango del proveedor se cae al tramo del ECP y se marca
 * `etaProveedorVerificada: false`. No se inventa un número: el tramo es un plazo
 * realmente declarado, y la bandera permite listar los corredores sin configurar
 * en vez de que el hueco pase inadvertido.
 */

import { resolveTramo, addBusinessDays } from './ecpTramos.js';

/** Un entero >= 0, o null si el valor no sirve. Un dato roto NO vale cero. */
function diaValido(v) {
  return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

function dias(n) {
  return n === 1 ? '1 día hábil' : `${n} días hábiles`;
}

/**
 * Texto público aproximado para un rango de días hábiles.
 *
 * Usa las formas ya establecidas en los Términos §7. Nunca devuelve un número
 * cerrado sin cualificador: o es un rango, o lleva "aproximadamente".
 */
export function plazoTexto(minDias, maxDias) {
  const min = diaValido(minDias) ?? 0;
  const max = diaValido(maxDias) ?? min;

  if (max === 0)   return 'pocas horas';
  if (min === 0)   return `pocas horas a ${dias(max)}`;
  if (min === max) return `aproximadamente ${dias(max)}`;
  return `${min} a ${dias(max)}`;
}

/**
 * Plazo publicable de una operación.
 *
 * @param {object} p
 * @param {number} p.amountBOB                     importe en moneda de origen (BOB)
 * @param {number|null} [p.payoutEtaMinBusinessDays] mínimo del proveedor, del corredor
 * @param {number|null} [p.payoutEtaMaxBusinessDays] máximo del proveedor, del corredor
 * @param {Date}   [p.desde]                       momento de referencia
 * @returns {{
 *   plazoLiquidacion:string, plazoMinDiasHabiles:number, plazoMaxDiasHabiles:number,
 *   plazoLiquidacionHasta:string, tramo:string|null, tramoNombre:string|null,
 *   origen:'proveedor'|'ecp', excedeTramoEcp:boolean, etaProveedorVerificada:boolean
 * }|null}  null si el importe cae fuera de los tramos declarados (lo rechaza el
 *          control de límites, no se acomoda al tramo más cercano).
 */
export function resolvePlazoLiquidacion({
  amountBOB,
  payoutEtaMinBusinessDays = null,
  payoutEtaMaxBusinessDays = null,
  desde = new Date(),
}) {
  const tramo = resolveTramo(amountBOB);
  if (!tramo) return null;

  // Basta el MÁXIMO para considerar el dato configurado: es el que fija el
  // compromiso. Sin mínimo se asume 0, que redacta "pocas horas a N".
  const etaMax = diaValido(payoutEtaMaxBusinessDays);
  const etaMin = etaMax === null ? null : Math.min(diaValido(payoutEtaMinBusinessDays) ?? 0, etaMax);

  const verificada = etaMax !== null;
  // Manda el proveedor cuando hay dato. El tramo solo cubre el hueco, y su plazo
  // es un techo ("hasta N"), así que se expresa como rango desde 0.
  const minDias = verificada ? etaMin : 0;
  const maxDias = verificada ? etaMax : tramo.diasHabiles;

  // Mismo criterio que plazoLiquidacion(): si entra en fin de semana, el "mismo
  // día hábil" es el siguiente hábil. No se compromete un vencimiento en día no hábil.
  const base    = (desde.getDay() === 0 || desde.getDay() === 6) ? addBusinessDays(desde, 1) : desde;
  const venceAt = maxDias === 0 ? new Date(base) : addBusinessDays(base, maxDias);
  venceAt.setHours(23, 59, 59, 999);

  return {
    plazoLiquidacion:       plazoTexto(minDias, maxDias),
    plazoMinDiasHabiles:    minDias,
    plazoMaxDiasHabiles:    maxDias,
    plazoLiquidacionHasta:  venceAt.toISOString(),
    tramo:                  tramo.id,
    tramoNombre:            tramo.nombre,
    origen:                 verificada ? 'proveedor' : 'ecp',
    excedeTramoEcp:         maxDias > tramo.diasHabiles,
    etaProveedorVerificada: verificada,
  };
}

export default { resolvePlazoLiquidacion, plazoTexto };
