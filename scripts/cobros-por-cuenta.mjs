#!/usr/bin/env node
/**
 * cobros-por-cuenta.mjs — Qué hay en cada cuenta, y de quién es. SOLO LECTURA.
 *
 *   node scripts/cobros-por-cuenta.mjs
 *   node scripts/cobros-por-cuenta.mjs --desde 2026-10-01
 *   node scripts/cobros-por-cuenta.mjs --json
 *
 * ── Para qué ────────────────────────────────────────────────────────────────
 *
 * Mientras BANECO habilita las cuentas nuevas (2111783624 y 2111783662), TODO
 * sigue cobrándose en la cuenta original 2111088816: carga de billetera y pagos
 * transfronterizos mezclados. La segregación ya está construida pero inerte.
 *
 * El día que las cuentas estén listas hay que mover el dinero que corresponde a
 * cada destino. Este reporte es el que dice cuánto: agrupa los cobros
 * efectivamente acreditados por **cuenta** y por **destino de fondos**.
 *
 * Sin él, esa transferencia sería a ojo, y mezclar fondos de clientes al
 * repartirlos es exactamente el problema que la segregación viene a resolver.
 *
 * ── Qué cuenta y qué no ─────────────────────────────────────────────────────
 *
 * Solo cobros con sello de pago real (`bankQr.paidAt`). Un QR emitido y no
 * pagado no puso un peso en ninguna cuenta, así que no se reparte.
 *
 * Los cobros anteriores a que se registrara la cuenta aparecen como
 * `<sin registrar>`. Todos ellos cayeron en la cuenta original, porque hasta
 * octubre de 2026 no había otra; el backfill los deja explícitos.
 */
import * as dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'

const JSON_OUT = process.argv.includes('--json')
const iDesde   = process.argv.indexOf('--desde')
const DESDE    = iDesde !== -1 ? new Date(process.argv[iDesde + 1]) : null

const uri = process.env.MONGODB_URI
if (!uri) { console.error('Falta MONGODB_URI.'); process.exit(1) }
await mongoose.connect(uri)
const db = mongoose.connection.db

const SIN_CUENTA = '<sin registrar>'
const filtroFecha = DESDE ? { 'bankQr.paidAt': { $gte: DESDE } } : {}

/** Agrega una colección al acumulador por cuenta y propósito. */
async function acumular(coleccion, campoMonto, propositoPorDefecto, acc) {
  const docs = await db.collection(coleccion).find({
    'bankQr.paidAt': { $ne: null, $exists: true },
    ...filtroFecha,
  }).project({ [campoMonto]: 1, bankQr: 1 }).toArray()

  for (const d of docs) {
    const cuenta    = d.bankQr?.accountCredit || SIN_CUENTA
    const proposito = d.bankQr?.purpose || propositoPorDefecto
    const monto     = Number(d[campoMonto] ?? 0)
    if (!Number.isFinite(monto)) continue

    acc[cuenta] ??= {}
    acc[cuenta][proposito] ??= { monto: 0, operaciones: 0 }
    acc[cuenta][proposito].monto       += monto
    acc[cuenta][proposito].operaciones += 1
  }
}

const acc = {}
await acumular('wallettransactions', 'amount',         'wallet_deposit',    acc)
await acumular('transactions',       'originalAmount', 'crossborder_payin', acc)

// Qué cuenta corresponde a cada destino, según la configuración vigente.
const cfg = await db.collection('srl_config').findOne({})
const destino = {
  wallet_deposit:    cfg?.bankAccounts?.wallet_deposit?.accountNumber    || null,
  crossborder_payin: cfg?.bankAccounts?.crossborder_payin?.accountNumber || null,
}

if (JSON_OUT) {
  console.log(JSON.stringify({ porCuenta: acc, destinoConfigurado: destino }, null, 2))
} else {
  console.log('\n── Cobros acreditados, por cuenta y destino de fondos ──\n')
  const cuentas = Object.keys(acc).sort()
  if (!cuentas.length) console.log('  (sin cobros acreditados en el período)')

  for (const cuenta of cuentas) {
    const total = Object.values(acc[cuenta]).reduce((s, v) => s + v.monto, 0)
    console.log(`  Cuenta ${cuenta}   total Bs ${total.toFixed(2)}`)
    for (const [prop, v] of Object.entries(acc[cuenta]).sort()) {
      const marca = destino[prop] && destino[prop] !== cuenta && cuenta !== SIN_CUENTA ? '  ← debe moverse' : ''
      console.log(`     ${prop.padEnd(20)} Bs ${String(v.monto.toFixed(2)).padStart(10)}  (${v.operaciones} op)${marca}`)
    }
    console.log('')
  }

  console.log('── Destino configurado por propósito ──')
  for (const [prop, cuenta] of Object.entries(destino)) {
    console.log(`  ${prop.padEnd(20)} ${cuenta ?? 'sin configurar (sigue cayendo en la cuenta por defecto)'}`)
  }

  const pendiente = Object.entries(acc).flatMap(([cuenta, props]) =>
    Object.entries(props)
      .filter(([prop]) => destino[prop] && destino[prop] !== cuenta && cuenta !== SIN_CUENTA)
      .map(([prop, v]) => ({ de: cuenta, a: destino[prop], prop, monto: v.monto })))

  if (pendiente.length) {
    console.log('\n── Transferencias de regularización pendientes ──')
    pendiente.forEach(p => console.log(`  Bs ${p.monto.toFixed(2).padStart(10)}  ${p.de} → ${p.a}   (${p.prop})`))
  } else {
    console.log('\n  Nada por mover: cada cobro ya está en la cuenta de su destino.')
  }
}

await mongoose.disconnect()
