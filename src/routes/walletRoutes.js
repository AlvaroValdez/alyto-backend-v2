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
import { protect } from '../middlewares/authMiddleware.js'
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

const router = Router()

router.get('/balance',           protect, getWalletBalance)
router.get('/transactions',      protect, getWalletTransactions)
router.post('/deposit/initiate', protect, initiateDeposit)
router.post('/send',             protect, sendP2P)
router.post('/withdraw/request', protect, requestWithdrawal)

// QR Wallet (Fase 29)
router.post('/qr/generate', protect, generateWalletQR)
router.post('/qr/scan',     protect, scanAndPayQR)
router.get('/qr/preview',   protect, previewQR)

export default router
