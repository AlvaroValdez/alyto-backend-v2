/**
 * ipnController.js — Handlers de IPN (webhooks entrantes)
 *
 * Procesa notificaciones asíncronas de Vita Wallet y Fintoc para el motor
 * de pagos cross-border. El flujo automatizado completo es:
 *
 *   POST /crossborder → Transaction (payin_pending)
 *         ↓ usuario paga en widget de Vita / Fintoc
 *   POST /api/v1/ipn/vita  ← Vita confirma payin
 *         ↓
 *   dispatchPayout() → Vita withdrawal (o email admin si anchor manual)
 *         ↓
 *   POST /api/v1/ipn/vita  ← Vita confirma payout (segundo IPN)
 *         ↓
 *   Transaction.status = "completed" ✅
 *
 * Seguridad:
 *   - Vita IPN: validación HMAC-SHA256 (mismo algoritmo que outbound requests)
 *   - Fintoc IPN: validación por tipo de evento + lookup por payinReference
 *   - Ambos handlers responden HTTP 200 siempre para evitar reintentos innecesarios
 *     ante errores internos. Los errores se loguean para revisión manual.
 */

import crypto            from 'crypto';
import { logger }        from '../utils/logger.js';
import { enqueueIpnEvent, isSqsEnabled } from '../utils/sqsBuffer.js';
import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import User              from '../models/User.js';
import {
  createPayout,
  createVitaSentPayout,
  VITA_SENT_ONLY_COUNTRIES,
  getPrices,
} from '../services/vitaWalletService.js';
import {
  verifyWebhookSignature,
  getHarborQuote,
  createHarborTransfer,
  getCustomerUuid,
  createQuote,
  getRequirementsSchema,
  createTransfer as createOwlPayTransfer,
  buildPayoutInstrument,
  resolveHarborCountry,
} from '../services/owlPayService.js';
import FundingRecord from '../models/FundingRecord.js';
import { HARBOR_MIN_USD, HARBOR_MAX_USD } from '../routing/euAmountRouter.js';
import {
  registerAuditTrail,
  sendUSDCToHarbor,
  getStellarUSDCBalance,
} from '../services/stellarService.js';
import Sentry from '../services/sentry.js';
import { mapHarborError }     from '../utils/harborErrorMapper.js';
import { pickSupportedQuote } from '../utils/harborMethodSupport.js';
import { notify, NOTIFICATIONS } from '../services/notifications.js';
import { broadcastToAdmins } from '../routes/adminSSE.js';
import { sendEmail, sendRawEmail, EMAILS } from '../services/email.js';
import { generateOfficialReceipt }   from '../utils/pdfGenerator.js';
import { generarNumeroCorrelativo }  from '../utils/correlativoService.js';
import { uploadBuffer, getDownloadUrl } from '../services/storageService.js';
import { resolveQuoteRate, checkFxDrift } from '../services/exchangeRateService.js';
import { recordSent }       from './contactsController.js';

// ─── Helpers Internos ─────────────────────────────────────────────────────────

/**
 * Verifica la firma HMAC-SHA256 del IPN entrante de Vita.
 *
 * Vita firma el body con:
 *   sortedString = claves ordenadas alfabéticamente, concatenadas key+value
 *                  (objetos anidados con sus claves también ordenadas → JSON.stringify)
 *   signature    = HMAC-SHA256(VITA_SECRET, sortedString)
 *
 * NOTA: a diferencia de las peticiones salientes, el IPN NO incluye
 * xLogin ni xDate en el mensaje a firmar — solo el sortedBody.
 *
 * @param {object} body    — req.body ya parseado
 * @param {object} headers — req.headers
 * @returns {boolean}
 */
function verifyVitaSignature(body, headers) {
  const secret = process.env.VITA_SECRET;
  if (!secret) return false;

  // Ordena recursivamente las claves de un objeto
  function sortObjectKeys(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    const sorted = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = sortObjectKeys(obj[key]);
    });
    return sorted;
  }

  // Construye el string a firmar: key + value concatenados, claves ordenadas
  function sortAndStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return String(obj);
    return Object.keys(obj).sort().map(key => {
      const val = obj[key];
      if (typeof val === 'object' && val !== null) {
        return key + JSON.stringify(sortObjectKeys(val));
      }
      return key + val;
    }).join('');
  }

  const sortedString = sortAndStringify(body);

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(sortedString)
    .digest('hex');

  const receivedSignature = headers['authorization']
    ?.replace('V2-HMAC-SHA256, Signature: ', '')
    ?.trim();

  if (!receivedSignature || receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Registra una entrada en el ipnLog de la transacción.
 * Operación no crítica — falla silenciosamente para no interrumpir el flujo.
 *
 * @param {object} transaction — Documento Mongoose (no .lean())
 * @param {string} eventType
 * @param {string} provider
 * @param {string} status
 * @param {*}      rawPayload
 */
// Truncación de payloads grandes para acotar la memoria retenida por documento.
const MAX_IPN_PAYLOAD_BYTES = 10 * 1024; // 10KB por entrada
const MAX_IPN_LOG_ENTRIES   = 50;        // conservar solo las últimas 50 entradas

function truncateIpnPayload(rawPayload) {
  try {
    const str = JSON.stringify(rawPayload);
    if (str.length > MAX_IPN_PAYLOAD_BYTES) {
      return {
        _truncated:    true,
        _originalSize: str.length,
        preview:       str.substring(0, 500),
      };
    }
    return rawPayload;
  } catch {
    return { _error: 'Could not serialize payload' };
  }
}

async function appendIpnLog(transaction, eventType, provider, status, rawPayload) {
  try {
    const safePayload = truncateIpnPayload(rawPayload);
    transaction.ipnLog.push({ provider, eventType, status, rawPayload: safePayload, receivedAt: new Date() });
    if (transaction.ipnLog.length > MAX_IPN_LOG_ENTRIES) {
      transaction.ipnLog = transaction.ipnLog.slice(-MAX_IPN_LOG_ENTRIES);
    }
    await transaction.save();
  } catch (err) {
    console.error('[Alyto IPN] Error guardando ipnLog:', {
      transactionId: transaction.alytoTransactionId,
      eventType,
      error: err.message,
    });
  }
}

/**
 * Notifica al admin que hay un payout manual pendiente (Escenario C — Bolivia).
 * Delega al servicio de email con Dynamic Template de SendGrid.
 *
 * @param {object} transaction — Documento Mongoose con beneficiary y montos
 */
export async function notifyAdminManualPayout(transaction) {
  await sendEmail(...EMAILS.adminBoliviaAlert(transaction));
}

/**
 * Calcula el monto neto a enviar a Vita para el withdrawal.
 * Es el originalAmount menos todos los fees que Alyto retiene.
 *
 * Usa feeBreakdown.totalFee si está almacenado; en caso contrario
 * usa 0 (seguro: Vita calculará la conversión sin deducción extra).
 *
 * TODO (Fase 18B): almacenar netAmountToSend explícitamente al crear la
 * transacción en POST /crossborder para evitar esta reconstrucción.
 *
 * @param {object} transaction
 * @returns {number}
 */
/**
 * Calcula el monto neto a enviar a Vita descontando los fees de Alyto.
 *
 * Fees descontados aquí (retenidos por Alyto antes de enviar):
 *   payinFee       — costo del método de pago local (ej. Fintoc)
 *   alytoCSpread   — spread cambiario de Alyto
 *   fixedFee       — fee fijo por operación
 *   profitRetention — margen de ganancia de Alyto
 *
 * El payoutFee (costo de dispersión en destino) lo descuenta Vita
 * directamente sobre el monto que recibe — NO se descuenta aquí.
 *
 * @param {object} transaction — Documento Mongoose
 * @returns {number} Monto neto en CLP a enviar a Vita
 * @throws {Error} Si el monto neto es <= 0
 */
function resolveNetAmountForPayout(transaction) {
  const fees = transaction.fees || {};
  const round2 = n => Math.round(n * 100) / 100;

  // Usar totalDeductedReal si está disponible (transacciones nuevas).
  // Fallback explícito para transacciones anteriores que no tienen el campo.
  const totalReal = fees.totalDeductedReal
    ?? round2(
      (fees.payinFee        || 0)
      + (fees.alytoCSpread  || 0)
      + (fees.fixedFee      || 0)
      + (fees.profitRetention || 0),
    );

  const montoNeto = round2((transaction.originalAmount ?? 0) - totalReal);

  console.log('[dispatchPayout] Desglose fees:');
  console.log('  originAmount:', transaction.originalAmount);
  console.log('  - payinFee:', fees.payinFee || 0);
  console.log('  - alytoCSpread:', fees.alytoCSpread || 0);
  console.log('  - fixedFee:', fees.fixedFee || 0);
  console.log('  - profitRetention:', fees.profitRetention || 0);
  console.log('  totalDeductedReal (usado):', totalReal);
  console.log('  = montoNeto enviado a Vita:', montoNeto);

  if (montoNeto <= 0) {
    throw new Error(
      `Monto neto inválido: ${montoNeto} — revisar config de fees en corredor ${transaction.corridorId}`,
    );
  }

  return montoNeto;
}

// ─── Helpers de Payout por Proveedor ─────────────────────────────────────────

/**
 * Construye el payload de beneficiario normalizado para Vita o OwlPay.
 * Soporta tanto formato dinámico (campos de withdrawal_rules de Vita)
 * como formato legado (campos nombrados del schema de Transaction).
 *
 * @param {object} ben         — transaction.beneficiary
 * @param {number} amount      — monto ya convertido a moneda del proveedor
 * @param {string} currency    — moneda del proveedor (ej. 'usd', 'clp')
 * @param {object} transaction
 * @returns {{ vitaPayload: object, beneficiaryFlat: object }}
 */
// Vita API solo acepta [a-zA-Z0-9 ] en nombres. NFD descompone caracteres
// acentuados (á → a + combining accent), luego eliminamos esos combining marks.
function normalizeNameForVita(str) {
  return (str ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildBeneficiaryPayloads(ben, amount, currency, transaction) {
  const dynamicFields = {};
  if (ben.dynamicFields instanceof Map) {
    for (const [k, v] of ben.dynamicFields.entries()) dynamicFields[k] = v;
  } else if (ben.dynamicFields && typeof ben.dynamicFields === 'object') {
    Object.assign(dynamicFields, ben.dynamicFields);
  }

  const isDynamicFormat = Boolean(
    dynamicFields.beneficiary_first_name ??
    dynamicFields.beneficiary_email      ??
    dynamicFields.bank_code,
  );

  let vitaPayload;
  if (isDynamicFormat) {
    const firstName = normalizeNameForVita(dynamicFields.beneficiary_first_name);
    const lastName  = normalizeNameForVita(dynamicFields.beneficiary_last_name);
    vitaPayload = {
      country:          transaction.destinationCountry,
      currency,
      amount,
      order:            transaction.alytoTransactionId,
      purpose:          'ISSAVG',
      ...dynamicFields,
      // Override normalized names after spread to strip diacritics rejected by Vita
      beneficiary_first_name: firstName,
      beneficiary_last_name:  lastName,
      fc_customer_type: 'natural',
      fc_legal_name:    `${firstName} ${lastName}`.trim() || 'Beneficiario Alyto',
      fc_document_type: dynamicFields.beneficiary_document_type ?? 'dni',
    };
  } else {
    const firstName = normalizeNameForVita(ben.firstName);
    const lastName  = normalizeNameForVita(ben.lastName);
    vitaPayload = {
      country:                     transaction.destinationCountry,
      currency,
      amount,
      order:                       transaction.alytoTransactionId,
      beneficiary_first_name:      firstName,
      beneficiary_last_name:       lastName,
      beneficiary_email:           ben.email      ?? '',
      beneficiary_address:         ben.address    ?? '',
      beneficiary_document_type:   ben.documentType   ?? 'dni',
      beneficiary_document_number: ben.documentNumber ?? '',
      purpose:                     'ISSAVG',
      ...(ben.bankCode    ? { bank_code:         ben.bankCode    } : {}),
      ...(ben.accountBank ? { account_bank:       ben.accountBank } : {}),
      ...(ben.accountType ? { account_type_bank:  ben.accountType } : {}),
      fc_customer_type: 'natural',
      fc_legal_name:    `${firstName} ${lastName}`.trim(),
      fc_document_type: ben.documentType ?? 'dni',
      ...dynamicFields,
    };
  }

  // Beneficiario plano para OwlPay (campos estándar)
  const beneficiaryFlat = {
    firstName:      vitaPayload.beneficiary_first_name ?? ben.firstName ?? '',
    lastName:       vitaPayload.beneficiary_last_name  ?? ben.lastName  ?? '',
    email:          vitaPayload.beneficiary_email      ?? ben.email     ?? '',
    documentType:   vitaPayload.beneficiary_document_type   ?? ben.documentType   ?? 'dni',
    documentNumber: vitaPayload.beneficiary_document_number ?? ben.documentNumber ?? '',
    bankCode:       vitaPayload.bank_code        ?? ben.bankCode    ?? '',
    accountNumber:  vitaPayload.account_bank     ?? ben.accountBank ?? '',
    accountType:    vitaPayload.account_type_bank ?? ben.accountType ?? 'savings',
    address:        vitaPayload.beneficiary_address ?? ben.address  ?? '',
    dynamicFields,
  };

  return { vitaPayload, beneficiaryFlat };
}

/**
 * Calcula la conversión BOB→USDC para corredores SRL Bolivia.
 *
 * La tasa (bobPerUsdc) proviene exclusivamente de corridor.manualExchangeRate,
 * que el admin fija desde PATCH /admin/corridors/:corridorId/rate.
 * USDC es el activo de tránsito en Stellar (≈ 1:1 con USD para Vita/OwlPay).
 *
 * @param {number} netAmountBOB  — monto neto en BOB (después de descontar fees)
 * @param {object} corridor      — TransactionConfig del corredor
 * @returns {{ usdcAmount: number, bobPerUsdc: number }}
 * @throws {Error} si manualExchangeRate no está configurada (= 0)
 */
async function convertBobToUsdc(netAmountBOB, corridor) {
  // Fuente única (resolveQuoteRate): tasa admin sin colchón, o mercado + colchón.
  // Solo se llega aquí en el fallback de recalc (tx sin digitalAssetAmount). Debe
  // usar la MISMA tasa con colchón que la cotización para no entregar bajo costo.
  const { bobPerUsdc } = await resolveQuoteRate(corridor);

  const usdcAmount = Math.round((netAmountBOB / bobPerUsdc) * 100) / 100; // 2 decimales — igual que en la cotización (round2)
  return { usdcAmount, bobPerUsdc };
}

// ─── buildOwlPayBeneficiary ───────────────────────────────────────────────────

/**
 * Maps form values (stored in transaction.beneficiary.dynamicFields) to the
 * Harbor transfer structure: { beneficiary_info, payout_instrument,
 * transfer_purpose, is_self_transfer }.
 *
 * Form fields are defined in owlPayForms.js (frontend). The backend does NOT
 * depend on the Harbor requirements schema to build this — form ↔ schema
 * mapping is owned here.
 *
 * CN: beneficiary_info includes full address + SWIFT payout_instrument.
 * NG: beneficiary_info is name-only + account_number/bank_name payout_instrument.
 */
function buildOwlPayBeneficiary(rawBeneficiary, schema, destCountry, paymentMethod) {
  if (!rawBeneficiary) throw new Error('beneficiaryDetails missing on transaction');

  const dest = (destCountry ?? '').toUpperCase();

  // Normalise dynamicFields (Mongoose Map or plain object)
  const df = rawBeneficiary?.dynamicFields instanceof Map
    ? Object.fromEntries(rawBeneficiary.dynamicFields.entries())
    : (rawBeneficiary?.dynamicFields ?? {});

  // Read a field: dynamicFields first, then top-level beneficiary subdoc
  const get = (...keys) => {
    for (const k of keys) {
      const v = df[k] ?? rawBeneficiary[k];
      if (v !== undefined && v !== null && v !== '') return String(v).trim();
    }
    return null;
  };

  // beneficiary_name: new form sends it directly; legacy format uses firstName+lastName
  const beneficiaryName =
    get('beneficiary_name') ||
    (`${get('firstName', 'first_name') ?? ''} ${get('lastName', 'last_name') ?? ''}`.trim()) ||
    get('account_holder_name', 'accountHolderName') ||
    '';

  // transfer_purpose + is_self_transfer come from the new OwlPay form
  const transferPurpose = get('transfer_purpose') ?? null;
  const isSelfTransferRaw = df.is_self_transfer ?? rawBeneficiary.is_self_transfer;
  const isSelfTransfer = isSelfTransferRaw === true || isSelfTransferRaw === 'true';

  let beneficiary_info, payout_instrument;

  // ─── Helpers ────────────────────────────────────────────────────────────
  // Schemas Harbor (vía GET /v2/transfers/quotes/:id/requirements) usan
  // additionalProperties:false → campos extra producen error 2005.
  //
  // ⚠️ DISCREPANCIA schema-vs-implementación verificada end-to-end
  // (scripts/audit-harbor-end-to-end.js): el schema endpoint dice que
  // beneficiary_address.required = ['street', 'country'], pero la
  // implementación REAL exige también city, state_province y postal_code
  // para todos los países (NG, BR, MX, IN, SG, AE, etc.). Por eso construimos
  // siempre el address completo. Fallback inteligente para state_province en
  // países sin states reales (HK, SG, NG, AE) → usar country code.
  const iban         = get('iban', 'account_number');
  const resolvedDest = resolveHarborCountry(dest, iban);

  const buildAddress = (countryCode) => {
    const street = get('street', 'address', 'direccion');
    const city   = get('city', 'ciudad');
    const state  = get('state_province', 'stateProvince', 'provincia');
    const postal = get('postal_code', 'postalCode', 'codigoPostal');

    if (!street) throw new Error(`[Harbor] street requerido en beneficiary_address (${countryCode})`);
    if (!city)   throw new Error(`[Harbor] city requerido en beneficiary_address (${countryCode})`);
    if (!postal) throw new Error(`[Harbor] postal_code requerido en beneficiary_address (${countryCode})`);

    // state_province: Harbor valida contra enum. Para US exige abreviatura de estado (CA, NY…);
    // el fallback countryCode='US' no es un estado válido → lanzar error explícito.
    // Para países sin subdivisiones reales (HK, SG, NG…) el country code es aceptado por Harbor.
    if (!state && countryCode === 'US') {
      throw new Error('[Harbor] state_province requerido para US (ej. CA, NY, TX)');
    }
    const stateProvince = state || countryCode;

    return {
      street,
      city,
      state_province: stateProvince,
      postal_code:    postal,
      country:        countryCode,
    };
  };

  // ─── EU SEPA/WIRE ───────────────────────────────────────────────────────
  // Schema verificado. SEPA: { account_holder_name, account_number(IBAN) }.
  // WIRE: + bank_name, swift_code. beneficiary_address requires postal_code.
  if (['EU', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'PT', 'AT', 'PL', 'SE', 'CH', 'NO', 'DK', 'FI', 'IE'].includes(dest)) {
    if (!iban) throw new Error('[Harbor] IBAN (account_number) requerido para EU');
    const holderName = get('account_holder_name') ?? beneficiaryName;
    if (!holderName) throw new Error('[Harbor] account_holder_name requerido para EU');

    const isWire = (paymentMethod ?? '').toUpperCase() === 'WIRE';
    if (isWire) {
      const bic      = get('bic', 'swift_code');
      const bankName = get('bank_name');
      if (!bic)      throw new Error('[Harbor] swift_code (BIC) requerido para WIRE EU');
      if (!bankName) throw new Error('[Harbor] bank_name requerido para WIRE EU');
      payout_instrument = {
        account_holder_name: holderName,
        bank_name:           bankName,
        account_number:      iban,
        swift_code:          bic,
      };
    } else {
      payout_instrument = { account_holder_name: holderName, account_number: iban };
    }
    beneficiary_info = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress(resolvedDest),
    };

  // ─── CN (CIPS, WIRE) ────────────────────────────────────────────────────
  // Schema verificado. payout: 4 SWIFT fields. benef: name + address.
  // dob/id_doc allowed but NOT required → omitidos para no inflar el payload.
  } else if (dest === 'CN') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'CN', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('CN'),
    };

  // ─── NG (BANK-TRANSFER) ─────────────────────────────────────────────────
  // Schema verificado. payout: name, bank_name, account_number. benef: name + address.
  } else if (dest === 'NG') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'NG', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('NG'),
    };

  // ─── BR (PIX) ───────────────────────────────────────────────────────────
  // Schema verificado. payout: br_cpf required + optional phone/email/EVP.
  // benef: name + address (dob/id_doc allowed but no requeridos).
  } else if (dest === 'BR') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'BR', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('BR'),
    };

  // ─── MX (SPEI) ──────────────────────────────────────────────────────────
  // Schema verificado. payout: mx_clabe ONLY. benef: name + address + dob + id_doc (TODOS required).
  } else if (dest === 'MX') {
    const dob   = get('beneficiary_dob', 'dateOfBirth', 'dob');
    const idDoc = get('beneficiary_id_doc_number', 'documentNumber', 'document_number', 'ci');
    if (!dob)   throw new Error('[Harbor] beneficiary_dob requerido para MX SPEI');
    if (!idDoc) throw new Error('[Harbor] beneficiary_id_doc_number requerido para MX SPEI');
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'MX', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:          beneficiaryName,
      beneficiary_address:       buildAddress('MX'),
      beneficiary_dob:           dob,
      beneficiary_id_doc_number: idDoc,
    };

  // ─── AE (FTS, AANI, BANK-TRANSFER) ──────────────────────────────────────
  // Schema verificado. payout: name, phone_number(+971), swift_code, account_number(IBAN).
  // benef: name + address.
  } else if (dest === 'AE') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'AE', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('AE'),
    };

  // ─── HK (CHATS, WIRE) ───────────────────────────────────────────────────
  // Schema verificado. CHATS añade bank_code(3 dígitos). benef: name + address.
  } else if (dest === 'HK') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'HK', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('HK'),
    };

  // ─── IN (IMPS) ──────────────────────────────────────────────────────────
  // Schema verificado. payout: bank_code(IFSC) + account_number ONLY.
  // benef: name + email + address + phone + dob + id_doc (TODOS required).
  } else if (dest === 'IN') {
    const email = get('beneficiary_email', 'email');
    const phone = get('beneficiary_phone_number', 'phone_number', 'phone');
    const dob   = get('beneficiary_dob', 'dateOfBirth', 'dob');
    const idDoc = get('beneficiary_id_doc_number', 'documentNumber', 'document_number');
    if (!email) throw new Error('[Harbor] beneficiary_email requerido para IN IMPS');
    if (!phone) throw new Error('[Harbor] beneficiary_phone_number requerido para IN IMPS');
    if (!dob)   throw new Error('[Harbor] beneficiary_dob requerido para IN IMPS');
    if (!idDoc) throw new Error('[Harbor] beneficiary_id_doc_number requerido para IN IMPS');
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'IN', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:          beneficiaryName,
      beneficiary_email:         email,
      beneficiary_address:       buildAddress('IN'),
      beneficiary_phone_number:  phone,
      beneficiary_dob:           dob,
      beneficiary_id_doc_number: idDoc,
    };

  // ─── US (ACH_PUSH, DOMESTIC_WIRE, FEDWIRE, WIRE) ────────────────────────
  // Schema verificado. payout: name, bank_name, account_number, routing_number.
  // benef: name + address (ACH_PUSH solo requiere name pero incluir address es válido).
  } else if (dest === 'US') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'US', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('US'),
    };

  // ─── SG (BANK-TRANSFER) ─────────────────────────────────────────────────
  // Schema verificado. payout: 4 SWIFT fields. benef: name + address.
  } else if (dest === 'SG') {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, 'SG', paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress('SG'),
    };

  // ─── JP, GB (corredores aún no activos para SRL — esperan LLC) ──────────
  // Schemas asumidos (SRL no tiene acceso al corredor en Harbor sandbox).
  } else if (['JP', 'GB'].includes(dest)) {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, dest, paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress(dest),
    };

  // ─── Default / país no mapeado ──────────────────────────────────────────
  } else {
    payout_instrument = buildPayoutInstrument(rawBeneficiary, resolvedDest, paymentMethod);
    beneficiary_info  = {
      beneficiary_name:    beneficiaryName,
      beneficiary_address: buildAddress(resolvedDest),
    };
  }

  console.log('[OwlPay] buildOwlPayBeneficiary:', { dest, beneficiaryName, payout_instrument, beneficiary_address: beneficiary_info?.beneficiary_address });

  return {
    beneficiary_info,
    payout_instrument,
    transfer_purpose: transferPurpose,
    is_self_transfer: isSelfTransfer,
  };
}

