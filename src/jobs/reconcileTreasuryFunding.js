/**
 * reconcileTreasuryFunding.js — Reconciliación de Fondeo de Tesorería (Camino A, H3)
 *
 * Sondea Horizon buscando USDC entrante a la wallet de TESORERÍA SRL
 * (STELLAR_SRL_PUBLIC_KEY). Tras Camino A, los depósitos de usuarios ya NO caen
 * ahí (van a sus direcciones custodiales), así que todo inflow a esta wallet que
 * no sea un depósito de usuario legacy (memo ALYTO-) es FONDEO.
 *
 * Por cada inflow USDC:
 *   1. Dedupe por horizonOperationId (idempotente).
 *   2. Si el memo es ALYTO- → es depósito de usuario legacy → lo ignora (lo
 *      maneja monitorUSDCDeposits, H2). Sin doble manejo.
 *   3. Busca un FundingIntent 'open' cuyo memo coincida (correlativo FND-...).
 *   4. Crea un FundingRecord confirmado (trazabilidad), enlazando el intent si
 *      existe; marca el intent 'matched'.
 *   5. Si NO hay intent → FundingRecord 'unmatched' + alerta admin.
 *   6. Dispara auto-retry de transacciones en pending_funding (fire-and-forget).
 *
 * Cursor: pagingToken en system_configs (`stellar:treasury:cursor:<addr>`),
 * default 'now' (la wallet de tesorería tiene historia larga → solo inflows nuevos;
 * el fondeo histórico ya está registrado y no debe re-crearse).
 *
 * La fuente de verdad de liquidez para autorizar payouts es el saldo on-chain
 * (ver tryOwlPayV2, "on-chain manda"); el FundingRecord es libro de trazabilidad.
 */

import * as Sentry              from '@sentry/node'
import { horizonServer, ASSETS } from '../config/stellar.js'
import SystemConfig             from '../models/SystemConfig.js'
import FundingRecord            from '../models/FundingRecord.js'
import FundingIntent            from '../models/FundingIntent.js'
import { notifyAdmins }         from '../services/notifications.js'
import { retryPendingFundingTransactions } from '../controllers/fundingController.js'

const POLL_LIMIT = 50

let _isRunning = false

export async function reconcileTreasuryFunding() {
  if (_isRunning) {
    console.warn('[Treasury Reconcile] Ciclo anterior aún en ejecución — skip')
    return
  }

  const treasury = process.env.STELLAR_SRL_PUBLIC_KEY
  if (!treasury) {
    console.warn('[Treasury Reconcile] STELLAR_SRL_PUBLIC_KEY no configurado — skip')
    return
  }

  _isRunning = true
  const stats = { processed: 0, matched: 0, unmatched: 0, skipped: 0, userDeposit: 0, errors: 0 }
  const cursorKey = `stellar:treasury:cursor:${treasury}`

  try {
    const cursor = await SystemConfig.getValue(cursorKey, 'now')

    const response = await horizonServer
      .payments()
      .forAccount(treasury)
      .cursor(cursor)
      .limit(POLL_LIMIT)
      .order('asc')
      .call()

    for (const record of response.records ?? []) {
      stats.processed++
      try {
        await _processFundingInflow(record, treasury, 'SRL', stats)
      } catch (err) {
        stats.errors++
        console.error('[Treasury Reconcile] Error procesando operación:', { operationId: record?.id, error: err.message })
        Sentry.captureException(err, { tags: { job: 'reconcileTreasuryFunding' }, extra: { operationId: record?.id } })
      }
      await SystemConfig.setValue(cursorKey, record.paging_token)
    }

    if (stats.matched > 0 || stats.unmatched > 0 || stats.errors > 0) {
      console.info('[Treasury Reconcile] Ciclo completado:', stats)
    }
  } catch (err) {
    console.error('[Treasury Reconcile] Error de ciclo:', err.message)
    Sentry.captureException(err, { tags: { job: 'reconcileTreasuryFunding', level: 'batch' } })
  } finally {
    _isRunning = false
  }
}

async function _processFundingInflow(record, treasury, entity, stats) {
  if (record.type !== 'payment') return

  // Solo USDC entrante a la tesorería (ignora salientes/round-trip)
  if (
    record.asset_code   !== 'USDC'             ||
    record.asset_issuer !== ASSETS.USDC.issuer  ||
    record.to           !== treasury            ||
    record.from         === treasury
  ) return

  // Idempotencia — ¿ya reconciliado?
  const already = await FundingRecord.exists({ horizonOperationId: record.id })
  if (already) { stats.skipped++; return }

  // Depósitos de usuario legacy (memo ALYTO-) NO son fondeo → los maneja H2
  const tx   = await record.transaction()
  const memo = (tx.memo ?? '').trim()
  if (memo.startsWith('ALYTO-')) { stats.userDeposit++; return }

  const amount = parseFloat(record.amount)

  // Buscar intent abierto que matchee el memo correlativo
  const intent = memo ? await FundingIntent.findOne({ memo, status: 'open' }) : null

  const fundingRecord = await FundingRecord.create({
    fundingId:             `FUND-${entity}-RECON-${record.id}`,
    entity,
    type:                  'internal',
    asset:                 'USDC',
    amount,
    usdEquivalent:         amount,
    exchangeRate:          1,
    stellarTxId:           record.transaction_hash,
    horizonOperationId:    record.id,
    reconciledFromStellar: true,
    intentId:              intent?.intentId ?? null,
    registeredBy:          intent?.createdBy ?? null,
    note:                  intent
      ? `Reconciliación automática de intent ${intent.intentId}`
      : `Inflow USDC de tesorería sin intent (memo='${memo || '(vacío)'}', from=${record.from})`,
    status:                'confirmed',
  })

  if (intent) {
    intent.status             = 'matched'
    intent.matchedFundingId   = fundingRecord.fundingId
    intent.matchedStellarTxId = record.transaction_hash
    intent.matchedAmount      = amount
    intent.matchedAt          = new Date()
    await intent.save()
    stats.matched++
    console.info('[Treasury Reconcile] Fondeo reconciliado con intent:', {
      intentId: intent.intentId, amount, txHash: record.transaction_hash,
    })
  } else {
    stats.unmatched++
    console.warn('[Treasury Reconcile] Inflow de tesorería SIN intent — revisión admin:', {
      amount, from: record.from, memo: memo || '(vacío)', txHash: record.transaction_hash,
    })
    notifyAdmins({
      title: '⚠️ Fondeo de tesorería sin intent',
      body:  `Llegaron ${amount.toFixed(2)} USDC a la tesorería ${entity} sin un intent que coincida. Revisá el origen.`,
      data:  { type: 'treasury_funding_unmatched', amount: String(amount), entity },
    }).catch(() => {})
  }

  // Auto-retry de payouts en pending_funding (fire-and-forget)
  setImmediate(() =>
    retryPendingFundingTransactions(entity).catch((e) =>
      console.error('[Treasury Reconcile] Auto-retry error:', e.message),
    ),
  )
}
