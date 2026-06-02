/**
 * sep10Service.js — SEP-10 Web Authentication
 *
 * Implementa autenticación Stellar estándar (SEP-10):
 *   - Challenge: el servidor genera una transacción no firmada
 *   - Verify: el cliente la firma con su keypair → servidor valida y emite JWT
 *
 * Spec: https://stellar.org/protocol/sep-10
 *
 * Flujo:
 *   1. GET  /api/v1/stellar/auth?account=G...
 *      → Servidor genera challenge (manage_data operation firmado por STELLAR_SRL_PUBLIC_KEY)
 *      → Retorna { transaction: <XDR>, network_passphrase }
 *
 *   2. POST /api/v1/stellar/auth
 *      Body: { transaction: <XDR firmado por el usuario> }
 *      → Servidor verifica firmas
 *      → Retorna { token: <JWT Alyto> }
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Networks,
  Transaction,
  StrKey,
  Account,
} from '@stellar/stellar-sdk';
import crypto from 'crypto';
import jwt    from 'jsonwebtoken';

import {
  horizonServer,
  NETWORK_PASSPHRASE,
  PRIORITY_FEE_STROOPS,
} from '../config/stellar.js';

import { requireEnvSecret } from '../utils/secrets.js';
import { logger }           from '../utils/logger.js';
import User                 from '../models/User.js';

// ─── Constantes SEP-10 ───────────────────────────────────────────────────────

const CHALLENGE_TTL_SECONDS = 900; // 15 minutos — tiempo para que el cliente firme
const TOKEN_EXPIRES_IN      = '24h';

// ─── Challenge ───────────────────────────────────────────────────────────────

/**
 * Genera un challenge SEP-10 para una cuenta Stellar.
 *
 * El challenge es una transacción con:
 *   - source: SIGNING_KEY del servidor (STELLAR_SRL_PUBLIC_KEY)
 *   - sequence: 0 (no consume sequence real)
 *   - manage_data operation: nombre del home_domain + nonce aleatorio de 64 bytes
 *
 * @param {string} accountId - G... public key del cliente
 * @returns {Promise<{transaction: string, network_passphrase: string}>}
 */
export async function buildChallenge(accountId) {
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw Object.assign(new Error('Invalid Stellar account ID'), { status: 400 });
  }

  const serverKeypair = Keypair.fromSecret(requireEnvSecret('STELLAR_SRL_SECRET_KEY'));

  // SEP-10 spec: usamos una cuenta con sequence 0 para el challenge
  // No necesitamos cargar la cuenta real — el challenge no consume sequence
  const sourceKeypair = serverKeypair;

  // Nonce: 64 bytes aleatorios en base64
  const nonce = crypto.randomBytes(48).toString('base64');

  const homeDomain   = process.env.HOME_DOMAIN ?? 'alyto.app';
  const nowSeconds   = Math.floor(Date.now() / 1000);

  // Construir la transacción challenge
  // SEP-10 spec: usamos sequence = 0 (la tx no consume sequence real del ledger)
  // Account requiere string para sequence — usamos '0'
  const account = new Account(sourceKeypair.publicKey(), '0');

  const tx = new TransactionBuilder(account, {
    fee:               '100',
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: {
      minTime: nowSeconds,
      maxTime: nowSeconds + CHALLENGE_TTL_SECONDS,
    },
  })
    // Operación 1: manage_data con nonce (identifica al cliente)
    .addOperation(Operation.manageData({
      name:   `${homeDomain} auth`,
      value:  Buffer.from(nonce),
      source: accountId,        // la cuenta del CLIENTE es source de esta operación
    }))
    // Operación 2 (opcional SEP-10): web_auth_domain
    .addOperation(Operation.manageData({
      name:   'web_auth_domain',
      value:  Buffer.from(homeDomain),
      source: sourceKeypair.publicKey(),
    }))
    .build();

  tx.sign(sourceKeypair);

  return {
    transaction:        tx.toEnvelope().toXDR('base64'),
    network_passphrase: NETWORK_PASSPHRASE,
  };
}

// ─── Verify ──────────────────────────────────────────────────────────────────

/**
 * Verifica un challenge firmado y emite un JWT Alyto.
 *
 * Validaciones SEP-10:
 *   1. La transacción es válida XDR
 *   2. El network passphrase coincide
 *   3. La transacción está firmada por la cuenta del cliente (accountId)
 *   4. La transacción no ha expirado (timebounds)
 *   5. La fuente de la operación manage_data es el accountId del cliente
 *
 * @param {string} transactionXdr - XDR en base64, firmado por el cliente
 * @returns {Promise<{token: string, userId?: string}>}
 */
export async function verifyChallenge(transactionXdr) {
  let tx;
  try {
    tx = new Transaction(transactionXdr, NETWORK_PASSPHRASE);
  } catch {
    throw Object.assign(new Error('Invalid transaction XDR'), { status: 400 });
  }

  // 1. Verificar timebounds
  const now = Math.floor(Date.now() / 1000);
  if (tx.timeBounds) {
    if (now < Number(tx.timeBounds.minTime) || now > Number(tx.timeBounds.maxTime)) {
      throw Object.assign(new Error('Challenge has expired'), { status: 400 });
    }
  }

  // 2. Extraer el accountId del cliente (source de la primera manage_data op)
  const firstOp = tx.operations[0];
  if (firstOp.type !== 'manageData') {
    throw Object.assign(new Error('Invalid challenge operation'), { status: 400 });
  }

  const clientAccountId = firstOp.source;
  if (!clientAccountId || !StrKey.isValidEd25519PublicKey(clientAccountId)) {
    throw Object.assign(new Error('Cannot determine client account from challenge'), { status: 400 });
  }

  // 3. Verificar que el cliente firmó la transacción
  const clientKeypair    = Keypair.fromPublicKey(clientAccountId);
  const txHash           = tx.hash();
  const clientSignatures = tx.signatures.filter(sig => {
    try { return clientKeypair.verify(txHash, sig.signature()); }
    catch { return false; }
  });

  if (clientSignatures.length === 0) {
    throw Object.assign(new Error('Transaction not signed by the claimed account'), { status: 400 });
  }

  // 4. Buscar el usuario por publicKey en MongoDB
  const user = await User.findOne({ 'stellarAccount.publicKey': clientAccountId });

  if (!user) {
    // Usuario no registrado en Alyto con este keypair
    // Para SEP-10 puro (interoperabilidad), emitimos token sin userId
    logger.warn('[sep10] Verified challenge for unknown Stellar account', { clientAccountId });
    const token = jwt.sign(
      { stellarAccount: clientAccountId, iss: 'alyto.app' },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN },
    );
    return { token };
  }

  // 5. Emitir JWT Alyto completo para usuario registrado
  const token = jwt.sign(
    {
      id:             user._id,
      tokenVersion:   user.tokenVersion ?? 0,
      stellarAccount: clientAccountId,
    },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES_IN },
  );

  logger.info('[sep10] Challenge verified — JWT issued', {
    userId:          String(user._id),
    stellarAccount:  clientAccountId,
  });

  return { token, userId: String(user._id) };
}
