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
import WalletBOB    from '../models/WalletBOB.js'
import User         from '../models/User.js'
import { HEARTBEAT_KEY } from '../jobs/monitorUSDCDeposits.js'
import { getUSDCAvailableNow, getTreasuryReserveUSDC } from '../services/treasuryLiquidity.js'

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
 * ⚠️ La clasificación es CONSCIENTE DEL MODELO (custodial + ledger-only). En Alyto
 * los saldos por conversión BOB→USDC (Fase 35/39) y P2P (Fase 41) se acreditan en
 * el ledger Mongo SIN mover USDC a la dirección custodial del usuario — su respaldo
 * vive en la tesorería SRL, no en su cuenta. Por eso la dirección del delta importa:
 *
 *   - 'onchain_exceeds_ledger'   → la cadena tiene MÁS que el ledger (on-chain > espejo).
 *       USDC en la dirección custodial que NO se acreditó al usuario (depósito sin
 *       reconocer / inflow externo). Única inconsistencia por-wallet que es una
 *       ANOMALÍA REAL en este modelo.
 *   - 'ledger_exceeds_onchain'   → el ledger tiene MÁS que la cadena, con algo on-chain
 *       (wallet mixta: depósito on-chain + crédito ledger-only). ESPERADO.
 *   - 'offchain_without_onchain' → saldo espejo sin nada on-chain (puro ledger-only).
 *       ESPERADO.
 *
 * Los dos estados ESPERADOS (espejo > on-chain) NO son un hueco: su respaldo se
 * garantiza a nivel AGREGADO por la prueba de solvencia (getSolvencySnapshot), no
 * por dirección. La alerta solo escala 'onchain_exceeds_ledger' (ver evaluateAnchorAlerts).
 * (El tipo 'onchain_without_offchain' —inflow a dirección NO registrada— no es
 *  detectable por-wallet; se vigila con el contador noMatch del listener.)
 *
 * @param {{mirrorUSDC:number, onChainUSDC:number, toleranceUSDC?:number}} p
 * @returns {{status:'ok'|'onchain_exceeds_ledger'|'ledger_exceeds_onchain'|'offchain_without_onchain', deltaUSDC:number}}
 */
