/**
 * becDisbursementService.js — Dispersión / pago a terceros Banco Económico
 *                             (API Market v1.3.0 §9 — Planillas de pagos)
 *
 *   transfer({...})        — ordena una planilla de 1 ítem (off-ramp BOB → banco del usuario)
 *   verifyNotifyStatus(req)— autentica el webhook de confirmación (§9.2 notifyStatus)
 *   isAvailable()          — credenciales + cuenta de débito configuradas
 *   isEnabled()            — dispersión real habilitada (gate de seguridad)
 *
 * Endpoint upload: POST /api/batchPayment/upload
 *   Una transferencia individual on-demand se modela como una planilla de UN ítem.
 *   ⚠️ Pendiente confirmar con BANECO (Marcelo, 2026-06-23): que aceptan planilla de
 *   1 ítem, pagos interbancarios (bankCode), catálogo de bankCode, límites/horarios,
 *   y si BatchPayment.accountCode (cuenta beneficiaria) va cifrado o plano.
 *   Ver docs/BANECO_PEDIDO_TECNICO_DISPERSION.md.
 *
 * Confirmación: el banco hace POST a nuestro endpoint notifyStatus (§9.2) por cada
 *   pago del detalle, con status ACEP (aceptado) / RECH (rechazado). Ese webhook es
 *   el que completa o revierte el retiro (ver controllers). Como red de seguridad
 *   existe el job reconcileBecDisbursements.
 *
 * SEGURIDAD: la dispersión real exige WALLET_BANECO_DISBURSEMENT_ENABLED=true Y
 *   credenciales reales. Sin eso, opera en mock mode (no mueve dinero).
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { apiFetch, encryptAes, isAvailable as clientAvailable, isMockMode } from './becClient.js';

// Cuenta de débito (origen de la dispersión) — la cuenta de tesorería BOB de la SRL.
const debitAccount = () => process.env.BEC_ACCOUNT_DEBIT ?? process.env.BEC_ACCOUNT_CREDIT;

// El doc marca varios accountCode como "cifrado"; ciframos la cuenta de débito (propia).
let _encryptedDebit = null;
function getEncryptedDebit() {
  if (!_encryptedDebit) _encryptedDebit = encryptAes(debitAccount());
  return _encryptedDebit;
}

/** @returns {boolean} credenciales + cuenta de débito configuradas */
export function isAvailable() {
  return !!(clientAvailable() && debitAccount());
}

/**
 * Gate de habilitación de dispersión REAL. Por defecto OFF: aunque haya credenciales,
 * no se ejecuta una dispersión real hasta activarlo explícitamente (tras confirmación
 * del banco). Si está OFF pero hay credenciales, igual se simula (mock) para no romper.
 * @returns {boolean}
 */
export function isEnabled() {
  return process.env.WALLET_BANECO_DISBURSEMENT_ENABLED === 'true';
}

/** Dispara mock cuando: no habilitado, o sin credenciales, o BEC_MOCK_ENABLED. */
function disburseMock() {
  return !isEnabled() || isMockMode();
}

// ── Mapeo de tipo de cuenta beneficiaria al catálogo BEC ────────────────────────
// CCAD = Cuenta Corriente o Caja de Ahorro · CMOVILD = Billetera Móvil
function mapAccountTypeCode(accountType) {
  const v = String(accountType ?? '').toLowerCase();
  if (v.includes('movil') || v.includes('billetera') || v === 'wallet') return 'CMOVILD';
  return 'CCAD';
}

/**
 * Ordena una transferencia individual de BOB a la cuenta bancaria de un beneficiario,
 * modelada como una planilla de 1 ítem (§9.1 batchPayment/upload).
 *
 * @param {object} p
 * @param {string} p.batchId        — ID externo de la planilla (idempotencia) — usar wtxId
 * @param {string} p.batchDetailId  — ID externo del pago dentro de la planilla — usar wtxId
 * @param {number} p.amount         — monto BOB
 * @param {string} [p.currency]     — 'BOB' | 'USD' (default BOB; debe == moneda cuenta débito)
 * @param {string} p.description    — motivo de la planilla / glosa
 * @param {object} p.beneficiary
 * @param {string} p.beneficiary.accountCode   — nº cuenta del beneficiario
 * @param {string} p.beneficiary.bankCode      — código ASFI de la entidad financiera destino
 * @param {string} p.beneficiary.name          — nombre/razón social del beneficiario
 * @param {string} [p.beneficiary.accountType] — 'caja de ahorro' | 'corriente' | 'billetera movil'
 * @param {string} [p.beneficiary.docId]       — CI/NIT del beneficiario (opcional)
 * @param {string} [p.beneficiary.phone]       — celular (opcional, notificación)
 * @param {string} [p.beneficiary.email]       — email (opcional, notificación)
 * @param {object} p.amlData                   — { source, destination } origen/destino de fondos (requerido)
 * @returns {Promise<{ bankBatchId: string|number, _mock?: boolean }>}
 */
