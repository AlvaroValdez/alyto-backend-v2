/**
 * redenlaceAccountService.js — Cuentas de Comercio de ATC: saldos y movimientos.
 *
 * El producto se llama "Cuentas de Establecimientos y Consulta de Saldos" en el
 * portal y "Cuentas de Comercios" en el título del documento. Son el mismo.
 *
 * ## Para qué se integra
 *
 * Para que el pre-check de liquidez de la dispersión EXISTA. Hasta ahora el
 * adapter de Red Enlace no sabía responder el saldo, y el guard lo saltaba: con
 * `WALLET_BANK_LIQUIDITY_CHECK=true` no se chequeaba nada y tampoco se avisaba.
 * Eso ya emite un warning (ver `disbursementService`), pero el arreglo de fondo
 * es éste: poder preguntar.
 *
 * El número que da ATC es mejor que el de BANECO: `saldoDisponible` viene **neto
 * de retenciones**, y `saldoRetenido` llega aparte, así que se puede distinguir
 * "no hay plata" de "hay plata retenida".
 *
 * ## Dos rarezas del API, verificadas contra la especificación
 *
 * 1. **El nombre del parámetro cambia entre endpoints.** En `/saldos` la lista
 *    de cuentas se llama `numeroCuentas` (plural) y admite hasta 10. En
 *    `/creditos` y `/debitos` se llama `numeroCuenta` (singular) y admite **una
 *    sola**. No es un error de lectura: está así en las dos tablas.
 *
 * 2. **La tabla de headers de la especificación se contradice.** Dice enviar
 *    `Authorization: Bearer <access_token>` y el ejemplo de la misma fila muestra
 *    un `Basic`. Los requests de todas las secciones usan `access_token` crudo +
 *    `client_id`, que es lo que ya hace `redenlaceClient`. Misma inconsistencia
 *    que en QR Simple.
 *
 * ## Lo que este producto NO resuelve
 *
 * Se integró esperando recuperar la FASE A de la conciliación de cobros (listar
 * los QR pagados de un día). No alcanza: en los créditos el campo
 * `numeroReferencia` **solo se llena para PAYOUT**. Para un `PAYIN QR` llega
 * `"N/A"`, y la tabla de salida lo dice explícitamente. Es decir: se puede saber
 * que entró un abono por QR, su importe y su hora, pero no A QUÉ QR corresponde.
 * Con dos cobros del mismo monto el calce es ambiguo.
 *
 * Por eso `getPaidQRs` sigue devolviendo lista vacía en el servicio de QR y la
 * red de seguridad sigue siendo la FASE B (consulta uno por uno). Ver
 * `redenlaceQrService`.
 */

import { apiFetch, isAvailable as clientAvailable, isMockMode } from './redenlaceClient.js';
import { logger }  from '../../utils/logger.js';
import Sentry      from '../sentry.js';

// ── Config ───────────────────────────────────────────────────────────────────
// Regla 21: siempre dentro de funciones, nunca en un const de módulo.
const cfg = {
  nit:     () => process.env.REDENLACE_NIT,
  account: () => process.env.REDENLACE_ACCOUNT,
};

/** @returns {boolean} NIT y cuenta de comercio configurados, además del cliente. */
export function isAvailable() {
  return clientAvailable() && Boolean(cfg.nit()) && Boolean(cfg.account());
}

