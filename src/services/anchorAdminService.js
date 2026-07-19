/**
 * anchorAdminService.js — AnchorAdmin, Fase 1 (observabilidad de solo lectura)
 *
 * Módulo de administración interna del Stellar Anchor de Alyto (AV Finance SRL).
 * Responde a las tres preguntas ordenadoras del panel:
 *   1. ¿Está sano el anchor?      → getListenerStatus (4.2), getTreasuryStatus (4.3)
 *   2. ¿Cuadran las cuentas?      → reconcileDualLedger (4.4), getSolvencySnapshot (4.5)
 *   3. ¿Puedo probárselo al regulador? → (exportación de evidencia — bloque futuro)
 *
 * TODAS las funciones de este archivo son de SOLO LECTURA. No mueven fondos, no
 * firman transacciones, no escriben saldos. Reutilizan los servicios existentes
 * (stellarService, monitorUSDCDeposits) en lugar de duplicar lógica Stellar.
 *
 * La lógica de clasificación (reconciliación, solvencia, salud del listener) se
 * extrae a FUNCIONES PURAS exportadas y testeadas en tests/unit/anchorAdmin.test.js
 * — son las piezas donde un error silencioso es más costoso (spec §7).
 */

import { Keypair } from '@stellar/stellar-sdk'

import { horizonServer } from '../config/stellar.js'
import {
  getStellarUSDCBalance,
  getStellarXLMBalance,
  hasUSDCTrustline,
} from '../services/stellarService.js'
import SystemConfig from '../models/SystemConfig.js'
import WalletUSDC   from '../models/WalletUSDC.js'
import { HEARTBEAT_KEY } from '../jobs/monitorUSDCDeposits.js'

// ─── Parámetros configurables ─────────────────────────────────────────────────

/** Intervalo esperado del ciclo del listener (ms). El job corre cada 30s. */
const MONITOR_INTERVAL_MS = parseInt(process.env.USDC_MONITOR_INTERVAL_MS ?? '30000', 10)

/** Cuántos ciclos puede perder el listener antes de marcarlo ámbar/rojo. */
const MONITOR_AMBER_MISSED = 3   // ~90s sin latido → sospechoso
const MONITOR_RED_MISSED   = 6   // ~180s sin latido → probablemente muerto

/** Tolerancia de descuadre USDC (absorbe redondeo float). Configurable. */
const RECON_TOLERANCE_USDC = parseFloat(process.env.ANCHOR_RECON_TOLERANCE_USDC ?? '0.0001')

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES PURAS (testeables sin DB ni red)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pasivo USDC que Alyto le debe al usuario en una wallet custodial.
 *
 * = balance (disponible) + balanceFrozen (congelado por orden ASFI/UIF).
 * `balanceReserved` es un carve-out DE `balance` (USDC reservado en una conversión
 * BOB→USDC pendiente) — sigue siendo pasivo del usuario y ya está incluido en
 * `balance`, por eso NO se suma aparte.
 *
 * ⚠️ Identidad contable a confirmar con el equipo antes de cablear alertas de
 *    solvencia: si `balanceReserved` representara USDC aún NO acreditado on-chain,
 *    habría que excluirlo. Hoy se asume que respalda pasivo real.
 *
 * @param {{balance?:number, balanceFrozen?:number}} wallet
 * @returns {number}
 */
export function mirrorLiabilityUSDC(wallet) {
  const balance = Number(wallet?.balance) || 0
  const frozen  = Number(wallet?.balanceFrozen) || 0
  return balance + frozen
}

/**
 * Clasifica el estado de reconciliación de UNA wallet: compara el saldo espejo
 * (MongoDB) contra el saldo real on-chain (Stellar) de su dirección custodial.
 *
 * Detecta dos de los tres tipos de inconsistencia del spec §4.4 que son
 * computables por-wallet:
 *   - 'balance_mismatch'          → ambos registros existen pero difieren
 *   - 'offchain_without_onchain'  → hay saldo espejo pero la cadena no lo respalda
 * (El tercero, 'onchain_without_offchain' — inflow a una dirección no registrada —
 *  no es detectable a nivel de una wallet conocida; se vigila con el contador
 *  noMatch del listener y un barrido de cadena en un bloque posterior.)
 *
 * @param {{mirrorUSDC:number, onChainUSDC:number, toleranceUSDC?:number}} p
 * @returns {{status:'ok'|'balance_mismatch'|'offchain_without_onchain', deltaUSDC:number}}
 */
