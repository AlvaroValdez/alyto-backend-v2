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
 * Se publica **el MAYOR de los dos**. El plazo del proveedor es el piso: nunca
 * prometer más rápido de lo que se puede entregar. Si el del ECP es más largo, se
 * publica el del ECP, que además es el comprometido ante ASFI.
 *
 * Consecuencia que no se oculta: cuando el proveedor es más lento que el tramo, el
 * plazo publicado EXCEDE el declarado en el Protocolo. Es honesto con el
 * consumidor y, a la vez, evidencia de que el Protocolo declaró tramos que no se
 * cumplen en todos los corredores. El campo `excedeTramoEcp` lo marca para que
 * quede medible y no se descubra por un reclamo.
 *
 * ── Qué pasa si falta el dato ───────────────────────────────────────────────────
 *
 * Sin `payoutEtaBusinessDays` configurado se cae al tramo del ECP y se marca
 * `etaProveedorVerificada: false`. No se inventa un número: el tramo es un plazo
 * realmente declarado, y la bandera permite listar los corredores sin configurar
 * en vez de que el hueco pase inadvertido.
 */

import { resolveTramo, addBusinessDays } from './ecpTramos.js';

/** Texto público para un número de días hábiles. */
export function plazoTexto(diasHabiles) {
  if (diasHabiles === 0) return 'Mismo día hábil';
  if (diasHabiles === 1) return 'Hasta 1 día hábil';
  return `Hasta ${diasHabiles} días hábiles`;
}

/**
 * Plazo publicable de una operación.
 *
 * @param {object}  p
 * @param {number}  p.amountBOB              importe en moneda de origen (BOB)
 * @param {number|null} [p.payoutEtaBusinessDays] plazo real del proveedor, del corredor
 * @param {Date}    [p.desde]                momento de referencia
 * @returns {{
 *   diasHabiles:number, plazoLiquidacion:string, plazoLiquidacionHasta:string,
 *   tramo:string|null, tramoNombre:string|null, origen:'proveedor'|'ecp',
 *   excedeTramoEcp:boolean, etaProveedorVerificada:boolean
 * }|null}  null si el importe cae fuera de los tramos declarados (lo rechaza
 *          el control de límites, no se acomoda al tramo más cercano).
 */
export function resolvePlazoLiquidacion({ amountBOB, payoutEtaBusinessDays = null, desde = new Date() }) {
  const tramo = resolveTramo(amountBOB);
  if (!tramo) return null;

  const etaProveedor = Number.isFinite(payoutEtaBusinessDays) && payoutEtaBusinessDays >= 0
    ? Math.trunc(payoutEtaBusinessDays)
    : null;

  // El mayor manda. Con empate se atribuye al ECP: es el plazo comprometido.
  const dias   = etaProveedor === null ? tramo.diasHabiles : Math.max(etaProveedor, tramo.diasHabiles);
  const origen = etaProveedor !== null && etaProveedor > tramo.diasHabiles ? 'proveedor' : 'ecp';

  // Mismo criterio que plazoLiquidacion(): si entra en fin de semana, el "mismo
  // día hábil" es el siguiente hábil. No se compromete un vencimiento en día no hábil.
  const base = (desde.getDay() === 0 || desde.getDay() === 6) ? addBusinessDays(desde, 1) : desde;
  const venceAt = dias === 0 ? new Date(base) : addBusinessDays(base, dias);
  venceAt.setHours(23, 59, 59, 999);

  return {
    diasHabiles:            dias,
    plazoLiquidacion:       plazoTexto(dias),
    plazoLiquidacionHasta:  venceAt.toISOString(),
    tramo:                  tramo.id,
    tramoNombre:            tramo.nombre,
    origen,
    excedeTramoEcp:         dias > tramo.diasHabiles,
    etaProveedorVerificada: etaProveedor !== null,
  };
}

export default { resolvePlazoLiquidacion, plazoTexto };
