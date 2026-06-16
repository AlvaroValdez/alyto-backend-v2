/**
 * adminRoutes.js — Rutas del Panel de Administración
 *
 * Todas las rutas requieren:
 *   1. protect()    → JWT válido, carga req.user
 *   2. checkAdmin() → req.user.role === 'admin', responde 403 si no
 *
 * Montado en server.js bajo: /api/v1/admin
 *
 * Endpoints:
 *   GET   /users                              — Lista todos los usuarios
 *   GET   /ledger                             — Últimas 100 operaciones (legacy)
 *   GET   /transactions                       — Ledger paginado con filtros y resumen
 *   GET   /transactions/:transactionId        — Detalle completo de una transacción
 *   PATCH /transactions/:transactionId/status — Actualización manual de status
 *   GET   /corridors                          — Lista todos los corredores
 *   PATCH /corridors/:corridorId              — Actualiza parámetros de un corredor
 *   POST  /funding                            — Registra fondeo de liquidez (USDC/P2P)
 *   GET   /funding                            — Lista fondeos paginados con resumen
 *   GET   /funding/balance                    — Balance estimado de liquidez por entidad
 *   GET   /funding/forecast                   — Previsión USDC live: Stellar vs compromisos
 */

import { Router }    from 'express';
import { protect }   from '../middlewares/authMiddleware.js';
import { checkAdmin } from '../middlewares/checkAdmin.js';
import { idempotencyCheck } from '../middlewares/idempotency.js';
import {
  getAllUsers,
  getUser,
  updateUser,
  getGlobalLedger,
  listTransactions,
  getLedgerCounts,
  getTransaction,
  updateTransactionStatus,
  listCorridors,
  createCorridor,
  updateCorridor,
  setCorridorRate,
  deactivateCorridor,
  getCorridorAnalytics,
  getGlobalAnalytics,
  updateGlobalPricing,
  getTransactionComprobante,
  getCorridorRates,
  vitaDiagnostic,
  vitaBalance,
  stellarBalance,
  testPush,
  getMemoryStats,
  resetUserTokenVersion,
  simulateBankQrPayment,
} from '../controllers/adminController.js';
import adminSSE from './adminSSE.js';
import {
  createFunding,
  listFunding,
  getFundingBalance,
  getUSDCForecast,
  createFundingIntent,
  listFundingIntents,
  cancelFundingIntent,
} from '../controllers/fundingController.js';
import {
  getWalletFeeConfig,
  updateWalletFeeConfig,
  getWalletFeeRevenue,
  harvestRevenueToTreasury,
} from '../controllers/walletFeeController.js';
import {
  upsertExchangeRate,
  listExchangeRates,
  getCLPBOBRate,
  updateCLPBOBRate,
  deleteBOBUSDCOverride,
} from '../controllers/exchangeRateController.js';
import {
  listKYBApplications,
  getKYBApplication,
  reviewKYBApplication,
  downloadKYBDocument,
} from '../controllers/kybController.js';
import {
  getSRLConfig,
  uploadSRLQR,
  toggleSRLQR,
  deleteSRLQR,
  uploadWalletSRLQR,
  toggleWalletSRLQR,
  deleteWalletSRLQR,
  updateBankData,
} from '../controllers/srlConfigController.js';
import {
  getSpAConfig,
  updateSpAConfig,
} from '../controllers/spaConfigController.js';
import {
  adminListWallets,
  adminListPendingDeposits,
  adminGetDepositComprobante,
  adminConfirmDeposit,
  adminFreezeWallet,
  adminUnfreezeWallet,
  adminListPendingWithdrawals,
  adminConfirmWithdrawal,
  adminRejectWithdrawal,
} from '../controllers/walletController.js';
import {
  adminListPendingConversions,
  adminConfirmBOBtoUSDC,
  adminRejectBOBtoUSDC,
} from '../controllers/walletUSDCController.js';
import {
  adminListarReclamos,
  adminReclamosVencimientos,
  adminGetReclamo,
  adminResponderReclamo,
} from '../controllers/reclamosController.js';
import {
  listSanctions,
  addSanction,
  removeSanction,
  screenUserManual,
  listFlaggedUsers,
  clearSanctionsFlag,
} from '../controllers/sanctionsController.js';
import {
  adminGetBusinessInvoice,
} from '../controllers/businessInvoiceController.js';
import { simulateTransferCompleted } from '../services/owlPayService.js';
import multer from 'multer';

const router = Router();

// Aplicar protect + checkAdmin a TODAS las rutas de este router
router.use(protect, checkAdmin);