// ─── tryOwlPayV2 — Harbor off-ramp v2 (SRL/LLC) ─────────────────────────────

/**
 * Flujo off-ramp OwlPay Harbor v2: USDC → fiat local.
 *
 *   A. Pre-check liquidez USDC en wallet Stellar SRL.
 *   B. createQuote  → POST /v2/transfers/quotes
 *   C. getRequirementsSchema → GET /v2/transfers/quotes/:id/requirements
 *   D. buildOwlPayBeneficiary → mapea beneficiaryDetails al schema
 *   E. createOwlPayTransfer  → POST /v2/transfers (obtiene instruction_address)
 *   F. sendUSDCToHarbor (si OWLPAY_USDC_SEND_ENABLED=true) o alerta al admin.
 *
 * Estados que puede dejar en la transacción:
 *   pending_funding            — liquidez USDC insuficiente en wallet Stellar
 *   payout_pending_usdc_send   — Harbor transfer creado, envío USDC en espera
 *   payout_sent                — USDC enviado, Harbor procesando
 *
 * @param {object} transaction  — Documento Mongoose
 * @param {object} corridor     — TransactionConfig lean
 * @param {number} netAmountUSD — Monto en USD/USDC a enviar (ya convertido de BOB si aplica)
 */
/**
 * Genera el Comprobante Oficial de Transacción (Bolivia SRL) para un payout Harbor
 * completado y lo sube a storage. FIRE-AND-FORGET: nunca lanza ni bloquea el flujo.
 * Solo aplica a legalEntity SRL (exigencia ASFI: comprobante por transacción).
 */
async function generateSrlComprobante(transaction) {
  try {
    if (transaction.legalEntity !== 'SRL') return;
    if (transaction.boliviaCompliance?.comprobanteUrl) return; // ya generado (idempotente)

    const user = await User.findById(transaction.userId).lean();
    if (!user) return;

    const numeroComprobante = await generarNumeroCorrelativo('BOL');
    const digital          = transaction.digitalAssetAmount ?? 0;
    const comisionServicio = transaction.fees?.totalDeducted ?? 0;
    // Tasa BOB/USDC: usar conversionRate.rate si está guardado (más preciso);
    // si no, calcular desde netBOB (excluye fees) para no inflar la tasa mostrada.
    const netBOB = transaction.originalAmount
      - (transaction.fees?.totalDeducted   ?? 0)
      - (transaction.fees?.profitRetention ?? 0);
    const tipoCambio = transaction.conversionRate?.rate
      ?? (digital > 0 && netBOB > 0
        ? Number((netBOB / digital).toFixed(6))
        : 0);

    const dto = {
      numeroComprobante,
      nombreCliente:      user.companyName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
      nitOci:             user.taxId
        ?? (user.identityDocument?.number && !/pending|verification/i.test(user.identityDocument.number)
            ? user.identityDocument.number : null)
        ?? 'NO REGISTRADO',
      tipoDocumento:      user.taxId ? 'NIT' : 'CI',
      codigoClienteAlyto: user._id.toString(),
      fechaHora:          (transaction.createdAt ?? new Date()).toISOString(),
      tipoOperacion:      'Liquidación de Activo Digital',
      txid:               transaction.stellarTxId ?? 'PENDIENTE',
      montoFiatRecibido:  transaction.originalAmount,
      tipoDeCambio:       tipoCambio,
      montoActivoEntregado: digital,
      comisionServicio,
      totalLiquidado:     transaction.originalAmount - comisionServicio,
    };

    const { buffer, filename } = await generateOfficialReceipt(dto);
    const s3Key = `pdfs/bolivia/${numeroComprobante}_${filename}`;
    const { url, key } = await uploadBuffer(buffer, s3Key, { contentType: 'application/pdf' });

    // Presigned URL de 6 días guardada en BD (max SigV4 = 7 días)
    const resolvedUrl = await getDownloadUrl(key ?? s3Key, 6 * 24 * 3600).catch(() => null);
    const storedUrl   = resolvedUrl ?? url;

    await Transaction.findByIdAndUpdate(transaction._id, {
      $set: {
        'boliviaCompliance.comprobanteUrl':        storedUrl,
        'boliviaCompliance.numeroComprobante':     numeroComprobante,
        'boliviaCompliance.comprobanteGeneratedAt': new Date(),
      },
    });
    console.info('[Comprobante SRL] Generado (Harbor payout):', {
      transactionId: transaction.alytoTransactionId, numeroComprobante,
    });
  } catch (err) {
    console.error('[Comprobante SRL] Error generando comprobante (no bloquea):', {
      transactionId: transaction?.alytoTransactionId, error: err.message,
    });
  }
}

