/**
 * resolver-payout-denegado.mjs
 *
 * Cierra una transacción cuyo payout Vita fue DENEGADO pero quedó colgada en
 * payout_sent porque el IPN nunca llegó y el job de reconciliación leía el status
 * en la ruta equivocada del JSON.
 *
 * ⚠️ AUTOCONTENIDO A PROPÓSITO: extrae el status de la respuesta de Vita por su
 * cuenta, sin depender de extractVitaTxAttributes ni mapVitaIpnFailure. Así se
 * puede correr en el contenedor de producción ANTES de desplegar los arreglos.
 * Una vez desplegados, reconcileVitaTransfers cubre este caso solo y este script
 * deja de hacer falta.
 *
 * NO mueve dinero. Solo corrige el ESTADO y el mensaje que ven admin y usuaria.
 * La devolución de los BOB es una operación bancaria aparte.
 *
 * Uso (desde ~/alyto-v2):
 *   docker compose exec -T alyto-backend node scripts/resolver-payout-denegado.mjs ALY-C-...
 *   docker compose exec -T alyto-backend node scripts/resolver-payout-denegado.mjs ALY-C-... --apply
 *   docker compose exec -T alyto-backend node scripts/resolver-payout-denegado.mjs ALY-C-... --apply --notificar
 *
 * --apply      escribe el estado (sin avisar a la usuaria)
 * --notificar  además manda push + email de "transferencia fallida"
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';
import User from '../src/models/User.js';
import { getVitaTransaction } from '../src/services/vitaWalletService.js';
import { notify, NOTIFICATIONS } from '../src/services/notifications.js';
import { sendEmail, EMAILS } from '../src/services/email.js';

const TX_ID    = process.argv[2];
const APPLY    = process.argv.includes('--apply');
const NOTIFICAR = process.argv.includes('--notificar');
// --forzar: reescribe una tx que YA está en failed. Necesario cuando el job de
// reconciliación llegó primero y dejó un mensaje al usuario peor que el nuestro.
const FORZAR   = process.argv.includes('--forzar');

const ESTADOS_DENEGADOS = new Set([
  'denied', 'rejected', 'failed', 'canceled', 'cancelled', 'returned', 'expired',
]);

// ── Texto que verá la USUARIA en su app (TransactionDetail → "¿Qué pasó…") ────
// Revisar antes de correr con --notificar. Deliberadamente NO promete plazo ni
// monto: la devolución todavía es una decisión abierta.
const MENSAJE_USUARIA = 'No pudimos completar tu transferencia: nuestro proveedor de pagos en ' +
  'destino la rechazó y el dinero no llegó al beneficiario.';
const ACCION_USUARIA  = 'Tu dinero está resguardado y no se perdió. Nuestro equipo ya está ' +
  'revisando tu caso y te contactará. Si prefieres, escríbenos a soporte@alyto.app.';

function extraerAtributos(resp) {
  // Forma real: { transaction: { id, type, attributes: { status, included, … } } }
  return resp?.transaction?.attributes
      ?? resp?.data?.transaction?.attributes
      ?? resp?.data?.transaction
      ?? resp?.data
      ?? resp;
}

async function main() {
  if (!TX_ID) {
    console.error('Falta el alytoTransactionId.\n  node scripts/resolver-payout-denegado.mjs ALY-C-... [--apply] [--notificar]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  const tx = await Transaction.findOne({ alytoTransactionId: TX_ID });
  if (!tx)                 { console.log('Transacción no encontrada.'); return cerrar(); }
  if (tx.status === 'failed' && !FORZAR) {
    console.log(`Ya está en failed: "${String(tx.failureReason).slice(0, 120)}…"`);
    console.log(`  mensaje a la usuaria: "${tx.userFailureReason ?? '—'}"`);
    console.log('  Nada que hacer. Usar --forzar para reescribirlo.');
    return cerrar();
  }
  if (!tx.payoutReference) { console.log('Sin payoutReference — no se puede consultar a Vita.'); return cerrar(); }

  console.log(`  estado en Alyto : ${tx.status}`);
  console.log(`  payoutReference : ${tx.payoutReference}`);
  console.log(`  monto           : ${tx.originalAmount} ${tx.originCurrency} → prometido ${tx.destinationAmount} ${tx.destinationCurrency}\n`);

  const attrs  = extraerAtributos(await getVitaTransaction(tx.payoutReference));
  const estado = String(attrs?.status ?? '').toLowerCase();
  const w      = attrs?.included?.withdrawal ?? attrs?.included?.vita_sent ?? {};
  const motivo = w.reject_motive ?? attrs?.reject_motive ?? null;

  console.log(`  estado en Vita  : ${estado || '(vacío)'}`);
  console.log(`  reject_motive   : ${motivo ?? '(Vita no registró motivo)'}`);
  if (w.total_sent != null) {
    console.log(`  Vita iba a entregar: ${w.total_sent} ${(w.currency ?? '').toUpperCase()}` +
                ` (bruto ${w.total_without_fixed_cost}, fija ${w.fixed_cost})`);
  }

  if (!ESTADOS_DENEGADOS.has(estado)) {
    console.log(`\n⚠️  Vita NO lo da por rechazado (status="${estado}"). No se toca nada.`);
    return cerrar();
  }

  // Mensaje técnico para admin: si Vita no dio motivo, se guarda su registro crudo
  // — perder el dato es peor que guardar JSON.
  const detalle = motivo ?? JSON.stringify({
    status: estado, total_sent: w.total_sent, fixed_cost: w.fixed_cost,
    total_without_fixed_cost: w.total_without_fixed_cost, statuses: attrs?.statuses,
  }).slice(0, 500);

  const adminMsg = `Payout rechazado por Vita (status="${estado}"): ${detalle}` +
    ' · Cerrado manualmente con resolver-payout-denegado.mjs: el IPN nunca llegó y ' +
    'reconcileVitaTransfers leía el status en la ruta equivocada del JSON.';

  console.log(`\n  ── quedará así ──`);
  console.log(`  status            : failed`);
  console.log(`  failureReason     : ${adminMsg.slice(0, 150)}…`);
  console.log(`  userFailureReason : ${MENSAJE_USUARIA}`);
  console.log(`  userFailureAction : ${ACCION_USUARIA}`);
  console.log(`  notificación      : ${NOTIFICAR ? 'SÍ — push + email a la usuaria' : 'no (usar --notificar)'}`);

  if (!APPLY) { console.log('\nDry-run. Re-ejecutar con --apply.'); return cerrar(); }

  tx.status            = 'failed';
  tx.failureReason     = adminMsg;
  tx.userFailureReason = MENSAJE_USUARIA;
  tx.userFailureAction = ACCION_USUARIA;
  tx.failureCategory   = 'VITA_PAYOUT_DENIED';
  tx.failureRetryable  = false;   // el monto quedó bajo el mínimo nuevo del corredor
  tx.ipnLog            = tx.ipnLog ?? [];
  tx.ipnLog.push({
    provider: 'vitaWallet', eventType: 'payout_denied_manual', status: 'failed',
    rawPayload: { fuente: 'resolver-payout-denegado.mjs', estadoVita: estado,
                  reject_motive: motivo, total_sent: w.total_sent },
    receivedAt: new Date(),
  });
  await tx.save();
  console.log('\n✓ Estado corregido.');

  if (!NOTIFICAR) { console.log('  (sin avisar a la usuaria — correr con --notificar cuando el mensaje esté aprobado)'); return cerrar(); }

  try {
    await notify(tx.userId, NOTIFICATIONS.paymentFailed(tx.originalAmount, tx.originCurrency));
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
