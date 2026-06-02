/**
 * stellarCustodyController.js — Gestión de Keypairs Custodiales
 *
 * POST /api/v1/stellar/custody/provision  → provisiona keypair para el usuario
 * GET  /api/v1/stellar/custody/keypair    → retorna info del keypair (solo publicKey)
 *
 * Requiere JWT Alyto estándar (no SEP-10 token).
 */

import { provisionUserKeypair, hasCustodialKeypair } from '../services/custodyService.js';
import User from '../models/User.js';
import { logger } from '../utils/logger.js';

/**
 * POST /api/v1/stellar/custody/provision
 * Genera un keypair Stellar para el usuario autenticado.
 * Idempotente: si ya tiene keypair, retorna el existente sin crear uno nuevo.
 */
export async function provisionKeypair(req, res) {
  try {
    const userId = req.user._id;

    if (req.user.kycStatus !== 'approved') {
      return res.status(403).json({
        error: 'KYC approval required before provisioning a Stellar keypair',
      });
    }

    const result = await provisionUserKeypair(userId);
    return res.status(200).json({
      publicKey: result.publicKey,
      message:   'Keypair provisioned successfully. The secret key is stored securely and never exposed.',
    });
  } catch (err) {
    logger.error('[custody] provisionKeypair error', { err: err.message, userId: req.user?._id });
    return res.status(500).json({ error: 'Keypair provisioning failed' });
  }
}

/**
 * GET /api/v1/stellar/custody/keypair
 * Retorna la información pública del keypair del usuario.
 * La secretKey NUNCA se retorna.
 */
export async function getKeypairInfo(req, res) {
  try {
    const user = await User.findById(req.user._id)
      .select('stellarAccount.publicKey stellarAccount.createdByAlyto stellarAccount.activeTrustlines')
      .lean();

    if (!user?.stellarAccount?.publicKey) {
      return res.status(404).json({
        error:   'No keypair found',
        message: 'POST /api/v1/stellar/custody/provision to create one',
      });
    }

    return res.status(200).json({
      publicKey:         user.stellarAccount.publicKey,
      createdByAlyto:    user.stellarAccount.createdByAlyto,
      activeTrustlines:  user.stellarAccount.activeTrustlines ?? [],
      network:           process.env.STELLAR_NETWORK ?? 'testnet',
    });
  } catch (err) {
    logger.error('[custody] getKeypairInfo error', { err: err.message });
    return res.status(500).json({ error: 'Failed to retrieve keypair info' });
  }
}
