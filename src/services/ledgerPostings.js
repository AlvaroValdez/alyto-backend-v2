/**
 * ledgerPostings.js — Builders puros: evento de dinero → asiento del Libro Mayor
 *
 * Traduce un registro de la capa subsidiaria (WalletTransaction) al asiento de
 * doble entrada del §7. Puro y testeable: no toca DB. El posteo lo hace
 * ledgerSync/ledgerService.postEntry con lo que estos builders devuelven.
 *
 * SLICE A (esta entrega): eventos de wallet que MUEVEN saldo — depósito, retiro,
 * P2P, congelamiento. Las CONVERSIONES (bob_to_usdc / usdc_to_bob y sus patas)
 * se posponen a slice B porque su asiento depende de la decisión abierta de
 * reconocimiento de spread FX (§6/§12 del plan). Los eventos no mapeados devuelven
 * null con motivo (ver classifyWalletTx) — nunca se postean en silencio.
 *
 * Semántica clave (verificada en código):
 *   - `balanceReserved` es un earmark DENTRO de `balance` → las reservas NO mueven
 *     dinero y NO generan asiento. Solo `status:'completed'` con cambio de saldo postea.
 *   - `deposit`/`usdc_deposit` se reutilizan como patas de conversión: se distinguen
 *     por metadata.sourceUSDCWtxId / metadata.sourceBOBWtxId → esos se saltan (slice B).
 */

/** Cuentas por moneda. */
function accountsFor(currency) {
  return currency === 'USDC'
    ? { liab: '2020', frozen: '2021', feeRevenue: '4050' }
    : { liab: '2010', frozen: '2011', feeRevenue: '4010' }
}

/**
 * Clasifica un WalletTransaction para el GL: decide si postea y por qué no si no.
 * @returns {{ post:boolean, reason?:string, purpose?:string }}
 */
export function classifyWalletTx(wtx) {
  if (!wtx) return { post: false, reason: 'null' }
  if (wtx.status !== 'completed') return { post: false, reason: `status:${wtx.status} (sin movimiento neto)` }

  switch (wtx.type) {
    case 'deposit':
      // Pata de crédito BOB de una conversión USDC→BOB, o depósito bancario real.
      if (wtx.metadata?.sourceUSDCWtxId) return { post: true, purpose: 'convert_usdc_to_bob' }
      return { post: true, purpose: 'deposit' }
    case 'usdc_deposit':
      // Pata de crédito USDC de una conversión BOB→USDC, o depósito on-chain real.
      if (wtx.metadata?.sourceBOBWtxId) return { post: true, purpose: 'convert_bob_to_usdc' }
      return { post: true, purpose: 'deposit' }
    case 'withdrawal':   return { post: true, purpose: 'withdrawal' }
    case 'send':         return { post: true, purpose: 'p2p' }
    case 'receive':      return { post: false, reason: 'P2P deduplicado (se postea desde el send)' }
    case 'freeze':       return { post: true, purpose: 'freeze' }
    case 'unfreeze':     return { post: true, purpose: 'unfreeze' }
    // Patas de DÉBITO de conversión: se deduplican (el asiento completo se postea
    // desde la pata de crédito, que lleva swapRevenueBob en su metadata).
    case 'bob_to_usdc':  return { post: false, reason: 'pata débito BOB→USDC (posteada desde la pata crédito usdc_deposit)' }
    case 'usdc_to_bob':  return { post: false, reason: 'pata débito USDC→BOB (posteada desde la pata crédito deposit BOB)' }
    default:             return { post: false, reason: `tipo no mapeado: ${wtx.type}` }
  }
}

const R7 = (n) => +(Number(n) || 0).toFixed(7)

function entryBase(wtx, purpose) {
  return {
    entity: 'SRL',
    sourceType: 'wallet_tx',
    sourceRef: wtx.wtxId,
    posturePurpose: purpose,
    description: wtx.description || wtx.type,
  }
}

/**
 * Construye el asiento (para postEntry) de un WalletTransaction, o null si no aplica.
 * @param {object} wtx  WalletTransaction (lean)
 * @returns {null|{entity,sourceType,sourceRef,posturePurpose,description,lines}}
 */