/**
 * Genera el documento de compliance correcto al COMPLETAR una liquidación SRL:
 *   - cuenta business (accountType business + businessProfileId) → Factura B2B
 *     (autoGenerateBusinessInvoice — persiste verificationHash para el QR)
 *   - retail → Comprobante Oficial de Transacción (generateSrlComprobante)
 *
 * Fire-and-forget — nunca bloquea ni lanza. Debe llamarse en TODAS las rutas
 * de completado (Vita sandbox, Vita IPN real, Harbor IPN).
 *
 * @param {object} transaction — Documento Transaction (mongoose, no lean)
 */
export async function generateComprobanteOnCompletion(transaction) {
  try {
    if (transaction.legalEntity !== 'SRL') return;
    const user = await User.findById(transaction.userId).lean();
    if (!user) return;

    if (user.accountType === 'business' && user.businessProfileId) {
      // Import dinámico para evitar dependencia circular con businessInvoiceController.
      const { autoGenerateBusinessInvoice } = await import('./businessInvoiceController.js');
      await autoGenerateBusinessInvoice(transaction, user._id);
    } else {
      await generateSrlComprobante(transaction);
    }
  } catch (err) {
    console.error('[Comprobante] Error en generateComprobanteOnCompletion (no bloquea):', {
      transactionId: transaction?.alytoTransactionId, error: err.message,
    });
  }
}

export async function tryOwlPayV2(transaction, corridor, netAmountUSD) {
  const entity = transaction.legalEntity;

  // Guard idempotencia: si ya tiene transferId Y el USDC ya fue enviado → abortar.
  // Si el USDC NO fue enviado (stellarTxHash vacío), permitir reintento del envío Stellar
  // reutilizando el transfer existente (memo idempotente vía _findTransactionByMemo).
  if (transaction.harborTransfer?.transferId) {
    const usdcAlreadySent = !!transaction.stellarTxHash;
    if (usdcAlreadySent) {
      console.warn('[tryOwlPayV2] Transfer ya procesado (USDC ya enviado) — abortando:', {
        transactionId:      transaction.alytoTransactionId,
        existingTransferId: transaction.harborTransfer.transferId,
      });
      return;
    }

    // Transfer creado pero USDC no enviado — reenviar solamente (idempotente via memo)
    console.info('[tryOwlPayV2] Reintentando USDC send para transfer existente:', {
      transactionId: transaction.alytoTransactionId,
      transferId:    transaction.harborTransfer.transferId,
    });

    const retryAddress = transaction.harborTransfer.instructionAddress;
    const retryMemo    = transaction.harborTransfer.instructionMemo;
    const retryAmount  = transaction.harborTransfer.usdcAmountRequired ?? netAmountUSD;

    if (!retryAddress || !retryMemo) {
      throw new Error(
        `[Harbor] Retry USDC: faltan instruction_address/memo en harborTransfer ` +
        `(tx: ${transaction.alytoTransactionId})`,
      );
    }

    const usdcSendEnabled = ['true', '1'].includes(process.env.OWLPAY_USDC_SEND_ENABLED ?? '');
    if (!usdcSendEnabled) {
      console.warn('[tryOwlPayV2] Retry USDC: OWLPAY_USDC_SEND_ENABLED=0 — sin acción');
      return { provider: 'owlpay', status: 'payout_pending_usdc_send', transferId: transaction.harborTransfer.transferId };
    }

    const stellarResult = await sendUSDCToHarbor({
      destinationAddress: retryAddress,
      amount:             retryAmount,
      memo:               retryMemo,
      transactionId:      transaction.alytoTransactionId,
    });

    transaction.stellarTxHash = stellarResult.hash;
    transaction.status        = 'payout_sent';
    transaction.statusReason  = null;
    transaction.ipnLog.push({
      provider:   'stellar',
      eventType:  'usdc_sent_to_harbor',
      status:     'payout_sent',
      rawPayload: {
        hash:     stellarResult.hash,
        ledger:   stellarResult.ledger,
        amount:   retryAmount,
        memo:     retryMemo,
        existing: stellarResult.existing ?? false,
        retry:    true,
      },
      receivedAt: new Date(),
    });
    await transaction.save();

    console.log('[OwlPay] USDC sent (retry):', stellarResult.hash);
    return {
      provider:    'owlpay',
      status:      'payout_sent',
      transferId:  transaction.harborTransfer.transferId,
      stellarHash: stellarResult.hash,
    };
  }

  // ── STEP 0: Validar que el NETO USDC esté en el rango que Harbor acepta ───
  // Harbor rechaza source.amount fuera de [30, 9998] USD. Validar ANTES de crear
  // el quote/transfer evita recibir el payin BOB y luego no poder liquidar.
  if (netAmountUSD < HARBOR_MIN_USD || netAmountUSD > HARBOR_MAX_USD) {
    const reason = `Neto USDC ${netAmountUSD.toFixed(2)} fuera del rango Harbor [${HARBOR_MIN_USD}, ${HARBOR_MAX_USD}]`;
    console.error('[tryOwlPayV2] Monto fuera de rango Harbor:', {
      transactionId: transaction.alytoTransactionId, netAmountUSD, HARBOR_MIN_USD, HARBOR_MAX_USD,
    });
    transaction.status       = 'failed';
    transaction.statusReason = reason;
    await transaction.save();
    broadcastToAdmins('tx_failed', { transactionId: transaction.alytoTransactionId, reason });
    return { provider: 'owlpay', status: 'failed', reason };
  }

  // ── STEP A: Pre-check liquidez USDC (on-chain manda) ────────────────────────
  // Fuente de verdad = saldo on-chain real en Stellar menos los payouts en vuelo
  // (USDC ya comprometido). El saldo on-chain ES el colateral real; el FundingRecord
  // es un libro de trazabilidad de origen, NO una tranca de pago. Esta fórmula es
  // idéntica a la del panel de previsión (getUSDCForecast → availableNow), de modo
  // que lo que el admin ve disponible es exactamente lo que el motor autoriza.
  const [onChainBalance, inflightAgg] = await Promise.all([
    getStellarUSDCBalance(process.env.STELLAR_SRL_PUBLIC_KEY),
    Transaction.aggregate([
      {
        $match: {
          legalEntity: entity,
          status: { $in: ['payout_pending_usdc_send', 'payout_in_transit', 'payout_sent'] },
        },
      },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$digitalAssetAmount', 0] } } } },
    ]),
  ]);
  const inflight    = inflightAgg[0]?.total ?? 0;
  const usdcBalance = Math.max(0, onChainBalance - inflight);
  const needed      = netAmountUSD + 1; // 1 USDC de reserva para fees de red

  if (usdcBalance < needed) {
    console.warn('[OwlPay] Insufficient USDC balance:',
      { usdcBalance, needed, tx: transaction.alytoTransactionId });

    transaction.status       = 'pending_funding';
    transaction.statusReason =
      `Insufficient USDC: has ${usdcBalance}, needs ${needed}`;
    await transaction.save();

    broadcastToAdmins('tx_manual_payout', {
      transactionId: transaction.alytoTransactionId,
      reason:        'pending_funding_usdc',
      required:      needed,
      available:     usdcBalance,
    });

    try {
      await sendRawEmail(
        process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
        `⚠️ USDC Liquidez Insuficiente — ${transaction.alytoTransactionId}`,
        `<p>Transaction <strong>${transaction.alytoTransactionId}</strong> requiere ` +
        `<strong>${needed.toFixed(2)} USDC</strong>, pero hay ` +
        `<strong>${usdcBalance.toFixed(2)} USDC</strong> disponibles.</p>` +
        `<p>Fondea la wallet Stellar SRL y vuelve a ejecutar el payout.</p>`,
      );
    } catch (e) { console.error('[tryOwlPayV2] Error email admin (pending_funding):', e.message); }

    return { provider: 'owlpay', status: 'pending_funding' };
  }

  // ── STEP B: Quote ─────────────────────────────────────────────────────────
  // Reusar providerQuoteId del initCrossBorderPayment si aún está vigente (+5s
  // de margen). Para payin manual SRL el admin tarda minutos/horas → siempre
  // expira y se crea un quote nuevo. Reuso solo ocurre si la confirmación fue
  // ultra-rápida (< ~55 s desde la creación de la tx).
  // Per MSA firmado 30/03/2026: hay UN solo Customer en Harbor (AV Finance LLC).
  // SRL/SpA son entidades operativas internas; el on_behalf_of es siempre el
  // UUID del LLC. legalEntity se mantiene solo para trazabilidad interna.
  const legalEntity  = (transaction.legalEntity ?? 'SRL').toUpperCase();
  const customerUuid = getCustomerUuid(transaction.legalEntity);

  if (!customerUuid) {
    const err = new Error(
      '[OwlPay] Customer UUID no configurado. Variable esperada: ' +
      'OWLPAY_CUSTOMER_UUID (o legacy OWLPAY_CUSTOMER_UUID_LLC / _SRL)',
    );
    console.error('[tryOwlPayV2]', err.message, {
      transactionId: transaction.alytoTransactionId,
      legalEntity,
    });
    throw err;
  }

  console.log('[tryOwlPayV2] Customer UUID resuelto:', {
    legalEntity,                             // entidad interna (SRL/SpA/LLC)
    uuid: customerUuid.slice(0, 16) + '...', // siempre el UUID de LLC en Harbor
  });

  const hasValidProviderQuote = Boolean(
    transaction.providerQuoteId &&
    transaction.rateExpiresAt &&
    new Date(transaction.rateExpiresAt) > new Date(Date.now() + 5_000),
  );

  let quoteId;
  let expiresAt;
  let quoteData = null;

  if (hasValidProviderQuote) {
    console.log('[tryOwlPayV2] Reutilizando providerQuoteId vigente:', transaction.providerQuoteId);
    quoteId   = transaction.providerQuoteId;
    expiresAt = transaction.rateExpiresAt;
  } else {
    if (transaction.providerQuoteId) {
      console.warn('[tryOwlPayV2] providerQuoteId expirado — creando nuevo quote. Posible diferencia de monto.');
    }

    const quote = await createQuote({
      source_amount:              netAmountUSD,
      destination_country:        resolveHarborCountry(corridor.destinationCountry),
      destination_currency:       corridor.destinationCurrency,
      destination_payment_method: 'bank_transfer',
      source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      customer_uuid:              customerUuid,
      customer_type:              'business',
    });

    // Harbor returns `{ data: [...] }` con un quote por método de pago disponible
    // (ej. CN/CNY: CIPS + WIRE). Si la transacción tiene owlPayMethod definido por
    // el usuario, lo respetamos; si el método ya no está disponible al momento del
    // payout, hacemos fallback al primero y dejamos un warning en logs.
    const quotesList      = Array.isArray(quote.data)
      ? quote.data
      : (quote.data ? [quote.data] : [quote]);
    const preferredMethod = transaction.owlPayMethod ?? null;
    quoteData             = preferredMethod
      ? quotesList.find(q => q?.payment_method === preferredMethod)
      : null;

    if (!quoteData) {
      // Fallback: usa pickSupportedQuote para evitar caer en métodos broken
      // (ej. SEPA EU) cuando preferredMethod no está disponible.
      const fallback = pickSupportedQuote(quotesList, corridor.destinationCountry);
      if (preferredMethod) {
        console.warn(
          '[tryOwlPayV2] Método preferido %s no disponible para %s — fallback a %s',
          preferredMethod, corridor.corridorId,
          fallback?.payment_method ?? quotesList[0]?.payment_method,
        );
      }
      quoteData = fallback ?? quotesList[0];
    }
    if (!quoteData) {
      throw new Error('[OwlPay] No hay quotes disponibles para este corredor');
    }

    console.log(
      '[OwlPay] Método seleccionado: %s | rate: %s',
      quoteData.payment_method, quoteData.exchange_rate,
    );

    quoteId   = quoteData.id ?? quoteData.quote_id;
    expiresAt = quoteData.expires_at ?? quoteData.crypto_funds_settlement_expire_date;
  }

  if (!quoteId) throw new Error('[OwlPay] No quote_id en la respuesta de Harbor');

  transaction.payoutQuoteId       = quoteId;
  transaction.payoutQuoteExpiresAt = new Date(expiresAt ?? Date.now() + 5 * 60 * 1000);
  await transaction.save();

  console.log('[OwlPay] Quote created:', quoteId);

  // ── DEBUG: Para US, loguear requirements schema para auditar enum state_province ──
  if ((corridor.destinationCountry ?? '').toUpperCase() === 'US') {
    getRequirementsSchema(quoteId, 'US')
      .then(s => {
        const schemaStr = JSON.stringify(s?.schema ?? s?.raw ?? s);
        console.log('[Harbor DEBUG US requirements]', schemaStr.slice(0, 2000));
      })
      .catch(e => console.warn('[Harbor DEBUG US requirements] fetch falló:', e.message));
  }

  // ── STEP C: Build beneficiary from stored form values ────────────────────
  // Schema fetching removed — form fields are defined statically in owlPayForms.js.
  // buildOwlPayBeneficiary reads from transaction.beneficiary.dynamicFields.
  const rawBeneficiary = transaction.beneficiaryDetails ?? transaction.beneficiary ?? {};
  const selectedMethod = quoteData?.payment_method ?? transaction.owlPayMethod ?? null;
  const {
    beneficiary_info,
    payout_instrument,
    transfer_purpose: beneficiaryPurpose,
    is_self_transfer: isSelfTransfer,
  } = buildOwlPayBeneficiary(rawBeneficiary, null, corridor.destinationCountry, selectedMethod);

  // ── STEP D: Create transfer ───────────────────────────────────────────────
  const sourceAddress = process.env.STELLAR_SRL_PUBLIC_KEY ?? '';

  const transfer = await createOwlPayTransfer({
    quote_id:                  quoteId,
    on_behalf_of:              customerUuid,
    application_transfer_uuid: transaction.alytoTransactionId,
    source_address:            sourceAddress,
    beneficiary_info,
    payout_instrument,
    transfer_purpose:          beneficiaryPurpose ?? transaction.transferPurpose ?? 'FAMILY_MAINTENANCE',
    is_self_transfer:          isSelfTransfer,
  });

  const transferData = transfer.data ?? transfer;
  const transferId   = transferData.uuid ?? transferData.id ?? transferData.transfer_id;
  const instructions = transferData.transfer_instructions
    ?? transferData.source?.transfer_instructions ?? {};
  const instructionAddress = instructions.instruction_address ?? instructions.address ?? null;
  const instructionMemo    = instructions.instruction_memo    ?? instructions.memo    ?? null;

  transaction.payoutReference = transferId;
  transaction.harborTransfer  = {
    transferId,
    instructionAddress,
    instructionMemo,
    instructionChain: instructions.chain ?? process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
    usdcAmountRequired: netAmountUSD,
    expiresAt:          transferData.crypto_funds_settlement_expire_date ?? expiresAt ?? null,
    quoteId,
    status: transferData.status ?? 'pending',
  };
  transaction.status        = 'payout_pending_usdc_send';
  transaction.statusReason  = null;
  transaction.providersUsed = [...(transaction.providersUsed ?? []), 'payout:owlPay-v2'];

  // ── Actualizar destinationAmount al monto real del transfer Harbor ────────
  // El frontend mostró un estimado (extrapolación Vita o quote de GET /quote).
  // Harbor confirma el monto exacto al crear el transfer. Se sobrescribe aquí
  // para que el historial de la tx refleje lo que el beneficiario recibirá.
  const harborDestAmount = parseFloat(
    transferData.destination?.amount ?? transferData.destination_amount ?? 0,
  );
  if (harborDestAmount > 0) {
    const previousAmount = transaction.destinationAmount ?? 0;
    const difference     = harborDestAmount - previousAmount;
    const diffPercent    = previousAmount > 0
      ? ((difference / previousAmount) * 100).toFixed(2)
      : '0.00';

    const previousRate    = transaction.exchangeRate ?? null;
    const originalAmount  = transaction.originalAmount ?? 0;
    const newExchangeRate = originalAmount > 0
      ? parseFloat((harborDestAmount / originalAmount).toFixed(6))
      : null;

    console.log('[tryOwlPayV2] Actualizando montos al rate real Harbor:', {
      transactionId: transaction.alytoTransactionId,
      previousAmount,
      realAmount:    harborDestAmount,
      previousRate:  previousRate?.toFixed(6),
      newRate:       newExchangeRate?.toFixed(6),
      difference:    difference.toFixed(2),
      diffPercent:   `${diffPercent}%`,
    });

    const harborPaymentMethod = transferData.destination?.payment_method
      ?? transferData.payment_method
      ?? transaction.owlPayMethod
      ?? 'unknown';

    transaction.destinationAmount = harborDestAmount;
    if (newExchangeRate !== null) transaction.exchangeRate = newExchangeRate;
    transaction.rateConfidence    = 'exact';
    transaction.rateSource        = `harbor:${harborPaymentMethod}`;
    transaction.rateHistory       = transaction.rateHistory ?? [];
    transaction.rateHistory.push({
      at:             new Date(),
      previousAmount,
      newAmount:      harborDestAmount,
      previousRate,
      newRate:        newExchangeRate,
      difference,
      diffPercent,
      reason:         'harbor_transfer_locked',
    });

    // Notificar al usuario si el ajuste supera 0.5% (alineado con banner FE
    // de rateHistory en TransactionDetail.jsx). Cambios menores son ruido.
    if (Math.abs(difference) >= 0.005 * previousAmount && previousAmount > 0) {
      const user = await User.findById(transaction.userId).select('email firstName').lean();
      if (user?.email) {
        // rateUpdated devuelve [email, templateId, dynamicData] si hay template,
        // o [email, subject, html] como fallback — sendRawEmail maneja el segundo.
        const useTemplate   = !!process.env.SENDGRID_TEMPLATE_REQUOTE_NOTIFICATION;
        const rateEmailArgs = EMAILS.rateUpdated(user, transaction, {
          previousAmount,
          newAmount:  harborDestAmount,
          difference,
          diffPercent,
        });
        Promise.resolve()
          .then(() => (useTemplate ? sendEmail : sendRawEmail)(...rateEmailArgs))
          .catch(err => console.error('[tryOwlPayV2] Error enviando email rateUpdated:', err.message));
      }
    }
  }

  transaction.ipnLog.push({
    provider:   'owlPay',
    eventType:  'owlpay_transfer_created',
    status:     'payout_pending_usdc_send',
    rawPayload: {
      transfer_id:         transferId,
      instruction_address: instructionAddress,
      instruction_memo:    instructionMemo,
      expires_at:          transaction.harborTransfer.expiresAt,
      destination_amount:  transferData.destination?.amount ?? null,
    },
    receivedAt: new Date(),
  });
  await transaction.save();

  console.log('[OwlPay] Transfer created:', transferId, 'memo:', instructionMemo);

  // ── STEP F: Send USDC via Stellar ─────────────────────────────────────────
  const usdcSendEnabled = ['true', '1'].includes(process.env.OWLPAY_USDC_SEND_ENABLED ?? '');

  if (!usdcSendEnabled) {
    transaction.statusReason =
      `OWLPAY_USDC_SEND_ENABLED=0 — admin must send ` +
      `${netAmountUSD} USDC to ${instructionAddress} ` +
      `with memo: ${instructionMemo ?? 'N/A'}`;
    await transaction.save();

    broadcastToAdmins('tx_manual_payout', {
      transactionId:       transaction.alytoTransactionId,
      reason:              'awaiting_manual_usdc_send',
      instruction_address: instructionAddress,
      instruction_memo:    instructionMemo,
      amount_usdc:         netAmountUSD,
      transfer_id:         transferId,
    });

    try {
      await sendRawEmail(...EMAILS.adminUSDCSendRequired({
        transaction,
        transfer: transaction.harborTransfer,
        quote:    quoteData,
      }));
    } catch (e) { console.error('[tryOwlPayV2] Error email admin (manual send):', e.message); }

    return {
      provider:   'owlpay',
      status:     'payout_pending_usdc_send',
      transferId,
    };
  }

  // Auto-send USDC via Stellar
  // Harbor provee un memo numérico único por transfer (formato: 14 dígitos en sandbox).
  // Sin memo válido Harbor no puede asociar el USDC al transfer — es un error fatal.
  if (!instructionMemo) {
    throw new Error(
      `[Harbor] No se recibió instruction_memo para transfer ${transferId}. ` +
      `No es posible enviar USDC sin memo. Contactar OwlPay soporte.`,
    );
  }
  const stellarResult  = await sendUSDCToHarbor({
    destinationAddress: instructionAddress,
    amount:             netAmountUSD,
    memo:               instructionMemo,
    transactionId:      transaction.alytoTransactionId,
  });

  transaction.stellarTxHash = stellarResult.hash;
  transaction.status        = 'payout_sent';
  transaction.statusReason  = null;
  transaction.ipnLog.push({
    provider:   'stellar',
    eventType:  'usdc_sent_to_harbor',
    status:     'payout_sent',
    rawPayload: {
      hash:     stellarResult.hash,
      ledger:   stellarResult.ledger,
      amount:   netAmountUSD,
      memo:     instructionMemo,
      existing: stellarResult.existing ?? false,
    },
    receivedAt: new Date(),
  });
  await transaction.save();

  console.log('[OwlPay] USDC sent:', stellarResult.hash);
  return {
    provider:     'owlpay',
    status:       'payout_sent',
    transferId,
    stellarHash:  stellarResult.hash,
  };
}

