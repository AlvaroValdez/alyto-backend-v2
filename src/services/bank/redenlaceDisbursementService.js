/**
 * redenlaceDisbursementService.js — Dispersión de fondos de ATC S.A. (Red Enlace)
 *                                   Pay Out Asíncrono, `/payout/async/v3/*`
 *
 *   transfer({...})          — autoriza un lote de 1 ítem (retiro BOB → cuenta del usuario)
 *   verifyNotifyStatus(req)  — autentica el webhook de confirmación
 *   normalizeNotify(req)     — traduce el webhook a la forma que espera el handler
 *   mapNotifyStatus(estado)  — traduce el estado de ATC a nuestro modelo
 *   listBanks()              — catálogo de bancos destino habilitados
 *   isAvailable() / isEnabled()
 *
 * Es el riel que BANECO confirmó no tener (§9 Planillas, `docs/ADMIN_BANK_MONITORING.md`).
 *
 * ── Cuatro diferencias con BANECO que cambian el comportamiento
 *
 * 1. **El documento del beneficiario es obligatorio.** BANECO lo aceptaba vacío;
 *    ATC exige `ciNitDestino` entre 5 y 20 caracteres. Un retiro sin CI se
 *    rechaza, así que validamos antes de llamar en vez de descubrirlo con la
 *    orden ya enviada.
 *
 * 2. **El lote puede responder éxito con ítems fallados.** ATC devuelve
 *    `code: "00"` a nivel lote y marca el ítem con `estado: "ERROR"`. Mirar solo
 *    el código del lote daría por despachado un retiro que el banco no aceptó.
 *
 * 3. **El webhook no trae nuestro identificador.** Trae el `transaccionId` que
 *    mandamos, que es un alias de 9 dígitos (ATC no acepta nuestros
 *    identificadores). `normalizeNotify` lo traduce de vuelta vía
 *    `ProviderReference`.
 *
 * 4. **Existe un estado `REVERTIDO`.** Un retiro ya pagado puede volver. No
 *    tenemos camino para eso y no lo vamos a inventar en silencio: ver
 *    `mapNotifyStatus`.
 *
 * ── Seguridad del dinero saliente: tres llaves, no dos
 *
 * BANECO exigía credenciales reales + gate explícito. Acá se suma una tercera:
 * si la URL base apunta a producción de ATC, hace falta además
 * `REDENLACE_DISBURSEMENT_PRODUCTION_CONFIRMED=true`. El motivo es concreto: el
 * portal de ATC etiqueta su gateway como "ATC Prod" pero emite credenciales de
 * certificación, así que la etiqueta no distingue el ambiente. La URL sí.
 */

import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { apiFetch, isAvailable as clientAvailable, isMockMode } from './redenlaceClient.js';
import { issueReference, attachExternalReference, resolveByReference } from './providerReference.js';

// ── Config ───────────────────────────────────────────────────────────────────
// Regla 21: siempre dentro de funciones.
const cfg = {
  baseUrl:      () => String(process.env.REDENLACE_BASE_URL ?? ''),
  branchCode:   () => process.env.REDENLACE_BRANCH_CODE ?? process.env.REDENLACE_ESTABLISHMENT_ID,
  sourceAccount:() => process.env.REDENLACE_ACCOUNT,
  sucursal:     () => process.env.REDENLACE_PAYOUT_SUCURSAL ?? 'LPZ',
  webhookUrl:   () => process.env.REDENLACE_PAYOUT_WEBHOOK_URL,
  webhookToken: () => process.env.REDENLACE_PAYOUT_WEBHOOK_TOKEN,
};

/** Sucursales que acepta ATC para la cuenta de origen. */
const SUCURSALES = ['CBB', 'COB', 'LPZ', 'ORU', 'POT', 'SCZ', 'SUC', 'TJA', 'TRI'];

/** @returns {boolean} credenciales, comercio y cuenta de origen configurados */
export function isAvailable() {
  return !!(clientAvailable() && cfg.branchCode() && cfg.sourceAccount());
}

