/**
 * stellarDepositController.js — SEP-24 Interactive Anchor Controller
 *
 * GET  /api/v1/stellar/anchor/info
 * POST /api/v1/stellar/anchor/transactions/deposit
 * POST /api/v1/stellar/anchor/transactions/withdraw
 * GET  /api/v1/stellar/anchor/transactions
 * GET  /api/v1/stellar/anchor/transaction
 * GET  /api/v1/stellar/anchor/fee
 */

import {
  getAnchorInfo,
  initiateDeposit,
  initiateWithdraw,
  listTransactions,
  getTransaction,
  getFee,
} from '../services/sep24Service.js';
import { logger } from '../utils/logger.js';

export async function handleGetInfo(req, res) {
  try {
    const info = await getAnchorInfo();
    return res.status(200).json(info);
  } catch (err) {
    logger.error('[sep24] getInfo error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
}

export async function handleDeposit(req, res) {
  try {
    const result = await initiateDeposit({ body: req.body, user: req.user });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep24] deposit error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleWithdraw(req, res) {
  try {
    const result = await initiateWithdraw({ body: req.body, user: req.user });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep24] withdraw error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleListTransactions(req, res) {
  try {
    const result = await listTransactions({ user: req.user, query: req.query });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep24] listTransactions error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleGetTransaction(req, res) {
  try {
    const result = await getTransaction({ query: req.query, user: req.user });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep24] getTransaction error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleGetFee(req, res) {
  try {
    const result = await getFee({ query: req.query });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep24] getFee error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
}