// ─── dispatchPayout ───────────────────────────────────────────────────────────

/**
 * Dispara el payout al beneficiario después de que el payin fue confirmado.
 * Se invoca desde ambos handlers (vita y fintoc) cuando el payin queda confirmado.
 *
 * Proveedores soportados (payoutMethod en TransactionConfig):
 *   vitaWallet    → Vita withdrawal API (CLP/USD → banco LatAm)
 *   owlPay        → Harbor/OwlPay disbursement (USD → banco LatAm)
 *   anchorBolivia → Payout manual — notifica al admin vía email
 *
 * Fallback: si el proveedor principal falla, intenta corridor.fallbackPayoutMethod.
 * En sandbox (VITA_ENVIRONMENT=sandbox): auto-completa sin esperar IPN.
 *
 * @param {object} transaction — Documento Mongoose con .save() disponible
 */
export async function dispatchPayout(transaction) {
  // Atomic gate: solo un caller puede avanzar de payin_confirmed → processing.
  // Reemplaza el check en-memoria que era vulnerable a race conditions cuando
  // dos IPNs concurrentes llegaban al mismo tiempo.
  const locked = await Transaction.findOneAndUpdate(
    { _id: transaction._id, status: 'payin_confirmed' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  );
  if (!locked) {
    console.warn('[dispatchPayout] Bloqueado — transacción no está en payin_confirmed (ya procesada o en status diferente):', {
      transactionId: transaction.alytoTransactionId,
      status: transaction.status,
    });
    return;
  }
  // Usar el documento fresco con status actualizado
  transaction = locked;

  // ── Resiliencia: el gate ya movió payin_confirmed → processing. Cualquier
  // excepción no controlada en el cuerpo NO debe dejar la tx atascada en
  // 'processing' (el job reconcile solo cubre Harbor payout_sent). Se captura,
  // se marca 'failed' (retryable) con la causa persistida en failureReason +
  // ipnLog, y se notifica al usuario/admin. Ver dispatchPayout catch al final.
  try {
  console.log('[dispatchPayout] Iniciando para:', transaction.alytoTransactionId,
    '| status:', transaction.status,
    '| NODE_ENV:', process.env.NODE_ENV);

  // ── Obtener configuración del corredor ────────────────────────────────────
  let corridor;
  try {
    corridor = await TransactionConfig.findById(transaction.corridorId).lean();
  } catch (err) {
    console.error('[Alyto Payout] Error obteniendo TransactionConfig:', {
      corridorId:    transaction.corridorId?.toString(),
      transactionId: transaction.alytoTransactionId,
      error:         err.message,
    });
  }

  if (!corridor) {
    // Error de configuración del sistema, no del pago — el payin fue confirmado.
    // No marcar como 'failed' para no confundir al usuario; dejar en payin_confirmed
    // para intervención manual por el equipo de operaciones.
    console.error('[Alyto Payout] Corredor no encontrado — payout pendiente de intervención manual.', {
      corridorId:    transaction.corridorId?.toString(),
      transactionId: transaction.alytoTransactionId,
    });
    transaction.ipnLog.push({
      provider:   'manual',
      eventType:  'payout.corridor_missing',
      status:     'pending',
      rawPayload: {
        note:       'Corredor no encontrado al intentar ejecutar el payout.',
        corridorId: transaction.corridorId?.toString(),
      },
    });
    await transaction.save().catch(() => {});

    // Alertar al admin — el payin fue confirmado pero no podemos ejecutar el payout
    sendRawEmail(
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      `⚠️ Payout bloqueado — corredor no encontrado [${transaction.alytoTransactionId}]`,
      `<p>El payin fue confirmado pero el corredor <strong>${transaction.corridorId?.toString()}</strong> ` +
      `no existe en TransactionConfig.</p>` +
      `<p>Transacción: <strong>${transaction.alytoTransactionId}</strong> | ` +
      `Entidad: ${transaction.legalEntity} | Monto: ${transaction.originalAmount} ${transaction.originCurrency}</p>` +
      `<p>Requiere intervención manual inmediata.</p>`,
    ).catch(e => console.error('[dispatchPayout] Error email admin corridor_missing:', e.message));

    return;
  }

  const payoutMethod = corridor.payoutMethod;
  console.info('[Alyto Payout] Despachando payout.', {
    transactionId:      transaction.alytoTransactionId,
    payoutMethod,
    fallbackMethod:     corridor.fallbackPayoutMethod ?? 'none',
    destinationCountry: transaction.destinationCountry,
    originCurrency:     transaction.originCurrency,
  });

  // ── Ruta v2: OwlPay Harbor off-ramp (SRL/LLC) ─────────────────────────────
  if (payoutMethod === 'owlPay' && ['SRL', 'LLC'].includes(transaction.legalEntity)) {
    // Compute net USD amount before calling tryOwlPayV2
    const _netAmountNative = resolveNetAmountForPayout(transaction);
    let _netAmountUSD = _netAmountNative;

    if (corridor.originCurrency === 'BOB') {
      let usdcAmount, bobPerUsdc;
      if (transaction.digitalAssetAmount > 0) {
        usdcAmount = transaction.digitalAssetAmount;
        // Tasa con colchón (fuente única) para el registro de auditoría.
        bobPerUsdc = (await resolveQuoteRate(corridor)).bobPerUsdc;
      } else {
        const convResult = await convertBobToUsdc(_netAmountNative, corridor);
        usdcAmount = convResult.usdcAmount;
        bobPerUsdc = convResult.bobPerUsdc;
      }

      // ── Guard de drift cambiario (Harbor — incluye EEUU/USD) ─────────────────
      // El payin SRL es manual y se confirma horas después de cotizar. Si el BOB
      // se depreció más allá del colchón ya incluido en la tasa congelada, NO
      // fondeamos a ciegas (entregaríamos por debajo de costo): pausamos en
      // 'pending_fx_review' y avisamos al admin. Fail-open si no hay tasa/mercado.
      const lockedBobPerUsdc = usdcAmount > 0
        ? Math.round((_netAmountNative / usdcAmount) * 1e6) / 1e6
        : bobPerUsdc;
      const drift = await checkFxDrift({
        lockedBobPerUsdc,
        manualRateActive: corridor.manualExchangeRate > 0,
      });
      if (drift.drifted) {
        transaction.status        = 'pending_fx_review';
        transaction.statusReason  = 'fx_drift_guard';
        transaction.failureReason =
          `Drift cambiario ${drift.driftPct}% supera umbral ${drift.thresholdPct}% ` +
          `(congelada ${drift.lockedBobPerUsdc} → mercado ${drift.marketNow} BOB/USDC)`;
        await transaction.save().catch(() => {});
        console.warn('[dispatchPayout] FX guard activado (owlPay) — payout pausado:', {
          transactionId: transaction.alytoTransactionId, ...drift,
        });
        import('../services/email.js')
          .then(m => m.notifyAdminFxGuard(transaction, drift))
          .catch(() => {});
        return;
      }

      transaction.conversionRate       = { fromCurrency: 'BOB', toCurrency: 'USDC', rate: bobPerUsdc, convertedAmount: usdcAmount };
      transaction.digitalAsset         = 'USDC';
      transaction.digitalAssetAmount   = usdcAmount;
      await transaction.save().catch(err =>
        console.error('[dispatchPayout] Error guardando conversionRate/USDC (owlPay):', err.message),
      );
      _netAmountUSD = usdcAmount;
    }

    try {
      await tryOwlPayV2(transaction, corridor, _netAmountUSD);
    } catch (err) {
      // Mapear el error de Harbor a mensajes admin + usuario accionables
      const mapped = mapHarborError(err);

      console.error('[Alyto Payout] tryOwlPayV2 falló:', {
        transactionId: transaction.alytoTransactionId,
        category:      mapped.category,
        adminMessage:  mapped.adminMessage,
        userMessage:   mapped.userMessage,
        stellarTxCode: err.stellarTxCode ?? null,
        stellarOpCode: err.stellarOpCode ?? null,
      });
      Sentry.captureException(err, {
        tags:  { component: 'dispatchPayout', provider: 'owlPay-v2', category: mapped.category },
        extra: {
          transactionId: transaction.alytoTransactionId,
          stellarTxCode: err.stellarTxCode ?? null,
          stellarOpCode: err.stellarOpCode ?? null,
          isPermanent:   err.isPermanent   ?? false,
          harborDetails: err.details ?? err.data?.details,
        },
      });

      transaction.status            = 'failed';
      transaction.failureReason     = mapped.adminMessage;                  // técnico, ledger admin
      transaction.userFailureReason = mapped.userMessage;                   // claro, app usuario
      transaction.userFailureAction = mapped.userAction;                    // qué hacer
      transaction.failureCategory   = mapped.category;                      // para analytics/UI
      transaction.failureRetryable  = mapped.retryable;                     // FE muestra "Reintentar"
      await appendIpnLog(transaction, 'owlpay_v2_failed', 'owlPay', 'failed', {
        category: mapped.category, error: err.message, details: err.details,
      });

      try {
        await notify(transaction.userId,
          NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency));
      } catch (e) { console.error('[Email] Error push failed (owlPay v2):', e.message); }
      try {
        const user = await User.findById(transaction.userId).lean();
        if (user?.email) await sendEmail(...EMAILS.paymentFailed(user, transaction));
      } catch (e) { console.error('[Email] Error failed (owlPay v2):', e.message); }
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── vitaWallet | owlPay: ambos proveedores bancarios con lógica común ────
  // ─────────────────────────────────────────────────────────────────────────
  if (payoutMethod === 'vitaWallet' || payoutMethod === 'owlPay') {
    const ben              = transaction.beneficiary ?? {};
    const netAmountNative  = resolveNetAmountForPayout(transaction);

    // ── Conversión BOB → USDC para corredores SRL Bolivia ───────────────────
    // Vita y OwlPay operan en USD (USDC ≈ 1:1 USD). Tasa fijada por admin
    // en corridor.manualExchangeRate vía PATCH /admin/corridors/:id/rate.
    // USDC es el activo de tránsito en Stellar — se registra en digitalAsset.
    let payoutAmountUSD = netAmountNative;
    let vitaCurrency    = (transaction.originCurrency ?? 'clp').toLowerCase();

    if (corridor.originCurrency === 'BOB') {
      // Si el frontend envió usdcTransitAmount al crear la transacción, ya está almacenado
      // en transaction.digitalAssetAmount. Usarlo directamente para que payout use
      // el MISMO monto USDC que se cotizó al usuario — sin recalcular.
      let usdcAmount, bobPerUsdc;
      if (transaction.digitalAssetAmount > 0) {
        usdcAmount  = transaction.digitalAssetAmount;
        // Tasa con colchón (fuente única) para el registro de auditoría.
        bobPerUsdc  = (await resolveQuoteRate(corridor)).bobPerUsdc;
        console.log('[dispatchPayout] Usando usdcTransitAmount de la cotización:', {
          netBOB: netAmountNative, bobPerUsdc, usdcAmount,
        });
      } else {
        // Fallback: recalcular (cotización sin usdcTransitAmount — transacciones antiguas)
        const convResult = await convertBobToUsdc(netAmountNative, corridor);
        usdcAmount = convResult.usdcAmount;
        bobPerUsdc = convResult.bobPerUsdc;
        console.log('[dispatchPayout] Conversión BOB→USDC recalculada:', {
          netBOB: netAmountNative, bobPerUsdc, usdcAmount,
        });
      }

      // ── Guard de drift cambiario ────────────────────────────────────────────
      // El payin SRL es manual y se confirma horas después de cotizar. Si el BOB
      // se depreció más allá del colchón ya incluido en la tasa congelada, NO
      // fondeamos a ciegas (entregaríamos por debajo de costo): pausamos en
      // 'pending_fx_review' y avisamos al admin para decidir (re-cotizar o ejecutar).
      // Fail-open: si no hay tasa congelada o no se lee el mercado, no bloquea.
      const lockedBobPerUsdc = usdcAmount > 0
        ? Math.round((netAmountNative / usdcAmount) * 1e6) / 1e6
        : bobPerUsdc;
      const drift = await checkFxDrift({
        lockedBobPerUsdc,
        manualRateActive: corridor.manualExchangeRate > 0,
      });
      if (drift.drifted) {
        transaction.status        = 'pending_fx_review';
        transaction.statusReason  = 'fx_drift_guard';
        transaction.failureReason =
          `Drift cambiario ${drift.driftPct}% supera umbral ${drift.thresholdPct}% ` +
          `(congelada ${drift.lockedBobPerUsdc} → mercado ${drift.marketNow} BOB/USDC)`;
        await transaction.save().catch(() => {});
        console.warn('[dispatchPayout] FX guard activado — payout pausado:', {
          transactionId: transaction.alytoTransactionId, ...drift,
        });
        // Fire-and-forget (no bloquea el flujo) — patrón email del módulo.
        import('../services/email.js')
          .then(m => m.notifyAdminFxGuard(transaction, drift))
          .catch(() => {});
        return;
      }

      // Registrar conversión + activo Stellar en la transacción
      transaction.conversionRate = {
        fromCurrency:    'BOB',
        toCurrency:      'USDC',
        rate:            bobPerUsdc,
        convertedAmount: usdcAmount,
      };
      transaction.digitalAsset       = 'USDC';
      transaction.digitalAssetAmount = usdcAmount;

      await transaction.save().catch(err =>
        console.error('[dispatchPayout] Error guardando conversionRate/USDC:', err.message),
      );

      payoutAmountUSD = usdcAmount;
      vitaCurrency    = 'usd';
    }

    // ── Pre-cargar precios Vita (requerido por tryProvider) ────────────────────
    // Ya NO recalculamos destinationAmount aquí. Per spec v1.0 §4.2 the quote
    // amounts locked at Transaction.create are final; any live-rate drift is
    // absorbed by Alyto (no post-execution user adjustment).
    // getPrices() solo se necesita para que Vita procese la transacción.
    let sharedLivePrices = null;
    if (payoutMethod === 'vitaWallet') {
      try {
        sharedLivePrices = await getPrices();
        console.log('[dispatchPayout] Precios Vita cargados para tryProvider. destinationAmount del quote preservado:', {
          transactionId: transaction.alytoTransactionId,
          destinationAmount: transaction.destinationAmount,
          payoutAmountUSD, vitaCurrency,
        });
      } catch (priceErr) {
        console.warn('[dispatchPayout] No se pudo cargar precios Vita (tryProvider usará call propio):', priceErr.message);
      }
    }

    const { vitaPayload, beneficiaryFlat } = buildBeneficiaryPayloads(
      ben, payoutAmountUSD, vitaCurrency, transaction,
    );

    // ── Función interna: intentar payout con un proveedor específico ──────
    async function tryProvider(method) {
      if (method === 'vitaWallet') {
        // Vita requiere llamar GET /prices justo antes de POST /transactions
        // para bloquear el tipo de cambio. Sin este paso retorna "Los precios caducaron",
        // especialmente en corredores manuales donde el payin se confirma horas después.
        // Si ya obtuvimos los precios arriba (sharedLivePrices), se reutilizan;
        // de lo contrario se hace una llamada fresca.
        if (!sharedLivePrices) await getPrices();

        // GT, SV, ES, PL solo están disponibles vía vita_sent (no en withdrawal rails).
        // Para todos los demás destinos se sigue usando withdrawal (comportamiento original).
        const destCountry = (transaction.destinationCountry ?? '').toUpperCase();
        if (VITA_SENT_ONLY_COUNTRIES.has(destCountry)) {
          console.info(`[dispatchPayout] ${destCountry} → vita_sent routing`);
          return createVitaSentPayout(vitaPayload);
        }
        return createPayout(vitaPayload);
      }
      if (method === 'owlPay') {
        // Harbor v2 off-ramp se maneja antes de tryProvider via tryOwlPayV2.
        // Si caemos aquí, el corredor no califica para v2 (ej. entidad no es SRL/LLC)
        // o se activó como fallback — en ese caso, no hay flujo v1 disponible.
        throw new Error('OwlPay v1 disbursement descontinuado. Usa OwlPay Harbor v2 (SRL/LLC).');
      }
      throw new Error(`Proveedor desconocido: ${method}`);
    }

    // ── Intento con proveedor primario ───────────────────────────────────
    let providerUsed    = payoutMethod;
    let providerResponse;
    let primaryError;

    try {
      providerResponse = await tryProvider(payoutMethod);
    } catch (err) {
      primaryError = err;
      console.error(`[Alyto Payout] ${payoutMethod} falló:`, {
        transactionId: transaction.alytoTransactionId,
        error: err.message,
      });
      Sentry.captureException(err, {
        tags:  { component: 'dispatchPayout', provider: payoutMethod },
        extra: { transactionId: transaction.alytoTransactionId },
      });

      // ── Fallback al proveedor secundario (si configurado) ────────────
      const fallback = corridor.fallbackPayoutMethod;
      // 'owlPay' (v1) está descontinuado — ignorarlo aunque esté en la config del corredor
      const effectiveFallback = (fallback === 'owlPay') ? null : fallback;
      if (effectiveFallback && effectiveFallback !== payoutMethod) {
        console.warn(`[Alyto Payout] Intentando fallback: ${fallback}`);
        try {
          providerResponse = await tryProvider(fallback);
          providerUsed     = fallback;
          await appendIpnLog(transaction, 'payout_fallback_used', fallback, 'processing', {
            primaryProvider: payoutMethod,
            primaryError:    primaryError.message,
            fallbackProvider: fallback,
          });
        } catch (fallbackErr) {
          console.error(`[Alyto Payout] Fallback ${fallback} también falló:`, fallbackErr.message);
          transaction.status        = 'failed';
          transaction.failureReason = `Primary (${payoutMethod}): ${primaryError.message} | Fallback (${fallback}): ${fallbackErr.message}`;
          await appendIpnLog(transaction, 'payout_all_providers_failed', 'system', 'failed', {
            primaryProvider: payoutMethod, primaryError: primaryError.message,
            fallbackProvider: fallback,    fallbackError: fallbackErr.message,
          });
          try {
            await notify(transaction.userId,
              NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency));
          } catch (e) { console.error('[Email] Error push failed (all providers):', e.message); }
          try {
            const user = await User.findById(transaction.userId).lean();
            if (user?.email) {
              await sendEmail(...EMAILS.paymentFailed(user, transaction));
              console.log(`[Email] ✅ Fallido (todos los providers) → userId=${user._id}`);
            }
          } catch (e) { console.error('[Email] Error failed (all providers):', e.message); }
          return;
        }
      } else {
        // Sin fallback — marcar como fallido
        transaction.status        = 'failed';
        transaction.failureReason = `${payoutMethod} falló: ${primaryError.message}`;
        await appendIpnLog(transaction, 'payout_dispatch_failed', payoutMethod, 'failed', {
          error: primaryError.message,
        });
        try {
          await notify(transaction.userId,
            NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency));
        } catch (e) { console.error('[Email] Error push failed (no fallback):', e.message); }
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user?.email) {
            await sendEmail(...EMAILS.paymentFailed(user, transaction));
            console.log(`[Email] ✅ Fallido → userId=${user._id}`);
          }
        } catch (e) { console.error('[Email] Error failed (no fallback):', e.message); }
        return;
      }
    }

    // ── Payout aceptado por el proveedor ─────────────────────────────────
    console.log(`[dispatchPayout] ${providerUsed} aceptó payout ✅`);

    // Extraer referencia externa según proveedor
    if (providerUsed === 'vitaWallet') {
      transaction.payoutReference = providerResponse?.data?.id ?? providerResponse?.id ?? providerResponse?.transaction?.id ?? null;
    } else {
      // OwlPay
      transaction.payoutReference = providerResponse?.disbursementId ?? providerResponse?.id ?? null;
    }
    transaction.providersUsed = [...(transaction.providersUsed ?? []), `payout:${providerUsed}`];

    console.info(`[Alyto Payout] Payout creado (${providerUsed}).`, {
      transactionId:  transaction.alytoTransactionId,
      payoutReference: transaction.payoutReference,
      amount:          payoutAmountUSD,
      provider:        providerUsed,
    });

    console.log('[dispatchPayout] VITA_ENVIRONMENT check:', process.env.VITA_ENVIRONMENT);
    console.log('[dispatchPayout] ¿Es sandbox?:', process.env.VITA_ENVIRONMENT === 'sandbox');

    if (process.env.VITA_ENVIRONMENT === 'sandbox') {
      // ── SANDBOX: simulate production 2-step flow (payout_sent → completed) ────
      // Step 1: payout_sent — same as production
      console.log(`[dispatchPayout] 🧪 Sandbox (${providerUsed}) — step 1: payout_sent`);

      transaction.status = 'payout_sent';
      transaction.ipnLog.push({
        provider:   'system',
        eventType:  'payout_dispatched_sandbox',
        status:     'payout_sent',
        rawPayload: {
          message:          'Sandbox step 1/2 — simulating production payout_sent',
          vitaWithdrawalId: transaction.payoutReference,
        },
        receivedAt: new Date(),
      });
      await transaction.save();

      // Push + email: pago enviado al banco
      try {
        await notify(
          transaction.userId,
          NOTIFICATIONS.payoutSent(transaction.destinationCountry),
        );
      } catch (notifErr) {
        console.error('[Alyto Payout] Error push payout_sent (sandbox):', notifErr.message);
      }

      // SANDBOX ONLY: simulate Vita IPN delay
      const txId = transaction._id;
      setTimeout(async () => {
        try {
          console.log(`[dispatchPayout] 🧪 Sandbox step 2: completing ${transaction.alytoTransactionId}`);
          const tx = await Transaction.findById(txId);
          if (!tx || tx.status !== 'payout_sent') return;

          tx.status      = 'completed';
          tx.completedAt = new Date();
          tx.ipnLog.push({
            provider:   'system',
            eventType:  'payout_completed_sandbox',
            status:     'completed',
            rawPayload: {
              message:          'Sandbox step 2/2 — simulated Vita IPN confirmation',
              vitaWithdrawalId: tx.payoutReference,
            },
            receivedAt: new Date(),
          });
          await tx.save();

          if (tx.contactId) {
            recordSent(tx.contactId, tx.destinationAmount, tx.destinationCurrency).catch(() => {});
          }

          // Stellar audit trail (best-effort)
          try {
            const stellarTxId = await registerAuditTrail(tx);
            if (stellarTxId) {
              tx.stellarTxId = stellarTxId;
              tx.ipnLog.push({
                provider:   'stellar',
                eventType:  'stellar_audit_registered',
                status:     'completed',
                rawPayload: {
                  stellarTxId,
                  network:     process.env.STELLAR_NETWORK ?? 'testnet',
                  explorerUrl: `https://stellar.expert/explorer/testnet/tx/${stellarTxId}`,
                },
                receivedAt: new Date(),
              });
              await tx.save().catch(() => {});
            }
          } catch (stellarErr) {
            console.error('[Stellar] Error (sandbox step 2):', stellarErr.message);
          }

          // Comprobante/factura (B2B si business, retail si no) — fire-and-forget
          generateComprobanteOnCompletion(tx).catch(() => {});

          // Push: transferencia completada
          try {
            await notify(
              tx.userId,
              NOTIFICATIONS.paymentCompleted(
                tx.originalAmount, tx.originCurrency,
                tx.destinationAmount, tx.destinationCurrency,
              ),
            );
          } catch (notifErr) {
            console.error('[Alyto Payout] Error push paymentCompleted (sandbox):', notifErr.message);
          }

          // Email: pago completado
          try {
            const user = await User.findById(tx.userId).lean();
            if (user?.email) {
              await sendEmail(...EMAILS.paymentCompleted(user, tx));
              console.log(`[Email] ✅ Completado (sandbox) → userId=${user._id}`);
            }
          } catch (emailErr) {
            console.error('[Email] Error completado (sandbox):', emailErr.message);
          }

          console.log('[dispatchPayout] ✅ Sandbox step 2 complete:', tx.alytoTransactionId);
        } catch (err) {
          console.error('[dispatchPayout] Sandbox step 2 error:', err.message);
        }
      }, 4000);

      console.log('[dispatchPayout] 🧪 Sandbox step 1 done — step 2 scheduled in 4s:', transaction.alytoTransactionId);

    } else {
      // ── VITA PRODUCCIÓN: esperar segundo IPN de Vita para confirmar el payout ─
      transaction.status = 'payout_sent';

      await appendIpnLog(transaction, 'payout_dispatched', providerUsed, 'payout_sent', {
        payoutReference: transaction.payoutReference,
        amount:          payoutAmountUSD,
        country:         transaction.destinationCountry,
        provider:        providerUsed,
      });

      // Notificación push: pago enviado al banco
      try {
        await notify(
          transaction.userId,
          NOTIFICATIONS.payoutSent(transaction.destinationCountry),
        );
      } catch (notifErr) {
        console.error('[Alyto Payout] Error enviando push payout_sent:', notifErr.message);
      }

      console.log('[dispatchPayout] Producción — esperando IPN de Vita');
    }

    return;
  }

  // ── anchorBolivia: payout manual (Escenario C — Bolivia) ─────────────────
  if (payoutMethod === 'anchorBolivia') {
    transaction.status = 'payout_pending';
    await appendIpnLog(transaction, 'anchor_bolivia_payout_pending', 'anchorBolivia', 'payout_pending', {
      note: 'Payout manual Bolivia — admin debe confirmar transferencia.',
    });

    broadcastToAdmins('tx_manual_payout', {
      transactionId:      transaction.alytoTransactionId,
      status:             'payout_pending',
      payoutMethod:       'anchorBolivia',
      destinationAmount:  transaction.destinationAmount,
      destinationCurrency: transaction.destinationCurrency,
      timestamp:          new Date().toISOString(),
    });

    notifyAdminManualPayout(transaction)
      .catch(err => console.error('[Alyto Payout] Error email admin Bolivia payout:', err.message));
    console.info('[Alyto Payout] Payout manual Bolivia — admin notificado.', {
      transactionId: transaction.alytoTransactionId,
    });
    return;
  }

  // ── rampNetwork / stellar / otros — placeholder Fase 18B ────────────────
  console.warn('[Alyto Payout] payoutMethod no implementado — marcando como processing.', {
    payoutMethod,
    transactionId: transaction.alytoTransactionId,
  });
  transaction.status = 'processing';
  await appendIpnLog(transaction, 'payout_method_unimplemented', payoutMethod, 'processing', {
    payoutMethod,
    note: 'Implementación pendiente Fase 18B.',
  });

  } catch (dispatchErr) {
    // ── Red de seguridad: excepción no controlada en el cuerpo de dispatchPayout.
    // Evita que la tx quede atascada en 'processing' sin causa ni recuperación.
    console.error('[dispatchPayout] ❌ Excepción no controlada — marcando failed:', {
      transactionId: transaction?.alytoTransactionId,
      error:         dispatchErr.message,
      stack:         dispatchErr.stack?.split('\n').slice(0, 4).join(' | '),
    });
    Sentry.captureException(dispatchErr, {
      tags:  { component: 'dispatchPayout', stage: 'unhandled' },
      extra: { transactionId: transaction?.alytoTransactionId },
    });
    try {
      // Recargar fresco — solo recuperar si nadie le puso ya un estado terminal.
      const fresh = await Transaction.findById(transaction._id);
      if (fresh && fresh.status === 'processing') {
        fresh.status            = 'failed';
        fresh.failureReason     = `dispatchPayout: ${dispatchErr.message}`;
        fresh.userFailureReason = 'No pudimos completar el envío. Nuestro equipo fue notificado y lo revisará.';
        fresh.failureRetryable  = true;
        fresh.ipnLog.push({
          provider:   'system',
          eventType:  'payout_dispatch_exception',
          status:     'failed',
          rawPayload: {
            error: dispatchErr.message,
            stack: dispatchErr.stack?.split('\n').slice(0, 4).join(' | '),
          },
          receivedAt: new Date(),
        });
        await fresh.save();

        // Notificar usuario (push/in-app) — fire-and-forget
        notify(fresh.userId,
          NOTIFICATIONS.paymentFailed(fresh.originalAmount, fresh.originCurrency),
        ).catch(() => {});

        // Alertar admin por email
        try {
          const adminEmail = process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL;
          if (adminEmail) {
            await sendRawEmail(
              adminEmail,
              `⚠️ dispatchPayout falló [${fresh.alytoTransactionId}]`,
              `<p>Excepción no controlada al ejecutar el payout.</p>`
              + `<p>Tx: <strong>${fresh.alytoTransactionId}</strong> · ${fresh.originalAmount} ${fresh.originCurrency} → ${fresh.destinationCountry}</p>`
              + `<p>Error: <code>${dispatchErr.message}</code></p>`
              + `<p>Marcada como <strong>failed</strong> (retryable). Revisar en el Ledger.</p>`,
            );
          }
        } catch (e) { console.error('[dispatchPayout] Error email admin (exception):', e.message); }
      }
    } catch (recoverErr) {
      console.error('[dispatchPayout] Error en recuperación tras excepción:', recoverErr.message);
    }
  }
}

