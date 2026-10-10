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
 * **Manda el plazo del proveedor, siempre que esté configurado.** Es el dato real,
 * y lo que hay que proteger es que al consumidor no se le prometa algo que no es.
 *
 * Esto aplica en LAS DOS direcciones, y es el punto que importa:
 *   - Proveedor más LENTO que el tramo → se publica el del proveedor. Publicar el
 *     tramo sería prometer una entrega que no se puede cumplir.
 *   - Proveedor más RÁPIDO que el tramo → se publica el del proveedor igual.
 *     Publicar el tramo (más largo) también es información falsa, solo que en la
 *     otra dirección, y además le oculta al usuario que su pago llega antes.
 *
 * Una versión anterior de este módulo publicaba el MAYOR de los dos. Estaba mal:
 * confundía "no prometer de menos" con "elegir el número más grande". El criterio
 * correcto es la exactitud, no el margen.
 *
 * ⚠️ Consecuencia operativa: al publicar el plazo real se pierde el colchón que
 * daba el tramo. Por eso `payoutEtaBusinessDays` debe cargarse con la COTA
 * SUPERIOR de lo que tarda el proveedor, no con su promedio: pasa a ser la
 * promesa, sin margen detrás.
 *
 * `excedeTramoEcp` se conserva porque sigue siendo señal regulatoria: marca los
 * corredores donde la realidad supera el tramo declarado en el Protocolo.
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

  // Manda el proveedor cuando hay dato. El tramo solo cubre el hueco.
  const dias   = etaProveedor ?? tramo.diasHabiles;
  const origen = etaProveedor === null ? 'ecp' : 'proveedor';

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
