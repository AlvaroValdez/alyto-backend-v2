/**
 * stellarAuthController.js — SEP-10 Web Authentication Controller
 *
 * GET  /api/v1/stellar/auth?account=G...  → challenge XDR
 * POST /api/v1/stellar/auth               → verify + JWT
 */

import { buildChallenge, verifyChallenge } from '../services/sep10Service.js';
import { logger } from '../utils/logger.js';

/**
 * GET /api/v1/stellar/auth?account=G...
 * Genera y retorna el challenge SEP-10.
 */
export async function getChallenge(req, res) {
  try {
    const { account, home_domain } = req.query;
    if (!account) {
      return res.status(400).json({ error: 'account query parameter is required' });
    }
    const result = await buildChallenge(account, home_domain);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep10] getChallenge error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

/**
 * POST /api/v1/stellar/auth
 * Body: { transaction: <XDR base64 firmado por el cliente> }
 * Verifica el challenge y retorna JWT Alyto.
 */
export async function postVerify(req, res) {
  try {
    const { transaction } = req.body;
    if (!transaction) {
      return res.status(400).json({ error: 'transaction field is required' });
    }
    const result = await verifyChallenge(transaction);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep10] postVerify error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}
