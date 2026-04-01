/**
 * seedCorredoresEsPl.js — Seed de corredores España (ES) y Polonia (PL)
 *
 * Crea 4 corredores nuevos:
 *   CL → ES | CLP → EUR | SpA | fintoc → vitaWallet (vita_sent)
 *   CL → PL | CLP → PLN | SpA | fintoc → vitaWallet (vita_sent)
 *   BO → ES | BOB → EUR | SRL | manual  → vitaWallet (vita_sent)
 *   BO → PL | BOB → PLN | SRL | manual  → vitaWallet (vita_sent)
 *
 * Nota: ES y PL son despachados vía vita_sent (no withdrawal) porque Vita
 * no soporta bank withdrawal en Europa. El sistema lo rutea automáticamente
 * usando VITA_SENT_ONLY_COUNTRIES en quoteSocket.js / paymentController.js.
 *
 * Uso: node scripts/seedCorredoresEsPl.js
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import TransactionConfig from '../src/models/TransactionConfig.js'

await mongoose.connect(process.env.MONGODB_URI)

const corridors = [

  // ── SpA: Chile → España ───────────────────────────────────────────────────
  {
    corridorId:             'cl-es',
    originCountry:          'CL',
    destinationCountry:     'ES',
    originCurrency:         'CLP',
    destinationCurrency:    'EUR',
    payinMethod:            'fintoc',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               300,
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10000,
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'B',
    isActive:               true,
    adminNotes:             'CL→ES via vita_sent (VITA_SENT_ONLY_COUNTRIES). fixed_cost dinámico desde Vita /prices.',
  },

  // ── SpA: Chile → Polonia ──────────────────────────────────────────────────
  {
    corridorId:             'cl-pl',
    originCountry:          'CL',
    destinationCountry:     'PL',
    originCurrency:         'CLP',
    destinationCurrency:    'PLN',
    payinMethod:            'fintoc',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               300,
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10000,
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'B',
    isActive:               true,
    adminNotes:             'CL→PL via vita_sent (VITA_SENT_ONLY_COUNTRIES). fixed_cost dinámico desde Vita /prices.',
  },

  // ── SRL: Bolivia → España ─────────────────────────────────────────────────
  {
    corridorId:             'bo-es-srl',
    originCountry:          'BO',
    destinationCountry:     'ES',
    originCurrency:         'BOB',
    destinationCurrency:    'EUR',
    payinMethod:            'manual',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               5,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 1,
    manualExchangeRate:     0,       // fallback a BOB_USD_RATE env
    minAmountOrigin:        100,
    maxAmountOrigin:        null,
    legalEntity:            'SRL',
    routingScenario:        'C',
    isActive:               true,
    adminNotes:             'BO→ES via vita_sent (VITA_SENT_ONLY_COUNTRIES). Payin manual Banco Bisa.',
  },

  // ── SRL: Bolivia → Polonia ────────────────────────────────────────────────
  {
    corridorId:             'bo-pl-srl',
    originCountry:          'BO',
    destinationCountry:     'PL',
    originCurrency:         'BOB',
    destinationCurrency:    'PLN',
    payinMethod:            'manual',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               5,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 1,
    manualExchangeRate:     0,       // fallback a BOB_USD_RATE env
    minAmountOrigin:        100,
    maxAmountOrigin:        null,
    legalEntity:            'SRL',
    routingScenario:        'C',
    isActive:               true,
    adminNotes:             'BO→PL via vita_sent (VITA_SENT_ONLY_COUNTRIES). Payin manual Banco Bisa.',
  },
]

for (const corridor of corridors) {
  const doc = await TransactionConfig.findOneAndUpdate(
    { corridorId: corridor.corridorId },
    { $setOnInsert: corridor },
    { upsert: true, new: true }
  )
  const wasCreated = doc.createdAt?.getTime() === doc.updatedAt?.getTime()
  const status = wasCreated ? '✅ creado' : '⚠️  ya existe'
  console.log(`${status}  ${corridor.corridorId.padEnd(12)} → ${corridor.destinationCountry} | ${corridor.originCurrency}→${corridor.destinationCurrency} | ${corridor.legalEntity}`)
}

await mongoose.disconnect()
console.log('\n✅ Seed ES/PL completado.')