// ─── POST /api/v1/ipn/vita ────────────────────────────────────────────────────

/**
 * Recibe y procesa los IPN de Vita Wallet.
 *
 * Vita reintenta este endpoint cada 10 minutos por 30 días hasta recibir HTTP 200.
 * Por eso siempre respondemos 200, incluso si hay errores internos — el error
 * queda registrado en ipnLog y en los logs del servidor.
 *
 * Este handler procesa DOS tipos de IPN:
 *   1. Confirmación de payin (pay-in completado por el usuario)
 *      → transaction.status === "payin_pending" → dispatchPayout()
 *
 *   2. Confirmación de payout (withdrawal bancario completado por Vita)
 *      → transaction.status === "payout_sent" → status = "completed"
 *
 * Body esperado de Vita:
 * {
 *   "status": "completed" | "denied",
 *   "order":  "{alytoTransactionId}",
 *   "wallet": { "token": "...", "uuid": "..." }
 * }
 */
export async function handleVitaIPN(req, res) {
  // ── 0. Ping de validación de webhook ──────────────────────────────────────
  // Al registrar la URL, Vita hace un POST SIN firma para validar que existe.
  // Un evento real siempre trae { status, order }. Si faltan ambos, es un ping
  // de validación → responder 200 para que Vita active la URL. No procesa nada,
  // por lo que un body vacío de un tercero es inofensivo (sin order = sin acción).
  if (!req.body || (req.body.order === undefined && req.body.status === undefined)) {
    console.info('[Vita IPN] Ping de validación de webhook — 200 OK');
    return res.status(200).json({ ok: true, message: 'Vita IPN endpoint activo' });
  }

  // ── 1. Validar firma HMAC-SHA256 ──────────────────────────────────────────
  if (!verifyVitaSignature(req.body, req.headers)) {
    console.warn('[Vita IPN] Invalid signature - requestId:', req.headers['x-request-id'] ?? 'unknown');
    Sentry.captureMessage('IPN firma inválida recibida', {
      level: 'warning',
      extra: { ip: req.ip, requestId: req.headers['x-request-id'] ?? 'unknown' },
    });
    // 401 aquí: firma inválida no necesita un 200 — Vita no reintentará si enviamos 401
    return res.status(401).json({ error: 'Firma inválida.' });
  }

  // ── AWS-2B: buffer SQS. Si está activo, encolar el evento ya verificado y
  //    delegar al consumer. fromSqsConsumer evita re-encolar cuando el propio
  //    consumer reejecuta este handler. Si el encolado falla → procesar síncrono.
  if (isSqsEnabled() && !req.fromSqsConsumer) {
    const queued = await enqueueIpnEvent('vita', {
      body:    req.body,
      headers: req.headers,
      rawBody: req.rawBody ? Buffer.from(req.rawBody).toString('base64') : null,
    });
    if (queued) return res.status(200).json({ received: true, queued: true });
  }

  const { status: vitaStatus, order: vitaOrder, wallet } = req.body;

  console.info('[Alyto IPN/Vita] IPN recibido.', {
    vitaStatus,
    order: vitaOrder,
    walletUuid: wallet?.uuid,
  });

  // ── 2. Buscar transacción por alytoTransactionId ──────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: vitaOrder });
  } catch (err) {
    console.error('[Alyto IPN/Vita] Error buscando transacción en BD:', {
      order: vitaOrder,
      error: err.message,
    });
    // 200: error interno, Vita no debe reintentar este IPN (el problema es nuestro)
    return res.status(200).json({ received: true });
  }

  if (!transaction) {
    console.warn('[Alyto IPN/Vita] Transacción no encontrada para order:', vitaOrder);
    // 200: evitar reintentos de Vita ante un order que no existe en nuestro sistema
    return res.status(200).json({ received: true });
  }

  // ── 3. Registrar IPN en el log de la transacción ──────────────────────────
  // Nota: appendIpnLog llama a transaction.save() — no llamar save() adicionales
  // antes de esta línea si ya se modificó el documento.
  await appendIpnLog(transaction, 'vita_ipn_received', 'vitaWallet', vitaStatus, req.body);

  // ── 4. Procesar según el estado actual de la transacción ─────────────────
  const currentStatus = transaction.status;

  try {

    // ── Caso A: confirmación de payin ─────────────────────────────────────
    if (['payin_pending', 'initiated', 'pending'].includes(currentStatus)) {

      if (vitaStatus === 'completed') {
        transaction.status        = 'payin_confirmed';
        transaction.payinReference = wallet?.uuid ?? transaction.payinReference;
        await transaction.save();

        console.info('[Alyto IPN/Vita] Payin confirmado — disparando payout.', {
          transactionId: transaction.alytoTransactionId,
          walletUuid:    wallet?.uuid,
        });

        // Notificación push: payin confirmado
        try {
          await notify(
            transaction.userId,
            NOTIFICATIONS.payinConfirmed(transaction.originalAmount, transaction.originCurrency),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payin_confirmed:', notifErr.message);
        }

        // Email transaccional: pago iniciado
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentInitiated(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentInitiated:', emailErr.message);
        }

        // Fire-and-forget: no awaitar para responder 200 rápido a Vita
        dispatchPayout(transaction).catch(err => {
          console.error('[Alyto IPN/Vita] dispatchPayout fire-and-forget falló:', {
            transactionId: transaction.alytoTransactionId,
            error:         err.message,
          });
          sendRawEmail(
            process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
            `🚨 dispatchPayout falló — ${transaction.alytoTransactionId}`,
            `<p>El payout fire-and-forget (Vita IPN) falló para la transacción ` +
            `<strong>${transaction.alytoTransactionId}</strong>.</p>` +
            `<p>Error: <code>${err.message}</code></p>` +
            `<p>Entidad: ${transaction.legalEntity} | Monto: ${transaction.originalAmount} ${transaction.originCurrency}</p>` +
            `<p>Requiere revisión y payout manual.</p>`,
          ).catch(() => {});
        });

      } else if (vitaStatus === 'denied') {
        transaction.status        = 'failed';
        transaction.failureReason = 'Payin denegado por Vita Wallet.';
        await transaction.save();

        console.info('[Alyto IPN/Vita] Payin denegado por Vita.', {
          transactionId: transaction.alytoTransactionId,
        });

        // Notificación push: pago fallido
        try {
          await notify(
            transaction.userId,
            NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payment_failed (payin denied):', notifErr.message);
        }

        // Email transaccional: pago fallido
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentFailed(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentFailed (payin denied):', emailErr.message);
        }
      }
      // Otros estados de Vita (ej. 'pending') → no hacer nada, esperar siguiente IPN
      return res.status(200).json({ received: true });
    }

    // ── Caso B: ya procesado previamente — idempotencia ──────────────────
    if (currentStatus === 'payin_confirmed' && vitaStatus === 'completed') {
      console.info('[Alyto IPN/Vita] IPN duplicado de payin — ya procesado. Ignorando.', {
        transactionId: transaction.alytoTransactionId,
      });
      return res.status(200).json({ received: true });
    }

    // ── Caso C: confirmación de payout (segundo IPN de Vita) ─────────────
    if (currentStatus === 'payout_sent') {

      if (vitaStatus === 'completed') {
        transaction.status      = 'completed';
        transaction.completedAt = new Date();
        await transaction.save();

        if (transaction.contactId) {
          recordSent(transaction.contactId, transaction.destinationAmount, transaction.destinationCurrency).catch(() => {});
        }

        await appendIpnLog(transaction, 'payout_completed', 'vitaWallet', 'completed', req.body);

        console.info('[Alyto IPN/Vita] Payout completado — transacción finalizada. ✅', {
          transactionId: transaction.alytoTransactionId,
        });

        // Registrar audit trail inmutable en Stellar (best-effort, no bloquea el flujo)
        const stellarTxId = await registerAuditTrail(transaction);
        if (stellarTxId) {
          transaction.stellarTxId = stellarTxId;
          transaction.ipnLog.push({
            provider:   'stellar',
            eventType:  'stellar_audit_registered',
            status:     'completed',
            rawPayload: {
              stellarTxId,
              network:     process.env.STELLAR_NETWORK ?? 'testnet',
              explorerUrl: `https://stellar.expert/explorer/${
                process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet'
              }/tx/${stellarTxId}`,
            },
            receivedAt: new Date(),
          });
          await transaction.save().catch(err =>
            console.error('[Alyto IPN/Vita] Error guardando stellarTxId:', err.message),
          );
        }

        // Comprobante/factura (B2B si business, retail si no) — fire-and-forget
        generateComprobanteOnCompletion(transaction).catch(() => {});

        // Notificación push: transferencia completada
        try {
          await notify(
            transaction.userId,
            NOTIFICATIONS.paymentCompleted(
              transaction.originalAmount,
              transaction.originCurrency,
              transaction.destinationAmount,
              transaction.destinationCurrency,
            ),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payment_completed:', notifErr.message);
        }

        // Email transaccional: pago completado
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user?.email) {
            await sendEmail(...EMAILS.paymentCompleted(user, transaction));
            console.log(`[Email] ✅ Completado → userId=${user._id}`);
          }
        } catch (emailErr) {
          console.error('[Email] Error completado:', emailErr.message);
        }

      } else if (vitaStatus === 'denied') {
        transaction.status        = 'failed';
        transaction.failureReason = 'Payout (withdrawal bancario) denegado por Vita Wallet.';
        await transaction.save();

        await appendIpnLog(transaction, 'payout_denied', 'vitaWallet', 'failed', req.body);

        console.error('[Alyto IPN/Vita] Payout denegado por Vita — requiere revisión manual.', {
          transactionId: transaction.alytoTransactionId,
        });

        // Notificar al admin que el payout falló y requiere intervención
        notifyAdminManualPayout(transaction).catch(() => {});

        // Notificación push: transferencia fallida
        try {
          await notify(
            transaction.userId,
            NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
          );
        } catch (notifErr) {
          console.error('[Alyto IPN/Vita] Error enviando push payment_failed (payout denied):', notifErr.message);
        }

        // Email transaccional: pago fallido
        try {
          const user = await User.findById(transaction.userId).lean();
          if (user) await sendEmail(...EMAILS.paymentFailed(user, transaction));
        } catch (emailErr) {
          console.error('[Alyto IPN/Vita] Error enviando email paymentFailed (payout denied):', emailErr.message);
        }
      }
      return res.status(200).json({ received: true });
    }

    // ── Caso D: estado no esperado — loguear y responder 200 ─────────────
    console.warn('[Alyto IPN/Vita] IPN recibido en estado inesperado — ignorando.', {
      transactionId: transaction.alytoTransactionId,
      currentStatus,
      vitaStatus,
    });

  } catch (err) {
    // Error interno no manejado — loguear sin reventar el proceso
    console.error('[Alyto IPN/Vita] Error procesando IPN:', {
      transactionId: transaction?.alytoTransactionId,
      currentStatus,
      vitaStatus,
      error:         err.message,
    });
  }

  return res.status(200).json({ received: true });
}

