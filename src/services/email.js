/**
 * email.js — Servicio de emails transaccionales vía SendGrid
 *
 * Todas las funciones de envío son fire-and-forget respecto al flujo principal:
 * nunca lanzan excepción. Los errores se loguean en Sentry con contexto.
 *
 * Uso:
 *   import { sendEmail, EMAILS } from './email.js';
 *   await sendEmail(...EMAILS.paymentInitiated(user, transaction));
 */

import sgMail from '@sendgrid/mail';
import Sentry  from './sentry.js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY ?? '');

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Formatea un monto monetario según la moneda.
 *   CLP → "$100.000 CLP"
 *   COP → "$404.550 COP"
 *   USD → "$100.00 USD"
 *
 * @param {number} amount
 * @param {string} currency — código ISO 4217 (CLP, COP, USD, BOB, etc.)
 * @returns {string}
 */
function formatCurrency(amount, currency) {
  if (amount == null || !currency) return `${amount ?? ''} ${currency ?? ''}`.trim();

  const iso = currency.toUpperCase();

  // Monedas sin decimales (enteros)
  const noDecimals = ['CLP', 'COP', 'PYG', 'VND'];

  const formatted = new Intl.NumberFormat('es-CL', {
    style:                 'decimal',
    minimumFractionDigits: noDecimals.includes(iso) ? 0 : 2,
    maximumFractionDigits: noDecimals.includes(iso) ? 0 : 2,
  }).format(amount);

  return `$${formatted} ${iso}`;
}

/**
 * Formatea una fecha en español chileno.
 *   → "20 de marzo de 2026, 14:35 hrs"
 *
 * @param {Date|string} date
 * @returns {string}
 */
function formatDate(date) {
  if (!date) return '';

  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);

  const datePart = new Intl.DateTimeFormat('es-CL', {
    day:   'numeric',
    month: 'long',
    year:  'numeric',
  }).format(d);

  const timePart = new Intl.DateTimeFormat('es-CL', {
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

  return `${datePart}, ${timePart} hrs`;
}

/**
 * Resuelve el nombre completo del beneficiario soportando todos los formatos:
 *   - dynamicFields (Bolivia manual / Vita)
 *   - campos nombrados del schema (formato legado)
 *   - fullName explícito
 *
 * @param {object} beneficiary — sub-documento del beneficiario
 * @returns {string}
 */
function resolveBeneficiaryName(beneficiary) {
  if (!beneficiary) return '';

  // Formato Bolivia / Vita: campos en dynamicFields
  const df = beneficiary.dynamicFields ?? {};
  if (df.beneficiary_first_name || df.beneficiary_last_name) {
    return `${df.beneficiary_first_name ?? ''} ${df.beneficiary_last_name ?? ''}`.trim();
  }

  // Formato dinámico plano (llaves al nivel del objeto)
  if (beneficiary.beneficiary_first_name || beneficiary.beneficiary_last_name) {
    return `${beneficiary.beneficiary_first_name ?? ''} ${beneficiary.beneficiary_last_name ?? ''}`.trim();
  }

  // fullName explícito
  if (beneficiary.fullName) return beneficiary.fullName;

  // Formato schema nombrado
  return `${beneficiary.firstName ?? ''} ${beneficiary.lastName ?? ''}`.trim();
}

/**
 * Enmascara el nombre para privacidad: "Carlos García" → "C***** G*****"
 *
 * @param {string} name
 * @returns {string}
 */
function maskName(name) {
  if (!name) return '—';
  return name
    .split(' ')
    .filter(Boolean)
    .map(word => word[0] + '*'.repeat(Math.max(word.length - 1, 2)))
    .join(' ');
}

/**
 * Enmascara un documento de identidad: "12345678" → "123*****"
 *
 * @param {string} doc
 * @returns {string}
 */
function maskDocument(doc) {
  if (!doc) return '—';
  const s = String(doc);
  const visible = Math.min(3, Math.floor(s.length / 2));
  return s.slice(0, visible) + '*'.repeat(s.length - visible);
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Envía un email transaccional usando una Dynamic Template de SendGrid.
 * Nunca lanza excepción — maneja errores internamente.
 *
 * @param {string} to          — Email destinatario
 * @param {string} templateId  — ID del Dynamic Template en SendGrid
 * @param {object} dynamicData — Variables dinámicas del template
 */
export async function sendEmail(to, templateId, dynamicData) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[Alyto Email] SENDGRID_API_KEY no configurado — email omitido.', {
      to,
      templateId,
    });
    return;
  }

  const msg = {
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@alyto.app',
      name:  'Alyto',
    },
    templateId,
    dynamicTemplateData: dynamicData,
  };

  try {
    await sgMail.send(msg);
    console.info('[Alyto Email] Email enviado.', { to, templateId });
  } catch (err) {
    console.error('[Alyto Email] Error enviando email:', {
      to,
      templateId,
      error: err.message,
    });
    Sentry.captureException(err, {
      tags:  { component: 'emailService' },
      extra: { to, templateId },
    });
  }
}