export function classifyWalletReconciliation({ mirrorUSDC, onChainUSDC, toleranceUSDC = RECON_TOLERANCE_USDC }) {
  const mirror  = Number(mirrorUSDC)  || 0
  const onChain = Number(onChainUSDC) || 0
  const delta   = +(mirror - onChain).toFixed(7)   // USDC tiene 7 decimales on-chain

  // Ambos prácticamente cero → nada que conciliar.
  if (Math.abs(mirror) <= toleranceUSDC && Math.abs(onChain) <= toleranceUSDC) {
    return { status: 'ok', deltaUSDC: 0 }
  }

  // Espejo positivo pero la cadena no lo respalda (subcolateralización del usuario).
  if (mirror > toleranceUSDC && onChain <= toleranceUSDC) {
    return { status: 'offchain_without_onchain', deltaUSDC: delta }
  }

  // Cualquier diferencia por encima de la tolerancia.
  if (Math.abs(delta) > toleranceUSDC) {
    return { status: 'balance_mismatch', deltaUSDC: delta }
  }

  return { status: 'ok', deltaUSDC: 0 }
}

/**
 * Prueba de solvencia (spec §4.5): compara el pasivo total (suma de saldos de
 * usuarios) contra la reserva total (USDC realmente custodiado on-chain).
 *
 * @param {{liabilitiesUSDC:number, reservesUSDC:number, toleranceUSDC?:number}} p
 * @returns {{liabilitiesUSDC:number, reservesUSDC:number, differenceUSDC:number, covered:boolean, status:'covered'|'uncovered'}}
 */
export function computeSolvency({ liabilitiesUSDC, reservesUSDC, toleranceUSDC = RECON_TOLERANCE_USDC }) {
  const liabilities = Number(liabilitiesUSDC) || 0
  const reserves    = Number(reservesUSDC)    || 0
  const difference  = +(reserves - liabilities).toFixed(7)
  // Cubierto si la reserva alcanza el pasivo (permitiendo la tolerancia de redondeo).
  const covered = difference >= -toleranceUSDC
  return {
    liabilitiesUSDC: +liabilities.toFixed(7),
    reservesUSDC:    +reserves.toFixed(7),
    differenceUSDC:  difference,
    covered,
    status: covered ? 'covered' : 'uncovered',
  }
}

/**
 * Clasifica la salud del listener por antigüedad de su último latido (heartbeat).
 *
 * @param {{heartbeatAt:number|null, now?:number, intervalMs?:number}} p
 * @returns {{status:'green'|'amber'|'red'|'unknown', secondsSinceHeartbeat:number|null, missedCycles:number|null}}
 */
export function classifyListenerHealth({ heartbeatAt, now = Date.now(), intervalMs = MONITOR_INTERVAL_MS }) {
  if (!heartbeatAt) {
    // Nunca latió: puede ser arranque reciente o listener que jamás corrió.
    return { status: 'unknown', secondsSinceHeartbeat: null, missedCycles: null }
  }
  const elapsedMs    = Math.max(0, now - heartbeatAt)
  const missedCycles = Math.floor(elapsedMs / intervalMs)
  let status = 'green'
  if (missedCycles >= MONITOR_RED_MISSED)        status = 'red'
  else if (missedCycles >= MONITOR_AMBER_MISSED) status = 'amber'
  return {
    status,
    secondsSinceHeartbeat: Math.round(elapsedMs / 1000),
    missedCycles,
  }
}