export function buildWalletTxEntry(wtx) {
  const cls = classifyWalletTx(wtx)
  if (!cls.post) return null

  // Conversiones cross-currency (§6): asiento completo desde la pata de crédito.
  if (cls.purpose === 'convert_bob_to_usdc') return buildBobToUsdcEntry(wtx)
  if (cls.purpose === 'convert_usdc_to_bob') return buildUsdcToBobEntry(wtx)

  // Eventos mono-moneda (slice A).
  const currency = wtx.currency || 'BOB'
  const { liab, frozen, feeRevenue } = accountsFor(currency)
  const amount = R7(wtx.amount)
  const dims   = { userId: wtx.userId ?? null, sourceTxId: wtx.wtxId }
  const base   = entryBase(wtx, cls.purpose)

  switch (wtx.type) {
    case 'deposit':       // depósito BOB real (banco)
      return { ...base, lines: [
        { account: '1030', currency, debit: amount, dims },
        { account: liab,   currency, credit: amount, dims },
      ] }

    case 'usdc_deposit':  // depósito USDC on-chain (dirección custodial)
      return { ...base, lines: [
        { account: '1020', currency: 'USDC', debit: amount, dims },
        { account: '2020', currency: 'USDC', credit: amount, dims },
      ] }

    case 'withdrawal':    // retiro liquidado: pasivo usuario ↓, banco ↓
      return { ...base, lines: [
        { account: liab,   currency, debit: amount, dims },
        { account: '1030', currency, credit: amount, dims },
      ] }

    case 'send': {        // P2P: emisor ↓ (monto+fee), receptor ↑ (monto), fee → ingreso
      const fee   = Number(wtx.metadata?.fee) || 0
      const total = R7(amount + fee)
      const cpDims = { userId: wtx.counterpartyUserId ?? null, sourceTxId: wtx.wtxId }
      const lines = [
        { account: liab, currency, debit: total,   dims },
        { account: liab, currency, credit: amount, dims: cpDims },
      ]
      if (fee > 0) lines.push({ account: feeRevenue, currency, credit: fee, dims })
      return { ...base, lines }
    }

    case 'freeze':        // balance → congelado
      return { ...base, lines: [
        { account: liab,   currency, debit: amount, dims },
        { account: frozen, currency, credit: amount, dims },
      ] }

    case 'unfreeze':      // congelado → balance
      return { ...base, lines: [
        { account: frozen, currency, debit: amount, dims },
        { account: liab,   currency, credit: amount, dims },
      ] }

    default:
      return null
  }
}

/**
 * Conversión BOB→USDC (ancla: pata de crédito `usdc_deposit` con sourceBOBWtxId).
 * Modelo §6, spread reconocido al confirmar (decisión FX = A, base devengado):
 *   Dr 2010 bobAmount BOB · Cr 1090 (bobAmount−spread) BOB · Cr 4060 spread BOB
 *   Dr 1090 usdcAmount USDC · Cr 2020 usdcAmount USDC
 * Balancea por moneda; 1090 absorbe la posición FX; 4060 = ingreso por spread (BOB).
 */
function buildBobToUsdcEntry(wtx) {
  const usdcAmount = R7(wtx.amount)
  const bobAmount  = R7(wtx.metadata?.bobAmount)
  const swap       = R7(wtx.metadata?.swapRevenueBob)
  if (!bobAmount || !usdcAmount) return null   // metadata incompleta → no postear (reconcile lo detecta)
  const dims  = { userId: wtx.userId ?? null, sourceTxId: wtx.wtxId }
  const lines = [
    { account: '2010', currency: 'BOB',  debit:  bobAmount, dims },
    { account: '1090', currency: 'BOB',  credit: R7(bobAmount - swap), dims },
    { account: '1090', currency: 'USDC', debit:  usdcAmount, dims },
    { account: '2020', currency: 'USDC', credit: usdcAmount, dims },
  ]
  if (swap > 0) lines.push({ account: '4060', currency: 'BOB', credit: swap, dims })
  return { ...entryBase(wtx, 'convert_bob_to_usdc'), lines }
}

/**
 * Conversión USDC→BOB (ancla: pata de crédito `deposit` BOB con sourceUSDCWtxId).
 *   Dr 2020 usdcAmount USDC · Cr 1090 usdcAmount USDC
 *   Dr 1090 (bobAmount+spread) BOB · Cr 2010 bobAmount BOB · Cr 4060 spread BOB
 */
function buildUsdcToBobEntry(wtx) {
  const bobAmount  = R7(wtx.amount)
  const usdcAmount = R7(wtx.metadata?.usdcAmount)
  const swap       = R7(wtx.metadata?.swapRevenueBob)
  if (!bobAmount || !usdcAmount) return null
  const dims  = { userId: wtx.userId ?? null, sourceTxId: wtx.wtxId }
  const lines = [
    { account: '2020', currency: 'USDC', debit:  usdcAmount, dims },
    { account: '1090', currency: 'USDC', credit: usdcAmount, dims },
    { account: '1090', currency: 'BOB',  debit:  R7(bobAmount + swap), dims },
    { account: '2010', currency: 'BOB',  credit: bobAmount, dims },
  ]
  if (swap > 0) lines.push({ account: '4060', currency: 'BOB', credit: swap, dims })
  return { ...entryBase(wtx, 'convert_usdc_to_bob'), lines }
}

export default { classifyWalletTx, buildWalletTxEntry }
