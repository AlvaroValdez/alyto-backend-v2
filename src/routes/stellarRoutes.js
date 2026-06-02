/**
 * stellarRoutes.js — Rutas Stellar SEP-1/10/12/24/31
 *
 * Prefijo registrado en server.js: /api/v1/stellar
 *
 * Endpoints por SEP:
 *
 *   SEP-1:  stellar.toml servido en /.well-known/stellar.toml (express.static en server.js)
 *
 *   SEP-10: Web Authentication
 *     GET  /auth?account=G...           → challenge XDR
 *     POST /auth                        → verify + JWT
 *
 *   SEP-12: KYC API
 *     GET    /customer                  → estado KYC del cliente (requiere SEP-10 token)
 *     PUT    /customer                  → actualizar datos del cliente
 *     DELETE /customer                  → solicitar eliminación de datos (GDPR)
 *
 *   SEP-31: Cross-Border Payments (Receiving Anchor)
 *     GET   /cross-border/info          → activos y corredores disponibles
 *     POST  /cross-border/transactions  → crear transacción cross-border
 *     GET   /cross-border/transactions/:id → estado de la transacción
 *     PATCH /cross-border/transactions/:id → callback del sending anchor
 *
 *   SEP-24: Interactive Anchor (Deposit & Withdraw)
 *     GET  /anchor/info                 → activos y operaciones soportadas
 *     POST /anchor/transactions/deposit → iniciar depósito
 *     POST /anchor/transactions/withdraw → iniciar retiro
 *     GET  /anchor/transactions         → listar transacciones del usuario
 *     GET  /anchor/transaction          → obtener transacción por id
 *     GET  /anchor/fee                  → calcular fee
 *
 *   Custody:
 *     POST /custody/provision           → generar keypair para usuario autenticado
 *     GET  /custody/keypair             → info del keypair (solo publicKey)
 */

import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { sep10Protect } from '../middlewares/sep10Middleware.js';
import { generalLimiter } from '../config/rateLimiters.js';

// Controladores
import {
  getChallenge as sep10GetChallenge,
  postVerify   as sep10PostVerify,
} from '../controllers/stellarAuthController.js';

import {
  handleGet    as sep12Get,
  handlePut    as sep12Put,
  handleDelete as sep12Delete,
} from '../controllers/stellarKycController.js';

import {
  handleGetInfo          as sep31GetInfo,
  handleCreateTransaction as sep31Create,
  handleGetTransaction    as sep31Get,
  handlePatchTransaction  as sep31Patch,
} from '../controllers/stellarPaymentController.js';

import {
  handleGetInfo          as sep24GetInfo,
  handleDeposit          as sep24Deposit,
  handleWithdraw         as sep24Withdraw,
  handleListTransactions  as sep24List,
  handleGetTransaction    as sep24GetTx,
  handleGetFee            as sep24GetFee,
} from '../controllers/stellarDepositController.js';

import {
  provisionKeypair,
  getKeypairInfo,
} from '../controllers/stellarCustodyController.js';

const router = Router();

// ─── SEP-10: Web Authentication ──────────────────────────────────────────────
router.get ('/auth', generalLimiter, sep10GetChallenge);
router.post('/auth', generalLimiter, sep10PostVerify);

// ─── SEP-12: KYC API ─────────────────────────────────────────────────────────
router.get   ('/customer', sep10Protect, sep12Get);
router.put   ('/customer', sep10Protect, sep12Put);
router.delete('/customer', sep10Protect, sep12Delete);

// ─── SEP-31: Cross-Border Payments ───────────────────────────────────────────
router.get  ('/cross-border/info',             generalLimiter, sep31GetInfo);
router.post ('/cross-border/transactions',     sep10Protect,   sep31Create);
router.get  ('/cross-border/transactions/:id', sep10Protect,   sep31Get);
router.patch('/cross-border/transactions/:id', sep10Protect,   sep31Patch);

// ─── SEP-24: Interactive Anchor ───────────────────────────────────────────────
router.get ('/anchor/info',                     generalLimiter, sep24GetInfo);
router.post('/anchor/transactions/deposit',     sep10Protect,   sep24Deposit);
router.post('/anchor/transactions/withdraw',    sep10Protect,   sep24Withdraw);
router.get ('/anchor/transactions',             sep10Protect,   sep24List);
router.get ('/anchor/transaction',              sep10Protect,   sep24GetTx);
router.get ('/anchor/fee',                      generalLimiter, sep24GetFee);

// ─── Custody ─────────────────────────────────────────────────────────────────
// Requiere JWT Alyto estándar (no SEP-10 token) — solo usuarios autenticados
router.post('/custody/provision', protect, provisionKeypair);
router.get ('/custody/keypair',   protect, getKeypairInfo);

export default router;