export function classifyWalletReconciliation({ mirrorUSDC, onChainUSDC, toleranceUSDC = RECON_TOLERANCE_USDC }) {
  const mirror  = Number(mirrorUSDC)  || 0
  const onChain = Number(onChainUSDC) || 0
  const delta   = +(mirror - onChain).toFixed(7)   // USDC tiene 7 decimales on-chain

  // Ambos prácticamente cero, o diferencia dentro de la tolerancia → nada que conciliar.
  if (Math.abs(mirror) <= toleranceUSDC && Math.abs(onChain) <= toleranceUSDC) {
    return { status: 'ok', deltaUSDC: 0 }
  }
  if (Math.abs(delta) <= toleranceUSDC) {
    return { status: 'ok', deltaUSDC: 0 }
  }

  // Dirección on-chain > espejo: la cadena tiene más que el ledger → anomalía REAL.
  if (onChain - mirror > toleranceUSDC) {
    return { status: 'onchain_exceeds_ledger', deltaUSDC: delta }   // delta < 0
  }

  // Dirección espejo > on-chain: estado ESPERADO del modelo ledger-only (respaldo en
  // tesorería). Sin nada on-chain → puro ledger-only; con algo on-chain → wallet mixta.
  if (Math.abs(onChain) <= toleranceUSDC) {
    return { status: 'offchain_without_onchain', deltaUSDC: delta }
  }
  return { status: 'ledger_exceeds_onchain', deltaUSDC: delta }
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
 * @param {{listener?:object, reconciliation?:object, solvency?:object,
 *          thresholds?:{maxDiscrepancies?:number, minHotUSDC?:number}}} p
 *   thresholds.minHotUSDC — mínimo operativo de la cuenta caliente. En 0 o ausente
 *   la alerta de recarga no se evalúa (despliegue sin reserva fría).
 * @returns {Array<{key:string, severity:'critical'|'warning', title:string, detail:string}>}
 */
export function evaluateAnchorAlerts({ listener, reconciliation, solvency, thresholds = {} }) {
  const minHotUSDC = Number(thresholds.minHotUSDC) || 0
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

  // Reconciliación del dual ledger. En el modelo custodial + ledger-only con barrido de
  // USDC custodial a tesorería, el saldo on-chain de una dirección está DECORRELACIONADO
  // del ledger en AMBAS direcciones, así que NINGÚN descuadre por-wallet es riesgo de
  // colateralización — esa cobertura solo la mide la solvencia agregada (abajo).
  //   - espejo > on-chain ('offchain_without_onchain', 'ledger_exceeds_onchain'): estado
  //     esperado de conversión/P2P; respaldo en tesorería. NO se alerta.
  //   - on-chain > espejo ('onchain_exceeds_ledger'): USDC en la dirección custodial por
  //     encima del ledger. NUNCA es sub-colateralización (hay de más, no de menos) y suele
  //     ser TRANSITORIO (ventana depósito→acreditación→barrido) o el reverso de un P2P
  //     ledger-only. Se degrada a AVISO (cooldown 6h): sirve para detectar un depósito
  //     PERSISTENTEMENTE sin acreditar, no para paginar en cada liquidación.
  //   - fetch errors: transitorios → aviso de reconciliación incompleta.
  if (reconciliation && Array.isArray(reconciliation.discrepancies)) {
    const onchainExcess = reconciliation.discrepancies.filter(d => d.type === 'onchain_exceeds_ledger')
    const fetchErrors   = reconciliation.discrepancies.filter(d => d.type === 'onchain_fetch_error')

    if (onchainExcess.length > maxDiscrepancies) {
      const total = onchainExcess.every(d => Number.isFinite(d.deltaUSDC))
        ? +onchainExcess.reduce((s, d) => s + Math.abs(d.deltaUSDC), 0).toFixed(7)
        : (reconciliation.totalMismatchUSDC ?? '?')
      alerts.push({
        key:      'reconciliation-discrepancy',
        severity: 'warning',
        title:    'USDC on-chain sin acreditar en el ledger (revisar si persiste)',
        detail:   `${onchainExcess.length} wallet(s) con on-chain > espejo, total ${total} USDC. Suele ser transitorio (liquidación en curso) y NO es riesgo de colateralización; investigar solo si se repite en ciclos sucesivos.`,
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

  // Solvencia agregada (§4.5): la red de seguridad REAL del modelo ledger-only. Si la
  // reserva (custodial + tesorería) no cubre el pasivo (saldos + payouts en vuelo), es
  // sub-colateralización real → crítico. Si no se pudo medir con fiabilidad (algún fetch
  // on-chain falló), la cobertura quedó ciega → aviso.
  if (solvency) {
    if (solvency.covered === false) {
      const deficit = Number.isFinite(solvency.differenceUSDC) ? Math.abs(solvency.differenceUSDC) : '?'
      alerts.push({
        key:      'solvency-uncovered',
        severity: 'critical',
        title:    'Sub-colateralización de la tesorería',
        detail:   `El pasivo (${solvency.liabilitiesUSDC ?? '?'} USDC) supera la reserva custodial+tesorería (${solvency.reservesUSDC ?? '?'} USDC). Déficit ${deficit} USDC.`,
      })
    } else if (solvency.reliable === false) {
      alerts.push({
        key:      'solvency-unreliable',
        severity: 'warning',
        title:    'Solvencia no verificable este ciclo',
        detail:   'No se pudo medir la reserva on-chain con fiabilidad (fetch Horizon fallido); la cobertura quedó sin confirmar.',
      })
    }

    // Recarga de la cuenta caliente. Con reserva fría, la solvencia puede estar
    // perfecta y aun así los payouts empezar a fallar porque la caliente se agotó:
    // la fría no se moviliza sola, exige dos firmas. Avisar ANTES de que el primer
    // payout rebote — es un problema de liquidez, no de solvencia.
    if (solvency.coldConfigured && minHotUSDC > 0 && Number.isFinite(solvency.treasuryHotUSDC)
        && solvency.treasuryHotUSDC < minHotUSDC) {
      alerts.push({
        key:      'treasury-hot-low',
        severity: 'warning',
        title:    'Cuenta caliente por debajo del mínimo operativo',
        detail:   `La caliente tiene ${solvency.treasuryHotUSDC} USDC, por debajo del mínimo de ${minHotUSDC} USDC. `
                + `Requiere recarga desde la reserva fría (dos firmas). Reserva fría disponible: ${solvency.treasuryColdUSDC ?? '?'} USDC.`,
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
    coverageNote: "Detecta 'onchain_exceeds_ledger' (anomalía real), 'ledger_exceeds_onchain' y 'offchain_without_onchain' (esperados en el modelo ledger-only, respaldo agregado en tesorería vía solvencia). 'onchain_without_offchain' se vigila vía listener noMatch (bloque futuro).",
    discrepancies,
  }
}

/**
 * 4.5 — Cuadre de reservas contra pasivos (prueba de solvencia, modelo de dos lados).
 *
 * En el modelo custodial + ledger-only de Alyto el USDC vive en DOS pozos y hay DOS
 * clases de pasivo, así que una solvencia honesta suma ambos lados:
 *
 *   RESERVA  = USDC custodial on-chain (depósitos directos de usuarios, Fase 40)
 *            + USDC de la tesorería SRL on-chain (respaldo de conversiones BOB→USDC
 *              y P2P, que acreditan el ledger sin mover USDC a la cuenta del usuario)
 *
 *   PASIVO   = Σ saldos USDC de usuarios (mirror: balance + congelado)
 *            + USDC de payouts comprometidos/en vuelo contra la tesorería
 *              (getUSDCAvailableNow.inflight — estados payout_pending_usdc_send /
 *               payout_in_transit / payout_sent)
 *
 * Cubierto ⇔ RESERVA ≥ PASIVO. La reserva de tesorería y el en-vuelo salen de
 * `treasuryLiquidity` (misma fuente que el pre-check de payout) para no desincronizar
 * definiciones. Antes la reserva contaba SOLO lo custodial y omitía la tesorería, por
 * lo que reportaba sub-colateralización falsa (los saldos por conversión/P2P están
 * respaldados por la tesorería, no por la cuenta custodial del usuario).
 */
export async function getSolvencySnapshot({ limit = 2000 } = {}) {
  const wallets = await WalletUSDC.find({ status: { $in: ['active', 'frozen'] }, stellarAddress: { $ne: null } })
    .select('stellarAddress balance balanceFrozen')
    .limit(limit)
    .lean()

  // ── Pasivo lado usuarios + reserva lado custodial (por dirección) ────────────
  let userLiabilitiesUSDC = 0
  const addresses = new Set()
  for (const w of wallets) {
    userLiabilitiesUSDC += mirrorLiabilityUSDC(w)
    if (w.stellarAddress) addresses.add(w.stellarAddress)
  }

  let custodialReserveUSDC = 0
  let reserveFetchErrors = 0
  await Promise.all([...addresses].map(async (addr) => {
    try { custodialReserveUSDC += await getStellarUSDCBalance(addr) }
    catch { reserveFetchErrors++ }
  }))

  // ── Lado tesorería: reserva on-chain + payouts en vuelo (pasivo) ─────────────
  // La RESERVA suma caliente + fría: la fría respalda el pasivo aunque requiera dos
  // firmas para moverse. Medirla solo con la caliente reportaría un déficit falso en
  // cuanto el grueso del respaldo se traslade a la fría.
  // El VUELO sigue saliendo de getUSDCAvailableNow, que excluye lo custodial.
  let treasuryReserveUSDC = 0
  let treasuryHotUSDC     = 0
  let treasuryColdUSDC    = 0
  let coldConfigured      = false
  let inflightPayoutUSDC  = 0
  let treasuryFetchError  = false
  try {
    const [reserve, t] = await Promise.all([
      getTreasuryReserveUSDC('SRL'),
      getUSDCAvailableNow('SRL'),
    ])
    treasuryReserveUSDC = Number(reserve.total) || 0
    treasuryHotUSDC     = Number(reserve.hot)   || 0
    treasuryColdUSDC    = Number(reserve.cold)  || 0
    coldConfigured      = reserve.coldConfigured
    inflightPayoutUSDC  = Number(t.inflight) || 0
    // Sin pubkey o con un fetch fallido, la reserva quedó subestimada.
    if (reserve.total == null || reserve.partial) treasuryFetchError = true
  } catch {
    treasuryFetchError = true
  }

  const reservesUSDC    = custodialReserveUSDC + treasuryReserveUSDC
  const liabilitiesUSDC = userLiabilitiesUSDC + inflightPayoutUSDC
  const solvency = computeSolvency({ liabilitiesUSDC, reservesUSDC })

  return {
    cutAt:              new Date().toISOString(),
    walletCount:        wallets.length,
    custodialAddresses: addresses.size,
    reserveFetchErrors,
    // Desglose de los dos lados para el panel (§4.5).
    custodialReserveUSDC: +custodialReserveUSDC.toFixed(7),
    treasuryReserveUSDC:  +treasuryReserveUSDC.toFixed(7),
    // Desglose caliente/fría: la caliente es lo movilizable por el sistema, la fría
    // exige multifirma. La suma es el respaldo; solo la caliente es liquidez.
    treasuryHotUSDC:      +treasuryHotUSDC.toFixed(7),
    treasuryColdUSDC:     +treasuryColdUSDC.toFixed(7),
    coldConfigured,
    userLiabilitiesUSDC:  +userLiabilitiesUSDC.toFixed(7),
    inflightPayoutUSDC:   +inflightPayoutUSDC.toFixed(7),
    ...solvency,
    // Reserva subestimada si falló algún fetch custodial O el de tesorería.
    reliable: reserveFetchErrors === 0 && !treasuryFetchError,
  }
}

/**
 * 4.7 — Congelamientos ACTIVOS. Lista las wallets actualmente congeladas (BOB y
 * USDC) con los datos del usuario y del congelamiento (quién, cuándo, motivo).
 * El histórico de congelamientos/descongelamientos vive en el audit log
 * (GET /admin/anchor/audit?action=wallet.freeze).
 */
export async function getFrozenWallets() {
  const [bobFrozen, usdcFrozen] = await Promise.all([
    WalletBOB.find({ status: 'frozen' }).select('userId balanceFrozen frozenReason frozenAt frozenBy').lean(),
    WalletUSDC.find({ status: 'frozen' }).select('userId balanceFrozen frozenReason frozenAt frozenBy').lean(),
  ])

  // Agrupar por usuario (un usuario puede tener BOB y USDC congelados).
  const byUser = new Map()
  const put = (row, ledger) => {
    const uid = String(row.userId)
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId:       uid,
        frozenReason: row.frozenReason ?? null,
        frozenAt:     row.frozenAt ?? null,
        frozenBy:     row.frozenBy ? String(row.frozenBy) : null,
        ledgers:      {},
      })
    }
    byUser.get(uid).ledgers[ledger] = { balanceFrozen: row.balanceFrozen ?? 0 }
  }
  bobFrozen.forEach(r => put(r, 'BOB'))
  usdcFrozen.forEach(r => put(r, 'USDC'))

  // Enriquecer con datos del usuario (sin exponer nada sensible).
  const userIds = [...byUser.keys()]
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id email firstName lastName legalEntity')
    .lean()
  const userMap = new Map(users.map(u => [String(u._id), u]))

  const frozen = [...byUser.values()].map(row => {
    const u = userMap.get(row.userId)
    return {
      ...row,
      user: u ? { email: u.email, name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), legalEntity: u.legalEntity } : null,
    }
  }).sort((a, b) => new Date(b.frozenAt ?? 0) - new Date(a.frozenAt ?? 0))

  return { count: frozen.length, frozen }
}
