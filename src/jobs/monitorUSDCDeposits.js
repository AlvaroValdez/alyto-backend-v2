/**
 * monitorUSDCDeposits.js — Detección Automática de Depósitos USDC
 *
 * Camino A (segregación de wallet SRL): los depósitos USDC de usuarios caen en la
 * **dirección custodial propia de cada usuario** (Fase 38), NO en la wallet de
 * tesorería SRL compartida. Este job sondea Horizon cada 30s y acredita por
 * **dirección destino** (sin memo).
 *
 * Dos modos de vigilancia:
 *   1. CUSTODIAL — cada WalletUSDC.stellarAddress (cuenta propia del usuario).
 *      Match por `record.to === address` → acredita esa WalletUSDC. Sin memo.
 *   2. LEGACY    — la dirección SRL compartida (STELLAR_SRL_PUBLIC_KEY), para
 *      depósitos antiguos con memo `ALYTO-XXXXXX`. Transitorio hasta H4 (migración).
 *      ⚠️ Inflows a SRL SIN memo `ALYTO-` = fondeo de tesorería → este job los
 *         IGNORA (los maneja el job de reconciliación de tesorería, H3).
 *
 * Cursor: pagingToken por dirección, en SystemConfig.
 *   - custodial: default '0' (cuenta nueva, historia corta → captura desde creación)
 *   - legacy:    default 'now' (cuenta compartida con historia larga)
 *
 * Idempotencia: WalletTransaction.metadata.horizonOperationId evita doble
 * acreditación si el job se reinicia a mitad de un batch.
 *
 * Escalabilidad: O(N) llamadas Horizon por ciclo (1 por dirección custodial activa).
 * Irrelevante con el volumen actual (un puñado de usuarios). A escala (miles de
 * cuentas) reconsiderar ingestión propia / stream filtrado por issuer.
 */

import mongoose                 from 'mongoose'
import * as Sentry              from '@sentry/node'
import { horizonServer, ASSETS } from '../config/stellar.js'
import SystemConfig             from '../models/SystemConfig.js'
import WalletUSDC               from '../models/WalletUSDC.js'
import WalletTransaction        from '../models/WalletTransaction.js'
import Transaction              from '../models/Transaction.js'
import { notify, NOTIFICATIONS } from '../services/notifications.js'

const LEGACY_CURSOR_KEY = 'stellar:srl:cursor'                  // dirección SRL compartida (memo)
const cursorKeyFor      = (addr) => `stellar:deposit:cursor:${addr}`
const POLL_LIMIT        = 50     // operaciones por página Horizon (máximo permitido)

let _isRunning = false

// ─── Job principal ────────────────────────────────────────────────────────────

