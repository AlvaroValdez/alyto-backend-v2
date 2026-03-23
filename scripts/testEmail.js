/**
 * testEmail.js — Smoke test para el servicio de email SendGrid.
 *
 * Llama directamente al SDK de SendGrid (sin el wrapper sendEmail)
 * para obtener el status HTTP real de la respuesta y detectar errores reales.
 *
 * SendGrid responde 202 Accepted cuando el email fue encolado para entrega.
 * Cualquier otro código o excepción se reporta como error.
 *
 * Uso: npm run email:test
 * Uso (template específico): npm run email:test -- initiated
 */

import 'dotenv/config';
import sgMail from '@sendgrid/mail';
import { EMAILS } from '../src/services/email.js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY ?? '');

// ─── Datos ficticios ──────────────────────────────────────────────────────────

const mockUser = {
  email:     process.env.SENDGRID_ADMIN_EMAIL,
  firstName: 'Alvaro',
};

const mockTransaction = {
  alytoTransactionId:  'TXN-TEST00001',
  originalAmount:       100000,
  originCurrency:       'CLP',
  destinationAmount:    404550,
  destinationCurrency:  'COP',
  destinationCountry:   'CO',
  status:               'payin_confirmed',
  userId:               '663f1a2bdeadbeefcafe0001',
  beneficiary: {
    fullName: 'Juan García de Prueba',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Mapa de templates ────────────────────────────────────────────────────────

const TESTS = {
  initiated: {
    label: 'paymentInitiated',
    args:  () => EMAILS.paymentInitiated(mockUser, mockTransaction),
  },
  completed: {
    label: 'paymentCompleted',
    args:  () => EMAILS.paymentCompleted(mockUser, mockTransaction),
  },
  failed: {
    label: 'paymentFailed',
    args:  () => EMAILS.paymentFailed(mockUser, mockTransaction),
  },
  bolivia: {
    label: 'adminBoliviaAlert',
    args:  () => EMAILS.adminBoliviaAlert({
      ...mockTransaction,
      beneficiary: {
        firstName:      'Juan',
        lastName:       'García de Prueba',
        documentType:   'CI',
        documentNumber: '12345678',
        bankCode:       'BNB',
        accountBank:    '1234567890',
        accountType:    'Cuenta de Ahorros',
        email:          'juan.garcia@ejemplo.com',
      },
    }),
  },
};

// ─── Ejecución ────────────────────────────────────────────────────────────────

async function main() {
  const target = process.argv[2];

  const toRun = target
    ? Object.entries(TESTS).filter(([key]) => key === target)
    : Object.entries(TESTS);

  if (toRun.length === 0) {
    console.error(`❌ Template desconocido: "${target}"`);
    console.error(`   Opciones: ${Object.keys(TESTS).join(', ')}`);
    process.exit(1);
  }

  if (!process.env.SENDGRID_ADMIN_EMAIL) {
    console.error('❌ SENDGRID_ADMIN_EMAIL no está definido en .env');
    process.exit(1);
  }

  if (!process.env.SENDGRID_API_KEY) {
    console.error('❌ SENDGRID_API_KEY no está definido en .env');
    process.exit(1);
  }

  console.log(`\n🚀 Alyto Email Smoke Test — enviando a: ${mockUser.email}\n`);

  let passed = 0;
  let failed = 0;

  for (const [key, { label, args }] of toRun) {
    const [to, templateId, dynamicData] = args();

    const envKey = `SENDGRID_TEMPLATE_${key.toUpperCase()}`;
    if (!templateId) {
      console.log(`⚠️  ${label} — ${envKey} no configurado, omitido.`);
      continue;
    }

    const msg = {
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? 'pagos@alyto.app',
        name:  'Alyto',
      },
      templateId,
      dynamicTemplateData: dynamicData,
    };

    try {
      const [response] = await sgMail.send(msg);
      const status = response?.statusCode;

      if (status === 202) {
        console.log(`✅ ${label} — SendGrid aceptó (202) → ${to}`);
        passed++;
      } else {
        console.log(`⚠️  ${label} — respuesta inesperada: HTTP ${status}`);
        failed++;
      }
    } catch (err) {
      const status  = err?.response?.status ?? err?.code ?? '?';
      const detail  = err?.response?.body?.errors?.[0]?.message ?? err.message;
      console.log(`❌ ${label} — HTTP ${status}: ${detail}`);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`   Resultado: ${passed} aceptados, ${failed} fallaron`);
  console.log(`─────────────────────────────────`);
  console.log(`\n   💡 "Aceptado" (202) = SendGrid encoló el email.`);
  console.log(`      Si no llega: revisar Activity Feed en sendgrid.com\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('❌ Error inesperado:', err.message);
  process.exit(1);
});