/**
 * Gate de dispersión REAL. Por defecto OFF: aunque haya credenciales, no se
 * ejecuta una orden real hasta activarlo. Con el gate apagado se simula.
 */
export function isEnabled() {
  return process.env.WALLET_REDENLACE_DISBURSEMENT_ENABLED === 'true';
}

/** ¿La URL base apunta al ambiente productivo de ATC? */
function pointsToProduction() {
  return cfg.baseUrl().includes('api.redenlace.com.bo');
}

/**
 * Tercera llave. La URL es lo único que distingue el ambiente de forma fiable:
 * el portal de ATC emite credenciales de certificación bajo un gateway rotulado
 * "ATC Prod", así que ni la etiqueta ni las credenciales sirven para saber dónde
 * estamos parados.
 */
function assertProductionAuthorized() {
  if (!pointsToProduction()) return;
  if (process.env.REDENLACE_DISBURSEMENT_PRODUCTION_CONFIRMED === 'true') return;
  throw new Error(
    'Red Enlace: la URL base apunta a producción y falta ' +
    'REDENLACE_DISBURSEMENT_PRODUCTION_CONFIRMED=true. Dinero saliente real requiere ' +
    'confirmación explícita de ambiente.',
  );
}

/** Dispara mock cuando: no habilitado, o sin credenciales, o mock forzado. */
function disburseMock() {
  return !isEnabled() || isMockMode() || !isAvailable();
}

/**
 * Fecha de hoy **en Bolivia**, no en el servidor.
 *
 * ATC exige `fechaTransaccion >= hoy`. El VPS corre en UTC, que va adelantado
 * respecto de Bolivia (UTC-4, sin horario de verano). Entre las 20:00 y la
 * medianoche de Bolivia, la fecha UTC ya es la del día siguiente: mandarla
 * pasaría la validación pero programaría la transferencia para mañana, y un
 * retiro se demoraría un día entero sin que nada parezca estar roto.
 */
