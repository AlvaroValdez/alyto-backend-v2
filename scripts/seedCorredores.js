/**
 * seedCorredores.js — Seed de corredores de pago cross-border
 *
 * Crea o actualiza los corredores iniciales de Alyto V2.0 usando upsert:
 *   - Si el corredor ya existe, lo actualiza con los valores definidos aquí.
 *   - Si no existe, lo crea.
 *
 * Seguro para ejecutar múltiples veces (idempotente).
 *
 * Uso: node scripts/seedCorredores.js
 *      npm run seed:corredores
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import TransactionConfig from '../src/models/TransactionConfig.js';
import ExchangeRate      from '../src/models/ExchangeRate.js';

// ─── Definición de corredores ─────────────────────────────────────────────────

/**
 * Nota sobre nombres de campo:
 *   legalEntity   — entidad legal AV Finance que opera el corredor (LLC / SpA / SRL)
 *   payoutMethod  — enum del modelo: "vitaWallet" | "anchorBolivia" | "stellar_direct"
 *   routingScenario — A (LLC global) | B (SpA Chile) | C (SRL Bolivia) | D (LLC LatAm)
 */
const CORREDORES = [

  // ── Corredor 1: Chile → Colombia ──────────────────────────────────────────
  // Escenario B: payin vía Fintoc SpA + payout vía Vita withdrawal
  {
    corridorId:             'cl-co',
    originCountry:          'CL',
    destinationCountry:     'CO',
    originCurrency:         'CLP',
    destinationCurrency:    'COP',
    payinMethod:            'fintoc',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               300,
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,          // fixed_cost dinámico desde Vita /prices
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10000,      // mínimo 10.000 CLP (~10 USD)
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'B',
    isActive:               true,
    adminNotes:             'Corredor principal CL→CO. fixed_cost se obtiene en tiempo real de Vita /prices.',
  },

  // ── Corredor 2: Chile → Perú ──────────────────────────────────────────────
  {
    corridorId:             'cl-pe',
    originCountry:          'CL',
    destinationCountry:     'PE',
    originCurrency:         'CLP',
    destinationCurrency:    'PEN',
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
    adminNotes:             'Corredor CL→PE. fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 3: Chile → Bolivia ───────────────────────────────────────────
  // Escenario C: payout vía Anchor Manual Bolivia (AV Finance SRL)
  // El payout manual genera notificación email al admin + Comprobante Oficial PDF
  {
    corridorId:             'cl-bo',
    originCountry:          'CL',
    destinationCountry:     'BO',
    originCurrency:         'CLP',
    destinationCurrency:    'BOB',
    payinMethod:            'fintoc',
    payoutMethod:           'anchorBolivia',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               500,
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,
    profitRetentionPercent: 1.5,
    minAmountOrigin:        15000,      // mínimo mayor por costo operativo del anchor manual
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'C',
    isActive:               true,
    adminNotes:             'Corredor Bolivia — payout manual vía AV Finance SRL. Requiere Comprobante Oficial.',
  },

  // ── Corredor 4: Argentina → Colombia ─────────────────────────────────────
  // Escenario D: payin vía Vita (AR) + payout vía Vita (CO)
  {
    corridorId:             'ar-co',
    originCountry:          'AR',
    destinationCountry:     'CO',
    originCurrency:         'ARS',
    destinationCurrency:    'COP',
    payinMethod:            'vitaWallet',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               0,
    payinFeePercent:        1.5,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        5000,       // mínimo en ARS
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'D',
    isActive:               true,
    adminNotes:             'Corredor AR→CO. Payin y payout ambos vía Vita. Escenario D LLC LatAm.',
  },

  // ── Corredor 5: Brasil → Colombia ─────────────────────────────────────────
  // Inactivo hasta certificar integración BRL con Vita y testear PIX payin
  {
    corridorId:             'br-co',
    originCountry:          'BR',
    destinationCountry:     'CO',
    originCurrency:         'BRL',
    destinationCurrency:    'COP',
    payinMethod:            'vitaWallet',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               0,
    payinFeePercent:        1.5,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        100,        // mínimo en BRL
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'D',
    isActive:               false,      // inactivo hasta certificar con Vita
    adminNotes:             'INACTIVO — pendiente certificación BRL/PIX con Vita. Activar tras QA completo.',
  },

  // ── Corredor 7: Chile → Argentina ─────────────────────────────────────────
  {
    corridorId:             'cl-ar',
    originCountry:          'CL',
    destinationCountry:     'AR',
    originCurrency:         'CLP',
    destinationCurrency:    'ARS',
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
    adminNotes:             'Corredor CL→AR. fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 8: Chile → México ─────────────────────────────────────────────
  {
    corridorId:             'cl-mx',
    originCountry:          'CL',
    destinationCountry:     'MX',
    originCurrency:         'CLP',
    destinationCurrency:    'MXN',
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
    adminNotes:             'Corredor CL→MX. fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 9: Chile → Brasil ─────────────────────────────────────────────
  {
    corridorId:             'cl-br',
    originCountry:          'CL',
    destinationCountry:     'BR',
    originCurrency:         'CLP',
    destinationCurrency:    'BRL',
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
    adminNotes:             'Corredor CL→BR. fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 10: Chile → Estados Unidos ───────────────────────────────────
  {
    corridorId:             'cl-us',
    originCountry:          'CL',
    destinationCountry:     'US',
    originCurrency:         'CLP',
    destinationCurrency:    'USD',
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
    adminNotes:             'Corredor CL→US (USD). fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 11: Chile → Ecuador ───────────────────────────────────────────
  {
    corridorId:             'cl-ec',
    originCountry:          'CL',
    destinationCountry:     'EC',
    originCurrency:         'CLP',
    destinationCurrency:    'USD',
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
    adminNotes:             'Corredor CL→EC. Destino dolarizado (USD). fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 12: Chile → Venezuela ─────────────────────────────────────────
  {
    corridorId:             'cl-ve',
    originCountry:          'CL',
    destinationCountry:     'VE',
    originCurrency:         'CLP',
    destinationCurrency:    'USD',
    payinMethod:            'fintoc',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           3,
    fixedFee:               500,
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,
    profitRetentionPercent: 1.5,
    minAmountOrigin:        10000,
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'B',
    isActive:               true,
    adminNotes:             'Corredor CL→VE. Mayor spread y fee por riesgo operativo. Payout en USD vía Vita.',
  },

  // ── Corredor 13: Chile → Paraguay ──────────────────────────────────────────
  {
    corridorId:             'cl-py',
    originCountry:          'CL',
    destinationCountry:     'PY',
    originCurrency:         'CLP',
    destinationCurrency:    'PYG',
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
    adminNotes:             'Corredor CL→PY. fixed_cost dinámico desde Vita /prices.',
  },

  // ── Corredor 14: Chile → Uruguay ───────────────────────────────────────────
  {
    corridorId:             'cl-uy',
    originCountry:          'CL',
    destinationCountry:     'UY',
    originCurrency:         'CLP',
    destinationCurrency:    'UYU',
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
    adminNotes:             'Corredor CL→UY. fixed_cost dinámico desde Vita /prices.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  SpA Chile — Vita LatAm (corredores faltantes vs V1.5)
  //  CR, DO, GT, PA, HT → todos cubiertos por Vita Wallet
  // ══════════════════════════════════════════════════════════════════════════

  ...[
    { corridorId: 'cl-cr', dest: 'CR', destCurrency: 'CRC' },
    { corridorId: 'cl-do', dest: 'DO', destCurrency: 'DOP' },
    { corridorId: 'cl-gt', dest: 'GT', destCurrency: 'GTQ' },  // vita_sent routing
    { corridorId: 'cl-pa', dest: 'PA', destCurrency: 'USD' },  // Panamá dolarizado
    { corridorId: 'cl-ht', dest: 'HT', destCurrency: 'HTG' },
    { corridorId: 'cl-sv', dest: 'SV', destCurrency: 'USD' },  // El Salvador dolarizado — vita_sent routing
  ].map(({ corridorId, dest, destCurrency }) => ({
    corridorId,
    originCountry:          'CL',
    destinationCountry:     dest,
    originCurrency:         'CLP',
    destinationCurrency:    destCurrency,
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
    adminNotes:             `Corredor CL→${dest}. Vita Wallet. Verificar fixed_cost en /prices antes de activar en producción.`,
  })),

  // ══════════════════════════════════════════════════════════════════════════
  //  SpA Chile — OwlPay Global (AU, GB, CN)
  //  Payin: Fintoc (CLP) → Payout: OwlPay Harbor (AUD/GBP/CNY)
  //  Enrutado vía AV Finance LLC (Harbor) como payout institucional
  // ══════════════════════════════════════════════════════════════════════════

  ...[
    { corridorId: 'cl-au', dest: 'AU', destCurrency: 'AUD' },
    { corridorId: 'cl-gb', dest: 'GB', destCurrency: 'GBP' },
    { corridorId: 'cl-cn', dest: 'CN', destCurrency: 'CNY' },
  ].map(({ corridorId, dest, destCurrency }) => ({
    corridorId,
    originCountry:          'CL',
    destinationCountry:     dest,
    originCurrency:         'CLP',
    destinationCurrency:    destCurrency,
    payinMethod:            'fintoc',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   null,
    stellarAsset:           'USDC',
    alytoCSpread:           1.5,          // 0.5% OwlPay + 1% Alyto
    fixedFee:               500,          // ~0.5 USD en CLP
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        50000,        // mínimo mayor por riesgo y costos OwlPay
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'B',
    isActive:               true,
    adminNotes:             `Corredor CL→${dest}. Payout OwlPay Harbor. Verificar activación par CLP→${destCurrency} con Harbor antes de producción.`,
  })),

  // ══════════════════════════════════════════════════════════════════════════
  //  SRL Bolivia — Payin manual (BOB) → USDC (Stellar) → Payout LatAm
  // ══════════════════════════════════════════════════════════════════════════

  // ── Corredores SRL Bolivia ─────────────────────────────────────────────────
  //
  // manualExchangeRate: CONFIGURAR desde admin ANTES de activar operaciones.
  //   Endpoint: PATCH /api/v1/admin/corridors/:corridorId/rate
  //   Body: { "manualExchangeRate": 6.96, "note": "Tasa ASFI DD/MM/YYYY" }
  //
  //   Representa: 1 USDC = N BOB (activo de tránsito Stellar = USDC).
  //   Referencia: tasa ASFI oficial Bolivia = 6.96 BOB/USD (fija desde 2011).
  //   Sin esta tasa: getQuote devuelve error RATE_NOT_CONFIGURED.
  //
  // Flujo: BOB (banco SRL) → USDC (Stellar highway) → COP/PEN/USD (Vita/OwlPay)
  // fallbackPayoutMethod: 'owlPay' — Harbor/OwlPay si Vita no está disponible.
  ...[
    { corridorId: 'bo-co', dest: 'CO', destCurrency: 'COP', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-pe', dest: 'PE', destCurrency: 'PEN', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-cl', dest: 'CL', destCurrency: 'CLP', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-ar', dest: 'AR', destCurrency: 'ARS', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-mx', dest: 'MX', destCurrency: 'MXN', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-br', dest: 'BR', destCurrency: 'BRL', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-us', dest: 'US', destCurrency: 'USD', spread: 2, fixed: 3, retention: 0.8 },
    { corridorId: 'bo-ec', dest: 'EC', destCurrency: 'USD', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-ve', dest: 'VE', destCurrency: 'USD', spread: 3, fixed: 8, retention: 1.5 },
    { corridorId: 'bo-py', dest: 'PY', destCurrency: 'PYG', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-uy', dest: 'UY', destCurrency: 'UYU', spread: 2, fixed: 5, retention: 1 },
    // Vita LatAm faltantes vs V1.5
    { corridorId: 'bo-cr', dest: 'CR', destCurrency: 'CRC', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-do', dest: 'DO', destCurrency: 'DOP', spread: 2, fixed: 5, retention: 1 },
    { corridorId: 'bo-gt', dest: 'GT', destCurrency: 'GTQ', spread: 2, fixed: 5, retention: 1 },   // vita_sent routing
    { corridorId: 'bo-pa', dest: 'PA', destCurrency: 'USD', spread: 2, fixed: 3, retention: 0.8 },  // dolarizado
    { corridorId: 'bo-ht', dest: 'HT', destCurrency: 'HTG', spread: 3, fixed: 8, retention: 1.5 },
    { corridorId: 'bo-sv', dest: 'SV', destCurrency: 'USD', spread: 2, fixed: 3, retention: 0.8 },  // El Salvador dolarizado — vita_sent routing
  ].map(({ corridorId, dest, destCurrency, spread, fixed, retention }) => ({
    corridorId,
    originCountry:          'BO',
    destinationCountry:     dest,
    originCurrency:         'BOB',
    destinationCurrency:    destCurrency,
    payinMethod:            'manual',
    payoutMethod:           'vitaWallet',
    fallbackPayoutMethod:   'owlPay',         // Harbor/OwlPay como respaldo si Vita falla
    manualExchangeRate:     0,                // CONFIGURAR vía: PATCH /api/v1/admin/corridors/:corridorId/rate
    stellarAsset:           'USDC',
    alytoCSpread:           spread,
    fixedFee:               fixed,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: retention,
    minAmountOrigin:        50,
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'C',
    isActive:               true,
    adminNotes:             dest === 'HT'
      ? `Corredor BO→HT. Payin manual SRL. Verificar cobertura Vita para HTG antes de activar en producción. Configurar tasa BOB/USDC con PATCH /api/v1/admin/corridors/${corridorId}/rate`
      : `Corredor BO→${dest}. Payin manual SRL. Tránsito USDC vía Stellar. Configurar tasa BOB/USDC con PATCH /api/v1/admin/corridors/${corridorId}/rate`,
  })),

  // ══════════════════════════════════════════════════════════════════════════
  //  OwlPay Harbor — Corredores Institucionales B2B
  //  Payout primario vía OwlPay. Entidad LLC para corredores globales.
  //  Entidad SRL para bo-us (USD directo desde Bolivia).
  //
  //  Diferencia vs corredores SRL BO→LatAm:
  //    - SRL vitaWallet (primario) + owlPay (fallback)  → dispersión regional
  //    - Estos usan owlPay como PRIMARIO → destinos globales/institucionales
  // ══════════════════════════════════════════════════════════════════════════

  // ── BO → USA (USD institucional — SRL, OwlPay primario) ───────────────────
  // Override del corredor bo-us: owlPay como primario (vs vitaWallet en SRL LatAm)
  {
    corridorId:             'bo-us-owlpay',
    originCountry:          'BO',
    destinationCountry:     'US',
    originCurrency:         'BOB',
    destinationCurrency:    'USD',
    payinMethod:            'manual',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   'vitaWallet',
    manualExchangeRate:     0,            // CONFIGURAR: PATCH /api/v1/admin/corridors/bo-us-owlpay/rate
    stellarAsset:           'USDC',
    alytoCSpread:           1,            // 0.5% OwlPay fee + 0.5% Alyto
    fixedFee:               3,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.5,
    minAmountOrigin:        50,
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'C',
    isActive:               true,
    adminNotes:             'Corredor BO→US institucional. OwlPay Harbor como primario. Configurar tasa BOB/USDC.',
  },

  // ── BO → Eurozona (EUR — LLC, OwlPay) ─────────────────────────────────────
  {
    corridorId:             'bo-eu',
    originCountry:          'BO',
    destinationCountry:     'EU',
    originCurrency:         'BOB',
    destinationCurrency:    'EUR',
    payinMethod:            'manual',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   null,
    manualExchangeRate:     0,            // CONFIGURAR: PATCH /api/v1/admin/corridors/bo-eu/rate
    stellarAsset:           'USDC',
    alytoCSpread:           1.5,
    fixedFee:               5,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        50,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             'Corredor BO→EU (EUR). OwlPay Harbor LLC. Nuevo destino — verificar cobertura SEPA con OwlPay antes de activar en producción.',
  },

  // ── BO → México (MXN institucional — LLC, OwlPay) ─────────────────────────
  // Corredor LLC/institucional independiente del bo-mx (SRL/vitaWallet)
  {
    corridorId:             'bo-mx-llc',
    originCountry:          'BO',
    destinationCountry:     'MX',
    originCurrency:         'BOB',
    destinationCurrency:    'MXN',
    payinMethod:            'manual',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   'vitaWallet',
    manualExchangeRate:     0,            // CONFIGURAR: PATCH /api/v1/admin/corridors/bo-mx-llc/rate
    stellarAsset:           'USDC',
    alytoCSpread:           1,
    fixedFee:               5,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.5,
    minAmountOrigin:        50,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             'Corredor BO→MX institucional (LLC). OwlPay primario, Vita fallback. Distinto de bo-mx (SRL/vitaWallet).',
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  SRL Bolivia — OwlPay Global (AU, GB, CN)
  //  Payin: manual BOB → USDC Stellar → Payout OwlPay Harbor
  //  Tasa BOB/USDC: CONFIGURAR vía PATCH /api/v1/admin/corridors/:id/rate
  // ══════════════════════════════════════════════════════════════════════════

  ...[
    { corridorId: 'bo-au', dest: 'AU', destCurrency: 'AUD' },
    { corridorId: 'bo-gb', dest: 'GB', destCurrency: 'GBP' },
    { corridorId: 'bo-cn', dest: 'CN', destCurrency: 'CNY' },
  ].map(({ corridorId, dest, destCurrency }) => ({
    corridorId,
    originCountry:          'BO',
    destinationCountry:     dest,
    originCurrency:         'BOB',
    destinationCurrency:    destCurrency,
    payinMethod:            'manual',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   null,
    manualExchangeRate:     0,            // CONFIGURAR: PATCH /api/v1/admin/corridors/:corridorId/rate
    stellarAsset:           'USDC',
    alytoCSpread:           1.5,
    fixedFee:               5,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        50,
    maxAmountOrigin:        null,
    legalEntity:            'SpA',
    routingScenario:        'C',
    isActive:               true,
    adminNotes:             `Corredor BO→${dest}. Payin manual SRL, payout OwlPay Harbor. Configurar tasa BOB/USDC con PATCH /api/v1/admin/corridors/${corridorId}/rate`,
  })),

  // ── BO → Brasil (BRL institucional — LLC, OwlPay) ─────────────────────────
  {
    corridorId:             'bo-br-llc',
    originCountry:          'BO',
    destinationCountry:     'BR',
    originCurrency:         'BOB',
    destinationCurrency:    'BRL',
    payinMethod:            'manual',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   'vitaWallet',
    manualExchangeRate:     0,            // CONFIGURAR: PATCH /api/v1/admin/corridors/bo-br-llc/rate
    stellarAsset:           'USDC',
    alytoCSpread:           1,
    fixedFee:               5,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.5,
    minAmountOrigin:        50,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             'Corredor BO→BR institucional (LLC). OwlPay primario + PIX via Harbor. Distinto de bo-br (SRL/vitaWallet).',
  },

  // ── LLC Global (USD) → Colombia ────────────────────────────────────────────
  {
    corridorId:             'us-co',
    originCountry:          'US',
    destinationCountry:     'CO',
    originCurrency:         'USD',
    destinationCurrency:    'COP',
    payinMethod:            'vitaWallet',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               2,
    payinFeePercent:        1.5,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             'Corredor US→CO. Payin y payout vía Vita. Entidad LLC.',
  },

  // ── LLC Global (USD) → Perú ────────────────────────────────────────────────
  {
    corridorId:             'us-pe',
    originCountry:          'US',
    destinationCountry:     'PE',
    originCurrency:         'USD',
    destinationCurrency:    'PEN',
    payinMethod:            'vitaWallet',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               2,
    payinFeePercent:        1.5,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             'Corredor US→PE. Payin y payout vía Vita. Entidad LLC.',
  },

  // ── LLC Global (USD) → México ──────────────────────────────────────────────
  {
    corridorId:             'us-mx',
    originCountry:          'US',
    destinationCountry:     'MX',
    originCurrency:         'USD',
    destinationCurrency:    'MXN',
    payinMethod:            'vitaWallet',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               2,
    payinFeePercent:        1.5,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             'Corredor US→MX. Payin y payout vía Vita. Entidad LLC.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  LLC Global (USD) — Vita LatAm faltantes vs V1.5
  //  Payin: vitaWallet → Payout: vitaWallet
  // ══════════════════════════════════════════════════════════════════════════

  ...[
    { corridorId: 'us-ar', dest: 'AR', destCurrency: 'ARS' },
    { corridorId: 'us-br', dest: 'BR', destCurrency: 'BRL' },
    { corridorId: 'us-bo', dest: 'BO', destCurrency: 'BOB' },
    { corridorId: 'us-cl', dest: 'CL', destCurrency: 'CLP' },
    { corridorId: 'us-ec', dest: 'EC', destCurrency: 'USD' },
    { corridorId: 'us-ve', dest: 'VE', destCurrency: 'USD' },
    { corridorId: 'us-py', dest: 'PY', destCurrency: 'PYG' },
    { corridorId: 'us-uy', dest: 'UY', destCurrency: 'UYU' },
    { corridorId: 'us-cr', dest: 'CR', destCurrency: 'CRC' },
    { corridorId: 'us-do', dest: 'DO', destCurrency: 'DOP' },
    { corridorId: 'us-gt', dest: 'GT', destCurrency: 'GTQ' },  // vita_sent routing
    { corridorId: 'us-pa', dest: 'PA', destCurrency: 'USD' },
    { corridorId: 'us-ht', dest: 'HT', destCurrency: 'HTG' },
    { corridorId: 'us-sv', dest: 'SV', destCurrency: 'USD' },  // El Salvador dolarizado — vita_sent routing
  ].map(({ corridorId, dest, destCurrency }) => ({
    corridorId,
    originCountry:          'US',
    destinationCountry:     dest,
    originCurrency:         'USD',
    destinationCurrency:    destCurrency,
    payinMethod:            'vitaWallet',
    payoutMethod:           'vitaWallet',
    stellarAsset:           'USDC',
    alytoCSpread:           2,
    fixedFee:               2,
    payinFeePercent:        1.5,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.8,
    minAmountOrigin:        10,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             `Corredor US→${dest}. Payin y payout vía Vita. Entidad LLC.`,
  })),

  // ══════════════════════════════════════════════════════════════════════════
  //  LLC Global (USD) — OwlPay Global (AU, GB, CN)
  //  Payin: vitaWallet (USD) → Payout: OwlPay Harbor
  // ══════════════════════════════════════════════════════════════════════════

  ...[
    { corridorId: 'us-au', dest: 'AU', destCurrency: 'AUD' },
    { corridorId: 'us-gb', dest: 'GB', destCurrency: 'GBP' },
    { corridorId: 'us-cn', dest: 'CN', destCurrency: 'CNY' },
  ].map(({ corridorId, dest, destCurrency }) => ({
    corridorId,
    originCountry:          'US',
    destinationCountry:     dest,
    originCurrency:         'USD',
    destinationCurrency:    destCurrency,
    payinMethod:            'vitaWallet',
    payoutMethod:           'owlPay',
    fallbackPayoutMethod:   null,
    stellarAsset:           'USDC',
    alytoCSpread:           1,            // 0.5% OwlPay flat + 0.5% Alyto
    fixedFee:               3,
    payinFeePercent:        0,
    payoutFeeFixed:         0,
    profitRetentionPercent: 0.5,
    minAmountOrigin:        500,          // mínimo Harbor End User Model
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               true,
    adminNotes:             `Corredor US→${dest}. OwlPay Harbor LLC. Verificar activación par USD→${destCurrency} con Harbor antes de producción.`,
  })),

  // ── Corredor 6: Cualquier origen → Wallet Crypto (Stellar USDC) ──────────
  // Escenario futuro (Fase 18B): on-ramp directo a wallet Stellar
  {
    corridorId:             'any-crypto',
    originCountry:          'ANY',      // comodín — origen flexible
    destinationCountry:     'CRYPTO',   // destino = wallet Stellar, sin país físico
    originCurrency:         'CLP',
    destinationCurrency:    'USDC',
    payinMethod:            'fintoc',
    payoutMethod:           'stellar_direct',
    stellarAsset:           'USDC',
    alytoCSpread:           3,
    fixedFee:               0,
    payinFeePercent:        1.2,
    payoutFeeFixed:         0,
    profitRetentionPercent: 1,
    minAmountOrigin:        5000,
    maxAmountOrigin:        null,
    legalEntity:            'LLC',
    routingScenario:        'A',
    isActive:               false,      // inactivo hasta Fase 18B
    adminNotes:             'INACTIVO — on-ramp directo a Stellar USDC. Implementar en Fase 18B.',
  },
];

// ─── Lógica de seed ───────────────────────────────────────────────────────────

async function seedCorredores() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('[seedCorredores] ERROR: MONGODB_URI no definida en .env');
    process.exit(1);
  }

  console.log('[seedCorredores] Conectando a MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('[seedCorredores] Conexión exitosa.\n');

  let creados  = 0;
  let actualizados = 0;
  let activos  = 0;
  let inactivos = 0;

  for (const corredor of CORREDORES) {
    const result = await TransactionConfig.findOneAndUpdate(
      { corridorId: corredor.corridorId },   // el modelo aplica lowercase automáticamente
      { $set: corredor },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );

    // Si el documento fue insertado, Mongoose no tiene _id previo en el resultado
    // Distinguir nuevo vs actualizado por createdAt ≈ updatedAt
    const isNew = Math.abs(result.createdAt - result.updatedAt) < 1000;
    if (isNew) {
      creados++;
      console.log(`  ✅ CREADO    ${result.corridorId.toUpperCase().padEnd(12)} | ${result.originCurrency}→${result.destinationCurrency} | ${result.payinMethod}→${result.payoutMethod} | ${result.isActive ? 'ACTIVO' : 'INACTIVO'}`);
    } else {
      actualizados++;
      console.log(`  🔄 ACTUALIZADO ${result.corridorId.toUpperCase().padEnd(10)} | ${result.originCurrency}→${result.destinationCurrency} | ${result.payinMethod}→${result.payoutMethod} | ${result.isActive ? 'ACTIVO' : 'INACTIVO'}`);
    }

    if (result.isActive) activos++; else inactivos++;
  }

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  Corredores seedeados: ${activos} activos, ${inactivos} inactivos`);
  console.log(`  Nuevos: ${creados} | Actualizados: ${actualizados}`);
  console.log('────────────────────────────────────────────────────────\n');

  // ─── Seed tasas de cambio iniciales ────────────────────────────────────────
  console.log('\n[seedCorredores] Seeding tasas de cambio iniciales...');

  await ExchangeRate.findOneAndUpdate(
    { pair: 'BOB-USDT' },
    {
      pair:   'BOB-USDT',
      rate:   9.31,
      source: 'manual',
      note:   'Tasa inicial — actualizar desde panel admin (POST /api/v1/admin/exchange-rates)',
    },
    { upsert: true, new: true },
  );
  console.log('  ✅ BOB-USDT: 9.31 BOB/USDT (tasa inicial)');

  await ExchangeRate.findOneAndUpdate(
    { pair: 'CLP-USD' },
    {
      pair:   'CLP-USD',
      rate:   966,
      source: 'manual',
      note:   'Tasa referencial — Vita la actualiza automáticamente en cada cotización',
    },
    { upsert: true, new: true },
  );
  console.log('  ✅ CLP-USD: 966 CLP/USD (tasa referencial)');

  console.log('[seedCorredores] ✅ Tasas iniciales seedeadas\n');

  await mongoose.connection.close();
  console.log('[seedCorredores] Conexión cerrada. Script finalizado.');
}

seedCorredores().catch((err) => {
  console.error('[seedCorredores] Error fatal:', err.message);
  mongoose.connection.close().catch(() => {});
  process.exit(1);
});
