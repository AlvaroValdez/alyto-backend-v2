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
} from '../services/owlPayService.js';
import FundingRecord from '../models/FundingRecord.js';
import {
  registerAuditTrail,
  sendUSDCToHarbor,
  getStellarUSDCBalance,
} from '../services/stellarService.js';
import Sentry from '../services/sentry.js';
import { notify, NOTIFICATIONS } from '../services/notifications.js';
import { broadcastToAdmins } from '../routes/adminSSE.js';
import { sendEmail, sendRawEmail, EMAILS } from '../services/email.js';
import { getBOBRate }        from '../services/exchangeRateService.js';

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
async function notifyAdminManualPayout(transaction) {
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
    const firstName = dynamicFields.beneficiary_first_name ?? '';
    const lastName  = dynamicFields.beneficiary_last_name  ?? '';
    vitaPayload = {
      country:          transaction.destinationCountry,
      currency,
      amount,
      order:            transaction.alytoTransactionId,
      purpose:          'ISSAVG',
      ...dynamicFields,
      fc_customer_type: 'natural',
      fc_legal_name:    `${firstName} ${lastName}`.trim() || 'Beneficiario Alyto',
      fc_document_type: dynamicFields.beneficiary_document_type ?? 'dni',
    };
  } else {
    vitaPayload = {
      country:                     transaction.destinationCountry,
      currency,
      amount,
      order:                       transaction.alytoTransactionId,
      beneficiary_first_name:      ben.firstName  ?? '',
      beneficiary_last_name:       ben.lastName   ?? '',
      beneficiary_email:           ben.email      ?? '',
      beneficiary_address:         ben.address    ?? '',
      beneficiary_document_type:   ben.documentType   ?? 'dni',
      beneficiary_document_number: ben.documentNumber ?? '',
      purpose:                     'ISSAVG',
      ...(ben.bankCode    ? { bank_code:         ben.bankCode    } : {}),
      ...(ben.accountBank ? { account_bank:       ben.accountBank } : {}),
      ...(ben.accountType ? { account_type_bank:  ben.accountType } : {}),
      fc_customer_type: 'natural',
      fc_legal_name:    `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim(),
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
  // Prioridad: manualExchangeRate del corredor → MongoDB (ExchangeRate) → .env
  let bobPerUsdc = corridor.manualExchangeRate;

  if (!bobPerUsdc || bobPerUsdc <= 0) {
    bobPerUsdc = await getBOBRate();
    console.log('[convertBobToUsdc] manualExchangeRate no configurada en corredor — usando getBOBRate():', bobPerUsdc);
  }

  const usdcAmount = Math.round((netAmountBOB / bobPerUsdc) * 100) / 100; // 2 decimales — igual que en la cotización (round2)
  return { usdcAmount, bobPerUsdc };
}

// ─── buildOwlPayBeneficiary ───────────────────────────────────────────────────

/**
 * Maps Alyto beneficiaryDetails to the shape OwlPay Harbor requires.
 * Uses the requirements schema from getRequirementsSchema() for required-field
 * validation warnings — mapping is best-effort; unknown fields are skipped.
 */
function buildOwlPayBeneficiary(beneficiaryDetails, schema) {
  if (!beneficiaryDetails) {
    throw new Error('beneficiaryDetails missing on transaction');
  }

  const FIELD_MAP = {
    first_name:      ['firstName', 'first_name', 'nombre'],
    last_name:       ['lastName', 'last_name', 'apellido'],
    email:           ['email'],
    phone:           ['phone', 'telefono'],
    account_number:  ['accountNumber', 'account_number', 'numeroCuenta'],
    bank_code:       ['bankCode', 'bank_code', 'codigoBanco'],
    bank_name:       ['bankName', 'bank_name', 'banco'],
    routing_number:  ['routingNumber', 'routing_number'],
    iban:            ['iban', 'IBAN'],
    swift_code:      ['swiftCode', 'swift', 'bic'],
    document_type:   ['documentType', 'tipoDocumento'],
    document_number: ['documentNumber', 'documentoNumero', 'ci'],
    country:         ['country', 'pais', 'residenceCountry'],
    city:            ['city', 'ciudad'],
    address:         ['address', 'direccion'],
    postal_code:     ['postalCode', 'postal_code', 'codigoPostal'],
  };

  const result   = {};
  const required = schema?.required ?? [];

  for (const [owlField, sources] of Object.entries(FIELD_MAP)) {
    let value;
    for (const src of sources) {
      if (beneficiaryDetails[src] !== undefined &&
          beneficiaryDetails[src] !== null &&
          beneficiaryDetails[src] !== '') {
        value = beneficiaryDetails[src];
        break;
      }
    }
    if (value !== undefined) {
      result[owlField] = String(value).trim();
    } else if (required.includes(owlField)) {
      console.warn(`[OwlPay] Required beneficiary field missing: ${owlField}`);
    }
  }

  const missing = required.filter((f) => !result[f]);
  if (missing.length > 0) {
    console.warn('[OwlPay] Missing required beneficiary fields:', missing);
  }

  return result;
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
async function tryOwlPayV2(transaction, corridor, netAmountUSD) {
  const entity = transaction.legalEntity;

  // ── STEP A: Pre-check liquidez USDC en wallet Stellar SRL ────────────────
  const usdcBalance = await getStellarUSDCBalance();
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

  // ── STEP B: Create quote ──────────────────────────────────────────────────
  const customerUuidEnvKey = {
    SRL: 'OWLPAY_CUSTOMER_UUID_SRL',
    SpA: 'OWLPAY_CUSTOMER_UUID_SPA',
    LLC: 'OWLPAY_CUSTOMER_UUID_LLC',
  }[entity] ?? 'OWLPAY_CUSTOMER_UUID_SRL';

  const quote = await createQuote({
    source_amount:              netAmountUSD,
    destination_country:        corridor.destinationCountry,
    destination_currency:       corridor.destinationCurrency,
    destination_payment_method: 'bank_transfer',
    source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
    customer_uuid:              process.env[customerUuidEnvKey],
  });

  // Harbor may nest the quote object; normalise to top level
  const quoteData  = quote.data?.[0] ?? quote.data ?? quote;
  const quoteId    = quoteData.id ?? quoteData.quote_id;
  const expiresAt  = quoteData.expires_at ?? quoteData.crypto_funds_settlement_expire_date;

  if (!quoteId) throw new Error('[OwlPay] No quote_id in createQuote response');

  transaction.payoutQuoteId       = quoteId;
  transaction.payoutQuoteExpiresAt = new Date(expiresAt ?? Date.now() + 5 * 60 * 1000);
  await transaction.save();

  console.log('[OwlPay] Quote created:', quoteId);

  // ── STEP C: Get requirements schema ──────────────────────────────────────
  const schema = await getRequirementsSchema(quoteId);

  // ── STEP D: Build beneficiary ─────────────────────────────────────────────
  const rawBeneficiary     = transaction.beneficiaryDetails ?? transaction.beneficiary ?? {};
  const beneficiaryPayload = buildOwlPayBeneficiary(rawBeneficiary, schema?.data ?? schema);

  // ── STEP E: Create transfer ───────────────────────────────────────────────
  const transfer = await createOwlPayTransfer({
    quote_id:           quoteId,
    beneficiary:        beneficiaryPayload,
    external_reference: transaction.alytoTransactionId,
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

  transaction.ipnLog.push({
    event:      'owlpay_transfer_created',
    source:     'owlpay',
    rawPayload: {
      transfer_id:         transferId,
      instruction_address: instructionAddress,
      instruction_memo:    instructionMemo,
      expires_at:          transaction.harborTransfer.expiresAt,
      destination_amount:  transferData.destination?.amount ?? null,
    },
    timestamp: new Date(),
  });
  await transaction.save();

  console.log('[OwlPay] Transfer created:', transferId, 'memo:', instructionMemo);

  // ── STEP F: Send USDC via Stellar ─────────────────────────────────────────
  const usdcSendEnabled = process.env.OWLPAY_USDC_SEND_ENABLED === 'true';

  if (!usdcSendEnabled) {
    transaction.statusReason =
      `OWLPAY_USDC_SEND_ENABLED=false — admin must send ` +
      `${netAmountUSD} USDC to ${instructionAddress} ` +
      `with memo: ${instructionMemo}`;
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
  const memoForStellar = (instructionMemo ?? transaction.alytoTransactionId).slice(0, 28);
  const stellarResult  = await sendUSDCToHarbor({
    destinationAddress: instructionAddress,
    amount:             netAmountUSD,
    memo:               memoForStellar,
    transactionId:      transaction.alytoTransactionId,
  });

  transaction.stellarTxHash = stellarResult.hash;
  transaction.status        = 'payout_sent';
  transaction.statusReason  = null;
  transaction.ipnLog.push({
    event:      'usdc_sent_to_harbor',
    source:     'stellar',
    rawPayload: {
      hash:     stellarResult.hash,
      ledger:   stellarResult.ledger,
      amount:   netAmountUSD,
      memo:     memoForStellar,
      existing: stellarResult.existing ?? false,
    },
    timestamp: new Date(),
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
        bobPerUsdc = corridor.manualExchangeRate > 0
          ? corridor.manualExchangeRate
          : await getBOBRate();
      } else {
        const convResult = await convertBobToUsdc(_netAmountNative, corridor);
        usdcAmount = convResult.usdcAmount;
        bobPerUsdc = convResult.bobPerUsdc;
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
      console.error('[Alyto Payout] tryOwlPayV2 falló:', {
        transactionId: transaction.alytoTransactionId,
        error:         err.message,
      });
      Sentry.captureException(err, {
        tags:  { component: 'dispatchPayout', provider: 'owlPay-v2' },
        extra: { transactionId: transaction.alytoTransactionId },
      });

      transaction.status        = 'failed';
      transaction.failureReason = `OwlPay Harbor v2: ${err.message}`;
      await appendIpnLog(transaction, 'owlpay_v2_failed', 'owlPay', 'failed', { error: err.message });

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
        bobPerUsdc  = corridor.manualExchangeRate > 0
          ? corridor.manualExchangeRate
          : await getBOBRate();
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
      if (fallback && fallback !== payoutMethod) {
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

  // ── 3. Registrar IPN en log ───────────────────────────────────────────────
  await appendIpnLog(transaction, 'fintoc_ipn_received', 'fintoc', data?.status ?? 'succeeded', req.body);

  // ── 4. Procesar si el payin está pendiente ────────────────────────────────
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

  const { event, data } = req.body ?? {};
  const isV2      = typeof event === 'string' && event.startsWith('transfer.');
  const isV1      = typeof event === 'string' && event.startsWith('disbursement.');
  const eventKind = isV2 ? 'v2' : isV1 ? 'v1' : 'unknown';

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
  // rawPayload stored by appendIpnLog is req.body = { event, data: { transfer_id, status } }
  const alreadyProcessed = transaction.ipnLog?.some(
    entry => entry.provider === 'owlPay'
          && (entry.rawPayload?.data?.transfer_id ?? entry.rawPayload?.transfer_id) === transferId
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

    // ═══════════════════════════════════════════════════════════════════════
    // v2: transfer.completed — Harbor desembolsó el fiat al beneficiario
    // legacy v1: disbursement.completed
    // ═══════════════════════════════════════════════════════════════════════
    else if (event === 'transfer.completed' || event === 'disbursement.completed') {
      transaction.status      = 'completed';
      transaction.completedAt = new Date();
      if (transaction.harborTransfer) transaction.harborTransfer.status = 'completed';
      await transaction.save();

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