function fechaBolivia() {
  return new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── Orden de dispersión ──────────────────────────────────────────────────────

/**
 * Autoriza un lote de un solo ítem: el retiro de un usuario a su cuenta bancaria.
 *
 * Firma compartida con `becDisbursementService.transfer` — la impone el contrato
 * del bloque `disbursement` en `bankRegistry`.
 *
 * @param {object} p
 * @param {string} p.batchId        — wtxId (idempotencia)
 * @param {string} p.batchDetailId  — wtxId
 * @param {number} p.amount
 * @param {string} [p.currency]     — 'BOB' | 'USD'
 * @param {string} p.description    — glosa
 * @param {object} p.beneficiary    — { accountCode, bankCode, name, docId }
 * @returns {Promise<{bankBatchId:string, reference:string, numeroReferencia?:string, _mock?:boolean}>}
 */
export async function transfer(p) {
  const { batchId, batchDetailId, amount, currency = 'BOB', description, beneficiary } = p;

  // ── Validación previa ──────────────────────────────────────────────────────
  // Todo lo que ATC rechaza se chequea acá. Un error de formato descubierto por
  // el banco deja el retiro en 'dispatched' y obliga a revertir a mano.
  if (!batchId || !batchDetailId) throw new Error('transfer: batchId y batchDetailId son requeridos');
  if (!amount || amount <= 0)     throw new Error('transfer: amount debe ser > 0');

  const b = beneficiary ?? {};
  if (!b.accountCode) throw new Error('transfer: beneficiary.accountCode es requerido');
  if (!b.bankCode)    throw new Error('transfer: beneficiary.bankCode es requerido');

  const titular = String(b.name ?? '').trim();
  if (titular.length < 3 || titular.length > 80) {
    throw new Error(`transfer: titularDestino debe tener entre 3 y 80 caracteres (recibido ${titular.length})`);
  }

  // A diferencia de BANECO, ATC lo exige. Sin esto el lote vuelve con ERROR.
  const ciNit = String(b.docId ?? '').trim();
  if (ciNit.length < 5 || ciNit.length > 20) {
    throw new Error(
      'transfer: Red Enlace exige el documento del beneficiario (ciNitDestino, 5 a 20 ' +
      'caracteres). Pasalo como beneficiaryDocId en el dispatch.',
    );
  }

  const glosa = String(description ?? `Retiro Alyto ${batchDetailId}`).trim().slice(0, 80);
  if (glosa.length < 3) throw new Error('transfer: la glosa debe tener al menos 3 caracteres');

  const sucursal = String(cfg.sucursal()).toUpperCase();
  if (!SUCURSALES.includes(sucursal)) {
    throw new Error(`transfer: REDENLACE_PAYOUT_SUCURSAL inválida '${sucursal}'. Válidas: ${SUCURSALES.join(', ')}`);
  }

  const amt = Number(Number(amount).toFixed(2));

  // ── Alias numérico ─────────────────────────────────────────────────────────
  // `transaccionId` admite 14 caracteres y debe entrar en un int de 32 bits.
  // Idempotente por retiro: dos dispatch del mismo wtxId reusan el mismo alias,
  // así que ATC nunca ve dos identificadores para una sola orden.
  const alias = await issueReference({
    provider:    'redenlace',
    kind:        'payout',
    targetModel: 'WalletTransaction',
    targetId:    String(batchDetailId),
    amount:      amt,
    currency,
  });

  if (disburseMock()) {
    const bankBatchId = `mock-rl-disb-${Date.now()}-${String(batchDetailId).slice(-8)}`;
    logger.warn('[RedEnlace] Mock dispersión — lote simulado', {
      bankBatchId, amount: amt, destino: `${b.bankCode}/${b.accountCode}`, reference: alias.reference,
    });
    return { bankBatchId, reference: alias.reference, _mock: true };
  }

  assertProductionAuthorized();

  if (!cfg.webhookUrl()) {
    throw new Error('Red Enlace: falta REDENLACE_PAYOUT_WEBHOOK_URL (sin webhook el retiro no se liquida)');
  }

  // El `processId` va en la RUTA de la consulta de estado. Si no se guarda, un
  // retiro cuyo webhook se pierde queda sin forma de averiguar qué pasó, y la
  // única salida es despertar a un admin para que mire en el portal de ATC.
  const processId = crypto.randomUUID();

  const data = await apiFetch('/payout/async/v3/lote/autorizar', {
    method:  'POST',
    headers: { branchCode: String(cfg.branchCode()) },
    body:    JSON.stringify({
      processId,                                  // 36 caracteres, formato UUID
      webhookUrl: cfg.webhookUrl(),
      transacciones: [{
        transaccionId:    alias.reference,
        importe:          amt,
        fechaTransaccion: fechaBolivia(),
        cuentaOrigen:     cfg.sourceAccount(),
        cuentaDestino:    String(b.accountCode),
        codeBanco:        String(b.bankCode),
        codeSucursal:     sucursal,
        glosa,
        ciNitDestino:     ciNit,
        titularDestino:   titular,
        tipoMoneda:       currency,
      }],
    }),
  });

  if (data?.code !== '00') {
    throw new Error(`Red Enlace lote error [${data?.code}]: ${data?.message ?? 'sin detalle'}`);
  }

  // ⚠️ El lote responde '00' aunque un ítem haya fallado. Hay que mirar el ítem.
  const item = data?.data?.transacciones?.[0];
  if (!item) throw new Error('Red Enlace: el lote no devolvió la transacción');
  if (String(item.estado).toUpperCase() === 'ERROR') {
    throw new Error(`Red Enlace rechazó la transacción: ${item.mensaje ?? 'sin detalle'}`);
  }

  // Lo que se guarda acá es lo que permite reconstruir la operación después:
  // `numeroReferencia` es lo que aparece en los extractos de ATC, y `processId`
  // más `nroLote` son lo que exige la consulta de estado. Sin esto, un webhook
  // perdido deja el retiro sin diagnóstico posible.
  await persistirDatosDelLote(alias.reference, {
    externalReference: item.numeroReferencia,
    processId,
    nroLote: data.data.nroLote,
  });

  logger.info('[RedEnlace] Lote autorizado', {
    nroLote: data.data.nroLote, reference: alias.reference, estado: item.estado,
  });

  return {
    bankBatchId:      String(data.data.nroLote),
    reference:        alias.reference,
    numeroReferencia: item.numeroReferencia ? String(item.numeroReferencia) : undefined,
  };
}

/**
 * Deja en el alias los identificadores que ATC devolvió. Tolerante a fallos a
 * propósito: el dinero ya fue ordenado, así que un error guardando metadatos no
 * puede revertir nada ni debe tumbar la respuesta al admin. Queda registrado
 * como error para que se note.
 */
async function persistirDatosDelLote(reference, { externalReference, processId, nroLote }) {
  try {
    if (externalReference) await attachExternalReference(reference, externalReference);
    const doc = await resolveByReference(reference);
    if (doc) {
      doc.meta = { ...(doc.meta ?? {}), processId, nroLote: String(nroLote) };
      doc.markModified('meta');
      await doc.save();
    }
  } catch (err) {
    logger.error('[RedEnlace] No se pudieron guardar los datos del lote', {
      reference, error: err.message,
    });
  }
}

// ── Consulta de estado ───────────────────────────────────────────────────────

/**
 * Pregunta a ATC en qué estado quedó una transacción despachada.
 *
 * Es lo que le faltaba a BANECO y por eso allá la red de seguridad solo podía
 * alertar a un admin. Acá se puede resolver el retiro atascado consultando al
 * banco, que es la misma lógica que ya usa el barrido del cobro por QR.
 *
 * ⚠️ El método HTTP es ambiguo en la documentación de ATC: la tabla de atributos
 * dice GET y los ejemplos muestran POST. Está preguntado y sin responder, así
 * que probamos GET y caemos a POST si el gateway lo rechaza, registrando cuál
 * funcionó. Es la forma de obtener la respuesta que la documentación no da.
 *
 * @param {object} p
 * @param {string} p.processId      — el UUID que mandamos al autorizar
 * @param {string} p.transaccionId  — nuestro alias de 9 dígitos
 * @returns {Promise<{estado:string, mensaje?:string, numeroAch?:string, raw:object}|null>}
 */
export async function getBatchStatus({ processId, transaccionId }) {
  if (!processId || !transaccionId) {
    throw new Error('getBatchStatus: processId y transaccionId son requeridos');
  }
  if (disburseMock()) {
    logger.warn('[RedEnlace] Mock getBatchStatus', { transaccionId });
    return null;
  }

  const path = `/payout/async/v3/lote/estado/${encodeURIComponent(processId)}`
             + `?transaccionId=${encodeURIComponent(transaccionId)}`;

  let data;
  try {
    data = await apiFetch(path, { method: 'GET', headers: { branchCode: String(cfg.branchCode()) } });
    logger.info('[RedEnlace] Consulta de estado por GET');
  } catch (err) {
    if (!/HTTP 40[45]/.test(err.message)) throw err;
    data = await apiFetch(path, { method: 'POST', headers: { branchCode: String(cfg.branchCode()) } });
    logger.info('[RedEnlace] Consulta de estado por POST (GET rechazado)');
  }

  if (data?.code !== '00') {
    throw new Error(`Red Enlace estado error [${data?.code}]: ${data?.message ?? 'sin detalle'}`);
  }

  // La documentación pone `transacciones` en la raíz en un ejemplo y bajo `data`
  // en otro. Aceptamos las dos antes que fallar por una inconsistencia de ellos.
  const lista = data.transacciones ?? data.data?.transacciones ?? [];
  const t = lista.find((x) => String(x.transaccionId) === String(transaccionId)) ?? lista[0];
  if (!t) return null;

  return { estado: t.estado, mensaje: t.mensaje, numeroAch: t.numeroAch, raw: t };
}

// ── Catálogo de bancos ───────────────────────────────────────────────────────

/**
 * Bancos destino habilitados. Reemplaza el `bankName` de texto libre del
 * formulario de retiro por un selector validado: hoy el admin tiene que tipear
 * el código ASFI a mano al despachar.
 *
 * @returns {Promise<Array<{codigoBanco:string, descripcion:string}>>}
 */
export async function listBanks() {
  if (disburseMock()) {
    logger.warn('[RedEnlace] Mock listBanks — catálogo vacío');
    return [];
  }
  const data = await apiFetch('/payout/async/v3/bancos', {
    method:  'POST',
    headers: { branchCode: String(cfg.branchCode()) },
  });
  if (data?.code !== '00') throw new Error(`Red Enlace bancos error: ${data?.message ?? 'sin detalle'}`);
  return data.data ?? [];
}

// ── Webhook de confirmación ──────────────────────────────────────────────────

/**
 * Autentica el webhook de dispersión.
 *
 * ATC no firma el cuerpo: autentica con un token que viaja en el **query string**
 * de la URL que nosotros registramos. Eso convierte la URL completa en un
 * secreto, y es la razón por la que no se logea entera en ningún lado.
 *
 * Fail-closed en producción: sin token configurado, se rechaza. A diferencia del
 * cobro por QR, acá no hay reconfirmación automática contra ATC antes de mover
 * dinero, así que aceptar por estructura dejaría que cualquiera marcara retiros
 * como acreditados.
 *
 * @param {import('express').Request} req
 * @returns {{ok:boolean, reason:string}}
 */
export function verifyNotifyStatus(req) {
  const esperado = cfg.webhookToken();

  if (!esperado) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'no-token-prod-fail-closed' };
    }
    return { ok: true, reason: isMockMode() ? 'mock' : 'structural-no-token' };
  }

  const recibido = String(req.query?.token ?? '');
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-token' };
  }
  return { ok: true, reason: 'query-token' };
}

