#!/usr/bin/env node
/**
 * stellar-treasury-state.mjs — Estado on-chain de la tesorería. SOLO LECTURA.
 *
 * Imprime saldos, firmantes y umbrales de la cuenta caliente y de la reserva fría,
 * y evalúa si la multifirma está realmente configurada. Es la evidencia que se
 * captura antes y después de montar la reserva fría, y la que se adjunta al
 * expediente ASFI para demostrar el control.
 *
 *   node scripts/stellar-treasury-state.mjs
 *   node scripts/stellar-treasury-state.mjs --json
 *
 * No requiere ninguna clave privada: opera solo con claves públicas, que es
 * precisamente lo que hace verificable el control desde afuera.
 */
import * as dotenv from 'dotenv'
dotenv.config()

const JSON_OUT = process.argv.includes('--json')
const HORIZON  = process.env.STELLAR_HORIZON_URL
  ?? (process.env.STELLAR_NETWORK === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org')

const USDC_ISSUER = process.env.STELLAR_USDC_ISSUER ?? null

async function fetchAccount(pubKey) {
  const res = await fetch(`${HORIZON}/accounts/${pubKey}`)
  if (res.status === 404) return { notFunded: true }
  if (!res.ok) throw new Error(`Horizon ${res.status} para ${pubKey}`)
  return res.json()
}

/**
 * Un umbral medio >= 2 con firmantes de peso 1 significa que ninguna llave
 * individual puede mover fondos. Es el control que se le declara al regulador, así
 * que conviene verificarlo contra la cadena y no contra la intención.
 */
function assessMultisig(acc) {
  if (acc.notFunded) return { multisig: false, reason: 'cuenta inexistente o sin fondear' }

  const signers   = acc.signers ?? []
  const medium    = Number(acc.thresholds?.med_threshold ?? 0)
  const high      = Number(acc.thresholds?.high_threshold ?? 0)
  const totalPeso = signers.reduce((s, x) => s + Number(x.weight || 0), 0)
  const maxSolo   = signers.reduce((m, x) => Math.max(m, Number(x.weight || 0)), 0)

  if (medium < 2) {
    return { multisig: false, reason: `umbral medio en ${medium}: una sola firma basta para mover fondos` }
  }
  if (maxSolo >= medium) {
    return { multisig: false, reason: `existe un firmante de peso ${maxSolo} >= umbral ${medium}: puede operar solo` }
  }
  if (totalPeso < medium) {
    return { multisig: false, reason: `peso total ${totalPeso} < umbral ${medium}: CUENTA BLOQUEADA, nadie puede operar` }
  }
  return { multisig: true, reason: `requiere ${medium} de ${totalPeso} de peso; ningún firmante alcanza solo (máx ${maxSolo})`, medium, high, totalPeso }
}

function balanceOf(acc, code) {
  if (acc.notFunded) return null
  const b = (acc.balances ?? []).find((x) =>
    code === 'XLM' ? x.asset_type === 'native'
                   : x.asset_code === code && (!USDC_ISSUER || x.asset_issuer === USDC_ISSUER))
  return b ? Number(b.balance) : 0
}

const cuentas = [
  { rol: 'CALIENTE (operativa)', key: process.env.STELLAR_SRL_PUBLIC_KEY,      esperado: 'firma simple' },
  { rol: 'FRÍA (reserva)',       key: process.env.STELLAR_SRL_COLD_PUBLIC_KEY, esperado: 'multifirma'   },
].filter((c) => c.key)

if (cuentas.length === 0) {
  console.error('❌ Ni STELLAR_SRL_PUBLIC_KEY ni STELLAR_SRL_COLD_PUBLIC_KEY están definidas.')
  process.exit(1)
}

const salida = []
for (const c of cuentas) {
  const acc = await fetchAccount(c.key)
  const ms  = assessMultisig(acc)
  salida.push({
    rol: c.rol, esperado: c.esperado, publicKey: c.key,
    existe: !acc.notFunded,
    usdc: balanceOf(acc, 'USDC'), xlm: balanceOf(acc, 'XLM'),
    firmantes: (acc.signers ?? []).map((s) => ({ key: s.key, weight: s.weight })),
    umbrales: acc.thresholds ?? null,
    ...ms,
  })
}

if (JSON_OUT) {
  console.log(JSON.stringify({ horizon: HORIZON, capturadoEn: new Date().toISOString(), cuentas: salida }, null, 2))
  process.exit(0)
}

console.log(`\nHorizon: ${HORIZON}`)
console.log(`Capturado: ${new Date().toISOString()}\n`)

for (const c of salida) {
  console.log('─'.repeat(78))
  console.log(`${c.rol}  —  esperado: ${c.esperado}`)
  console.log(`  ${c.publicKey}`)
  if (!c.existe) { console.log('  ⚠️  cuenta inexistente o sin fondear\n'); continue }
  console.log(`  USDC: ${c.usdc}   XLM: ${c.xlm}`)
  console.log(`  umbrales: low=${c.umbrales.low_threshold} med=${c.umbrales.med_threshold} high=${c.umbrales.high_threshold}`)
  console.log('  firmantes:')
  for (const s of c.firmantes) console.log(`    ${s.key}  peso=${s.weight}`)
  console.log(`  multifirma: ${c.multisig ? '✅ SÍ' : '❌ NO'} — ${c.reason}`)
  console.log()
}

const fria = salida.find((c) => c.rol.startsWith('FRÍA'))
const cal  = salida.find((c) => c.rol.startsWith('CALIENTE'))

console.log('─'.repeat(78))
console.log('RESUMEN')
if (!fria) {
  console.log('  ❌ Sin reserva fría configurada (STELLAR_SRL_COLD_PUBLIC_KEY ausente).')
  console.log('     Todo el respaldo vive en una cuenta de firma simple.')
} else if (!fria.multisig) {
  console.log('  ❌ La reserva fría NO tiene multifirma efectiva:', fria.reason)
  console.log('     NO trasladar fondos hasta corregirlo.')
} else {
  console.log('  ✅ Reserva fría con multifirma efectiva:', fria.reason)
  const total = (cal?.usdc ?? 0) + fria.usdc
  const pct   = total > 0 ? ((fria.usdc / total) * 100).toFixed(1) : '0.0'
  console.log(`     Respaldo total: ${total} USDC — ${pct}% bajo multifirma, ${cal?.usdc ?? 0} USDC expuesto en la caliente.`)
  const min = Number(process.env.STELLAR_HOT_MIN_USDC) || 0
  if (min > 0 && (cal?.usdc ?? 0) < min) {
    console.log(`     ⚠️  La caliente (${cal?.usdc}) está por debajo del mínimo operativo (${min}): requiere recarga.`)
  }
}
console.log()
