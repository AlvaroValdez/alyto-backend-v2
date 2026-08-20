/**
 * marcar-reembolsada.mjs
 *
 * Deja constancia de que a la usuaria SÍ se le devolvió el dinero de una
 * transacción fallida, y actualiza lo que ve en la app.
 *
 * POR QUÉ HACE FALTA: `refunded` está en el enum de Transaction desde siempre pero
 * NINGÚN código lo asigna — no hay reversa automática. Una tx fallida y devuelta
 * quedaba idéntica a una fallida y no devuelta: la app le seguía diciendo
 * "nuestro equipo te contactará" cuando el dinero ya estaba de vuelta.
 *
 * NO mueve dinero. La devolución es una transferencia bancaria manual; esto solo
 * registra que ocurrió.
 *
 * Uso:
 *   node scripts/marcar-reembolsada.mjs ALY-C-... --ref "00071"
 *   node scripts/marcar-reembolsada.mjs ALY-C-... --ref "00071" --apply
 *   node scripts/marcar-reembolsada.mjs ALY-C-... --ref "00071" --apply --notificar
 *
 * --ref        referencia bancaria de la devolución (queda en el ipnLog, para auditoría)
 * --apply      escribe
 * --notificar  avisa a la usuaria por push + email
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';
import User from '../src/models/User.js';
import { notify } from '../src/services/notifications.js';
import { sendEmail, EMAILS } from '../src/services/email.js';

const TX_ID     = process.argv[2];
const APPLY     = process.argv.includes('--apply');
const NOTIFICAR = process.argv.includes('--notificar');
const REF       = (() => {
  const i = process.argv.indexOf('--ref');
  return i > -1 ? process.argv[i + 1] : null;
})();

function textoUsuaria(tx) {
  const monto = `${tx.originalAmount} ${tx.originCurrency}`;
  return {
    // El motivo del fallo NO se toca: sigue explicando qué pasó.
    accion: `Ya te devolvimos ${monto} a la cuenta desde la que hiciste la transferencia. ` +
            'Si no los ves reflejados o tienes dudas, escríbenos a soporte@alyto.app.',
  };
}

async function main() {
  if (!TX_ID) {
    console.error('Falta el alytoTransactionId.\n  node scripts/marcar-reembolsada.mjs ALY-C-... --ref "00071" [--apply] [--notificar]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  const tx = await Transaction.findOne({ alytoTransactionId: TX_ID });
  if (!tx) { console.log('Transacción no encontrada.'); return cerrar(); }

  if (!['failed', 'expired'].includes(tx.status)) {
    console.log(`⚠️  Está en "${tx.status}", no en failed. Una tx que no falló no se reembolsa por aquí.`);
    return cerrar();
  }

  const { accion } = textoUsuaria(tx);

  console.log(`  monto devuelto : ${tx.originalAmount} ${tx.originCurrency}`);
  console.log(`  ref. bancaria  : ${REF ?? '(sin especificar — recomendable pasar --ref)'}`);
  console.log(`\n  ── quedará así ──`);
  console.log(`  status            : refunded   (la app muestra "Reembolsada")`);
  console.log(`  userFailureReason : ${tx.userFailureReason ?? '—'}   ← sin cambios, sigue explicando qué pasó`);
  console.log(`  userFailureAction : ${accion}`);
  console.log(`  notificación      : ${NOTIFICAR ? 'SÍ — push + email' : 'no (usar --notificar)'}`);

  if (!APPLY) { console.log('\nDry-run. Re-ejecutar con --apply.'); return cerrar(); }

  tx.status            = 'refunded';
  tx.userFailureAction = accion;
  tx.failureRetryable  = false;
  tx.ipnLog            = tx.ipnLog ?? [];
  tx.ipnLog.push({
    provider: 'manual', eventType: 'refund_manual', status: 'refunded',
    rawPayload: { fuente: 'marcar-reembolsada.mjs', monto: tx.originalAmount,
                  moneda: tx.originCurrency, referenciaBancaria: REF },
    receivedAt: new Date(),
  });
  await tx.save();
  console.log('\n✓ Marcada como reembolsada.');

  if (!NOTIFICAR) { console.log('  (sin avisar a la usuaria)'); return cerrar(); }

  try {
    await notify(tx.userId, {
      title: 'Te devolvimos tu dinero',
      body:  `${tx.originalAmount} ${tx.originCurrency} de la transferencia que no pudimos completar.`,
      data:  { transactionId: tx.alytoTransactionId, type: 'refund' },
    });
    console.log('✓ Push enviada.');
  } catch (e) { console.error('✗ Push falló:', e.message); }

  try {
    const user = await User.findById(tx.userId).lean();
    if (user?.email) { await sendEmail(...EMAILS.paymentFailed(user, tx)); console.log(`✓ Email enviado a ${user.email}.`); }
  } catch (e) { console.error('✗ Email falló:', e.message); }

  return cerrar();
}

function cerrar() { return mongoose.disconnect(); }

main().catch(err => { console.error(err); process.exit(1); });