/**
 * Traduce el webhook de ATC a la forma que espera `handleBankDisbursementIPN`.
 *
 * ATC manda `transaccionId` (nuestro alias de 9 dígitos) y `estado`; el handler
 * espera `wtxId` y `status`. La vuelta del alias al `wtxId` sale de
 * `ProviderReference`: sin ese registro, la confirmación de un retiro llegaría
 * sin saber a qué retiro corresponde.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{wtxId:string, status:string, bankReference?:string, reason?:string}|null>}
 */
export async function normalizeNotify(req) {
  const b = req.body ?? {};
  if (!b.transaccionId || !b.estado) return null;

  const ref = await resolveByReference(String(b.transaccionId));
  if (!ref) {
    logger.warn('[RedEnlace] Confirmación con alias desconocido', { transaccionId: b.transaccionId });
    return null;
  }

  return {
    wtxId:         ref.targetId,
    status:        b.estado,
    bankReference: b.numeroAch ?? b.numeroReferencia ?? b.nroLote,
    reason:        b.mensaje,
  };
}

/**
 * Traduce el estado de ATC a nuestro modelo: 'accepted' | 'rejected' | 'unknown'.
 *
 * `PAGADO` y `COMPLETADO` conviven porque la documentación se contradice: el
 * webhook los documenta como `PAGADO|CANCELADO` y la tabla de estados usa
 * `COMPLETADO`. Aceptamos los dos hasta que ATC aclare.
 *
 * ⚠️ **`REVERTIDO` cae en 'unknown' a propósito.** Significa que un retiro ya
 * pagado volvió, y no tenemos camino para eso: el saldo del usuario ya fue
 * debitado y habría que reacreditarlo. Mapearlo a 'rejected' sería peor que no
 * hacer nada, porque intentaría liberar una reserva que ya no existe y dejaría
 * el registro diciendo que el retiro falló cuando en realidad se pagó y se
 * devolvió. Queda como 'unknown' para que se registre y lo resuelva una persona.
 * Es un hueco conocido, no un olvido.
 */
export function mapNotifyStatus(estado) {
  const s = String(estado ?? '').toUpperCase();
  if (s === 'PAGADO' || s === 'COMPLETADO') return 'accepted';
  if (s === 'RECHAZADO' || s === 'CANCELADO') return 'rejected';
  // PENDIENTE, PROCESO, ENVIADO, PENDIENTE_CONFIRMACION → todavía no hay nada que hacer.
  // REVERTIDO → ver el comentario de arriba.
  return 'unknown';
}
