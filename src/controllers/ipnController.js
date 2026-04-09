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
import { createDisbursement, verifyOwlPayWebhookSignature } from '../services/owlPayService.js';
import { registerAuditTrail }                  from '../services/stellarService.js';
import Sentry from '../services/sentry.js';
import { notify, NOTIFICATIONS } from '../services/notifications.js';
import { sendEmail, EMAILS } from '../services/email.js';
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

  console.log('[Vita IPN] Body raw:', JSON.stringify(body));
  console.log('[Vita IPN] VITA_SECRET primeros 8 chars:', secret.substring(0, 8));
  console.log('[Vita IPN] Sorted string:', sortedString);

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(sortedString)
    .digest('hex');

  const receivedSignature = headers['authorization']
    ?.replace('V2-HMAC-SHA256, Signature: ', '')
    ?.trim();

  console.log('[Vita IPN] Expected:', expectedSignature);
  console.log('[Vita IPN] Received:', receivedSignature);

  return expectedSignature === receivedSignature;
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
async function appendIpnLog(transaction, eventType, provider, status, rawPayload) {
  try {
    transaction.ipnLog.push({ provider, eventType, status, rawPayload, receivedAt: new Date() });
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

  // Usar totalDeductedReal si está disponible (transacciones nuevas).
  // Fallback explícito para transacciones anteriores que no tienen el campo.
  const totalReal = fees.totalDeductedReal
    ?? Math.round(
      (fees.payinFee        || 0)
      + (fees.alytoCSpread  || 0)
      + (fees.fixedFee      || 0)
      + (fees.profitRetention || 0),
    );

  const montoNeto = Math.round((transaction.originalAmount ?? 0) - totalReal);

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

    // ── Actualizar destinationAmount con tasa Vita en vivo ───────────────────
    // Garantiza que el ledger y la notificación al usuario reflejen el monto
    // real que Vita aplicará, no el estimado de la cotización (que puede ser
    // de hace horas en corredores con payin manual como Bolivia).
    // Se hace UNA sola llamada a getPrices() aquí y se reutiliza en tryProvider.
    let sharedLivePrices = null;
    if (payoutMethod === 'vitaWallet') {
      try {
        sharedLivePrices = await getPrices();
        const destKey     = (transaction.destinationCountry ?? '').toLowerCase();
        const destCountryUpper = destKey.toUpperCase();
        const vitaAttrsSource  = VITA_SENT_ONLY_COUNTRIES.has(destCountryUpper)
          ? sharedLivePrices?.vita_sent?.prices?.attributes
          : sharedLivePrices?.withdrawal?.prices?.attributes;
        const vitaAttrs = vitaAttrsSource ?? sharedLivePrices?.withdrawal?.prices?.attributes;
        let   liveDestAmount = null;

        if (vitaCurrency === 'usd') {
          // BOB corredor: payoutAmountUSD (USDC ≈ USD) × usdToDestRate
          const clpToDest = Number(vitaAttrs?.clp_sell?.[destKey] ?? NaN);
          const clpToUsd  = Number(vitaAttrs?.clp_sell?.['us']    ?? NaN);
          if (isFinite(clpToDest) && isFinite(clpToUsd) && clpToUsd > 0) {
            const usdToDestRate = clpToDest / clpToUsd;
            const vitaFee       = Number(vitaAttrs?.fixed_cost?.[destKey] ?? 0) || (corridor.payoutFeeFixed ?? 0);
            liveDestAmount = Math.round((payoutAmountUSD * usdToDestRate - vitaFee) * 100) / 100;
          }
        } else {
          // CLP/USD corredor estándar: netCLP × clpToDestRate
          const clpToDestRate = Number(vitaAttrs?.clp_sell?.[destKey] ?? NaN);
          const vitaFee       = Number(vitaAttrs?.fixed_cost?.[destKey] ?? 0) || (corridor.payoutFeeFixed ?? 0);
          if (isFinite(clpToDestRate) && clpToDestRate > 0) {
            liveDestAmount = Math.round((payoutAmountUSD * clpToDestRate - vitaFee) * 100) / 100;
          }
        }

        if (liveDestAmount != null && liveDestAmount > 0) {
          transaction.destinationAmount    = liveDestAmount;
          transaction.exchangeRateLockedAt = new Date();
          await transaction.save();
          console.log('[dispatchPayout] destinationAmount actualizado con tasa Vita en vivo:', {
            transactionId: transaction.alytoTransactionId,
            liveDestAmount, payoutAmountUSD, vitaCurrency,
          });
        }
      } catch (priceErr) {
        // No-fatal: continuar con el destinationAmount de la cotización original
        console.warn('[dispatchPayout] No se pudo actualizar destinationAmount con tasa en vivo:', priceErr.message);
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
        return createDisbursement({
          amount:              payoutAmountUSD,
          destinationCountry:  transaction.destinationCountry,
          destinationCurrency: transaction.destinationCurrency,
          beneficiary:         beneficiaryFlat,
          alytoTransactionId:  transaction.alytoTransactionId,
          userId:              transaction.userId,
        });
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
              console.log('[Email] ✅ Fallido (todos los providers) →', user.email);
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
            console.log('[Email] ✅ Fallido →', user.email);
          }
        } catch (e) { console.error('[Email] Error failed (no fallback):', e.message); }
        return;
      }
    }

    // ── Payout aceptado por el proveedor ─────────────────────────────────
    console.log(`[dispatchPayout] ${providerUsed} aceptó payout ✅`);

    // Extraer referencia externa según proveedor
    if (providerUsed === 'vitaWallet') {
      console.log('[dispatchPayout] Respuesta Vita:', JSON.stringify(providerResponse?.data || providerResponse));
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
              console.log('[Email] ✅ Completado (sandbox) →', user.email);
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
    console.warn('[Alyto IPN/Vita] Firma inválida — rechazando petición.', {
      ip:   req.ip,
      body: JSON.stringify(req.body)?.slice(0, 200),
    });
    Sentry.captureMessage('IPN firma inválida recibida', {
      level: 'warning',
      extra: { body: req.body, ip: req.ip },
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
            console.log('[Email] ✅ Completado →', user.email);
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
  // Log inmediato — ANTES de cualquier validación para confirmar que el handler es alcanzado
  console.log('[Fintoc IPN] ⚡ Webhook recibido en /api/v1/ipn/fintoc');
  console.log('[Fintoc IPN] Headers:', JSON.stringify({
    'content-type':     req.headers['content-type'],
    'fintoc-signature': req.headers['fintoc-signature'],
    'user-agent':       req.headers['user-agent'],
  }));
  console.log('[Fintoc IPN] Body:', JSON.stringify(req.body));

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
  // ── 1. Verificar firma HMAC-SHA256 ────────────────────────────────────────
  const signature = req.headers['x-owlpay-signature'];
  const rawBody   = req.rawBody ?? JSON.stringify(req.body);

  if (!verifyOwlPayWebhookSignature(rawBody, signature)) {
    console.warn('[Alyto IPN/OwlPay] Firma inválida — rechazando petición.', {
      ip: req.ip,
    });
    Sentry.captureMessage('OwlPay IPN firma inválida', {
      level: 'warning',
      extra: { ip: req.ip, body: req.body },
    });
    return res.status(401).json({ error: 'Firma inválida.' });
  }

  const { event, data } = req.body;
  const disbursementId     = data?.id ?? data?.disbursement_id;
  const disbursementStatus = data?.status;

  console.info('[Alyto IPN/OwlPay] Webhook recibido.', { event, disbursementId, disbursementStatus });

  // ── 2. Buscar transacción por payoutReference ─────────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findOne({ payoutReference: disbursementId });
  } catch (err) {
    console.error('[Alyto IPN/OwlPay] Error buscando transacción:', {
      disbursementId,
      error: err.message,
    });
    return res.status(200).json({ received: true });
  }

  if (!transaction) {
    console.warn('[Alyto IPN/OwlPay] Transacción no encontrada para disbursementId:', disbursementId);
    return res.status(200).json({ received: true });
  }

  // ── 3. Registrar webhook en ipnLog ────────────────────────────────────────
  await appendIpnLog(transaction, 'owlpay_webhook_received', 'owlPay', disbursementStatus, req.body);

  try {
    // ── Caso A: desembolso completado ─────────────────────────────────────
    if (disbursementStatus === 'completed' && transaction.status === 'payout_sent') {
      transaction.status      = 'completed';
      transaction.completedAt = new Date();
      await transaction.save();

      await appendIpnLog(transaction, 'payout_completed', 'owlPay', 'completed', req.body);

      console.info('[Alyto IPN/OwlPay] Payout completado — transacción finalizada. ✅', {
        transactionId: transaction.alytoTransactionId,
        disbursementId,
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
          await transaction.save().catch(err =>
            console.error('[Alyto IPN/OwlPay] Error guardando stellarTxId:', err.message),
          );
          console.log('[Stellar] ✅ Audit trail registrado (OwlPay):', stellarTxId);
        }
      } catch (stellarErr) {
        console.error('[Alyto IPN/OwlPay] Error Stellar audit:', stellarErr.message);
      }

      // Push notification
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
        console.error('[Alyto IPN/OwlPay] Error push payment_completed:', notifErr.message);
      }

      // Email transaccional
      try {
        const user = await User.findById(transaction.userId).lean();
        if (user?.email) {
          await sendEmail(...EMAILS.paymentCompleted(user, transaction));
          console.log('[Email] ✅ Completado (OwlPay) →', user.email);
        }
      } catch (emailErr) {
        console.error('[Email] Error completado (OwlPay):', emailErr.message);
      }

    // ── Caso B: desembolso fallido ────────────────────────────────────────
    } else if (disbursementStatus === 'failed' && transaction.status === 'payout_sent') {
      transaction.status        = 'failed';
      transaction.failureReason = `Payout OwlPay denegado: ${data?.failure_reason ?? 'Sin detalle'}`;
      await transaction.save();

      await appendIpnLog(transaction, 'payout_failed', 'owlPay', 'failed', req.body);

      console.error('[Alyto IPN/OwlPay] Payout denegado — requiere revisión manual.', {
        transactionId: transaction.alytoTransactionId,
        disbursementId,
        failureReason: data?.failure_reason,
      });

      notifyAdminManualPayout(transaction).catch(() => {});

      try {
        await notify(
          transaction.userId,
          NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
        );
      } catch (notifErr) {
        console.error('[Alyto IPN/OwlPay] Error push payment_failed:', notifErr.message);
      }

      try {
        const user = await User.findById(transaction.userId).lean();
        if (user?.email) await sendEmail(...EMAILS.paymentFailed(user, transaction));
      } catch (emailErr) {
        console.error('[Email] Error fallido (OwlPay):', emailErr.message);
      }

    } else {
      // Evento no accionable en el estado actual (ej. duplicado o estado inesperado)
      console.info('[Alyto IPN/OwlPay] Evento no accionable — ignorando.', {
        transactionId:   transaction.alytoTransactionId,
        currentStatus:   transaction.status,
        disbursementStatus,
        event,
      });
    }
  } catch (err) {
    console.error('[Alyto IPN/OwlPay] Error procesando webhook:', {
      transactionId: transaction?.alytoTransactionId,
      error:         err.message,
    });
    Sentry.captureException(err, {
      tags:  { component: 'handleOwlPayIPN' },
      extra: { transactionId: transaction?.alytoTransactionId, disbursementId },
    });
  }

  return res.status(200).json({ received: true });
}