/** Fecha en formato `yyyy-mm-dd`, que es lo único que acepta el API. */
function fechaISO(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Saldos de una o varias cuentas de comercio.
 *
 * @param {string[]} [cuentas] — por omisión, la cuenta de origen configurada.
 * @returns {Promise<Array<{numeroCuenta,estado,tipoMoneda,saldoDisponible,saldoContable,saldoRetenido,fechaUltimoCredito,fechaUltimoDebito}>>}
 */
export async function getBalances(cuentas) {
  const lista = (cuentas?.length ? cuentas : [cfg.account()]).filter(Boolean).map(String);
  if (!lista.length) throw new Error('getBalances: no hay cuenta de comercio configurada (REDENLACE_ACCOUNT)');
  // El API corta en 10; pedir más devolvería un error del proveedor en vez de
  // uno nuestro, y el mensaje de ATC no dice cuál es el límite.
  if (lista.length > 10) throw new Error(`getBalances: el API admite hasta 10 cuentas por consulta (recibidas ${lista.length})`);

  const res = await apiFetch('/cuentas-comercios/v1/cuentas/saldos', {
    method: 'POST',
    // Ojo: acá el campo es `numeroCuentas`, en plural. En /creditos y /debitos
    // el mismo dato se llama `numeroCuenta` y admite uno solo.
    body: JSON.stringify({ nit: cfg.nit(), numeroCuentas: lista }),
  });

  if (res?.code !== '00') {
    throw new Error(`getBalances: ATC respondió code='${res?.code}' ${res?.errorCode ?? ''} ${res?.errorMessage ?? ''}`.trim());
  }
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Saldo de la cuenta de origen de la dispersión, en la forma que espera el
 * registro de bancos.
 *
 * `available` sale de `saldoDisponible`, que ya viene neto de retenciones. No se
 * calcula `contable − retenido` a mano: si ATC cambiara la definición, el número
 * derivado mentiría en silencio.
 *
 * @returns {Promise<{available:number|null, balance:number|null, withheld:number|null, currency:string|null, status:string|null, raw:object|null}>}
 */
export async function getBalance() {
  if (isMockMode()) {
    logger.warn('[RedEnlace] Mock mode — getBalance simulado (available=null)');
    return { available: null, balance: null, withheld: null, currency: 'BOB', status: 'ACTIVA', raw: null, _mock: true };
  }

  const [cuenta] = await getBalances();
  if (!cuenta) return { available: null, balance: null, withheld: null, currency: null, status: null, raw: null };

  // Una cuenta que no está activa no puede dispersar. Se devuelve el estado para
  // que el llamador lo vea, en vez de un saldo que no se va a poder usar.
  if (cuenta.estado && cuenta.estado !== 'ACTIVA') {
    logger.warn('[RedEnlace] La cuenta de comercio no está activa', {
      numeroCuenta: cuenta.numeroCuenta, estado: cuenta.estado,
    });
  }

  return {
    available: cuenta.saldoDisponible ?? null,
    balance:   cuenta.saldoContable ?? null,
    withheld:  cuenta.saldoRetenido ?? null,
    currency:  cuenta.tipoMoneda ?? 'BOB',
    status:    cuenta.estado ?? null,
    raw:       cuenta,
  };
}

/**
 * Variante que no lanza, para el pre-check de liquidez.
 *
 * Devuelve `ok:false` ante cualquier problema, y el guard trata eso como
 * "no se pudo verificar" y deja pasar (fail-open deliberado). Lo importante es
 * que ya no se confunda con "no hay nada que verificar".
 */
export async function tryGetAvailableBalance() {
  try {
    const { available } = await getBalance();
    return { available, ok: true };
  } catch (err) {
    Sentry.captureException(err, { tags: { service: 'redenlaceAccountService', fn: 'tryGetAvailableBalance' } });
    logger.error(`[RedEnlace] tryGetAvailableBalance error: ${err.message}`);
    return { available: null, ok: false, error: err.message };
  }
}

/**
 * Movimientos y saldos de todas las cuentas del comercio en un rango.
 *
 * Usa `/transacciones`, que trae créditos y débitos juntos más los saldos, en vez
 * de combinar `/creditos` y `/debitos`: una llamada en lugar de dos, y el rango
 * de fechas es el mismo límite.
 *
 * @param {Date|string} desde
 * @param {Date|string} hasta — el API admite hasta 31 días de rango.
 * @returns {Promise<{header:object|null, movements:Array, withheld:Array}>}
 */
export async function getMovements(desde, hasta) {
  if (isMockMode()) {
    logger.warn('[RedEnlace] Mock mode — getMovements simulado (vacío)');
    return { header: null, movements: [], withheld: [], _mock: true };
  }

  const inicio = fechaISO(desde);
  const fin    = fechaISO(hasta);

  const dias = Math.round((new Date(fin) - new Date(inicio)) / 86_400_000);
  if (dias > 31) throw new Error(`getMovements: el API admite hasta 31 días de rango (pedidos ${dias})`);
  if (dias < 0)  throw new Error('getMovements: la fecha de inicio es posterior a la de fin');

  const res = await apiFetch('/cuentas-comercios/v1/cuentas/transacciones', {
    method: 'POST',
    body: JSON.stringify({ nit: cfg.nit(), fechaInicio: inicio, fechaFin: fin }),
  });

  if (res?.code !== '00') {
    throw new Error(`getMovements: ATC respondió code='${res?.code}' ${res?.errorMessage ?? ''}`.trim());
  }

  const saldos = Array.isArray(res.data?.saldos) ? res.data.saldos : [];

  return {
    // El "header" del extracto equivale al saldo de la cuenta de origen, para
    // que el monitoreo lo lea igual que en BANECO.
    header:    saldos.find((s) => String(s.numeroCuenta) === String(cfg.account())) ?? saldos[0] ?? null,
    movements: Array.isArray(res.data?.movimientos) ? res.data.movimientos : [],
    // ATC no devuelve una lista de retenciones; el retenido viene como monto en
    // el saldo. Se deja el campo por compatibilidad de la interfaz.
    withheld:  [],
  };
}

/**
 * Traduce un movimiento de ATC a la forma común del extracto, para que el admin
 * lo vea igual sin importar el banco.
 *
 * La dirección se deduce de la cuenta: si la nuestra es el destino, es crédito.
 * No se usa `tipoOperacion` para eso, porque mezcla el sentido con el método
 * ('PAYIN QR', 'PAYOUT ACH') y un método nuevo rompería la lectura.
 */
export function normalizeMovement(m, currency = 'BOB') {
  const esCredito = String(m.cuentaDestino) === String(cfg.account());
  const importe   = typeof m.importeTotal === 'number' ? m.importeTotal : m.importe;

  return {
    externalTxId:   m.transactionId || m.numOrdenAch || null,
    date:           m.fechaHoraTransaccion ?? null,
    time:           null,   // ATC lo manda junto en fechaHoraTransaccion
    direction:      esCredito ? 'credit' : 'debit',
    amount:         typeof importe === 'number' ? Math.abs(importe) : importe,
    signedAmount:   typeof importe === 'number' ? (esCredito ? importe : -importe) : null,
    currency:       m.moneda ?? currency,
    documentNumber: m.numOrdenAch ?? null,
    description:    m.mensaje ?? m.tipoOperacion ?? null,
    note:           m.tipoOperacion ?? null,
    raw:            m,
  };
}