export async function transfer(p) {
  const {
    batchId, batchDetailId, amount, currency = 'BOB', description, beneficiary, amlData,
  } = p;

  // Validaciones mínimas
  if (!batchId || !batchDetailId) throw new Error('transfer: batchId y batchDetailId son requeridos (idempotencia)');
  if (!amount || amount <= 0)     throw new Error('transfer: amount debe ser > 0');
  if (!beneficiary?.accountCode || !beneficiary?.bankCode || !beneficiary?.name) {
    throw new Error('transfer: beneficiary.accountCode, bankCode y name son requeridos');
  }
  if (!amlData?.source || !amlData?.destination) {
    throw new Error('transfer: amlData.source y amlData.destination son requeridos (§9 AMLData)');
  }

  const amt = Number(Number(amount).toFixed(2));

  if (disburseMock()) {
    const bankBatchId = `mock-bec-disb-${Date.now()}-${String(batchDetailId).slice(-8)}`;
    logger.warn(`[BEC] Mock dispersión — planilla simulada: ${bankBatchId} | Bs. ${amt} → ${beneficiary.bankCode}/${beneficiary.accountCode}`);
    return { bankBatchId, _mock: true };
  }

  const detail = {
    batchDetailId:  String(batchDetailId),
    amount:         amt,
    accountCode:    beneficiary.accountCode,                 // ⚠️ confirmar con banco si va cifrado
    accountTypeCode: mapAccountTypeCode(beneficiary.accountType),
    bankCode:       beneficiary.bankCode,
    beneficiaryName: beneficiary.name,
    ...(beneficiary.docId  ? { beneficaryDocId:  beneficiary.docId }  : {}), // sic: el doc usa 'beneficaryDocId'
    ...(beneficiary.phone  ? { beneficiaryPhone: beneficiary.phone }  : {}),
    ...(beneficiary.email  ? { beneficiaryEmail: beneficiary.email }  : {}),
    note:           (description ?? `Alyto ${batchDetailId}`).slice(0, 100),
    AMLData:        { AMLSource: amlData.source, AMLDestination: amlData.destination },
  };

  const data = await apiFetch('/api/batchPayment/upload', {
    method: 'POST',
    body:   JSON.stringify({
      batchId:       String(batchId),
      type:          process.env.BEC_DISBURSEMENT_TYPE ?? 'PROVIDERS',  // PAYROLL | PROVIDERS
      descripction:  (description ?? `Alyto retiro ${batchId}`).slice(0, 100), // sic: el doc usa 'descripction'
      detailedDebit: true,   // un débito por ítem (obligatorio para pagos interbancarios)
      accountCode:   getEncryptedDebit(),
      batchCurrency: currency,
      batchAmount:   amt,
      AMLData:       { AMLSource: amlData.source, AMLDestination: amlData.destination },
      paymentCount:  1,
      paymentList:   [detail],
    }),
  });

  if (data.responseCode !== 0) throw new Error(`BEC batchPayment error: ${data.message}`);
  return { bankBatchId: data.bankBatchId };
}

/**
 * Autentica un webhook entrante de confirmación de estado (§9.2 notifyStatus) ANTES
 * de mover dinero. El endpoint es público (server-to-server), así que el body por sí
 * solo no es confiable.
 *
 *   Capa 1 — Firma HMAC-SHA256 sobre el raw body (gated por BEC_DISBURSEMENT_IPN_SECRET).
 *     ⚠️ El header/esquema exacto se confirma en el onboarding del webhook con BANECO.
 *   Capa 2 — Validación estructural mínima (bankBatchId/batchDetailId/status presentes).
 *     (BEC no documenta un GET de estado de planilla; la red de seguridad es el job
 *      reconcileBecDisbursements + conciliación por movimientos.)
 *
 * @param {import('express').Request} req
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyNotifyStatus(req) {
  const b = req.body ?? {};
  if (!b.batchDetailId || !b.status) return { ok: false, reason: 'missing-fields' };

  const secret = process.env.BEC_DISBURSEMENT_IPN_SECRET;
  if (secret) {
    const provided = String(req.headers['x-bec-signature'] ?? req.headers['x-signature'] ?? '');
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody ?? '', 'utf8').digest('hex');
    const x = Buffer.from(provided);
    const y = Buffer.from(expected);
    if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) {
      return { ok: false, reason: 'bad-signature' };
    }
    return { ok: true, reason: 'hmac' };
  }

  // Mock/staging o sin secret configurado: aceptamos estructuralmente (el flujo de
  // prueba en staging usa el simulador admin, no este endpoint público).
  return { ok: true, reason: isMockMode() ? 'mock' : 'structural-no-secret' };
}

/** Normaliza el status del banco a nuestro modelo: 'accepted' | 'rejected' | 'unknown'. */
export function mapNotifyStatus(status) {
  const s = String(status ?? '').toUpperCase();
  if (s === 'ACEP') return 'accepted';
  if (s === 'RECH') return 'rejected';
  return 'unknown';
}
