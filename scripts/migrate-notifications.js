/**
 * migrate-notifications.js
 *
 * One-time migration: create in-app notifications for transactions that
 * were created before the notify() call was added to the payment flow.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-notifications.js
 */

import mongoose from 'mongoose';
import Transaction  from '../src/models/Transaction.js';
import Notification from '../src/models/Notification.js';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/alyto-v2';

// Map transaction status → notification payload
function buildPayload(tx) {
  const { status, originAmount, originCurrency, destinationAmount, destinationCurrency } = tx;

  if (status === 'completed') {
    return {
      type:  'payment_completed',
      title: '¡Dinero entregado! ✓',
      body:  `Tu transferencia fue completada. El beneficiario recibió ${Number(destinationAmount ?? 0).toLocaleString('es-CL')} ${destinationCurrency ?? ''}.`,
    };
  }

  if (status === 'failed' || status === 'refunded') {
    return {
      type:  'payment_failed',
      title: 'Transferencia no completada',
      body:  `Tu transferencia de ${Number(originAmount ?? 0).toLocaleString('es-CL')} ${originCurrency ?? ''} no pudo completarse.`,
    };
  }

  // payin_completed, in_transit, payout_pending, payout_sent, payin_pending, initiated
  return {
    type:  'payin_confirmed',
    title: 'Pago recibido ✓',
    body:  `Tu pago de ${Number(originAmount ?? 0).toLocaleString('es-CL')} ${originCurrency ?? ''} fue recibido y está siendo procesado.`,
  };
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('[Migration] Connected to MongoDB');

  const SKIP_STATUSES = ['pending', 'initiated'];

  const transactions = await Transaction.find({
    status: { $nin: SKIP_STATUSES },
    userId: { $exists: true },
  }).select('_id userId alytoTransactionId status originAmount originCurrency destinationAmount destinationCurrency').lean();

  console.log(`[Migration] Found ${transactions.length} transactions to check`);

  let created = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const txId = tx.alytoTransactionId ?? tx._id.toString();

    // Check if a notification already exists for this user+transaction
    const existing = await Notification.findOne({
      userId: tx.userId,
      'data.txId': txId,
    }).lean();

    if (existing) {
      skipped++;
      continue;
    }

    const payload = buildPayload(tx);

    await Notification.create({
      userId: tx.userId,
      type:   payload.type,
      title:  payload.title,
      body:   payload.body,
      data:   { txId, type: payload.type },
    });

    created++;
  }

  console.log(`[Migration] Done — created: ${created}, skipped (already existed): ${skipped}`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('[Migration] Fatal error:', err.message);
  process.exit(1);
});