/**
 * Deriva las alertas activas a disparar a partir del estado del listener y de la
 * reconciliación (spec §5: los indicadores críticos deben disparar alerta, no solo
 * mostrarse en pantalla). Función PURA — no envía nada, solo decide qué alertar.
 *
 * NO cubre el saldo XLM bajo del channel account: eso ya lo alerta `monitorChannelXLM`
 * (email + Sentry). NO cubre solvencia: su identidad contable está sin confirmar, así
 * que no se auto-alerta hasta validarla con el equipo.
 *
 * @param {{listener?:object, reconciliation?:object, thresholds?:{maxDiscrepancies?:number}}} p
 * @returns {Array<{key:string, severity:'critical'|'warning', title:string, detail:string}>}
 */
export function evaluateAnchorAlerts({ listener, reconciliation, thresholds = {} }) {
  const maxDiscrepancies = thresholds.maxDiscrepancies ?? 0
  const alerts = []

  // Horizon inalcanzable — el listener no pudo consultar el último ledger.
  if (listener?.horizon && listener.horizon.reachable === false) {
    alerts.push({
      key:      'listener-horizon-unreachable',
      severity: 'critical',
      title:    'Horizon inalcanzable',
      detail:   'El listener no pudo consultar el último ledger de Horizon.',
    })
  }

  // Salud del listener por antigüedad del latido. 'unknown' (arranque reciente) y
  // 'green' no alertan; 'red' es el caso agresivo del spec §4.2.
  if (listener?.health === 'red') {
    alerts.push({
      key:      'listener-dead',
      severity: 'critical',
      title:    'Listener de pagos probablemente caído',
      detail:   `Sin latido hace ${listener.secondsSinceHeartbeat}s (${listener.missedCycles} ciclos perdidos). Los pagos on-chain se liquidan pero el sistema no los acredita.`,
    })
  } else if (listener?.health === 'amber') {
    alerts.push({
      key:      'listener-lagging',
      severity: 'warning',
      title:    'Listener de pagos con retraso',
      detail:   `Sin latido hace ${listener.secondsSinceHeartbeat}s (${listener.missedCycles} ciclos perdidos).`,
    })
  }

  // Reconciliación del dual ledger. Separa descuadres reales de errores de fetch
  // Horizon (transitorios): un descuadre real es crítico; los fetch errors son un
  // aviso de que la reconciliación quedó incompleta.
  if (reconciliation && Array.isArray(reconciliation.discrepancies)) {
    const real = reconciliation.discrepancies.filter(
      d => d.type === 'balance_mismatch' || d.type === 'offchain_without_onchain',
    )
    const fetchErrors = reconciliation.discrepancies.filter(d => d.type === 'onchain_fetch_error')

    if (real.length > maxDiscrepancies) {
      alerts.push({
        key:      'reconciliation-discrepancy',
        severity: 'critical',
        title:    'Descuadre en la reconciliación del dual ledger',
        detail:   `${real.length} descuadre(s) espejo vs on-chain, total ${reconciliation.totalMismatchUSDC ?? '?'} USDC.`,
      })
    }
    if (fetchErrors.length > 0) {
      alerts.push({
        key:      'reconciliation-fetch-errors',
        severity: 'warning',
        title:    'Reconciliación incompleta (Horizon inestable)',
        detail:   `${fetchErrors.length} dirección(es) no se pudieron consultar on-chain este ciclo.`,
      })
    }
  }

  return alerts
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES CON I/O (Horizon + MongoDB) — orquestan los helpers puros
// ═══════════════════════════════════════════════════════════════════════════

/** Deriva una public key desde un secret key de entorno, o null si no aplica. */
function publicKeyFromSecretEnv(envName) {
  const secret = process.env[envName]
  if (!secret || !secret.startsWith('S')) return null
  try { return Keypair.fromSecret(secret).publicKey() } catch { return null }
}

function srlPublicKey() {
  return process.env.STELLAR_SRL_PUBLIC_KEY ?? publicKeyFromSecretEnv('STELLAR_SRL_SECRET_KEY')
}

function channelPublicKey() {
  return process.env.STELLAR_MASTER_PUBLIC
    ?? publicKeyFromSecretEnv('STELLAR_CHANNEL_SECRET')
    ?? publicKeyFromSecretEnv('STELLAR_MASTER_SECRET')
}

/**
 * 4.2 — Estado del listener de Horizon (monitorUSDCDeposits, polling con cursor).
 *
 * NOTA: la arquitectura real es POLLING (cursor en SystemConfig cada ~30s), NO SSE.
 * El "lag" se mide contra el último ledger cerrado de la red y contra el heartbeat.
 */
export async function getListenerStatus() {
  const [heartbeat, latestLedger, watchedAddresses] = await Promise.all([
    SystemConfig.getValue(HEARTBEAT_KEY, null),
    horizonServer.ledgers().order('desc').limit(1).call().then(r => r.records?.[0] ?? null).catch(() => null),
    WalletUSDC.countDocuments({ status: 'active', stellarAddress: { $ne: null } }),
  ])

  const health = classifyListenerHealth({ heartbeatAt: heartbeat?.at ?? null })

  return {
    mode:        'polling',   // NO es SSE — polling con cursor en SystemConfig
    health:      health.status,
    secondsSinceHeartbeat: health.secondsSinceHeartbeat,
    missedCycles:          health.missedCycles,
    intervalMs:            MONITOR_INTERVAL_MS,
    lastCycle: heartbeat
      ? { at: new Date(heartbeat.at).toISOString(), stats: heartbeat.stats ?? null }
      : null,
    horizon: latestLedger
      ? {
          reachable:        true,
          latestLedger:     latestLedger.sequence,
          latestLedgerAt:   latestLedger.closed_at,
          secondsBehind:    latestLedger.closed_at
            ? Math.round((Date.now() - new Date(latestLedger.closed_at).getTime()) / 1000)
            : null,
        }
      : { reachable: false },
    watchedCustodialAddresses: watchedAddresses,
  }
}

/**
 * 4.3 — Tesorería on-chain. Saldos de la cuenta SRL, trustline USDC y XLM del
 * channel account (punto único de falla del Fee Bump).
 */
export async function getTreasuryStatus() {
  const srl     = srlPublicKey()
  const channel = channelPublicKey()

  const channelLowThreshold = parseFloat(process.env.XLM_CHANNEL_LOW_THRESHOLD ?? '5')
  const accountLowThreshold = parseFloat(process.env.XLM_ACCOUNT_LOW_THRESHOLD ?? '2')

  const [srlUsdc, srlXlm, srlTrustline, channelXlm] = await Promise.all([
    srl     ? getStellarUSDCBalance(srl).catch(() => null)   : Promise.resolve(null),
    srl     ? getStellarXLMBalance(srl).catch(() => null)    : Promise.resolve(null),
    srl     ? hasUSDCTrustline(srl).catch(() => null)        : Promise.resolve(null),
    channel ? getStellarXLMBalance(channel).catch(() => null): Promise.resolve(null),
  ])

  return {
    srl: srl ? {
      publicKey:     srl,
      usdcBalance:   srlUsdc,
      xlmBalance:    srlXlm,
      usdcTrustline: srlTrustline,
      xlmLow:        srlXlm != null ? srlXlm < accountLowThreshold : null,
    } : null,
    channelAccount: channel ? {
      publicKey:  channel,
      xlmBalance: channelXlm,
      // Alarma temprana: si el channel account se queda sin XLM, el Fee Bump falla
      // y TODOS los pagos de TODOS los usuarios se detienen (punto único de falla).
      xlmLow:      channelXlm != null ? channelXlm < channelLowThreshold : null,
      lowThreshold: channelLowThreshold,
      critical:    channelXlm != null ? channelXlm < channelLowThreshold : false,
    } : null,
  }
}

/**
 * 4.4 — Reconciliación del Dual Ledger. Compara, por wallet custodial activa, el
 * saldo espejo (MongoDB) contra el saldo real on-chain (Stellar).
 *
 * @param {{limit?:number}} [opts] - tope de wallets a inspeccionar por corrida
 * @returns {Promise<object>} resumen agregado + detalle de descuadres
 */
export async function reconcileDualLedger({ limit = 500 } = {}) {
  const wallets = await WalletUSDC.find({ status: { $in: ['active', 'frozen'] }, stellarAddress: { $ne: null } })
    .select('userId stellarAddress balance balanceFrozen balanceReserved status')
    .limit(limit)
    .lean()

  const discrepancies = []
  let checked = 0
  let totalMismatchUSDC = 0

  // On-chain lookups en paralelo controlado (el helper ya cachea por dirección).
  const results = await Promise.all(wallets.map(async (w) => {
    const mirrorUSDC  = mirrorLiabilityUSDC(w)
    let onChainUSDC   = null
    try {
      onChainUSDC = await getStellarUSDCBalance(w.stellarAddress)
    } catch {
      return { wallet: w, error: 'onchain-fetch-failed' }
    }
    return { wallet: w, mirrorUSDC, onChainUSDC }
  }))

  for (const r of results) {
    if (r.error) {
      discrepancies.push({
        userId:        String(r.wallet.userId),
        stellarAddress: r.wallet.stellarAddress,
        type:          'onchain_fetch_error',
      })
      continue
    }
    checked++
    const cls = classifyWalletReconciliation({ mirrorUSDC: r.mirrorUSDC, onChainUSDC: r.onChainUSDC })
    if (cls.status !== 'ok') {
      totalMismatchUSDC += Math.abs(cls.deltaUSDC)
      discrepancies.push({
        userId:         String(r.wallet.userId),
        stellarAddress: r.wallet.stellarAddress,
        type:           cls.status,
        mirrorUSDC:     +r.mirrorUSDC.toFixed(7),
        onChainUSDC:    +Number(r.onChainUSDC).toFixed(7),
        deltaUSDC:      cls.deltaUSDC,
        stellarExpert:  `https://stellar.expert/explorer/public/account/${r.wallet.stellarAddress}`,
      })
    }
  }

  return {
    ranAt:              new Date().toISOString(),
    walletsChecked:     checked,
    discrepancyCount:   discrepancies.length,
    totalMismatchUSDC:  +totalMismatchUSDC.toFixed(7),
    // Limitación explícita (spec §5: sin límites silenciosos): el tipo
    // 'onchain_without_offchain' (inflow a dirección no registrada) NO se detecta
    // aquí; se vigila con el contador noMatch del listener + barrido futuro.
    coverageNote: "Detecta 'balance_mismatch' y 'offchain_without_onchain'. 'onchain_without_offchain' se vigila vía listener noMatch (bloque futuro).",
    discrepancies,
  }
}

/**
 * 4.5 — Cuadre de reservas contra pasivos (prueba de solvencia).
 * Pasivo = Σ saldos de usuarios (mirror). Reserva = Σ USDC on-chain custodiado
 * en las direcciones custodiales de esos mismos usuarios.
 */
export async function getSolvencySnapshot({ limit = 2000 } = {}) {
  const wallets = await WalletUSDC.find({ status: { $in: ['active', 'frozen'] }, stellarAddress: { $ne: null } })
    .select('stellarAddress balance balanceFrozen')
    .limit(limit)
    .lean()

  let liabilitiesUSDC = 0
  const addresses = new Set()
  for (const w of wallets) {
    liabilitiesUSDC += mirrorLiabilityUSDC(w)
    if (w.stellarAddress) addresses.add(w.stellarAddress)
  }

  // Reserva = suma de USDC on-chain en las direcciones custodiales (una por usuario).
  let reservesUSDC = 0
  let reserveFetchErrors = 0
  await Promise.all([...addresses].map(async (addr) => {
    try { reservesUSDC += await getStellarUSDCBalance(addr) }
    catch { reserveFetchErrors++ }
  }))

  const solvency = computeSolvency({ liabilitiesUSDC, reservesUSDC })

  return {
    cutAt:              new Date().toISOString(),
    walletCount:        wallets.length,
    custodialAddresses: addresses.size,
    reserveFetchErrors,
    ...solvency,
    // Si hubo errores de fetch, la reserva está subestimada → advertir.
    reliable: reserveFetchErrors === 0,
  }
}
