/**
 * resume-usdc-send.mjs — Procesa transacciones payout_pending_usdc_send
 *
 * Uso cuando se activa OWLPAY_USDC_SEND_ENABLED=1 y hay transacciones
 * acumuladas en estado payout_pending_usdc_send (Harbor transfer creado,
 * USDC aún no enviado).
 *
 * Prerrequisitos:
 *   - OWLPAY_USDC_SEND_ENABLED=1 en el entorno del servidor
 *   - STELLAR_SRL_SECRET_KEY / STELLAR_MASTER_SECRET configurados
 *   - MONGODB_URI configurado
 *
 * Uso:
 *   node scripts/resume-usdc-send.mjs              # dry-run (sin cambios)
 *   node scripts/resume-usdc-send.mjs --execute    # ejecuta envíos reales
 *   node scripts/resume-usdc-send.mjs --tx ALY-C-... --execute  # una sola tx
 */

import 'dotenv/config';
import mongoose from 'mongoose';

// ── Flags de CLI ──────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const DRY_RUN     = !args.includes('--execute');
const SINGLE_TX   = args.includes('--tx') ? args[args.indexOf('--tx') + 1] : null;
const SKIP_EXPIRED = !args.includes('--include-expired');

if (DRY_RUN) {
  console.log('[resume-usdc-send] 🔵 DRY-RUN — no se enviarán USDC. Pasa --execute para ejecutar realmente.');
}

// ── Imports lazy (después de dotenv) ─────────────────────────────────────────
// Se importan después de cargar el entorno para que STELLAR_NETWORK y MONGODB_URI
// ya estén disponibles cuando se inicializan los módulos.

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('[resume-usdc-send] ❌ MONGODB_URI no configurado.');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log('[resume-usdc-send] ✅ Conectado a MongoDB');

// Importar modelos y servicios DESPUÉS de conectar MongoDB
const { default: Transaction }    = await import('../src/models/Transaction.js');
const { sendUSDCToHarbor }         = await import('../src/services/stellarService.js');

// ── Buscar transacciones pendientes ──────────────────────────────────────────
const query = {
  status: 'payout_pending_usdc_send',
  'harborTransfer.instructionAddress': { $exists: true, $ne: null },
  'harborTransfer.usdcAmountRequired': { $gt: 0 },
};

if (SINGLE_TX) {
  query.alytoTransactionId = SINGLE_TX;
  console.log(`[resume-usdc-send] Modo single-tx: ${SINGLE_TX}`);
}

const pendingTxs = await Transaction.find(query).sort({ createdAt: 1 });

if (pendingTxs.length === 0) {
  console.log('[resume-usdc-send] ✅ No hay transacciones payout_pending_usdc_send pendientes.');
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`[resume-usdc-send] Encontradas ${pendingTxs.length} transacciones payout_pending_usdc_send`);

// ── Estadísticas ──────────────────────────────────────────────────────────────
const stats = { total: pendingTxs.length, sent: 0, skippedExpired: 0, alreadySent: 0, failed: 0 };

for (const tx of pendingTxs) {
  const harbor    = tx.harborTransfer;
  const alytoId   = tx.alytoTransactionId;
  const amount    = harbor.usdcAmountRequired;
  const destAddr  = harbor.instructionAddress;
  const memo      = harbor.instructionMemo;
  const expiresAt = harbor.expiresAt ? new Date(harbor.expiresAt) : null;

  console.log(`\n[${alytoId}]`);
  console.log(`  transferId:  ${harbor.transferId}`);
  console.log(`  amount USDC: ${amount}`);
  console.log(`  dest:        ${destAddr}`);
  console.log(`  memo:        ${memo}`);
  console.log(`  expiresAt:   ${expiresAt?.toISOString() ?? 'N/A'}`);

  // Verificar expiración del Harbor transfer
  if (SKIP_EXPIRED && expiresAt && expiresAt < new Date()) {
    console.log(`  ⚠️  EXPIRADO — skipping (usa --include-expired para forzar)`);
    stats.skippedExpired++;
    continue;
  }

  if (!memo) {
    console.log(`  ❌ Sin instruction_memo — no se puede enviar USDC sin memo Harbor.`);
    stats.failed++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`  🔵 DRY-RUN — se enviarían ${amount} USDC a ${destAddr} con memo ${memo}`);
    continue;
  }

  // ── Envío real ────────────────────────────────────────────────────────────
  try {
    const stellarResult = await sendUSDCToHarbor({
      destinationAddress: destAddr,
      amount,
      memo,
      transactionId: alytoId,
    });

    if (stellarResult.existing) {
      console.log(`  ✅ Ya enviado previamente — hash: ${stellarResult.hash}`);
      stats.alreadySent++;
    } else {
      console.log(`  ✅ USDC enviado — hash: ${stellarResult.hash} | ledger: ${stellarResult.ledger}`);
      stats.sent++;
    }

    // Actualizar transacción en MongoDB
    tx.stellarTxHash = stellarResult.hash;
    tx.status        = 'payout_sent';
    tx.statusReason  = null;
    tx.ipnLog.push({
      provider:   'stellar',
      eventType:  'usdc_sent_to_harbor_manual_resume',
      status:     'payout_sent',
      rawPayload: {
        hash:     stellarResult.hash,
        ledger:   stellarResult.ledger,
        amount,
        memo,
        existing: stellarResult.existing ?? false,
        resumedAt: new Date(),
      },
      receivedAt: new Date(),
    });
    await tx.save();

    console.log(`  💾 MongoDB actualizado → payout_sent`);

  } catch (err) {
    console.error(`  ❌ Error enviando USDC: ${err.message}`);
    if (err.isPermanent) {
      console.error(`     ERROR PERMANENTE — revisar manualmente.`);
    }
    stats.failed++;
  }
}

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('[resume-usdc-send] Resumen:');
console.log(`  Total procesadas:   ${stats.total}`);
if (DRY_RUN) {
  console.log(`  (DRY-RUN — ninguna enviada)`);
} else {
  console.log(`  Enviadas:           ${stats.sent}`);
  console.log(`  Ya enviadas antes:  ${stats.alreadySent}`);
  console.log(`  Expiradas (skip):   ${stats.skippedExpired}`);
  console.log(`  Fallidas:           ${stats.failed}`);
}
console.log('══════════════════════════════════════════');

await mongoose.disconnect();
process.exit(stats.failed > 0 ? 1 : 0);
