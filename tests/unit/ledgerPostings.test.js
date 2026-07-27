/**
 * ledgerPostings.test.js — Builders evento→asiento del Libro Mayor (Fase 2, slice A).
 *
 * Verifica que cada tipo de WalletTransaction produce un asiento balanceado y
 * correcto, que las reservas/no-completados NO postean, y que las patas de
 * conversión se saltan (slice B).
 */

import '../setup.env.js'
import { classifyWalletTx, buildWalletTxEntry } from '../../src/services/ledgerPostings.js'
import { assertBalanced, assertAccountsKnown } from '../../src/services/ledgerService.js'

const wtx = (over = {}) => ({ wtxId: 'WTX-1', userId: 'u1', status: 'completed', currency: 'BOB', amount: 100, ...over })

/** Todo asiento producido debe balancear por moneda y usar cuentas válidas. */
function expectValidEntry(entry) {
  expect(entry).not.toBeNull()
  expect(assertBalanced(entry.lines)).toBe(true)
  expect(assertAccountsKnown(entry.lines)).toBe(true)
  expect(entry.sourceType).toBe('wallet_tx')
  expect(entry.sourceRef).toBe('WTX-1')
}

describe('classifyWalletTx — qué postea y qué no', () => {
  test('no postea si no está completed (reserva/pending no mueve dinero)', () => {
    expect(classifyWalletTx(wtx({ status: 'pending' })).post).toBe(false)
    expect(classifyWalletTx(wtx({ status: 'failed' })).post).toBe(false)
  })
  test('receive se deduplica (se postea desde el send)', () => {
    expect(classifyWalletTx(wtx({ type: 'receive' })).post).toBe(false)
  })
  test('patas de DÉBITO de conversión se deduplican (se postean desde la pata crédito)', () => {
    expect(classifyWalletTx(wtx({ type: 'bob_to_usdc' })).post).toBe(false)
    expect(classifyWalletTx(wtx({ type: 'usdc_to_bob' })).post).toBe(false)
  })
  test('patas de CRÉDITO de conversión SÍ postean (con su propósito)', () => {
    expect(classifyWalletTx(wtx({ type: 'usdc_deposit', currency: 'USDC', metadata: { sourceBOBWtxId: 'X' } })))
      .toMatchObject({ post: true, purpose: 'convert_bob_to_usdc' })
    expect(classifyWalletTx(wtx({ type: 'deposit', metadata: { sourceUSDCWtxId: 'X' } })))
      .toMatchObject({ post: true, purpose: 'convert_usdc_to_bob' })
  })
})

describe('conversiones cross-currency (slice B, spread al confirmar)', () => {
  test('BOB→USDC: balancea por moneda, spread al 4060, control accounts mueven', () => {
    // 700 BOB → 99 USDC, spread 7 BOB. Ancla en la pata usdc_deposit.
    const e = buildWalletTxEntry(wtx({
      type: 'usdc_deposit', currency: 'USDC', amount: 99,
      metadata: { sourceBOBWtxId: 'WTX-B', bobAmount: 700, swapRevenueBob: 7 },
    }))
    expectValidEntry(e)
    expect(e.posturePurpose).toBe('convert_bob_to_usdc')
    expect(e.lines.find(l => l.account === '2010').debit).toBe(700)   // pasivo BOB usuario ↓
    expect(e.lines.find(l => l.account === '2020').credit).toBe(99)   // pasivo USDC usuario ↑
    expect(e.lines.find(l => l.account === '4060').credit).toBe(7)    // ingreso spread (BOB)
    // 1090 BOB = 700 − 7 = 693 (crédito); 1090 USDC = 99 (débito)
    expect(e.lines.find(l => l.account === '1090' && l.currency === 'BOB').credit).toBe(693)
    expect(e.lines.find(l => l.account === '1090' && l.currency === 'USDC').debit).toBe(99)
  })

  test('USDC→BOB: balancea, spread al 4060, ancla en la pata deposit BOB', () => {
    // 100 USDC → 693 BOB, spread 7 BOB. Ancla en la pata deposit BOB.
    const e = buildWalletTxEntry(wtx({
      type: 'deposit', currency: 'BOB', amount: 693,
      metadata: { sourceUSDCWtxId: 'WTX-U', usdcAmount: 100, swapRevenueBob: 7 },
    }))
    expectValidEntry(e)
    expect(e.posturePurpose).toBe('convert_usdc_to_bob')
    expect(e.lines.find(l => l.account === '2020').debit).toBe(100)   // pasivo USDC usuario ↓
    expect(e.lines.find(l => l.account === '2010').credit).toBe(693)  // pasivo BOB usuario ↑
    expect(e.lines.find(l => l.account === '4060').credit).toBe(7)    // ingreso spread
    expect(e.lines.find(l => l.account === '1090' && l.currency === 'BOB').debit).toBe(700)  // 693 + 7
  })

  test('conversión sin spread (swap=0) NO agrega línea 4060 y sigue balanceada', () => {
    const e = buildWalletTxEntry(wtx({
      type: 'usdc_deposit', currency: 'USDC', amount: 100,
      metadata: { sourceBOBWtxId: 'WTX-B', bobAmount: 700, swapRevenueBob: 0 },
    }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '4060')).toBeUndefined()
    expect(e.lines.find(l => l.account === '1090' && l.currency === 'BOB').credit).toBe(700)
  })

  test('metadata incompleta (sin bobAmount) → null, no postea un asiento roto', () => {
    expect(buildWalletTxEntry(wtx({ type: 'usdc_deposit', currency: 'USDC', amount: 99, metadata: { sourceBOBWtxId: 'X' } }))).toBeNull()
  })
})

