/**
 * providerContract.js — ¿Lo que tenemos configurado coincide con lo que el
 * proveedor declara?
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 *
 * El 2026-10-14 encontramos CUATRO instancias del mismo patrón en un solo día:
 * el proveedor declara un dato en su respuesta, nosotros guardamos otra cosa, y
 * nada los compara.
 *
 *   1. `time_to_arrival_transfer`  → se descartaba; se publicaba un plazo
 *      inventado a partir del monto.
 *   2. `regex_validate`/`min`/`max` → se descartaban; se cobraba contra
 *      beneficiarios que Vita iba a rechazar (code 305, dos operaciones).
 *   3. `currency_decimals`          → se ignora; se redondea a 2 fijo.
 *   4. `currency_iso_code`          → `bo-ve` decía USD y Vita paga VES: la
 *      cotización prometía "USD 17.252" por Bs 240. Nunca se liquidó una, así
 *      que el daño fue cero por suerte, no por control.
 *
 * Los cuatro convivieron con 1509 pruebas en verde. **Ninguna prueba podía
 * detectarlos**: todas usan `tests/helpers/vitaMock.js`, o sea una respuesta
 * que escribimos nosotros. Un mock jamás va a decir que Vita declara VES y la
 * base dice USD — repite lo que ya creemos.
 *
 * Este módulo es la pieza que faltaba: compara la CONFIGURACIÓN contra la
 * DECLARACIÓN del proveedor. Es función pura para poder probarse con fixtures;
 * quien la enfrenta a la API viva es `scripts/verificar-contrato-proveedor.mjs`.
 *
 * ── Qué NO hace ───────────────────────────────────────────────────────────────
 *
 * No valida que nuestra lógica de negocio sea correcta — para eso están las
 * otras pruebas. Solo responde una pregunta: ¿seguimos de acuerdo con el
 * proveedor sobre los hechos básicos del corredor?
 */

/** Severidades. `critico` bloquea; `aviso` informa sin frenar un despliegue. */
export const SEVERIDAD = { CRITICO: 'critico', AVISO: 'aviso' };

/** Decimales a los que el cotizador redondea hoy el monto destino (round2). */
export const DECIMALES_QUE_USAMOS = 2;

/**
 * Compara UN corredor contra las reglas que el proveedor declara para él.
 *
 * @param {object} corridor  TransactionConfig (lean): corridorId,
 *                           destinationCountry, destinationCurrency
 * @param {object|null} reglas  `rules[clavePais]` de getWithdrawalRules()
 * @param {object} [extra]
 * @param {number|null} [extra.minProveedorUSD]  `min_amount` del país
 * @param {number|null} [extra.minEfectivoUSD]   mínimo que realmente aplicamos
 * @returns {Array<{corridorId, check, severidad, esperado, encontrado, detalle}>}
 */
