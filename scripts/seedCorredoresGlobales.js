import 'dotenv/config'
import mongoose from 'mongoose'
import TransactionConfig from '../src/models/TransactionConfig.js'

await mongoose.connect(process.env.MONGODB_URI)

const owlPayBase = {
  payinMethod:            'fintoc',
  payoutMethod:           'owlPay',
  isActive:               true,
  routingScenario:        'B',
  payinFeePercent:        0,
  alytoCSpread:           1.5,
  fixedFee:               300,
  payoutFeeFixed:         0,
  profitRetentionPercent: 0.5,
  // Harbor mínimo $500 USD para SpA/CLP (End User Model)
  // minAmountOrigin = 483 000 CLP ≈ 500 USD × 966 CLP/USD (fallback estático)
  // resolveMinAmountOrigin() usará minAmountUSD dinámicamente en runtime
  minAmountUSD:           500,
  minAmountOrigin:        483000,
  maxAmountOrigin:        null,
}

const corridors = [
  // ── SpA (CL) → Global via OwlPay ──────────────────────────────────────────
  {
    ...owlPayBase,
    corridorId:          'cl-eu',
    legalEntity:         'SpA',
    originCountry:       'CL',
    destinationCountry:  'EU',
    originCurrency:      'CLP',
    destinationCurrency: 'EUR',
  },
  {
    ...owlPayBase,
    corridorId:          'cl-cn',
    legalEntity:         'SpA',
    originCountry:       'CL',
    destinationCountry:  'CN',
    originCurrency:      'CLP',
    destinationCurrency: 'CNY',
  },
  {
    ...owlPayBase,
    corridorId:          'cl-ae',
    legalEntity:         'SpA',
    originCountry:       'CL',
    destinationCountry:  'AE',
    originCurrency:      'CLP',
    destinationCurrency: 'AED',
  },
  {
    ...owlPayBase,
    corridorId:          'cl-gb',
    legalEntity:         'SpA',
    originCountry:       'CL',
    destinationCountry:  'GB',
    originCurrency:      'CLP',
    destinationCurrency: 'GBP',
  },

  // ── SRL (BO) → Global via OwlPay ──────────────────────────────────────────
  // Harbor mínimo $30 USD para SRL retail (confirmado para CN/NG, aplicado a todos)
  // resolveMinAmountOrigin() convierte dinámicamente con tasa BOB/USDC live
  {
    ...owlPayBase,
    corridorId:          'bo-eu-srl',
    legalEntity:         'SRL',
    originCountry:       'BO',
    destinationCountry:  'EU',
    originCurrency:      'BOB',
    destinationCurrency: 'EUR',
    payinMethod:         'manual',
    minAmountUSD:        30,
    minAmountOrigin:     1,
    fixedFee:            0,
  },
  {
    ...owlPayBase,
    corridorId:          'bo-cn-srl',
    legalEntity:         'SRL',
    originCountry:       'BO',
    destinationCountry:  'CN',
    originCurrency:      'BOB',
    destinationCurrency: 'CNY',
    payinMethod:         'manual',
    minAmountUSD:        30,
    minAmountOrigin:     1,
    fixedFee:            0,
  },
  {
    ...owlPayBase,
    corridorId:          'bo-ae-srl',
    legalEntity:         'SRL',
    originCountry:       'BO',
    destinationCountry:  'AE',
    originCurrency:      'BOB',
    destinationCurrency: 'AED',
    payinMethod:         'manual',
    minAmountUSD:        30,
    minAmountOrigin:     1,
    fixedFee:            0,
  },
  {
    ...owlPayBase,
    corridorId:          'bo-gb-srl',
    legalEntity:         'SRL',
    originCountry:       'BO',
    destinationCountry:  'GB',
    originCurrency:      'BOB',
    destinationCurrency: 'GBP',
    payinMethod:         'manual',
    minAmountUSD:        30,
    minAmountOrigin:     1,
    fixedFee:            0,
  },
]

for (const corridor of corridors) {
  await TransactionConfig.findOneAndUpdate(
    { corridorId: corridor.corridorId, legalEntity: corridor.legalEntity },
    { $setOnInsert: corridor },
    { upsert: true, new: true }
  )
  console.log(`✅ ${corridor.corridorId} → ${corridor.destinationCountry} (${corridor.legalEntity} | ${corridor.payoutMethod})`)
}

await mongoose.disconnect()
console.log('\n✅ Seed global completado.')
