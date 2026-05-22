/**
 * monitorUSDCDeposits.js — Fase 36: Detección Automática de Depósitos USDC
 *
 * Sondea Horizon cada 30s buscando pagos USDC entrantes en la cuenta
 * compartida de AV Finance SRL (STELLAR_SRL_PUBLIC_KEY).
 *
 * Flujo por cada pago detectado:
 *   1. Verificar tipo 'payment' + asset USDC + destinatario SRL
 *   2. Leer memo de la transacción Stellar → formato 'ALYTO-XXXXXX'
 *   3. Buscar WalletUSDC por stellarMemo
 *   4. Verificar idempotencia: ¿metadata.horizonOperationId ya existe?
 *   5. Acreditar balance atómicamente (sesión Mongoose + WalletTransaction)
 *   6. Enviar push notification al usuario
 *   7. Avanzar cursor en SystemConfig 'stellar:srl:cursor'
 *
 * Cursor: pagingToken de la última operación procesada.
 * Persiste en MongoDB (SystemConfig) → seguro ante reinicios.
 * Valor inicial 'now' → ignora historial previo al primer arranque.
 *
 * Idempotencia: WalletTransaction.metadata.horizonOperationId evita
 * doble acreditación si el job se reinicia a mitad de un batch.
 */

import mongoose                 from 'mongoose'
import * as Sentry              from '@sentry/node'
import { horizonServer, ASSETS } from '../config/stellar.js'
import SystemConfig             from '../models/SystemConfig.js'
import WalletUSDC               from '../models/WalletUSDC.js'
import WalletTransaction        from '../models/WalletTransaction.js'
import { sendPushNotification } from '../services/notifications.js'

const CURSOR_KEY  = 'stellar:srl:cursor'
const POLL_LIMIT  = 50     // operaciones por página Horizon (máximo permitido)

let _isRunning = false

// ─── Job principal ────────────────────────────────────────────────────────────

export async function monitorUSDCDeposits() {
  if (_isRunning) {
    console.warn('[USDC Monitor] Ciclo anterior aún en ejecución — skip')
    return
  }

  const srlPublicKey = process.env.STELLAR_SRL_PUBLIC_KEY
  if (!srlPublicKey) {
    console.warn('[USDC Monitor] STELLAR_SRL_PUBLIC_KEY no configurado — skip')
    return
  }

  _isRunning = true
  const stats = { processed: 0, credited: 0, skipped: 0, noMemo: 0, errors: 0 }

  try {
    const cursor = await SystemConfig.getValue(CURSOR_KEY, 'now')

    const response = await horizonServer
      .payments()
      .forAccount(srlPublicKey)
      .cursor(cursor)
      .limit(POLL_LIMIT)
      .order('asc')
      .call()

    const records = response.records ?? []

    for (const record of records) {
      stats.processed++

      try {
        await _processPayment(record, srlPublicKey, stats)
      } catch (err) {
        stats.errors++
        console.error('[USDC Monitor] Error procesando operación Horizon:', {
          operationId: record?.id,
          error:       err.message,
        })
        Sentry.captureException(err, {
          tags:  { job: 'monitorUSDCDeposits' },
          extra: { operationId: record?.id },
        })
      }

      // Avanzar cursor tras cada record (éxito o error).
      // Si el job se reinicia, idempotencia evita doble acreditación.
      await SystemConfig.setValue(CURSOR_KEY, record.paging_token)
    }

    if (stats.credited > 0 || stats.errors > 0) {
      console.info('[USDC Monitor] Ciclo completado:', stats)
    }

  } catch (err) {
    // Error de nivel batch (red, Horizon down, DB down)
    console.error('[USDC Monitor] Error de ciclo:', err.message)
    Sentry.captureException(err, { tags: { job: 'monitorUSDCDeposits', level: 'batch' } })
  } finally {
    _isRunning = false
  }
}

// ─── Procesamiento individual de un registro Horizon ─────────────────────────

async function _processPayment(record, srlPublicKey, stats) {
  // Solo operaciones de tipo 'payment' (excluye create_account, path_payment, etc.)
  if (record.type !== 'payment') return

  // Solo USDC entrante a la cuenta SRL
  if (
    record.asset_code   !== 'USDC'             ||
    record.asset_issuer !== ASSETS.USDC.issuer  ||
    record.to           !== srlPublicKey
  ) return

  // Obtener memo de la transacción padre
  const tx   = await record.transaction()
  const memo = (tx.memo ?? '').trim()

  if (!memo || !memo.startsWith('ALYTO-')) {
    stats.noMemo++
    // Depósito sin memo Alyto → loguear para revisión manual
    console.warn('[USDC Monitor] Depósito USDC sin memo válido — revisión manual requerida:', {
      operationId: record.id,
      amount:      record.amount,
      from:        record.from,
      txHash:      record.transaction_hash,
      memo:        memo || '(vacío)',
    })
    return
  }

  // Idempotencia — ¿ya acreditamos esta operación Horizon?
  const alreadyCredited = await WalletTransaction.exists({
    'metadata.horizonOperationId': record.id,
  })
  if (alreadyCredited) {
    stats.skipped++
    return
  }

  // Buscar wallet activa por stellarMemo
  const wallet = await WalletUSDC.findOne({ stellarMemo: memo, status: 'active' })
  if (!wallet) {
    console.warn('[USDC Monitor] Memo no coincide con ninguna WalletUSDC activa:', {
      memo,
      operationId: record.id,
      from:        record.from,
    })
    return
  }

  const amount = parseFloat(record.amount)

  // Acreditación atómica — sesión Mongoose garantiza consistencia
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const updated = await WalletUSDC.findOneAndUpdate(
        { _id: wallet._id, status: 'active' },
        { $inc: { balance: amount } },
        { new: true, session },
      )
      if (!updated) throw new Error(`WalletUSDC ${wallet._id} no encontrada o inactiva`)

      await WalletTransaction.create([{
        walletId:      wallet._id,
        walletModel:   'WalletUSDC',
        userId:        wallet.userId,
        type:          'usdc_deposit',
        currency:      'USDC',
        amount,
        balanceBefore: Math.max(0, updated.balance - amount),
        balanceAfter:  updated.balance,
        status:        'completed',
        stellarTxId:   record.transaction_hash,
        description:   `Depósito USDC Stellar — memo ${memo}`,
        confirmedAt:   new Date(),
        metadata: {
          horizonOperationId: record.id,
          stellarMemo:        memo,
          fromAccount:        record.from,
        },
      }], { session })
    })
  } finally {
    await session.endSession()
  }

  stats.credited++

  console.info('[USDC Monitor] Depósito USDC acreditado:', {
    userId:      wallet.userId.toString(),
    memo,
    amount,
    operationId: record.id,
    txHash:      record.transaction_hash,
  })

  // Push notification — fire-and-forget
  sendPushNotification(wallet.userId, {
    title: '💰 USDC recibido',
    body:  `Recibiste ${amount.toFixed(2)} USDC en tu wallet Alyto.`,
    data:  { type: 'usdc_deposit', amount: String(amount) },
  }).catch(() => {})
}