export async function monitorUSDCDeposits() {
  if (_isRunning) {
    console.warn('[USDC Monitor] Ciclo anterior aún en ejecución — skip')
    return
  }

  _isRunning = true
  const stats = { processed: 0, credited: 0, skipped: 0, noMatch: 0, errors: 0, addresses: 0 }

  try {
    const srlShared = process.env.STELLAR_SRL_PUBLIC_KEY ?? null

    // 1. Direcciones custodiales activas a vigilar (excluye null y la SRL compartida)
    const exclude = [null]
    if (srlShared) exclude.push(srlShared)
    const custodialAddresses = await WalletUSDC.distinct('stellarAddress', {
      status:         'active',
      stellarAddress: { $nin: exclude },
    })

    // 2. Vigilar cada dirección custodial (match por dirección, sin memo)
    for (const addr of custodialAddresses) {
      stats.addresses++
      try {
        await _pollAddress(addr, { mode: 'custodial' }, stats)
      } catch (err) {
        stats.errors++
        console.error('[USDC Monitor] Error vigilando dirección custodial:', { addr, error: err.message })
        Sentry.captureException(err, { tags: { job: 'monitorUSDCDeposits', mode: 'custodial' }, extra: { addr } })
      }
    }

    // 3. Dirección SRL compartida legacy (match por memo ALYTO-) — transición hasta H4
    if (srlShared) {
      stats.addresses++
      try {
        await _pollAddress(srlShared, { mode: 'legacy', cursorKey: LEGACY_CURSOR_KEY }, stats)
      } catch (err) {
        stats.errors++
        console.error('[USDC Monitor] Error vigilando dirección legacy SRL:', err.message)
        Sentry.captureException(err, { tags: { job: 'monitorUSDCDeposits', mode: 'legacy' } })
      }
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

// ─── Poll de una dirección ────────────────────────────────────────────────────

async function _pollAddress(address, opts, stats) {
  const cursorKey     = opts.cursorKey ?? cursorKeyFor(address)
  const defaultCursor = opts.mode === 'legacy' ? 'now' : '0'
  const cursor        = await SystemConfig.getValue(cursorKey, defaultCursor)

  const response = await horizonServer
    .payments()
    .forAccount(address)
    .cursor(cursor)
    .limit(POLL_LIMIT)
    .order('asc')
    .call()

  const records = response.records ?? []

  for (const record of records) {
    stats.processed++
    try {
      await _processPayment(record, address, opts, stats)
    } catch (err) {
      stats.errors++
      console.error('[USDC Monitor] Error procesando operación Horizon:', {
        operationId: record?.id,
        error:       err.message,
      })
      Sentry.captureException(err, {
        tags:  { job: 'monitorUSDCDeposits' },
        extra: { operationId: record?.id, address },
      })
    }
    // Avanzar cursor tras cada record (éxito o error). Idempotencia evita doble crédito.
    await SystemConfig.setValue(cursorKey, record.paging_token)
  }
}

// ─── Procesamiento individual de un registro Horizon ─────────────────────────

async function _processPayment(record, address, opts, stats) {
  // Solo operaciones de tipo 'payment' (excluye create_account, path_payment, etc.)
  if (record.type !== 'payment') return

  // Solo USDC entrante a la dirección vigilada
  if (
    record.asset_code   !== 'USDC'             ||
    record.asset_issuer !== ASSETS.USDC.issuer  ||
    record.to           !== address
  ) return

  // Idempotencia — ¿ya acreditamos esta operación Horizon?
  const alreadyCredited = await WalletTransaction.exists({
    'metadata.horizonOperationId': record.id,
  })
  if (alreadyCredited) {
    stats.skipped++
    return
  }

  // Resolver la WalletUSDC destino según el modo
  let wallet
  let memo = null

  if (opts.mode === 'custodial') {
    // Match por dirección destino — la dirección es exclusiva del usuario, sin memo
    wallet = await WalletUSDC.findOne({ stellarAddress: address, status: 'active' })
    if (!wallet) {
      stats.noMatch++
      console.warn('[USDC Monitor] Dirección custodial sin WalletUSDC activa:', {
        address, operationId: record.id, from: record.from,
      })
      return
    }
  } else {
    // Legacy: leer memo de la tx padre y buscar por stellarMemo.
    // Inflows SIN memo ALYTO- (= fondeo de tesorería) se ignoran → los maneja H3.
    const tx = await record.transaction()
    memo = (tx.memo ?? '').trim()
    if (!memo || !memo.startsWith('ALYTO-')) {
      stats.noMatch++
      console.warn('[USDC Monitor] Inflow USDC en SRL sin memo de usuario (posible fondeo de tesorería → H3):', {
        operationId: record.id,
        amount:      record.amount,
        from:        record.from,
        txHash:      record.transaction_hash,
        memo:        memo || '(vacío)',
      })
      return
    }
    wallet = await WalletUSDC.findOne({ stellarMemo: memo, status: 'active' })
    if (!wallet) {
      console.warn('[USDC Monitor] Memo no coincide con ninguna WalletUSDC activa:', {
        memo, operationId: record.id, from: record.from,
      })
      return
    }
  }

  const amount = parseFloat(record.amount)

  // Acreditación atómica — sesión Mongoose garantiza consistencia
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const updated = await WalletUSDC.findOneAndUpdate(
        { _id: wallet._id, status: 'active' },
        { $inc: { balance: amount } },
        { returnDocument: 'after', session },
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
        description:   opts.mode === 'custodial'
          ? `Depósito USDC Stellar — ${address}`
          : `Depósito USDC Stellar — memo ${memo}`,
        confirmedAt:   new Date(),
        metadata: {
          horizonOperationId: record.id,
          depositAddress:     address,
          stellarMemo:        memo,            // null en modo custodial
          fromAccount:        record.from,
        },
      }], { session })
    })
  } finally {
    await session.endSession()
  }

  stats.credited++

  // Reconciliación SEP-24 (Camino A): si el usuario tiene un depósito SEP-24
  // pendiente (custodial, sin memo), marcarlo como completado con el crédito
  // recibido para que el polling del cliente refleje el estado. Best-effort: la
  // acreditación de la WalletUSDC de arriba ya es autoritativa; esto solo refleja
  // el estado en la Transaction SEP-24. Solo aplica en modo custodial (los SEP-24
  // deposit usan la dirección custodial del usuario, sin memo).
  if (opts.mode === 'custodial') {
    try {
      const sep24Tx = await Transaction.findOneAndUpdate(
        { userId: wallet.userId, sep24Type: 'deposit', status: 'sep24_deposit_pending' },
        {
          $set: {
            status:             'completed',
            stellarTxId:        record.transaction_hash,
            digitalAssetAmount: amount,
            statusMessage:      `Depósito USDC recibido (${amount} USDC)`,
          },
        },
        { sort: { createdAt: 1 }, returnDocument: 'after' },   // el más antiguo pendiente
      )
      if (sep24Tx) {
        console.info('[USDC Monitor] Depósito SEP-24 reconciliado → completed:', {
          alytoTransactionId: sep24Tx.alytoTransactionId,
          userId:             wallet.userId.toString(),
          amount,
        })
      }
    } catch (err) {
      console.error('[USDC Monitor] Error reconciliando depósito SEP-24:', err.message)
      Sentry.captureException(err, { tags: { job: 'monitorUSDCDeposits', step: 'sep24-reconcile' } })
    }
  }

  console.info('[USDC Monitor] Depósito USDC acreditado:', {
    userId:      wallet.userId.toString(),
    mode:        opts.mode,
    address,
    memo,
    amount,
    operationId: record.id,
    txHash:      record.transaction_hash,
  })

  // Notificación in-app PERSISTENTE (campanita) + push FCM — fire-and-forget.
  // Mensaje de éxito al recepcionar los activos, visible en el centro de
  // notificaciones aunque la pantalla de depósito esté cerrada o el push no llegue.
  notify(wallet.userId, NOTIFICATIONS.usdcDepositReceived(amount)).catch(() => {})
}