describe('buildWalletTxEntry — asientos', () => {
  test('depósito BOB real: Dr 1030 banco / Cr 2010 usuario', () => {
    const e = buildWalletTxEntry(wtx({ type: 'deposit' }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '1030').debit).toBe(100)
    expect(e.lines.find(l => l.account === '2010').credit).toBe(100)
  })

  test('depósito USDC on-chain: Dr 1020 custodia / Cr 2020', () => {
    const e = buildWalletTxEntry(wtx({ type: 'usdc_deposit', currency: 'USDC', metadata: { horizonOperationId: 'op1' } }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '1020').debit).toBe(100)
    expect(e.lines.find(l => l.account === '2020').credit).toBe(100)
  })

  test('retiro: Dr 2010 usuario / Cr 1030 banco', () => {
    const e = buildWalletTxEntry(wtx({ type: 'withdrawal' }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '2010').debit).toBe(100)
    expect(e.lines.find(l => l.account === '1030').credit).toBe(100)
  })

  test('P2P sin comisión: emisor ↓ = receptor ↑ (mismo 2010, dims distintas)', () => {
    const e = buildWalletTxEntry(wtx({ type: 'send', counterpartyUserId: 'u2' }))
    expectValidEntry(e)
    const debit  = e.lines.find(l => l.debit > 0)
    const credit = e.lines.find(l => l.credit > 0)
    expect(debit.account).toBe('2010')
    expect(credit.account).toBe('2010')
    expect(debit.debit).toBe(100)
    expect(credit.credit).toBe(100)
    expect(debit.dims.userId).toBe('u1')
    expect(credit.dims.userId).toBe('u2')
  })

  test('P2P USDC con comisión: emisor ↓ (monto+fee), receptor ↑ (monto), fee → 4050', () => {
    const e = buildWalletTxEntry(wtx({ type: 'send', currency: 'USDC', amount: 30, counterpartyUserId: 'u2', metadata: { fee: 1 } }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.debit > 0).debit).toBe(31)              // 30 + 1
    expect(e.lines.find(l => l.account === '2020' && l.credit > 0).credit).toBe(30)
    expect(e.lines.find(l => l.account === '4050').credit).toBe(1)     // ingreso comisión P2P
  })

  test('freeze: Dr 2010 / Cr 2011 congelado', () => {
    const e = buildWalletTxEntry(wtx({ type: 'freeze' }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '2010').debit).toBe(100)
    expect(e.lines.find(l => l.account === '2011').credit).toBe(100)
  })

  test('unfreeze: Dr 2011 / Cr 2010', () => {
    const e = buildWalletTxEntry(wtx({ type: 'unfreeze' }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '2011').debit).toBe(100)
    expect(e.lines.find(l => l.account === '2010').credit).toBe(100)
  })

  test('freeze USDC usa las cuentas USDC (2020/2021)', () => {
    const e = buildWalletTxEntry(wtx({ type: 'freeze', currency: 'USDC', amount: 50 }))
    expectValidEntry(e)
    expect(e.lines.find(l => l.account === '2020').debit).toBe(50)
    expect(e.lines.find(l => l.account === '2021').credit).toBe(50)
  })

  test('eventos no posteables devuelven null', () => {
    expect(buildWalletTxEntry(wtx({ type: 'receive' }))).toBeNull()
    expect(buildWalletTxEntry(wtx({ status: 'pending' }))).toBeNull()
    expect(buildWalletTxEntry(wtx({ type: 'bob_to_usdc' }))).toBeNull()
  })
})