// multer para upload de imágenes QR (solo en rutas que lo necesitan)
const qrUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024, files: 1 },  // 2 MB máx.
  fileFilter(_req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo no permitido: ${file.mimetype}. Use PNG, JPG o WebP.`));
  },
});

// ─── Usuarios ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/users
 * Lista todos los usuarios del sistema ordenados por fecha de creación.
 */
router.get('/users', getAllUsers);

/**
 * GET /api/v1/admin/users/:userId
 * Detalle completo de un usuario para el modal de edición.
 */
router.get('/users/:userId', getUser);

/**
 * PATCH /api/v1/admin/users/:userId
 * Edita campos permitidos: accountType, legalEntity, kycStatus, role, isActive, sanctionsFlag.
 * Si isActive pasa a false, invalida tokens activos del usuario.
 */
router.patch('/users/:userId', updateUser);

/**
 * PATCH /api/v1/admin/users/:userId/reset-token-version
 * Resetea tokenVersion del usuario a 0 (rescate de sesiones desincronizadas).
 */
router.patch('/users/:userId/reset-token-version', resetUserTokenVersion);

// ─── Ledger legacy ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/ledger/counts
 * Counts por tab (actionable, manual_payout, in_progress, history, unpaid).
 * Debe ir ANTES de /ledger y del mount de adminSSE para evitar colisiones.
 */
router.get('/ledger/counts', getLedgerCounts);

/**
 * GET /api/v1/admin/ledger/events
 * Server-Sent Events para notificaciones en tiempo real al admin.
 * Auth: cookie alyto_token (inherited de router.use(protect, checkAdmin) arriba).
 */
router.use('/ledger', adminSSE);

/**
 * GET /api/v1/admin/ledger
 * Últimas 100 operaciones con usuario origen populado (vista rápida).
 * Para consultas filtradas y paginadas, usar /transactions.
 */
router.get('/ledger', getGlobalLedger);

// ─── Backoffice Ledger — Transacciones ────────────────────────────────────────

/**
 * GET /api/v1/admin/transactions
 *
 * Lista paginada de transacciones con filtros y resumen estadístico.
 *
 * Query params opcionales:
 *   status      — Ej: "completed", "failed", "in_transit"
 *   corridorId  — Slug del corredor (ej. "cl-bo-fintoc-anchorbolivia")
 *   entity      — "LLC" | "SpA" | "SRL"
 *   startDate   — ISO 8601 (ej. "2026-01-01")
 *   endDate     — ISO 8601 (ej. "2026-03-31")
 *   page        — default 1
 *   limit       — default 20, máximo 100
 *
 * Responde: { transactions, pagination, summary }
 */
router.get('/transactions', listTransactions);

/**
 * GET /api/v1/admin/transactions/:transactionId
 *
 * Documento completo de una transacción, incluyendo ipnLog y userId poblado.
 * Params: transactionId — alytoTransactionId (ej. "ALY-B-1710000000000-XYZ123")
 */
router.get('/transactions/:transactionId', getTransaction);

/**
 * GET /api/v1/admin/transactions/:transactionId/comprobante
 * Retorna el comprobante de pago subido por el usuario (base64).
 * Esta ruta DEBE ir ANTES de /:transactionId/status para evitar conflicto.
 */
router.get('/transactions/:transactionId/comprobante', getTransactionComprobante);

/**
 * GET /api/v1/admin/transactions/:transactionId/business-invoice
 *
 * Genera y descarga el Comprobante Oficial de Servicio B2B (PDF) desde admin.
 * Sin ownership check — acceso admin completo.
 */
router.get('/transactions/:transactionId/business-invoice', adminGetBusinessInvoice);

/**
 * PATCH /api/v1/admin/transactions/:transactionId/status
 *
 * Actualización manual del status. Registra la intervención en ipnLog.
 * Body: { status: String, note: String }
 */
router.patch('/transactions/:transactionId/status', idempotencyCheck, updateTransactionStatus);

/**
 * POST /api/v1/admin/transactions/:transactionId/simulate-bankqr-payment
 * Simula el webhook IPN del banco para sandbox. Solo transacciones bankQr en payin_pending.
 */
router.post('/transactions/:transactionId/simulate-bankqr-payment', simulateBankQrPayment);

// ─── Corredores ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/corridors
 * Todos los corredores (activos e inactivos), ordenados por corridorId.
 */
router.get('/corridors', listCorridors);

/**
 * GET /api/v1/admin/corridors/rates
 *
 * Tasas en tiempo real de todos los corredores activos.
 * Muestra fees desglosados, tasa efectiva y monto estimado para un envío de referencia.
 * IMPORTANTE: esta ruta DEBE ir ANTES de /:corridorId para que Express
 * no interprete "rates" como un corridorId.
 *
 * Query params: referenceAmount (default 100000)
 */
router.get('/corridors/rates', getCorridorRates);

/**
 * POST /api/v1/admin/corridors
 * Crea un corredor nuevo. Valida que corridorId no exista.
 * Body: todos los campos requeridos de TransactionConfig.
 */
router.post('/corridors', createCorridor);

/**
 * PATCH /api/v1/admin/corridors/:corridorId/rate
 *
 * Actualiza la tasa de cambio manual (BOB/USDC) de un corredor SRL Bolivia.
 * Solo aplica a corredores con payinMethod: 'manual'.
 *
 * Body: { manualExchangeRate: number, note: string }
 *   manualExchangeRate — unidades de originCurrency por 1 USDC (ej. 6.96 para BOB)
 *   note               — descripción obligatoria del ajuste (mín. 10 chars)
 *
 * Esta ruta DEBE registrarse ANTES de /:corridorId para que Express no la capture.
 */
router.patch('/corridors/:corridorId/rate', setCorridorRate);

/**
 * PATCH /api/v1/admin/corridors/:corridorId
 * Actualiza parámetros de un corredor con registro en changeLog.
 * corridorId es inmutable.
 */
router.patch('/pricing/global', updateGlobalPricing);
router.patch('/corridors/:corridorId', updateCorridor);

/**
 * DELETE /api/v1/admin/corridors/:corridorId
 * Baja lógica: isActive: false + deletedAt. No elimina físicamente.
 */
router.delete('/corridors/:corridorId', deactivateCorridor);

/**
 * GET /api/v1/admin/corridors/:corridorId/analytics
 * Rentabilidad del corredor en el periodo indicado.
 * Query params: startDate, endDate (ISO)
 */
router.get('/corridors/:corridorId/analytics', getCorridorAnalytics);

// ─── Fondeo Manual de Liquidez ────────────────────────────────────────────────

/**
 * POST /api/v1/admin/funding
 * Registra una operación de fondeo (compra USDC Binance P2P, exchange, etc.)
 * Body: { entity, type, asset, amount, sourceCurrency?, sourceAmount?,
 *         stellarTxId?, binanceOrderId?, bankReference?, note?, status? }
 */
router.post('/funding', createFunding);

/**
 * GET /api/v1/admin/funding
 * Lista fondeos paginados con resumen agregado por asset.
 * Query: entity?, asset?, type?, status?, startDate?, endDate?, page?, limit?
 * IMPORTANTE: Esta ruta DEBE ir ANTES de /funding/balance para que Express
 * no confunda "balance" con un ID de registro.
 */
router.get('/funding', listFunding);

/**
 * GET /api/v1/admin/funding/balance
 * Balance estimado de liquidez por entidad (totalFunded, totalPaidOut, available).
 * Query: entity? — filtra por LLC | SpA | SRL
 */
router.get('/funding/balance', getFundingBalance);

/**
 * GET /api/v1/admin/funding/forecast
 * Previsión USDC en tiempo real: balance Stellar live vs compromisos en vuelo vs
 * transacciones bloqueadas por liquidez insuficiente.
 * Query: entity? — 'SRL' (default) | 'LLC'
 * Responde: { alertLevel, stellar, committed, availableNow, pendingFunding, gap, fundingNeeded, recommendation }
 */
router.get('/funding/forecast', getUSDCForecast);

/**
 * Fondeo de tesorería — Intents (Camino A, H3).
 * POST   /api/v1/admin/funding/intents               — crea intent + QR SEP-7
 * GET    /api/v1/admin/funding/intents               — lista intents
 * PATCH  /api/v1/admin/funding/intents/:intentId/cancel — cancela intent abierto
 */
router.post('/funding/intents', createFundingIntent);
router.get('/funding/intents', listFundingIntents);
router.patch('/funding/intents/:intentId/cancel', cancelFundingIntent);

/**
 * Comisiones de wallet (P3 USDC P2P).
 * GET  /api/v1/admin/wallet-fees                  — config actual
 * PUT  /api/v1/admin/wallet-fees                  — actualizar comisiones
 * GET  /api/v1/admin/wallet-fees/revenue           — revenue acumulada + verificación
 * POST /api/v1/admin/wallet-fees/harvest-revenue   — cosecha revenue → tesorería SRL (?dryRun=true)
 */
router.get('/wallet-fees/revenue', getWalletFeeRevenue);
router.post('/wallet-fees/harvest-revenue', harvestRevenueToTreasury);
router.get('/wallet-fees', getWalletFeeConfig);
router.put('/wallet-fees', updateWalletFeeConfig);

// ─── Tasas de Cambio ──────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/exchange-rates/clp-bob
 * Tasas del corredor CLP→BOB: CLP/USDT, BOB/USDT, CLP/BOB (calculada).
 * IMPORTANTE: debe ir ANTES de /exchange-rates genérico.
 */
router.get('/exchange-rates/clp-bob', getCLPBOBRate);

/**
 * PATCH /api/v1/admin/exchange-rates/clp-bob
 * Actualiza CLP/USDT + BOB/USDT, calcula CLP/BOB, sincroniza SpAConfig.clpPerBob.
 * Body: { clpPerUsdt, bobPerUsdt, note? }
 */
router.patch('/exchange-rates/clp-bob', updateCLPBOBRate);

/**
 * POST /api/v1/admin/exchange-rates
 * Crea o actualiza la tasa para un par (upsert). Guarda previousRate automáticamente.
 * Body: { pair, rate, note? }
 */
router.post('/exchange-rates', upsertExchangeRate);

/**
 * DELETE /api/v1/admin/exchange-rates/bob-usdc-override
 * Elimina el override manual BOB-USDC y vuelve al auto-computado (job ≤ 30 min).
 * Falla si no hay override manual activo.
 */
router.delete('/exchange-rates/bob-usdc-override', deleteBOBUSDCOverride);

/**
 * GET /api/v1/admin/exchange-rates
 * Lista todas las tasas activas con quién las actualizó.
 */
router.get('/exchange-rates', listExchangeRates);

// ─── Analytics Global ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/analytics
 * Analytics global: volumen, revenue, desglose por entidad y corredor.
 * Query params: startDate, endDate (ISO)
 */
router.get('/analytics', getGlobalAnalytics);

// ─── Vita — Diagnóstico ───────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/vita/diagnostic
 *
 * Diagnóstico completo de la cuenta Vita AV Finance SpA:
 * saldos activos, cobertura de países por tabla de precios (clp_sell / usd_sell /
 * usdt_sell), depósitos recientes y pares de exchange disponibles.
 */
router.get('/vita/diagnostic', vitaDiagnostic);
router.get('/vita/balance',    vitaBalance);
router.get('/stellar/balance', stellarBalance);

// ─── SpA Chile — Configuración payin manual CLP ─────────────────────────

/**
 * GET /api/v1/admin/spa-config
 * Datos bancarios SpA, tasa CLP/BOB y limites del corredor cl-bo.
 */
router.get('/spa-config', getSpAConfig);

/**
 * PATCH /api/v1/admin/spa-config
 * Actualiza datos bancarios, tasa y limites.
 * Body: { bankName?, accountType?, accountNumber?, rut?, accountHolder?,
 *         bankEmail?, clpPerBob?, minAmountCLP?, maxAmountCLP?, isActive? }
 */
router.patch('/spa-config', updateSpAConfig);

// ─── SRL Bolivia — Configuración QR de pago ──────────────────────────────────

/**
 * GET /api/v1/admin/srl-config
 *
 * Devuelve la configuración SRL Bolivia completa:
 * todos los QR subidos (activos e inactivos) con metadatos del admin que los subió.
 */
router.get('/srl-config', getSRLConfig);

/**
 * POST /api/v1/admin/srl-config/qr
 *
 * Sube un nuevo código QR de pago para Bolivia.
 * Content-Type: multipart/form-data
 *
 * Campos:
 *   label  {string}  — Nombre visible al usuario ("Tigo Money", "Banco Bisa QR", etc.)
 *   qr     {File}    — Imagen PNG/JPG del QR (máx. 2 MB)
 *
 * El QR activo se incluye automáticamente en las instrucciones de todos los
 * corredores SRL con payinMethod === 'manual'.
 *
 * IMPORTANTE: esta ruta DEBE ir ANTES de /srl-config/qr/:qrId para que Express
 * no confunda el path con un qrId.
 */
router.post('/srl-config/qr', qrUpload.single('qr'), uploadSRLQR);

/**
 * PATCH /api/v1/admin/srl-config/qr/:qrId
 *
 * Activa o desactiva un QR sin eliminarlo.
 * Body: { "isActive": true | false }
 */
router.patch('/srl-config/qr/:qrId', toggleSRLQR);

/**
 * DELETE /api/v1/admin/srl-config/qr/:qrId
 *
 * Elimina permanentemente un QR de la configuración.
 * No afecta transacciones ya creadas.
 */
router.delete('/srl-config/qr/:qrId', deleteSRLQR);

/**
 * POST   /api/v1/admin/srl-config/wallet-qr          — Subir QR depósito Wallet BOB
 * PATCH  /api/v1/admin/srl-config/wallet-qr/:qrId    — Activar / desactivar
 * DELETE /api/v1/admin/srl-config/wallet-qr/:qrId    — Eliminar
 *
 * IMPORTANTE: la ruta POST debe ir ANTES de /wallet-qr/:qrId
 */
router.post('/srl-config/wallet-qr',          qrUpload.single('qr'), uploadWalletSRLQR);
router.patch('/srl-config/wallet-qr/:qrId',   toggleWalletSRLQR);
router.delete('/srl-config/wallet-qr/:qrId',  deleteWalletSRLQR);

/**
 * PATCH /api/v1/admin/srl-config/bank-data
 *
 * Actualiza los datos bancarios de AV Finance SRL mostrados en las instrucciones de pago.
 * Body: { bankName, accountHolder, accountNumber, accountType }
 *
 * IMPORTANTE: esta ruta DEBE ir DESPUÉS de /srl-config/qr/:qrId para evitar conflictos.
 */
router.patch('/srl-config/bank-data', updateBankData);

// ─── KYB — Cuentas Business ───────────────────────────────────────────────────

/**
 * GET /api/v1/admin/kyb
 *
 * Lista todas las solicitudes KYB con filtros y paginación.
 *
 * Query params:
 *   status                 — pending | under_review | approved | rejected | more_info
 *   country                — ISO 3166-1 alpha-2 (país de incorporación)
 *   estimatedMonthlyVolume — under_5k | 5k_20k | 20k_60k | over_60k
 *   page                   — default 1
 *   limit                  — default 20, máx 100
 */
router.get('/kyb', listKYBApplications);

/**
 * GET /api/v1/admin/kyb/:businessId
 *
 * Detalle completo de una solicitud KYB.
 * Incluye documentos en base64 para descarga y visualización.
 * Params: businessId — ej. "BIZ-A1B2C3D4"
 *
 * IMPORTANTE: esta ruta DEBE ir ANTES de /:businessId/review para evitar
 * que Express interprete "review" como un businessId.
 */
router.get('/kyb/:businessId', getKYBApplication);

/**
 * PATCH /api/v1/admin/kyb/:businessId/review
 *
 * Aprobar, rechazar o solicitar más información en una solicitud KYB.
 *
 * Body:
 *   status             {string}  — 'approved' | 'rejected' | 'more_info' | 'under_review'
 *   note               {string}  — Comentario visible al usuario
 *   rejectionReason    {string}  — Solo si status === 'rejected'
 *   transactionLimits  {object}  — { maxSingleTransaction, maxMonthlyVolume } — solo si approved
 */
router.patch('/kyb/:businessId/review', reviewKYBApplication);

/**
 * GET /api/v1/admin/kyb/:businessId/documents/:docIdx
 * Descarga/previsualiza un documento KYB (imagen o PDF).
 * Query: ?inline=1 para visualización en browser.
 */
router.get('/kyb/:businessId/documents/:docIdx', downloadKYBDocument);

// ─── Wallet BOB — Fase 25 ─────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/wallet
 * Lista paginada de todas las WalletBOB con usuario y saldo.
 * Query: status?, page?, limit?
 * IMPORTANTE: esta ruta DEBE ir ANTES de /wallet/deposits/pending y /wallet/:userId/*
 */
router.get('/wallet',                    adminListWallets);

/**
 * GET /api/v1/admin/wallet/deposits/pending
 * Lista depósitos BOB pendientes de confirmación manual.
 * IMPORTANTE: esta ruta DEBE ir ANTES de /wallet/:userId/* para que Express
 * no interprete "deposits" como un userId.
 */
router.get('/wallet/deposits/pending',   adminListPendingDeposits);

/**
 * GET /api/v1/admin/wallet/deposits/:wtxId/comprobante
 * Devuelve la imagen del comprobante (base64) de un depósito BOB manual.
 * IMPORTANTE: va ANTES de /wallet/:userId/* por el mismo motivo de orden.
 */
router.get('/wallet/deposits/:wtxId/comprobante', adminGetDepositComprobante);

/**
 * POST /api/v1/admin/wallet/deposit/confirm
 * Admin confirma que recibió la transferencia bancaria y acredita el saldo.
 * Body: { wtxId, bankReference, note? }
 */
router.post('/wallet/deposit/confirm',   adminConfirmDeposit);

/**
 * GET  /api/v1/admin/wallet/withdrawals/pending  — Lista retiros pendientes BOB
 * POST /api/v1/admin/wallet/withdrawal/confirm   — Confirma retiro (transfiere)
 * POST /api/v1/admin/wallet/withdrawal/reject    — Rechaza retiro (libera reserva)
 */
router.get('/wallet/withdrawals/pending',  adminListPendingWithdrawals);
router.post('/wallet/withdrawal/confirm',  adminConfirmWithdrawal);
router.post('/wallet/withdrawal/reject',   adminRejectWithdrawal);

/**
 * PATCH /api/v1/admin/wallet/:userId/freeze
 * Congela la wallet de un usuario por compliance ASFI/UIF.
 * Body: { reason (requerido), reportNumber? }
 */
router.patch('/wallet/:userId/freeze',   adminFreezeWallet);

/**
 * PATCH /api/v1/admin/wallet/:userId/unfreeze
 * Descongela la wallet de un usuario.
 */
router.patch('/wallet/:userId/unfreeze', adminUnfreezeWallet);

// ─── USDC Wallet — Fase 35 ────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/wallet/usdc/conversions/pending
 * Lista conversiones BOB→USDC pendientes de confirmación.
 */
router.get('/wallet/usdc/conversions/pending', adminListPendingConversions);

/**
 * POST /api/v1/admin/wallet/usdc/conversions/confirm
 * Confirma una conversión BOB→USDC: debita BOB y acredita USDC atómicamente.
 * Body: { wtxId, note? }
 */
router.post('/wallet/usdc/conversions/confirm', adminConfirmBOBtoUSDC);

/**
 * POST /api/v1/admin/wallet/usdc/conversions/reject
 * Rechaza una conversión BOB→USDC: libera BOB reservado y notifica al usuario.
 * Body: { wtxId, rejectReason? }
 */
router.post('/wallet/usdc/conversions/reject', adminRejectBOBtoUSDC);

// ─── PRILI — Reclamos ASFI (Fase 27) ─────────────────────────────────────────

/**
 * IMPORTANTE: /reclamos/vencimientos debe ir ANTES de /reclamos/:reclamoId
 * para que Express no interprete "vencimientos" como un reclamoId.
 */

/** GET /api/v1/admin/reclamos — Lista paginada con diasRestantes y flag urgente */
router.get('/reclamos',              adminListarReclamos);

/** GET /api/v1/admin/reclamos/vencimientos — Reclamos con plazo <= 3 días */
router.get('/reclamos/vencimientos', adminReclamosVencimientos);

/** GET /api/v1/admin/reclamos/:reclamoId — Detalle completo con documentos base64 */
router.get('/reclamos/:reclamoId',   adminGetReclamo);

/** PATCH /api/v1/admin/reclamos/:reclamoId — Responder o actualizar status */
router.patch('/reclamos/:reclamoId', adminResponderReclamo);

// ─── Sanciones AML (Fase 28) ──────────────────────────────────────────────────

/** GET  /api/v1/admin/sanctions — Lista entradas con filtros y paginación */
router.get('/sanctions',               listSanctions);

/** POST /api/v1/admin/sanctions — Agregar nueva entrada a la lista */
router.post('/sanctions',              addSanction);

/**
 * IMPORTANTE: rutas con segmento fijo deben ir ANTES de /sanctions/:entryId
 * para evitar que Express interprete el segmento como un entryId.
 */

/** POST /api/v1/admin/sanctions/screen — Verificación manual de persona/empresa */
router.post('/sanctions/screen',               screenUserManual);

/** GET  /api/v1/admin/sanctions/flagged-users — Usuarios con posible hit AML (sanctionsFlag=true) */
router.get('/sanctions/flagged-users',         listFlaggedUsers);

/** POST /api/v1/admin/sanctions/flagged-users/:userId/clear — Limpiar flag tras revisión manual */
router.post('/sanctions/flagged-users/:userId/clear', clearSanctionsFlag);

/** DELETE /api/v1/admin/sanctions/:entryId — Desactivar entrada (baja lógica) */
router.delete('/sanctions/:entryId',   removeSanction);

// ─── Notificaciones push — Trigger manual ─────────────────────────────────────

import { getNotificationTypes, sendNotification } from '../controllers/adminNotificationsController.js';

/**
 * GET /api/v1/admin/notifications/types
 * Lista los tipos de notificación disponibles con sus campos de metadata requeridos.
 * Sin DB call — basado en config local.
 * Respuesta: { types: Array<{ type, requiredMetadata }> }
 */
router.get('/notifications/types', getNotificationTypes);
router.post('/test-push', testPush);

/**
 * POST /api/v1/admin/notifications/send
 *
 * Envía manualmente una notificación push a un usuario específico.
 *
 * Body:
 *   userId           {string}  — ObjectId del usuario destinatario
 *   notificationType {string}  — payinConfirmed | paymentCompleted | paymentFailed | payoutSent
 *   metadata         {object}  — Parámetros del tipo:
 *     payinConfirmed:     { amount, currency }
 *     paymentCompleted:   { amount, currency, destinationAmount, destinationCurrency }
 *     paymentFailed:      { amount, currency }
 *     payoutSent:         { destinationCountry }
 *
 * Respuesta: { success: boolean, message: string }
 */
router.post('/notifications/send', sendNotification);

// ─── Observabilidad ──────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/health/memory
 * Estadísticas de memoria del proceso Node + tamaño de caches internos.
 */
router.get('/health/memory', getMemoryStats);

// ─── Sandbox helpers (non-production only) ───────────────────────────────────

/**
 * POST /api/v1/admin/sandbox/owlpay/simulate/:transferId
 *
 * Triggers the Harbor transfer.completed webhook for sandbox E2E testing.
 * Calls POST /v1/transfers/{uuid}/simulate-completed per Sam's docs (2026-04-23).
 * Returns 403 in production.
 *
 * Params:
 *   transferId — Harbor transfer UUID (from createHarborTransfer / Transaction.harborTransfer.id)
 */
router.post('/sandbox/owlpay/simulate/:transferId', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Sandbox-only endpoint' });
  }
  const { transferId } = req.params;
  try {
    const result = await simulateTransferCompleted(transferId);
    res.json({ success: true, transferId, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

import { cleanupOrphanTransactions } from '../jobs/cleanupOrphanTransactions.js';
import { reconcileHarborTransfers }  from '../jobs/reconcileHarborTransfers.js';
import { reconcileVitaTransfers }    from '../jobs/reconcileVitaTransfers.js';
import { rosMonitor }                from '../jobs/rosMonitor.js';
import { rosMonitorWallet }          from '../jobs/rosMonitorWallet.js';
import ROSAlert                      from '../models/ROSAlert.js';

/**
 * POST /api/v1/admin/cleanup-orphans
 * Ejecuta manualmente el job de limpieza de transacciones huérfanas.
 */
router.post('/cleanup-orphans', async (req, res) => {
  try {
    const deleted = await cleanupOrphanTransactions();
    res.json({ deleted, runAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/reconcile-harbor
 * Ejecuta manualmente el job de reconciliation Harbor.
 * Útil para forzar polling cuando un webhook se perdió y la tx quedó stuck.
 */
router.post('/reconcile-harbor', async (req, res) => {
  try {
    const stats = await reconcileHarborTransfers();
    res.json({ stats, runAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/reconcile-vita
 * Ejecuta manualmente el job de reconciliation Vita.
 * Útil para forzar polling cuando un IPN se perdió y la tx quedó en payout_sent.
 */
router.post('/reconcile-vita', async (req, res) => {
  try {
    const stats = await reconcileVitaTransfers();
    res.json({ stats, runAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/vita/force-complete
 * Fuerza la completación de una tx Vita atascada en payout_sent sin IPN.
 * Usar cuando Vita confirma el pago externamente (panel Vita Business)
 * pero el IPN nunca llegó. Genera audit trail Stellar + comprobante + notificaciones.
 *
 * Body: { transactionId: "ALY-C-..." }
 */
router.post('/vita/force-complete', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId requerido' });

  try {
    const Transaction = (await import('../models/Transaction.js')).default;
    const tx = await Transaction.findOne({ alytoTransactionId: transactionId });
    if (!tx) return res.status(404).json({ error: 'Transacción no encontrada' });
    if (tx.status !== 'payout_sent') {
      return res.status(400).json({ error: `Estado actual: ${tx.status} — solo se puede forzar desde payout_sent` });
    }
    const { generateComprobanteOnCompletion } = await import('../controllers/ipnController.js');
    const { registerAuditTrail }              = await import('../services/stellarService.js');
    const { notify, NOTIFICATIONS }           = await import('../services/notifications.js');
    const { sendEmail, EMAILS }               = await import('../services/email.js');
    const User                                = (await import('../models/User.js')).default;

    tx.status      = 'completed';
    tx.completedAt = new Date();
    tx.ipnLog = tx.ipnLog ?? [];
    tx.ipnLog.push({
      provider:   'vitaWallet',
      eventType:  'payout_completed_admin_forced',
      status:     'completed',
      rawPayload: { forcedBy: 'admin', forcedAt: new Date(), source: 'POST /admin/vita/force-complete' },
      receivedAt: new Date(),
    });
    await tx.save();

    const stellarTxId = await registerAuditTrail(tx).catch(() => null);
    if (stellarTxId) {
      tx.stellarTxId = stellarTxId;
      await tx.save().catch(() => {});
    }

    generateComprobanteOnCompletion(tx).catch(() => {});

    const user = await User.findById(tx.userId).lean();
    notify(tx.userId, NOTIFICATIONS.paymentCompleted(
      tx.originalAmount, tx.originCurrency, tx.destinationAmount, tx.destinationCurrency,
    )).catch(() => {});
    if (user?.email) sendEmail(...EMAILS.paymentCompleted(user, tx)).catch(() => {});

    res.json({ ok: true, transactionId, stellarTxId: stellarTxId ?? null, completedAt: tx.completedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/regenerate-comprobante
 * Regenera el comprobante PDF de una tx SRL completada.
 * Útil cuando la generación fire-and-forget falló silenciosamente.
 * Body: { transactionId: "ALY-C-..." }
 */
router.post('/regenerate-comprobante', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId requerido' });

  try {
    const Transaction = (await import('../models/Transaction.js')).default;
    const tx = await Transaction.findOne({ alytoTransactionId: transactionId });
    if (!tx) return res.status(404).json({ error: 'Transacción no encontrada' });
    if (tx.legalEntity !== 'SRL') return res.status(400).json({ error: 'Solo aplica para transacciones SRL' });
    if (tx.status !== 'completed') return res.status(400).json({ error: `Estado: ${tx.status} — solo se puede regenerar en completed` });

    const User = (await import('../models/User.js')).default;
    const { generarNumeroCorrelativo }  = await import('../utils/correlativoService.js');
    const { generateOfficialReceipt }   = await import('../utils/pdfGenerator.js');
    const { uploadBuffer, getDownloadUrl } = await import('../services/storageService.js');

    const user = await User.findById(tx.userId).lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const numeroComprobante = tx.boliviaCompliance?.numeroComprobante
      ?? await generarNumeroCorrelativo('BOL');

    const digital    = tx.digitalAssetAmount ?? 0;
    const tipoCambio = digital > 0
      ? Number((tx.originalAmount / digital).toFixed(6))
      : (tx.conversionRate?.rate ?? 0);
    const comisionServicio = tx.feeBreakdown?.alytoFee ?? tx.feeBreakdown?.totalDeducted ?? 0;

    const dto = {
      numeroComprobante,
      nombreCliente:        user.companyName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
      nitOci:               user.taxId
        ?? (user.identityDocument?.number && !/pending|verification/i.test(user.identityDocument.number)
            ? user.identityDocument.number : null)
        ?? 'NO REGISTRADO',
      tipoDocumento:        user.taxId ? 'NIT' : 'CI',
      codigoClienteAlyto:   user._id.toString(),
      fechaHora:            (tx.createdAt ?? new Date()).toISOString(),
      tipoOperacion:        'Liquidación de Activo Digital',
      txid:                 tx.stellarTxId ?? 'PENDIENTE',
      montoFiatRecibido:    tx.originalAmount,
      tipoDeCambio:         tipoCambio,
      montoActivoEntregado: digital,
      comisionServicio,
      totalLiquidado:       tx.originalAmount - comisionServicio,
    };

    const { buffer, filename } = await generateOfficialReceipt(dto);
    const s3Key  = `pdfs/bolivia/${numeroComprobante}_${filename}`;
    const { url, key } = await uploadBuffer(buffer, s3Key, { contentType: 'application/pdf' });

    // Generar presigned URL de 7 días para guardar en BD (no depende de resolución dinámica)
    const resolvedUrl = await getDownloadUrl(key ?? s3Key, 6 * 24 * 3600);
    const storedUrl   = resolvedUrl ?? url; // fallback a s3key:// si falla

    await Transaction.findByIdAndUpdate(tx._id, {
      $set: {
        'boliviaCompliance.comprobanteUrl':         storedUrl,
        'boliviaCompliance.numeroComprobante':      numeroComprobante,
        'boliviaCompliance.comprobanteGeneratedAt': new Date(),
      },
    });

    res.json({ ok: true, transactionId, comprobanteUrl: storedUrl, numeroComprobante,
               resolvedOk: !!resolvedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
  }
});

// ─── ROS / UIF Bolivia ────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/ros/alerts
 * Lista alertas ROS con filtros opcionales (status, severity, userId).
 * Paginado: ?page=1&limit=20&status=open&severity=high
 */
router.get('/ros/alerts', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, severity, userId, source } = req.query;
    const filter = {};
    if (status)   filter.status   = status;
    if (severity) filter.severity = severity;
    if (userId)   filter.userId   = userId;
    if (source)   filter.source   = source;

    const [alerts, total] = await Promise.all([
      ROSAlert.find(filter)
        .sort({ severity: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .populate('userId', 'firstName lastName email taxId')
        .lean(),
      ROSAlert.countDocuments(filter),
    ]);

    res.json({ alerts, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/v1/admin/ros/alerts/:alertId
 * Actualiza el status de una alerta ROS.
 * Body: { status: 'reviewed'|'dismissed'|'reported_uif', reviewNote: '...' }
 * reviewNote es obligatorio para 'dismissed'.
 */
router.patch('/ros/alerts/:alertId', async (req, res) => {
  try {
    const { alertId } = req.params;
    const { status, reviewNote } = req.body;

    const ALLOWED = ['reviewed', 'dismissed', 'reported_uif'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({
        error: `status debe ser uno de: ${ALLOWED.join(', ')}`,
      });
    }
    if (status === 'dismissed' && !reviewNote?.trim()) {
      return res.status(400).json({
        error: 'reviewNote es obligatorio al desestimar una alerta ROS (trazabilidad ASFI).',
      });
    }

    const update = {
      status,
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      ...(reviewNote ? { reviewNote } : {}),
      ...(status === 'reported_uif' ? { reportedToUifAt: new Date() } : {}),
    };

    const alert = await ROSAlert.findOneAndUpdate({ alertId }, update, { returnDocument: 'after' });
    if (!alert) return res.status(404).json({ error: 'Alerta no encontrada.' });

    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/ros/run
 * Fuerza un ciclo inmediato del monitor ROS (útil para testing o revisión urgente).
 */
router.post('/ros/run', async (req, res) => {
  try {
    const [crossborder, wallet] = await Promise.all([rosMonitor(), rosMonitorWallet()]);
    res.json({ stats: { crossborder, wallet }, runAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