// ─── POST /api/v1/ipn/fintoc ──────────────────────────────────────────────────

/**
 * Recibe y procesa los IPN / webhooks de Fintoc para el flujo cross-border.
 *
 * ⚠️  Este handler es para el flujo cross-border (payin → dispatchPayout).
 *     El webhook de Fintoc para el flujo SpA legacy está en
 *     POST /api/v1/payments/webhooks/fintoc (paymentController.js).
 *
 * Fintoc envía un event body con:
 * {
 *   "type": "payment_intent.succeeded",
 *   "data": { "id": "pi_...", "status": "succeeded", ... }
 * }
 *
 * La transacción se busca por payinReference === data.id.
 * Si no existe por payinReference, busca por paymentLegs.externalId (legacy).
 */
export async function handleFintocIPN(req, res) {
  // ── 0. Verificar firma HMAC ────────────────────────────────────────────────
  const fintocSecret = process.env.FINTOC_WEBHOOK_SECRET;
  if (fintocSecret) {
    const sigHeader = req.headers['fintoc-signature'] ?? req.headers['x-fintoc-signature'];
    if (!sigHeader) {
      console.warn('[Alyto IPN/Fintoc] Firma ausente — rechazando solicitud.');
      return res.status(400).json({ error: 'Missing signature' });
    }
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac('sha256', fintocSecret).update(rawBody).digest('hex');
    const received = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
        console.warn('[Alyto IPN/Fintoc] Firma inválida — rechazando solicitud.');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } catch {
      console.warn('[Alyto IPN/Fintoc] Error comparando firma — rechazando solicitud.');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else {
    // Fail-closed (audit 2026-06-11): sin secret NO se procesa el webhook —
    // antes era fail-open y un POST sin firma podía confirmar payins.
    // Mismo comportamiento que Vita/OwlPay/Stripe.
    console.error('[Alyto IPN/Fintoc] FINTOC_WEBHOOK_SECRET no configurado — webhook RECHAZADO (fail-closed).');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // ── AWS-2B: buffer SQS (ver handleVitaIPN). ──────────────────────────────
  if (isSqsEnabled() && !req.fromSqsConsumer) {
    const queued = await enqueueIpnEvent('fintoc', {
      body:    req.body,
      headers: req.headers,
      rawBody: req.rawBody ? Buffer.from(req.rawBody).toString('base64') : null,
    });
    if (queued) return res.status(200).json({ received: true, queued: true });
  }

  const { type, data } = req.body;

  console.info('[Alyto IPN/Fintoc] Evento recibido.', {
    type,
    paymentIntentId: data?.id,
  });

  // ── 1. Filtrar eventos irrelevantes ───────────────────────────────────────
  // Solo procesar confirmaciones de pago exitoso
  if (type !== 'payment_intent.succeeded') {
    console.info('[Alyto IPN/Fintoc] Evento ignorado (no es succeeded):', type);
    return res.status(200).json({ received: true });
  }

  const paymentIntentId = data?.id;
  if (!paymentIntentId) {
    console.warn('[Alyto IPN/Fintoc] Event sin data.id — ignorando.');
    return res.status(200).json({ received: true });
  }

  // ── 2. Buscar transacción cross-border por payinReference ─────────────────
  let transaction;
  try {
    transaction = await Transaction.findOne({ payinReference: paymentIntentId });

    // Fallback: buscar por paymentLegs.externalId (transacciones SpA legacy
    // que también podrían pasar por este endpoint)
    if (!transaction) {
      transaction = await Transaction.findOne({
        'paymentLegs.externalId': paymentIntentId,
        'paymentLegs.provider':   'fintoc',
      });
    }
  } catch (err) {
    console.error('[Alyto IPN/Fintoc] Error buscando transacción:', {
      paymentIntentId,
      error: err.message,
    });
    return res.status(200).json({ received: true });
  }

  if (!transaction) {
    console.warn('[Alyto IPN/Fintoc] Transacción no encontrada para payment_intent:', paymentIntentId);
    return res.status(200).json({ received: true });
  }

  // ── 3. Idempotency — evitar procesar el mismo evento dos veces ───────────
  const alreadyProcessed = transaction.ipnLog?.some(
    entry => entry.provider === 'fintoc'
          && (entry.rawPayload?.data?.id ?? entry.rawPayload?.id) === paymentIntentId
          && (entry.rawPayload?.type ?? entry.eventType) === type,
  );
  if (alreadyProcessed) {
    console.log('[Alyto IPN/Fintoc] Evento duplicado ignorado:', type, paymentIntentId);
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── 4. Registrar IPN en log ───────────────────────────────────────────────
  await appendIpnLog(transaction, 'fintoc_ipn_received', 'fintoc', data?.status ?? 'succeeded', req.body);

  // ── 5. Procesar si el payin está pendiente ────────────────────────────────
  try {
    if (transaction.status === 'payin_pending') {
      transaction.status = 'payin_confirmed';
      await transaction.save();

      console.info('[Alyto IPN/Fintoc] Payin confirmado — disparando payout.', {
        transactionId:   transaction.alytoTransactionId,
        paymentIntentId,
      });

      // Fire-and-forget: Fintoc también necesita respuesta rápida
      dispatchPayout(transaction).catch(err => {
        console.error('[Alyto IPN/Fintoc] dispatchPayout fire-and-forget falló:', {
          transactionId: transaction.alytoTransactionId,
          error:         err.message,
        });
        sendRawEmail(
          process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
          `🚨 dispatchPayout falló — ${transaction.alytoTransactionId}`,
          `<p>El payout fire-and-forget (Fintoc IPN) falló para la transacción ` +
          `<strong>${transaction.alytoTransactionId}</strong>.</p>` +
          `<p>Error: <code>${err.message}</code></p>` +
          `<p>Entidad: ${transaction.legalEntity} | Monto: ${transaction.originalAmount} ${transaction.originCurrency}</p>` +
          `<p>Requiere revisión y payout manual.</p>`,
        ).catch(() => {});
      });

    } else {
      console.info('[Alyto IPN/Fintoc] Transacción no en payin_pending — ignorando.', {
        transactionId: transaction.alytoTransactionId,
        currentStatus: transaction.status,
      });
    }
  } catch (err) {
    console.error('[Alyto IPN/Fintoc] Error procesando confirmación:', {
      transactionId: transaction?.alytoTransactionId,
      error:         err.message,
    });
  }

  return res.status(200).json({ received: true });
}

// ─── POST /api/v1/ipn/owlpay ──────────────────────────────────────────────────

/**
 * Recibe y procesa los webhooks de OwlPay Harbor para desembolsos institucionales.
 *
 * OwlPay notifica cuando un disbursement cambia de estado.
 * Este handler finaliza el ciclo del payout bancario en la transacción Alyto.
 *
 * Body esperado de OwlPay:
 * {
 *   "event": "disbursement.completed" | "disbursement.failed",
 *   "data": { "id": "disb_...", "status": "completed"|"failed", "failure_reason": "..." }
 * }
 */
export async function handleOwlPayIPN(req, res) {
  // ── 1. Verificar firma HMAC-SHA256 (harbor-signature: t=<ts>,v1=<hex>) ──────
  // Source: https://harbor-developers.owlpay.com/docs/verifying-requests-from-harbor
  const harborSignature = req.headers['harbor-signature'];
  const rawBody         = req.rawBody ?? JSON.stringify(req.body);

  if (!harborSignature) {
    console.warn('[OwlPay IPN] Missing harbor-signature header from IP:', req.ip);
    return res.status(401).json({ error: 'Missing signature' });
  }
  if (!verifyWebhookSignature(rawBody, harborSignature)) {
    console.warn('[OwlPay IPN] Invalid harbor-signature from IP:', req.ip);
    return res.status(401).json({ error: 'Firma inválida.' });
  }

  // ── AWS-2B: buffer SQS (ver handleVitaIPN). ──────────────────────────────
  if (isSqsEnabled() && !req.fromSqsConsumer) {
    const queued = await enqueueIpnEvent('owlpay', {
      body:    req.body,
      headers: req.headers,
      rawBody: req.rawBody ? Buffer.from(req.rawBody).toString('base64') : null,
    });
    if (queued) return res.status(200).json({ received: true, queued: true });
  }

  const { event, data } = req.body ?? {};
  const isV2       = typeof event === 'string' && event.startsWith('transfer.');
  const isV1       = typeof event === 'string' && event.startsWith('disbursement.');
  const isCustomer = typeof event === 'string' && event.startsWith('customer.');
  const eventKind  = isV2 ? 'v2' : isV1 ? 'v1' : isCustomer ? 'customer' : 'unknown';

  // ── Customer events (KYC) — no asociadas a transacción específica ────────
  // Per Harbor docs: customer.kyc_approved | customer.kyc_rejected
  // Aplican al Customer (AV Finance LLC). Si KYC rechazado → bloqueo global.
  if (isCustomer) {
    const customerUuid = data?.customer_uuid ?? data?.uuid ?? data?.id;
    console.info('[Alyto IPN/OwlPay] Customer event:', {
      event, customerUuid, status: data?.status,
    });
    if (event === 'customer.kyc_rejected') {
      console.error('[Alyto IPN/OwlPay] ⚠️ CUSTOMER KYC REJECTED', {
        customerUuid,
        reason: data?.failure_reason ?? data?.rejection_reason ?? 'sin detalle',
      });
      try {
        await sendRawEmail(
          process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
          `🚨 CRÍTICO — Harbor Customer KYC RECHAZADO`,
          `<p>Harbor rechazó el KYC del Customer (AV Finance LLC).</p>` +
          `<p>UUID: <strong>${customerUuid ?? 'desconocido'}</strong></p>` +
          `<p>Motivo: ${data?.failure_reason ?? 'no especificado'}</p>` +
          `<p><strong>Bloqueo total de transacciones Harbor</strong> hasta resolver con OwlPay support.</p>`,
        );
      } catch (e) { console.error('[OwlPay IPN] Error email admin (kyc rejected):', e.message); }
    }
    return res.status(200).json({ received: true, event });
  }

  const transferId            = data?.id ?? data?.transfer_id ?? data?.uuid;
  const externalReference     = data?.external_reference;                        // our ALY-* ID
  const applicationTransferId = data?.application_transfer_uuid ?? data?.applicationTransferUuid;
  const disbursementId        = data?.id ?? data?.disbursement_id;
  const status                = data?.status;
  const failureReason         = data?.failure_reason ?? data?.failureReason;

  console.info('[Alyto IPN/OwlPay] Webhook recibido.', {
    event, kind: eventKind, transferId, externalReference, applicationTransferId, status,
  });

  // ── 2. Buscar transacción ────────────────────────────────────────────────
  let transaction;
  try {
    if (isV2) {
      // Primary: external_reference holds our ALY-* ID (set in createTransfer)
      if (externalReference) {
        transaction = await Transaction.findOne({ alytoTransactionId: externalReference });
      }
      // Secondary: application_transfer_uuid es nuestro ALY-* ID enviado al crear el transfer.
      // Harbor lo incluye en transfer.status.* pero a veces omite external_reference.
      if (!transaction && applicationTransferId) {
        transaction = await Transaction.findOne({ alytoTransactionId: applicationTransferId });
      }
      // Fallback: Harbor's own transfer ID stored in harborTransfer sub-schema
      if (!transaction && transferId) {
        transaction = await Transaction.findOne({
          $or: [
            { 'harborTransfer.transferId': transferId },
            { payoutReference: transferId },
          ],
        });
      }
    } else {
      // v1 (legacy) o unknown
      transaction = await Transaction.findOne({ payoutReference: disbursementId ?? transferId });
    }
  } catch (err) {
    console.error('[Alyto IPN/OwlPay] Error buscando transacción:', { transferId, error: err.message });
    return res.status(200).json({ received: true });
  }

  if (!transaction) {
    console.warn('[Alyto IPN/OwlPay] Transacción no encontrada.', {
      event, transferId, externalReference, applicationTransferId,
    });
    return res.status(200).json({ received: true });
  }

  // ── 3. Idempotency — skip if this exact (transferId, status) was already logged ──
  // Harbor v2 usa data.id; v1 legacy usa data.transfer_id. Ambos cubiertos.
  const alreadyProcessed = transaction.ipnLog?.some(
    entry => entry.provider === 'owlPay'
          && (entry.rawPayload?.data?.id ?? entry.rawPayload?.data?.transfer_id ?? entry.rawPayload?.transfer_id) === transferId
          && (entry.rawPayload?.data?.status ?? entry.rawPayload?.status) === status,
  );
  if (alreadyProcessed) {
    console.log('[OwlPay IPN] Duplicate event skipped:', event, transferId, status);
    return res.status(200).json({ received: true, duplicate: true });
  }

  await appendIpnLog(transaction, 'owlpay_webhook_received', 'owlPay', status, req.body);

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // v2: transfer.source_received — Harbor recibió el USDC en la instruction address
    // ═══════════════════════════════════════════════════════════════════════
    if (event === 'transfer.source_received') {
      if (transaction.status === 'completed') {
        console.warn('[OwlPay IPN] source_received ignorado — tx ya completada:', transaction.alytoTransactionId);
      } else {
        transaction.status = 'payout_sent';
        if (transaction.harborTransfer) transaction.harborTransfer.status = status ?? 'source_received';
        await transaction.save();

        await appendIpnLog(transaction, 'harbor_source_received', 'owlPay', 'payout_sent', req.body);

        try {
          await notify(transaction.userId, {
            title: 'Pago en proceso',
            body:  'Recibimos los fondos en nuestra plataforma de liquidación. El beneficiario recibirá el pago pronto.',
            data:  { type: 'payout_sent' },
          });
        } catch (e) { console.error('[OwlPay IPN] Error push source_received:', e.message); }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v2: transfer.completed — Harbor desembolsó el fiat al beneficiario
    // legacy v1: disbursement.completed
    // ═══════════════════════════════════════════════════════════════════════
    else if (event === 'transfer.completed' || event === 'disbursement.completed') {
      if (transaction.status === 'completed') {
        console.warn('[OwlPay IPN] transfer.completed ignorado — tx ya completada:', transaction.alytoTransactionId);
        return res.status(200).json({ received: true, duplicate: true });
      }
      transaction.status      = 'completed';
      transaction.completedAt = new Date();
      if (transaction.harborTransfer) transaction.harborTransfer.status = 'completed';
      await transaction.save();

      if (transaction.contactId) {
        recordSent(transaction.contactId, transaction.destinationAmount, transaction.destinationCurrency).catch(() => {});
      }

      await appendIpnLog(transaction, 'payout_completed', 'owlPay', 'completed', req.body);

      console.info('[Alyto IPN/OwlPay] Payout completado. ✅', {
        transactionId: transaction.alytoTransactionId, event,
      });

      // Stellar audit trail (best-effort)
      try {
        const stellarTxId = await registerAuditTrail(transaction);
        if (stellarTxId) {
          transaction.stellarTxId = stellarTxId;
          transaction.ipnLog.push({
            provider:   'stellar',
            eventType:  'stellar_audit_registered',
            status:     'completed',
            rawPayload: {
              stellarTxId,
              network:     process.env.STELLAR_NETWORK ?? 'testnet',
              explorerUrl: `https://stellar.expert/explorer/${
                process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet'
              }/tx/${stellarTxId}`,
            },
            receivedAt: new Date(),
          });
          await transaction.save().catch(e =>
            console.error('[OwlPay IPN] Error guardando stellarTxId:', e.message));
        }
      } catch (stellarErr) {
        console.error('[OwlPay IPN] Error Stellar audit:', stellarErr.message);
      }

      // Comprobante/factura (B2B si business, retail si no) — fire-and-forget,
      // exigencia ASFI. Tras el audit trail para incluir el TXID real.
      await generateComprobanteOnCompletion(transaction);

      try {
        await notify(transaction.userId, NOTIFICATIONS.paymentCompleted(
          transaction.originalAmount, transaction.originCurrency,
          transaction.destinationAmount, transaction.destinationCurrency,
        ));
      } catch (e) { console.error('[OwlPay IPN] Error push completed:', e.message); }

      try {
        const user = await User.findById(transaction.userId).lean();
        if (user?.email) await sendEmail(...EMAILS.paymentCompleted(user, transaction));
      } catch (e) { console.error('[OwlPay IPN] Error email completed:', e.message); }

      try {
        broadcastToAdmins('tx_status_changed', {
          transactionId: transaction.alytoTransactionId,
          newStatus:     'completed',
          provider:      'owlpay',
        });
      } catch (e) { console.warn('[OwlPay IPN] Broadcast error (completed):', e.message); }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v2: transfer.failed / legacy disbursement.failed
    // ═══════════════════════════════════════════════════════════════════════
    else if (event === 'transfer.failed' || event === 'disbursement.failed') {
      transaction.status        = 'failed';
      transaction.failureReason = `Harbor transfer failed: ${failureReason ?? 'Sin detalle'}`;
      if (transaction.harborTransfer) transaction.harborTransfer.status = 'failed';
      await transaction.save();

      await appendIpnLog(transaction, 'payout_failed', 'owlPay', 'failed', req.body);

      console.error('[Alyto IPN/OwlPay] Transfer fallido — requiere revisión manual.', {
        transactionId: transaction.alytoTransactionId, failureReason,
      });

      notifyAdminManualPayout(transaction).catch(() => {});

      try {
        await notify(transaction.userId,
          NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency));
      } catch (e) { console.error('[OwlPay IPN] Error push failed:', e.message); }

      try {
        const user = await User.findById(transaction.userId).lean();
        if (user?.email) await sendEmail(...EMAILS.paymentFailed(user, transaction));
      } catch (e) { console.error('[OwlPay IPN] Error email failed:', e.message); }

      try {
        broadcastToAdmins('tx_status_changed', {
          transactionId: transaction.alytoTransactionId,
          newStatus:     'failed',
          provider:      'owlpay',
          reason:        failureReason ?? 'Sin detalle',
        });
      } catch (e) { console.warn('[OwlPay IPN] Broadcast error (failed):', e.message); }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v2: transfer.expired — el USDC no se envió antes del deadline
    // ═══════════════════════════════════════════════════════════════════════
    else if (event === 'transfer.expired') {
      transaction.status        = 'failed';
      transaction.failureReason = 'Harbor transfer expired — USDC not sent in time';
      if (transaction.harborTransfer) transaction.harborTransfer.status = 'expired';
      await transaction.save();

      await appendIpnLog(transaction, 'harbor_transfer_expired', 'owlPay', 'failed', req.body);

      console.error('[Alyto IPN/OwlPay] ⚠️ Harbor transfer EXPIRED', {
        transactionId: transaction.alytoTransactionId,
        expiresAt:     transaction.harborTransfer?.expiresAt,
      });

      // Alertar al admin — se requiere refund manual al usuario
      try {
        await sendRawEmail(
          process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
          `⚠️ Transfer EXPIRED — ${transaction.alytoTransactionId}`,
          `<p>Harbor transfer <strong>${transaction.harborTransfer?.transferId ?? transferId}</strong> expiró antes de que enviáramos USDC.</p>` +
          `<p>El deadline era <strong>${transaction.harborTransfer?.expiresAt ?? '—'}</strong>.</p>` +
          `<p><strong>Acción requerida:</strong> refund manual al usuario ${transaction.userId} por ${transaction.originalAmount} ${transaction.originCurrency}.</p>`,
        );
      } catch (e) { console.error('[OwlPay IPN] Error email admin (expired):', e.message); }

      try {
        await notify(transaction.userId,
          NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency));
      } catch (e) { console.error('[OwlPay IPN] Error push expired:', e.message); }

      try {
        const user = await User.findById(transaction.userId).lean();
        if (user?.email) await sendEmail(...EMAILS.paymentFailed(user, transaction));
      } catch (e) { console.error('[OwlPay IPN] Error email expired:', e.message); }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // transfer.status.* — Harbor notifica cambio de estado interno.
    // No requiere acción Alyto pero actualizamos harborTransfer.status.
    // ═══════════════════════════════════════════════════════════════════════
    else if (event?.startsWith('transfer.status.')) {
      const harborStatus = event.replace('transfer.status.', '');
      if (transaction.harborTransfer) {
        transaction.harborTransfer.status = harborStatus;
        // Guardar Harbor transferId si no lo tenemos aún (race condition en creación)
        if (!transaction.harborTransfer.transferId && transferId) {
          transaction.harborTransfer.transferId = transferId;
          transaction.payoutReference = transferId;
        }
        await transaction.save();
      }
      console.info('[Alyto IPN/OwlPay] Harbor status update.', {
        transactionId: transaction.alytoTransactionId,
        harborStatus,
        event,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Otros eventos (informativos, duplicados, etc.)
    // ═══════════════════════════════════════════════════════════════════════
    else {
      console.info('[Alyto IPN/OwlPay] Evento no accionable.', {
        transactionId: transaction.alytoTransactionId,
        currentStatus: transaction.status,
        event, status,
      });
    }
  } catch (err) {
    console.error('[Alyto IPN/OwlPay] Error procesando webhook:', {
      transactionId: transaction?.alytoTransactionId,
      error:         err.message,
    });
    Sentry.captureException(err, {
      tags:  { component: 'handleOwlPayIPN' },
      extra: { transactionId: transaction?.alytoTransactionId, event, transferId },
    });
  }

  return res.status(200).json({ received: true });
}

// ─── handleBankQrIPN ─────────────────────────────────────────────────────────

/**
 * Factory: devuelve un handler Express para el IPN de cualquier banco QR boliviano.
 *
 * El banco llama a POST /api/v1/ipn/{bankId} cuando el usuario paga el QR.
 * Respondemos { responseCode: 0, message: "" } siempre con HTTP 200 para
 * evitar reintentos del banco ante errores internos nuestros.
 *
 * Payload recibido del banco (objeto PaymentQR de Banco Económico):
 * {
 *   "payment": {
 *     "qrId":             "21061401016000000003",
 *     "transactionId":    "1236342",        ← ID interno del banco (≠ alytoTransactionId)
 *     "paymentDate":      "2021-06-14T00:00:00",
 *     "paymentTime":      "17:06:29",
 *     "currency":         "BOB",
 *     "amount":           150.00,
 *     "senderBankCode":   "1016",
 *     "senderName":       "JUAN PEREZ",
 *     "senderDocumentId": "0",
 *     "senderAccount":    "******1913",
 *     "description":      "Alyto ALY-C-..."
 *   }
 * }
 *
 * @param {string} bankId — 'bec' | 'bisa' | ...
 */
export function handleBankQrIPN(bankId) {
  return async function (req, res) {
    const OK = { responseCode: 0, message: '' };

    const { payment } = req.body ?? {};

    if (!payment?.qrId) {
      logger.warn(`[BankQr IPN ${bankId}] Payload sin payment.qrId`, { body: req.body });
      return res.status(200).json(OK);
    }

    logger.info(`[BankQr IPN ${bankId}] Pago recibido`, {
      qrId:   payment.qrId,
      amount: payment.amount,
      sender: payment.senderName,
    });

    let transaction;
    try {
      transaction = await Transaction.findOne({ 'bankQr.qrId': payment.qrId });
    } catch (err) {
      Sentry.captureException(err, { tags: { component: `bankQrIPN:${bankId}` } });
      return res.status(200).json(OK);
    }

    if (!transaction) {
      logger.warn(`[BankQr IPN ${bankId}] QR no encontrado en BD: ${payment.qrId}`);
      return res.status(200).json(OK);
    }

    // Idempotencia: pago ya procesado
    if (transaction.status !== 'payin_pending') {
      logger.info(`[BankQr IPN ${bankId}] Tx ya en estado ${transaction.status} — ignorando`, {
        alytoTransactionId: transaction.alytoTransactionId,
      });
      return res.status(200).json(OK);
    }

    // Validar monto (modifyAmount=false garantiza exactitud en el banco, pero double-check)
    const expectedAmount = transaction.originalAmount;
    const receivedAmount = Number(payment.amount);
    if (Math.abs(receivedAmount - expectedAmount) > 0.02) {
      logger.warn(`[BankQr IPN ${bankId}] Monto recibido ${receivedAmount} ≠ esperado ${expectedAmount}`, {
        qrId: payment.qrId,
      });
      Sentry.captureMessage(`BankQr IPN amount mismatch [${bankId}]`, {
        level: 'warning',
        extra: { qrId: payment.qrId, expectedAmount, receivedAmount, alytoId: transaction.alytoTransactionId },
      });
      transaction.ipnLog.push({
        provider:   `bankQr:${bankId}`,
        eventType:  'bankqr_amount_mismatch',
        status:     transaction.status,
        rawPayload: { payment },
        receivedAt: new Date(),
      });
      await transaction.save().catch(() => {});
      return res.status(200).json(OK);
    }

    // ── Confirmar payin ───────────────────────────────────────────────────────
    try {
      transaction.status         = 'payin_confirmed';
      transaction.bankQr.paidAt  = new Date();
      transaction.bankQr.payment = payment;
      transaction.payinReference = payment.qrId;
      transaction.ipnLog.push({
        provider:   `bankQr:${bankId}`,
        eventType:  'bankqr_payin_confirmed',
        status:     'payin_confirmed',
        rawPayload: { payment },
        receivedAt: new Date(),
      });
      await transaction.save();

      logger.info(`[BankQr IPN ${bankId}] ✅ Payin confirmado`, {
        alytoTransactionId: transaction.alytoTransactionId,
        amount:             receivedAmount,
        sender:             payment.senderName,
      });
    } catch (saveErr) {
      Sentry.captureException(saveErr, { tags: { component: `bankQrIPN:${bankId}` } });
      return res.status(200).json(OK);
    }

    // ── Disparar payout (fire-and-forget) ─────────────────────────────────────
    dispatchPayout(transaction).catch((err) => {
      logger.error(`[BankQr IPN ${bankId}] Error en dispatchPayout`, {
        alytoTransactionId: transaction.alytoTransactionId,
        error:              err.message,
      });
      Sentry.captureException(err, {
        tags:  { component: `bankQrIPN:${bankId}` },
        extra: { alytoTransactionId: transaction.alytoTransactionId },
      });
    });

    return res.status(200).json(OK);
  };
}
