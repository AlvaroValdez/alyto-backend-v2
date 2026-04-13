/**
 * walletRoutes.js — Rutas de la Wallet BOB (Fase 25)
 *
 * Montado en server.js bajo: /api/v1/wallet
 *
 * Todas las rutas de usuario requieren protect() (JWT válido).
 * Las rutas admin están en adminRoutes.js bajo /api/v1/admin/wallet/*.
 *
 * Endpoints:
 *   GET  /balance              — Saldo actual del usuario SRL
 *   GET  /transactions         — Historial paginado de movimientos
 *   POST /deposit/initiate     — Inicia depósito, retorna instrucciones bancarias
 *   POST /send                 — Envío P2P a otro usuario SRL
 *   POST /withdraw/request     — Solicitud de retiro a cuenta bancaria boliviana
 */

import { Router } from 'express'
import { protect, requireKycApproved } from '../middlewares/authMiddleware.js'
import { idempotencyCheck } from '../middlewares/idempotency.js'
import {
  getWalletBalance,
  getWalletTransactions,
  initiateDeposit,
  sendP2P,
  requestWithdrawal,
} from '../controllers/walletController.js'
import {
  generateWalletQR,
  scanAndPayQR,
  previewQR,
} from '../controllers/qrWalletController.js'
import {
  getUSDCBalance,
  getDepositInstructions,
  requestBOBtoUSDC,
  getUSDCTransactions,
} from '../controllers/walletUSDCController.js'

const router = Router()

// ─── BOB Wallet ───────────────────────────────────────────────────────────────

router.get('/balance',           protect, requireKycApproved, getWalletBalance)
router.get('/transactions',      protect, requireKycApproved, getWalletTransactions)
router.post('/deposit/initiate', protect, requireKycApproved, idempotencyCheck, initiateDeposit)
router.post('/send',             protect, requireKycApproved, sendP2P)
router.post('/withdraw/request', protect, requireKycApproved, requestWithdrawal)

// QR Wallet (Fase 29)
router.post('/qr/generate', protect, requireKycApproved, generateWalletQR)
router.post('/qr/scan',     protect, requireKycApproved, scanAndPayQR)
router.get('/qr/preview',   protect, requireKycApproved, previewQR)

// ─── USDC Wallet (Fase 35) ───────────────────────────────────────────────────
// IMPORTANTE: /usdc/deposit-instructions debe ir ANTES de /usdc/:anything

router.get('/usdc/balance',               protect, requireKycApproved, getUSDCBalance)
router.get('/usdc/deposit-instructions',  protect, requireKycApproved, getDepositInstructions)
router.get('/usdc/transactions',          protect, requireKycApproved, getUSDCTransactions)
router.post('/usdc/convert-bob',          protect, requireKycApproved, idempotencyCheck, requestBOBtoUSDC)

export default router
