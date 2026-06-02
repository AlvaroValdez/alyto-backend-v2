/**
 * stellarKycController.js — SEP-12 KYC Controller
 *
 * GET    /api/v1/stellar/customer           → estado KYC del cliente
 * PUT    /api/v1/stellar/customer           → actualizar datos del cliente
 * DELETE /api/v1/stellar/customer           → solicitar eliminación de datos
 */

import { getCustomer, putCustomer, deleteCustomer } from '../services/sep12Service.js';
import { logger } from '../utils/logger.js';

export async function handleGet(req, res) {
  try {
    const accountId = req.query.account ?? req.user?.stellarAccount;
    const id        = req.query.id      ?? req.user?._id?.toString();
    const result    = await getCustomer({ accountId, id });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep12] GET customer error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handlePut(req, res) {
  try {
    const accountId = req.query.account ?? req.user?.stellarAccount;
    if (!accountId) {
      return res.status(400).json({ error: 'account is required' });
    }
    const result = await putCustomer({ accountId, fields: req.body });
    return res.status(202).json(result);
  } catch (err) {
    logger.error('[sep12] PUT customer error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleDelete(req, res) {
  try {
    const accountId = req.query.account ?? req.user?.stellarAccount;
    const id        = req.query.id      ?? req.user?._id?.toString();
    await deleteCustomer({ accountId, id });
    return res.status(200).json({ message: 'Customer data scheduled for deletion' });
  } catch (err) {
    logger.error('[sep12] DELETE customer error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}