export function compararCorredor(corridor, reglas, extra = {}) {
  const hallazgos = [];
  const id = corridor?.corridorId ?? '(sin id)';

  const push = (check, severidad, esperado, encontrado, detalle) =>
    hallazgos.push({ corridorId: id, check, severidad, esperado, encontrado, detalle });

  // Sin reglas no hay con qué comparar. NO es un hallazgo: hay países que Vita
  // no publica (GT, SV) y se liquidan por otra vía. Confundir "no sé" con "está
  // mal" llenaría el informe de ruido y lo volvería inútil.
  if (!reglas) return hallazgos;

  // ── 1. MONEDA ───────────────────────────────────────────────────────────────
  // El caso bo-ve. Es crítico porque no es un detalle de presentación: define
  // qué se le promete al usuario y qué dice su comprobante. Una diferencia acá
  // puede ser de tres órdenes de magnitud.
  const monedaProveedor = reglas.currency_iso_code ?? null;
  const monedaConfig    = corridor?.destinationCurrency ?? null;
  if (monedaProveedor && monedaConfig && monedaProveedor !== monedaConfig) {
    push('moneda', SEVERIDAD.CRITICO, monedaProveedor, monedaConfig,
      `El proveedor liquida en ${monedaProveedor} (${reglas.currency_name ?? '—'}) y el corredor está ` +
      `configurado en ${monedaConfig}. La cotización le promete al usuario una moneda que no va a recibir.`);
  }

  // ── 2. DECIMALES ────────────────────────────────────────────────────────────
  // Aviso y no crítico porque lo verificamos contra el histórico: hay pagos a
  // CLP y COP completados con centavos, o sea que Vita los acepta y redondea.
  // El daño es imprecisión sub-unidad, no un rechazo. Si algún día un proveedor
  // empieza a rechazarlos, este aviso ya estaba puesto.
  const dec = reglas.currency_decimals;
  if (Number.isFinite(dec) && dec !== DECIMALES_QUE_USAMOS) {
    push('decimales', SEVERIDAD.AVISO, dec, DECIMALES_QUE_USAMOS,
      `El proveedor declara ${dec} decimales para ${monedaProveedor ?? monedaConfig} y el cotizador ` +
      `redondea a ${DECIMALES_QUE_USAMOS}. Hoy el proveedor lo tolera; el monto mostrado pierde precisión.`);
  }

  // ── 3. MÍNIMO ───────────────────────────────────────────────────────────────
  // Hoy esto pasa: `resolveEffectiveMinimum` eleva el mínimo con el piso del
  // proveedor. El check existe para CONGELAR ese comportamiento — si alguien
  // toca esa lógica y el mínimo efectivo cae por debajo del piso, volvemos a
  // cobrar operaciones que el proveedor va a rechazar.
  const { minProveedorUSD, minEfectivoUSD } = extra;
  if (Number.isFinite(minProveedorUSD) && Number.isFinite(minEfectivoUSD)
      && minEfectivoUSD < minProveedorUSD) {
    push('minimo', SEVERIDAD.CRITICO, `>= ${minProveedorUSD} USD`, `${minEfectivoUSD} USD`,
      `Se puede cobrar por debajo del mínimo del proveedor: el payout se rechaza con el dinero adentro.`);
  }

  return hallazgos;
}

/**
 * Campos que el proveedor devuelve y que NO consumimos.
 *
 * Es la mitad preventiva: los cuatro casos de hoy se descubrieron DESPUÉS de
 * perder plata. Esto los expone antes, cuando el proveedor agrega o renombra
 * algo. No falla el build — un campo nuevo no es un error, es algo para mirar.
 *
 * @param {object} reglasPais  `rules[clavePais]`
 * @param {string[]} consumidos  claves que el código sí usa
 * @returns {string[]} campos presentes y no consumidos
 */
export function camposNoConsumidos(reglasPais, consumidos = []) {
  if (!reglasPais || typeof reglasPais !== 'object') return [];
  const vistos = new Set(consumidos);
  return Object.keys(reglasPais)
    .filter(k => k !== 'fields')          // `fields` se recorre aparte
    .filter(k => !vistos.has(k))
    .sort();
}

/**
 * Atributos de campo que el proveedor publica y que la validación NO mira.
 *
 * Exactamente el agujero que costó las dos operaciones del 2026-10-14:
 * `regex_validate` llegaba en cada cotización y se ignoraba.
 *
 * @param {Array} fields  `rules[pais].fields`
 * @param {string[]} consumidos  atributos que `validateAgainstVitaFields` usa
 * @returns {Array<{campo:string, atributo:string}>}
 */
export function atributosDeCampoNoConsumidos(fields, consumidos = []) {
  if (!Array.isArray(fields)) return [];
  const vistos = new Set(consumidos);
  const fuera = [];
  for (const f of fields) {
    const clave = f?.key ?? f?.name ?? '(sin clave)';
    for (const attr of Object.keys(f ?? {})) {
      if (!vistos.has(attr)) fuera.push({ campo: clave, atributo: attr });
    }
  }
  return fuera;
}

export default { compararCorredor, camposNoConsumidos, atributosDeCampoNoConsumidos, SEVERIDAD };
