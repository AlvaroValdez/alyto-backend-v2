/**
 * stellarPaymentController.js — SEP-31 Cross-Border Payments Controller
 *
 * GET   /api/v1/stellar/cross-border/info
 * POST  /api/v1/stellar/cross-border/transactions
 * GET   /api/v1/stellar/cross-border/transactions/:id
 * PATCH /api/v1/stellar/cross-border/transactions/:id
 */

import { getInfo, createTransaction, getTransaction, patchTransaction } from '../services/sep31Service.js';
import { logger } from '../utils/logger.js';

export async function handleGetInfo(req, res) {
  try {
    const info = await getInfo();
    return res.status(200).json(info);
  } catch (err) {
    logger.error('[sep31] getInfo error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
}

export async function handleCreateTransaction(req, res) {
  try {
    const result = await createTransaction({ body: req.body, user: req.user });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep31] createTransaction error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleGetTransaction(req, res) {
  try {
    const result = await getTransaction({ transactionId: req.params.id, user: req.user });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep31] getTransaction error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handlePatchTransaction(req, res) {
  try {
    const result = await patchTransaction({ transactionId: req.params.id, body: req.body, user: req.user });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep31] patchTransaction error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}