/**
 * Envía un email con HTML inline (sin SendGrid Dynamic Template).
 * Útil para alertas admin que no necesitan template formal.
 * Nunca lanza excepción.
 *
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 */
export async function sendRawEmail(to, subject, html) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[Alyto Email] SENDGRID_API_KEY no configurado — email raw omitido.', { to, subject });
    return;
  }
  try {
    await sgMail.send({
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@alyto.app',
        name:  'Alyto',
      },
      subject,
      html,
    });
    console.info('[Alyto Email] Email raw enviado.', { to, subject });
  } catch (err) {
    console.error('[Alyto Email] Error enviando email raw:', { to, subject, error: err.message });
    Sentry.captureException(err, { tags: { component: 'emailService' }, extra: { to, subject } });
  }
}

/**
 * Envía el email de bienvenida. Usa SendGrid Dynamic Template si
 * SENDGRID_TEMPLATE_WELCOME está configurado; si no, envía HTML inline
 * (idéntico tono y estructura que otros emails transaccionales).
 */
export async function sendWelcomeEmail(user) {
  const entityName = {
    SpA: 'AV Finance SpA',
    SRL: 'AV Finance SRL',
    LLC: 'AV Finance LLC',
  }[user.legalEntity] ?? 'AV Finance';

  const verifyUrl    = `${process.env.APP_URL ?? 'https://alyto.app'}/kyc`;
  const supportEmail = process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app';

  if (process.env.SENDGRID_TEMPLATE_WELCOME) {
    return sendEmail(user.email, process.env.SENDGRID_TEMPLATE_WELCOME, {
      userName:        user.firstName,
      entityName,
      legalEntity:     user.legalEntity,
      verifyUrl,
      supportEmail,
      supportWhatsapp: process.env.SUPPORT_WHATSAPP ?? '+56988321490',
    });
  }

  const subject = `Bienvenido a Alyto, ${user.firstName} 👋`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;background:#F8FAFC;">
      <div style="background:#0B1526;padding:32px 24px;text-align:center;">
        <h1 style="color:#FFFFFF;margin:0;font-size:24px;letter-spacing:-0.5px;">Alyto</h1>
      </div>
      <div style="background:#FFFFFF;padding:32px 24px;color:#0F1B2E;">
        <h2 style="margin:0 0 16px;font-size:22px;">Hola ${user.firstName}, bienvenido a Alyto Wallet.</h2>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#3B4A63;">
          Tu cuenta ha sido creada bajo <strong>${entityName}</strong>.
        </p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#3B4A63;">
          El siguiente paso es verificar tu identidad para comenzar a enviar dinero.
        </p>
        <a href="${verifyUrl}"
           style="display:inline-block;background:#1D9E75;color:#FFFFFF;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">
          Verificar identidad
        </a>
        <p style="margin:32px 0 0;font-size:13px;color:#64748B;">
          ¿Dudas? Escríbenos a <a href="mailto:${supportEmail}" style="color:#1D9E75;">${supportEmail}</a>.
        </p>
      </div>
      <div style="padding:16px 24px;text-align:center;font-size:12px;color:#94A3B8;">
        Este email fue enviado a ${user.email}. © ${new Date().getFullYear()} Alyto.
      </div>
    </div>
  `;
  return sendRawEmail(user.email, subject, html);
}

// ─── Emails predefinidos ──────────────────────────────────────────────────────

/**
 * Colección de emails transaccionales predefinidos.
 * Cada función retorna [to, templateId, dynamicData] para hacer spread en sendEmail.
 *
 * Uso: await sendEmail(...EMAILS.paymentInitiated(user, transaction))
 */
export const EMAILS = {

  /**
   * Notifica al usuario que su pago cross-border fue iniciado (payin confirmado).
   *
   * @param {object} user        — Documento User de Mongoose
   * @param {object} transaction — Documento Transaction de Mongoose
   * @returns {[string, string, object]}
   */
  paymentInitiated(user, transaction) {
    const destAmount = transaction.destinationAmount != null
      ? formatCurrency(transaction.destinationAmount, transaction.destinationCurrency)
      : null;

    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_INITIATED,
      {
        userName:            user.firstName,
        transactionId:       transaction.alytoTransactionId,
        originAmount:        formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationAmount:   destAmount,
        destinationCurrency: transaction.destinationCurrency,
        beneficiaryName:     resolveBeneficiaryName(transaction.beneficiary),
        corridorLabel:       `${transaction.originCurrency} → ${transaction.destinationCurrency}`,
        estimatedDelivery:   '1 día hábil',
        createdAt:           formatDate(transaction.createdAt),
        supportEmail:        process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp:     process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  /**
   * Notifica al usuario que su pago fue completado y el dinero llegó al beneficiario.
   *
   * @param {object} user
   * @param {object} transaction
   * @returns {[string, string, object]}
   */
  paymentCompleted(user, transaction) {
    const destAmount = transaction.destinationAmount != null
      ? formatCurrency(transaction.destinationAmount, transaction.destinationCurrency)
      : null;

    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_COMPLETED,
      {
        userName:            user.firstName,
        transactionId:       transaction.alytoTransactionId,
        originAmount:        formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationAmount:   destAmount,
        destinationCurrency: transaction.destinationCurrency,
        beneficiaryName:     resolveBeneficiaryName(transaction.beneficiary),
        corridorLabel:       `${transaction.originCurrency} → ${transaction.destinationCurrency}`,
        completedAt:         formatDate(transaction.updatedAt),
        supportEmail:        process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp:     process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  /**
   * Notifica al usuario que su pago falló.
   *
   * @param {object} user
   * @param {object} transaction
   * @returns {[string, string, object]}
   */
  paymentFailed(user, transaction) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_FAILED,
      {
        userName:        user.firstName,
        transactionId:   transaction.alytoTransactionId,
        originAmount:    formatCurrency(transaction.originalAmount, transaction.originCurrency),
        failedAt:        formatDate(transaction.updatedAt),
        supportEmail:    process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp: process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  /**
   * Envía al usuario las instrucciones de transferencia bancaria para su payin manual.
   * Usado cuando el corredor tiene payinMethod: 'manual' (SRL Bolivia).
   *
   * @param {object} user
   * @param {object} transaction
   * @param {object} instructions — Objeto con datos bancarios
   * @returns {[string, string, object]}
   */
  manualPayinInstructions(user, transaction, instructions) {
    const destAmount = transaction.destinationAmount != null
      ? formatCurrency(transaction.destinationAmount, transaction.destinationCurrency)
      : null;

    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_MANUAL_PAYIN ?? process.env.SENDGRID_TEMPLATE_INITIATED,
      {
        userName:           user.firstName,
        transactionId:      transaction.alytoTransactionId,

        // Monto que el usuario debe transferir
        originAmount:       formatCurrency(transaction.originalAmount, transaction.originCurrency),
        // Monto que recibirá el beneficiario en destino
        destinationAmount:  destAmount,
        destinationCurrency: transaction.destinationCurrency ?? 'BOB',
        destinationCountry: transaction.destinationCountry,

        // Datos bancarios de AV Finance SRL (cuenta receptora)
        bankName:           instructions.bankName,
        accountHolder:      instructions.accountHolder,
        accountNumber:      instructions.accountNumber,
        accountType:        instructions.accountType,
        currency:           instructions.currency,

        // Referencia obligatoria en el concepto de la transferencia
        reference:          instructions.reference,
        concept:            instructions.concept ?? instructions.reference,
        instructions:       instructions.instructions,

        // Fecha y soporte
        createdAt:          formatDate(transaction.createdAt),
        supportEmail:       process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp:    process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  /**
   * Alerta al admin que hay un payin manual pendiente de verificar (SRL Bolivia).
   *
   * @param {object} transaction
   * @param {object} instructions
   * @returns {[string, string, object]}
   */
  adminManualPayinAlert(transaction, instructions) {
    return [
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      process.env.SENDGRID_TEMPLATE_ADMIN_MANUAL_PAYIN ?? process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA,
      {
        transactionId:     transaction.alytoTransactionId,
        originAmount:      formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationCountry: transaction.destinationCountry,
        userId:            transaction.userId?.toString(),
        bankName:          instructions.bankName,
        accountNumber:     instructions.accountNumber,
        reference:         instructions.reference,
        createdAt:         formatDate(transaction.createdAt),
        ledgerUrl:         `${process.env.APP_ADMIN_URL ?? 'http://localhost:3000'}/admin/ledger/${transaction.alytoTransactionId}`,
      },
    ];
  },

  /**
   * Alerta al equipo admin que hay un payout manual pendiente en Bolivia.
   * Reemplaza el email HTML inline de notifyAdminManualPayout().
   *
   * Los datos del beneficiario Bolivia se almacenan en transaction.beneficiary.dynamicFields
   * (formato beneficiaryData dinámico). Este método los aplana para el template.
   *
   * @param {object} transaction
   * @returns {[string, string, object]}
   */
  adminBoliviaAlert(transaction) {
    const ben = transaction.beneficiary ?? {};
    const df  = ben.dynamicFields ?? {};

    // Nombre completo desde dynamicFields o campos nombrados
    const fullName = resolveBeneficiaryName(transaction.beneficiary);
    const maskedName = maskName(fullName);

    // Documento (CI Bolivia)
    const docRaw = df.beneficiary_document ?? df.beneficiary_document_number
      ?? ben.documentNumber ?? '';
    const maskedDoc = maskDocument(docRaw);

    // Email del beneficiario (si existe)
    const beneficiaryEmail = df.beneficiary_email ?? ben.email ?? '';

    // Banco / cuenta: Bolivia manual no tiene banco del beneficiario (pago en efectivo / Tigo)
    const bankName     = df.beneficiary_bank ?? ben.bankCode ?? '—';
    const accountInfo  = df.beneficiary_account ?? ben.accountBank ?? '';

    // Teléfono
    const phone = df.beneficiary_phone ?? ben.phone ?? '';

    // Monto destino — puede estar como quotedDestAmount o calculado
    const destAmount = transaction.destinationAmount != null
      ? formatCurrency(transaction.destinationAmount, transaction.destinationCurrency)
      : `— ${transaction.destinationCurrency ?? 'BOB'}`;

    return [
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA,
      {
        transactionId:     transaction.alytoTransactionId,
        originAmount:      formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationAmount: destAmount,
        destinationCurrency: transaction.destinationCurrency ?? 'BOB',

        // Beneficiario — datos enmascarados
        beneficiaryName:    maskedName,
        beneficiaryDoc:     maskedDoc,
        beneficiaryBank:    bankName,
        beneficiaryAccount: accountInfo || '—',
        beneficiaryEmail:   beneficiaryEmail || '—',
        beneficiaryPhone:   phone || '—',

        userId:    transaction.userId?.toString(),
        createdAt: formatDate(transaction.createdAt),
        ledgerUrl: `${process.env.APP_ADMIN_URL ?? 'http://localhost:3000'}/admin/ledger/${transaction.alytoTransactionId}`,
      },
    ];
  },

  // ── CLP → BOB (SpA manual payin) ──────────────────────────────────────────

  /**
   * Instrucciones de transferencia CLP al usuario para corredor cl-bo manual.
   *
   * @param {object} user
   * @param {object} transaction
   * @param {object} spaCfg — SpAConfig con datos bancarios
   * @returns {[string, string, object]}
   */
  clpBobPayinInstructions(user, transaction, spaCfg) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_CLP_BOB_INSTRUCTIONS,
      {
        userName:        user.firstName,
        amount:          formatCurrency(transaction.originalAmount, 'CLP'),
        paymentRef:      transaction.paymentInstructions?.reference ?? transaction.alytoTransactionId,
        bankName:        spaCfg.bankName,
        accountType:     spaCfg.accountType,
        accountNumber:   spaCfg.accountNumber,
        rut:             spaCfg.rut,
        accountHolder:   spaCfg.accountHolder,
        bankEmail:       spaCfg.bankEmail,
        totalDeducted:   formatCurrency(transaction.fees?.totalDeducted, 'CLP'),
        destinationBOB:  formatCurrency(transaction.destinationAmount, 'BOB'),
        clpPerBob:       (transaction.exchangeRate ?? 0).toFixed(2),
        createdAt:       formatDate(transaction.createdAt),
        supportEmail:    process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
      },
    ];
  },

  /**
   * Alerta admin: nuevo pago CLP→BOB pendiente de verificacion.
   *
   * @param {object} transaction
   * @param {object} user
   * @returns {[string, string, object]}
   */
  adminClpBobAlert(transaction, user) {
    const ben = transaction.beneficiary?.dynamicFields ?? transaction.beneficiary ?? {};
    return [
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      process.env.SENDGRID_TEMPLATE_ADMIN_CLP_BOB,
      {
        transactionId:   transaction.alytoTransactionId,
        userName:        `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim(),
        userEmail:       user?.email ?? '',
        amount:          formatCurrency(transaction.originalAmount, 'CLP'),
        paymentRef:      transaction.paymentInstructions?.reference ?? '',
        beneficiaryType: ben.type ?? 'bank_data',
        beneficiaryName: `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim(),
        bankName:        ben.bankName ?? '',
        accountNumber:   ben.accountNumber ?? '',
        hasProof:        transaction.paymentProof?.data ? 'Si' : 'No',
        ledgerUrl:       `${process.env.FRONTEND_URL ?? ''}/admin/transactions`,
        createdAt:       formatDate(transaction.createdAt),
      },
    ];
  },

  /**
   * Confirmacion al usuario de payout completado CLP→BOB.
   *
   * @param {object} user
   * @param {object} transaction
   * @returns {[string, string, object]}
   */
  clpBobPayoutCompleted(user, transaction) {
    const ben = transaction.beneficiary?.dynamicFields ?? transaction.beneficiary ?? {};
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_CLP_BOB_COMPLETED,
      {
        userName:        user.firstName,
        destinationBOB:  formatCurrency(transaction.destinationAmount, 'BOB'),
        beneficiaryName: `${ben.firstName ?? ''} ${ben.lastName ?? ''}`.trim(),
        transactionId:   transaction.alytoTransactionId,
        completedAt:     formatDate(transaction.updatedAt),
        supportEmail:    process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
      },
    ];
  },

  // ── Welcome — Bienvenida al registro ──────────────────────────────────────

  /**
   * Email de bienvenida tras registro exitoso.
   *
   * @param {object} user — Documento User recién creado
   * @returns {[string, string, object]}
   */
  welcome(user) {
    const entityName = {
      SpA: 'AV Finance SpA',
      SRL: 'AV Finance SRL',
      LLC: 'AV Finance LLC',
    }[user.legalEntity] ?? 'AV Finance';

    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_WELCOME,
      {
        userName:      user.firstName,
        entityName,
        legalEntity:   user.legalEntity,
        verifyUrl:     `${process.env.APP_URL ?? 'https://alyto.app'}/kyc`,
        supportEmail:  process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp: process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  // ── Wallet — Depósito acreditado ────────────────────────────────────────────

  /**
   * Notifica al usuario que su depósito BOB fue acreditado.
   *
   * @param {object} user
   * @param {object} params
   * @param {number} params.amount
   * @param {string} params.currency
   * @param {number} params.newBalance
   * @param {string} params.wtxId
   * @returns {[string, string, object]}
   */
  walletDepositConfirmed(user, { amount, currency, newBalance, wtxId }) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_DEPOSIT_CONFIRMED,
      {
        userName:     user.firstName,
        amount:       formatCurrency(amount, currency),
        currency,
        newBalance:   formatCurrency(newBalance, currency),
        wtxId,
        confirmedAt:  formatDate(new Date()),
        supportEmail: process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
      },
    ];
  },

  // ── KYB — Cuentas Business ────────────────────────────────────────────────

  /**
   * Notifica al usuario que su solicitud KYB fue recibida y está en revisión.
   *
   * @param {object} user    — Documento User
   * @param {object} profile — Documento BusinessProfile
   * @returns {[string, string, object]}
   */
  kybReceived(user, profile) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_KYB_RECEIVED,
      {
        userName:    user.firstName,
        businessId:  profile.businessId,
        legalName:   profile.legalName ?? profile.tradeName ?? 'tu empresa',
        submittedAt: formatDate(profile.createdAt ?? new Date()),
        statusUrl:   `${process.env.APP_URL ?? 'https://alyto.app'}/business/kyb-status`,
        supportEmail: process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
      },
    ];
  },

  /**
   * Notifica al usuario que su cuenta Business fue aprobada.
   *
   * @param {object} user
   * @param {object} profile
   * @returns {[string, string, object]}
   */
  kybApproved(user, profile) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_KYB_APPROVED,
      {
        userName:              user.firstName,
        businessId:            profile.businessId,
        legalName:             profile.legalName ?? profile.tradeName,
        maxSingleTransaction:  formatCurrency(
          profile.transactionLimits?.maxSingleTransaction ?? 50_000, 'USD',
        ),
        maxMonthlyVolume:      formatCurrency(
          profile.transactionLimits?.maxMonthlyVolume ?? 80_000, 'USD',
        ),
        kybNote:     profile.kybNote ?? null,
        approvedAt:  formatDate(profile.kybReviewedAt ?? new Date()),
        dashboardUrl: `${process.env.APP_URL ?? 'https://alyto.app'}/dashboard`,
        supportEmail: process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
      },
    ];
  },

  /**
   * Notifica al usuario que su solicitud KYB fue rechazada.
   *
   * @param {object} user
   * @param {object} profile
   * @returns {[string, string, object]}
   */
  kybRejected(user, profile) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_KYB_REJECTED,
      {
        userName:          user.firstName,
        businessId:        profile.businessId,
        legalName:         profile.legalName ?? profile.tradeName,
        rejectionReason:   profile.kybRejectionReason ?? 'No especificada.',
        kybNote:           profile.kybNote ?? null,
        rejectedAt:        formatDate(profile.kybReviewedAt ?? new Date()),
        supportEmail:      process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp:   process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  /**
   * Notifica al usuario que se requiere información adicional para su KYB.
   *
   * @param {object} user
   * @param {object} profile
   * @returns {[string, string, object]}
   */
  kybMoreInfo(user, profile) {
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_KYB_MORE_INFO,
      {
        userName:          user.firstName,
        businessId:        profile.businessId,
        legalName:         profile.legalName ?? profile.tradeName,
        kybNote:           profile.kybNote ?? 'Por favor sube los documentos faltantes.',
        uploadUrl:         `${process.env.APP_URL ?? 'https://alyto.app'}/business/kyb-documents`,
        supportEmail:      process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp:   process.env.SUPPORT_WHATSAPP ?? '+56988321490',
      },
    ];
  },

  /**
   * Alerta al admin que hay una nueva solicitud KYB para revisar.
   *
   * @param {object} user    — Usuario que envió la solicitud
   * @param {object} profile — BusinessProfile creado
   * @returns {[string, string, object]}
   */
  adminKybAlert(user, profile) {
    return [
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      process.env.SENDGRID_TEMPLATE_ADMIN_KYB,
      {
        userName:              `${user.firstName} ${user.lastName}`,
        userEmail:             user.email,
        businessId:            profile.businessId,
        legalName:             profile.legalName ?? profile.tradeName ?? 'Sin razón social',
        country:               profile.countryOfIncorporation ?? profile.country ?? '—',
        estimatedMonthlyVolume: profile.estimatedMonthlyVolume ?? '—',
        businessType:          profile.businessType ?? '—',
        documentsCount:        profile.documents?.length ?? 0,
        submittedAt:           formatDate(profile.createdAt ?? new Date()),
        reviewUrl:             `${process.env.APP_ADMIN_URL ?? 'http://localhost:3000'}/admin/kyb/${profile.businessId}`,
      },
    ];
  },

  /**
   * Alerta admin: enviar USDC manualmente a Harbor (instruction_address).
   * Usa sendRawEmail (inline HTML) porque aún no existe SendGrid template.
   *
   * @param {{ transaction: object, transfer: object, quote: object }} ctx
   * @returns {[string, string, string]} — args para sendRawEmail(to, subject, html)
   */
  adminUSDCSendRequired({ transaction, transfer, quote }) {
    const ben         = transaction.beneficiary ?? transaction.beneficiaryDetails ?? {};
    const beneName    = resolveBeneficiaryName(ben) || '—';
    const destAmount  = formatCurrency(quote?.destinationAmount, quote?.destinationCurrency ?? transaction.destinationCurrency);
    const expiresStr  = transfer?.expiresAt ? formatDate(transfer.expiresAt) : '—';
    const ledgerUrl   = `${process.env.APP_ADMIN_URL ?? 'http://localhost:3000'}/admin/ledger/${transaction.alytoTransactionId}`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 640px; margin: auto; background: #0A1A2F; color: #E8ECF3; border-radius: 12px; overflow: hidden;">
        <div style="background: #B91C1C; padding: 20px 24px;">
          <h1 style="margin:0; font-size: 20px; color: #fff;">USDC Manual Send Required</h1>
          <p style="margin: 6px 0 0; font-size: 13px; color: #FCA5A5;">Transaction ${transaction.alytoTransactionId}</p>
        </div>
        <div style="padding: 24px;">
          <p style="margin-top:0;">Harbor ha emitido una instruction_address para esta transferencia. Alyto debe enviar USDC antes del vencimiento para evitar la expiración del transfer.</p>
          <table style="width:100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
            <tr><td style="padding:8px 0; color:#8A96B8;">Transaction ID</td><td style="padding:8px 0;"><code style="background:#1E293B; padding:2px 6px; border-radius:4px;">${transaction.alytoTransactionId}</code></td></tr>
            <tr><td style="padding:8px 0; color:#8A96B8;">Monto a enviar</td><td style="padding:8px 0;"><strong>${Number(transfer?.sourceAmount ?? 0).toFixed(6)} USDC</strong></td></tr>
            <tr><td style="padding:8px 0; color:#8A96B8;">Dirección destino</td><td style="padding:8px 0;"><code style="background:#1E293B; padding:2px 6px; border-radius:4px; word-break:break-all;">${transfer?.instructionAddress ?? '—'}</code></td></tr>
            <tr><td style="padding:8px 0; color:#8A96B8;">Memo</td><td style="padding:8px 0;"><code style="background:#1E293B; padding:2px 6px; border-radius:4px;">${transfer?.instructionMemo ?? 'none required'}</code></td></tr>
            <tr><td style="padding:8px 0; color:#8A96B8;">Chain</td><td style="padding:8px 0;">${transfer?.instructionChain ?? '—'}</td></tr>
            <tr><td style="padding:8px 0; color:#8A96B8;">⏰ Expira</td><td style="padding:8px 0; color:#FCA5A5;"><strong>${expiresStr}</strong></td></tr>
          </table>
          <hr style="border:none; border-top: 1px solid #1E293B;">
          <p style="font-size:13px; color:#8A96B8;">Beneficiario: <strong style="color:#E8ECF3;">${beneName}</strong> → <strong style="color:#E8ECF3;">${destAmount}</strong> en ${transaction.destinationCountry ?? '—'}</p>
          <div style="background:#7F1D1D; border-left: 4px solid #EF4444; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
            <strong>⚠️ WARNING:</strong> This transfer will EXPIRE if USDC is not sent before the deadline.
          </div>
          <a href="${ledgerUrl}" style="display:inline-block; background:#F5C518; color:#0A1A2F; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Abrir en Ledger</a>
        </div>
      </div>
    `;

    return [
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      `🔐 USDC Manual Send Required — ${transaction.alytoTransactionId}`,
      html,
    ];
  },
};
