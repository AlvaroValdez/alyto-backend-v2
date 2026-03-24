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
 * Resuelve el nombre completo del beneficiario soportando ambos formatos
 * del schema (campos nombrados del schema y campos dinámicos de Vita).
 *
 * @param {object} beneficiary
 * @returns {string}
 */
function resolveBeneficiaryName(beneficiary) {
  if (!beneficiary) return '';

  // Formato dinámico (Vita withdrawal_rules)
  if (beneficiary.beneficiary_first_name || beneficiary.beneficiary_last_name) {
    return `${beneficiary.beneficiary_first_name ?? ''} ${beneficiary.beneficiary_last_name ?? ''}`.trim();
  }

  // fullName explícito
  if (beneficiary.fullName) return beneficiary.fullName;

  // Formato schema nombrado
  return `${beneficiary.firstName ?? ''} ${beneficiary.lastName ?? ''}`.trim();
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
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_INITIATED,
      {
        userName:            user.firstName,
        transactionId:       transaction.alytoTransactionId,
        originAmount:        formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationAmount:   formatCurrency(transaction.destinationAmount, transaction.destinationCurrency),
        beneficiaryName:     resolveBeneficiaryName(transaction.beneficiary),
        corridorLabel:       `${transaction.originCurrency} → ${transaction.destinationCurrency}`,
        estimatedDelivery:   '1 día hábil',
        supportEmail:        process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
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
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_COMPLETED,
      {
        userName:          user.firstName,
        transactionId:     transaction.alytoTransactionId,
        originAmount:      formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationAmount: formatCurrency(transaction.destinationAmount, transaction.destinationCurrency),
        beneficiaryName:   resolveBeneficiaryName(transaction.beneficiary),
        completedAt:       formatDate(transaction.updatedAt),
        supportEmail:      process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
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
    return [
      user.email,
      process.env.SENDGRID_TEMPLATE_MANUAL_PAYIN,
      {
        userName:         user.firstName,
        transactionId:    transaction.alytoTransactionId,
        originAmount:     formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationCountry: transaction.destinationCountry,
        bankName:         instructions.bankName,
        accountHolder:    instructions.accountHolder,
        accountNumber:    instructions.accountNumber,
        accountType:      instructions.accountType,
        currency:         instructions.currency,
        reference:        instructions.reference,
        instructions:     instructions.instructions,
        supportEmail:     process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app',
        supportWhatsapp:  process.env.SUPPORT_WHATSAPP ?? '+56988321490',
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
   * @param {object} transaction
   * @returns {[string, string, object]}
   */
  adminBoliviaAlert(transaction) {
    return [
      process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
      process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA,
      {
        transactionId:     transaction.alytoTransactionId,
        originAmount:      formatCurrency(transaction.originalAmount, transaction.originCurrency),
        destinationAmount: formatCurrency(transaction.destinationAmount, transaction.destinationCurrency),
        beneficiary:       transaction.beneficiary,
        userId:            transaction.userId?.toString(),
        createdAt:         formatDate(transaction.createdAt),
        ledgerUrl:         `${process.env.APP_ADMIN_URL ?? 'http://localhost:3000'}/admin/ledger/${transaction.alytoTransactionId}`,
      },
    ];
  },
};
