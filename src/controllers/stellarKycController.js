/**
 * stellarKycController.js — SEP-12 KYC Controller
 *
 * GET    /api/v1/stellar/customer           → estado KYC del cliente
 * PUT    /api/v1/stellar/customer           → actualizar datos del cliente
 * DELETE /api/v1/stellar/customer           → solicitar eliminación de datos
 */

import { getCustomer, putCustomer, deleteCustomer } from '../services/sep12Service.js';
import { logger } from '../utils/logger.js';

/**
 * SEP-12 spec: el `account`/`id` solicitado DEBE pertenecer al token SEP-10
 * autenticado. Sin este check, cualquier keypair auto-generado con token
 * SEP-10 válido podía leer/modificar/anonimizar el KYC de OTRO usuario
 * pasando ?account=G... o ?id=<mongoId> (IDOR — fix 2026-07-18).
 * Devuelve la identidad efectiva o null si el caller pidió una ajena.
 */
function resolveOwnIdentity(req) {
  const authAccount = req.user?.stellarAccount ?? null;
  const authId      = req.user?._id?.toString() ?? null;

  const { account: qAccount, id: qId } = req.query;
  if (qAccount && qAccount !== authAccount) return null;
  if (qId && qId !== authId) return null;

  return { accountId: authAccount, id: authId };
}

export async function handleGet(req, res) {
  try {
    const identity = resolveOwnIdentity(req);
    if (!identity) return res.status(403).json({ error: 'account/id does not match the authenticated token' });
    const result = await getCustomer(identity);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[sep12] GET customer error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handlePut(req, res) {
  try {
    const identity = resolveOwnIdentity(req);
    if (!identity) return res.status(403).json({ error: 'account/id does not match the authenticated token' });
    if (!identity.accountId) {
      return res.status(400).json({ error: 'account is required' });
    }
    const result = await putCustomer({ accountId: identity.accountId, fields: req.body });
    return res.status(202).json(result);
  } catch (err) {
    logger.error('[sep12] PUT customer error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function handleDelete(req, res) {
  try {
    const identity = resolveOwnIdentity(req);
    if (!identity) return res.status(403).json({ error: 'account/id does not match the authenticated token' });
    await deleteCustomer(identity);
    return res.status(200).json({ message: 'Customer data scheduled for deletion' });
  } catch (err) {
    logger.error('[sep12] DELETE customer error', { err: err.message });
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}
