/**
 * resume-usdc-send.js
 *
 * Resume el envío de USDC para una transacción con status=payout_pending_usdc_send
 * cuyo Harbor transfer ya fue creado (harborTransfer.transferId existe) pero
 * el USDC no se envió (porque OWLPAY_USDC_SEND_ENABLED=0 al momento de crear).
 *
 * Reutiliza sendUSDCToHarbor() con sus garantías de idempotency, retry,
 * balance check, etc.
 *
 * Uso:
 *   node --env-file=.env scripts/resume-usdc-send.js ALY-C-...
 *   node --env-file=.env scripts/resume-usdc-send.js --all   # todas las pendientes
 */

import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';
import { sendUSDCToHarbor } from '../src/services/stellarService.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Uso: resume-usdc-send.js <transactionId> | --all');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
console.log('DB:', mongoose.connection.db.databaseName);

const query = arg === '--all'
  ? { status: 'payout_pending_usdc_send', 'harborTransfer.transferId': { $exists: true } }
  : { alytoTransactionId: arg };

const txs = await Transaction.find(query);
if (txs.length === 0) {
  console.error('No se encontraron tx pendientes que matchen.');
  process.exit(1);
}

console.log(`\nProcesando ${txs.length} transacción(es)...`);

for (const tx of txs) {
  const h = tx.harborTransfer ?? {};
  console.log(`\n── ${tx.alytoTransactionId} ──`);
  console.log(`  status:        ${tx.status}`);
  console.log(`  transferId:    ${h.transferId}`);
  console.log(`  instrAddress:  ${h.instructionAddress}`);
  console.log(`  instrMemo:     ${h.instructionMemo}`);
  console.log(`  usdcRequired:  ${h.usdcAmountRequired}`);

  if (!h.instructionAddress || !h.instructionMemo || !h.usdcAmountRequired) {
    console.log('  ❌ Falta data del harborTransfer. Skipping.');
    continue;
  }

  if (tx.status === 'payout_sent' || tx.status === 'completed') {
    console.log('  ⚠️ Ya enviado o completado. Skipping.');
    continue;
  }

  try {
    const result = await sendUSDCToHarbor({
      destinationAddress: h.instructionAddress,
      amount:             h.usdcAmountRequired,
      memo:               h.instructionMemo,
      transactionId:      tx.alytoTransactionId,
    });

    tx.stellarTxHash = result.hash;
    tx.status        = 'payout_sent';
    tx.statusReason  = null;
    tx.ipnLog.push({
      provider:   'stellar',
      eventType:  'usdc_sent_to_harbor_manual_resume',
      status:     'payout_sent',
      rawPayload: {
        hash:     result.hash,
        ledger:   result.ledger,
        amount:   h.usdcAmountRequired,
        memo:     h.instructionMemo,
        existing: result.existing ?? false,
      },
      receivedAt: new Date(),
    });
    await tx.save();

    console.log(`  ✅ USDC enviado. hash=${result.hash} (${result.existing ? 'ya existente' : 'nuevo'})`);
    console.log(`     Harbor detectará el USDC y disparará webhook transfer.source_received → status payout_sent → completed.`);
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
    if (err.stellarTxCode) console.log(`     stellar tx: ${err.stellarTxCode} op: ${err.stellarOpCode ?? '—'}`);
  }
}

await mongoose.disconnect();
console.log('\nListo.');
process.exit(0);
