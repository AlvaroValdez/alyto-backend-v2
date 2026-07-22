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
 *      → Servidor genera challenge (manage_data operation firmado por el SIGNING_KEY:
 *        cuenta dedicada STELLAR_SEP10_SECRET_KEY, o SRL como fallback legacy)
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

/**
 * Resuelve el web_auth_domain (SEP-10): el host del WEB_AUTH_ENDPOINT publicado
 * en el stellar.toml. Se deriva de STELLAR_ANCHOR_BASE_URL (ej. https://api.alyto.app
 * → 'api.alyto.app'); si no está seteado, cae a `api.<homeDomain>`, coherente con
 * el default de stellarTomlController.
 */
function resolveWebAuthDomain(homeDomain) {
  const baseUrl = process.env.STELLAR_ANCHOR_BASE_URL ?? `https://api.${homeDomain}`;
  try {
    return new URL(baseUrl).host;
  } catch {
    return `api.${homeDomain}`;
  }
}

/**
 * Keypair con el que se firman/verifican los challenges SEP-10.
 *
 * Usa la MISMA precedencia que `SEP10_SIGNING_PUBLIC` (config/stellar.js) para
 * garantizar que el firmante coincida con el `SIGNING_KEY` publicado en el
 * stellar.toml:
 *   1. STELLAR_SEP10_SECRET_KEY  → cuenta dedicada (higiene de llaves).
 *   2. STELLAR_SRL_SECRET_KEY    → fallback legacy (tesorería = firmante).
 *
 * La separación evita que la secreta de la cuenta que custodia los USDC sea la
 * que firma los logins.
 */
function sep10SigningKeypair() {
  return Keypair.fromSecret(
    process.env.STELLAR_SEP10_SECRET_KEY ?? requireEnvSecret('STELLAR_SRL_SECRET_KEY'),
  );
}

// ─── Challenge ───────────────────────────────────────────────────────────────

/**
 * Genera un challenge SEP-10 para una cuenta Stellar.
 *
 * El challenge es una transacción con:
 *   - source: SIGNING_KEY del servidor (cuenta de firma dedicada; ver sep10SigningKeypair)
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

  const serverKeypair = sep10SigningKeypair();

  // SEP-10 spec: usamos una cuenta con sequence 0 para el challenge
  // No necesitamos cargar la cuenta real — el challenge no consume sequence
  const sourceKeypair = serverKeypair;

  // Nonce: 64 bytes aleatorios en base64
  const nonce = crypto.randomBytes(48).toString('base64');

  const homeDomain   = process.env.HOME_DOMAIN ?? 'alyto.app';
  // web_auth_domain (SEP-10): DEBE ser el host del WEB_AUTH_ENDPOINT, NO el home
  // domain. El toml se sirve en alyto.app pero el endpoint de auth vive en
  // api.alyto.app; las wallets externas (SDF SDK readChallengeTx) derivan el
  // webAuthDomain esperado del WEB_AUTH_ENDPOINT y rechazan el challenge si no
  // coincide ("'web_auth_domain' operation value does not match ..."). Ver toml.
  const webAuthDomain = resolveWebAuthDomain(homeDomain);
  const nowSeconds   = Math.floor(Date.now() / 1000);

  // Construir la transacción challenge
  // SEP-10 spec: la tx del challenge DEBE tener sequence = 0 (nunca ejecutable).
  // TransactionBuilder incrementa la sequence de la Account al construir, así que
  // partimos de '-1' para que la transacción resultante quede con sequence 0.
  const account = new Account(sourceKeypair.publicKey(), '-1');

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
    // Operación 2 (opcional SEP-10): web_auth_domain = host del WEB_AUTH_ENDPOINT
    .addOperation(Operation.manageData({
      name:   'web_auth_domain',
      value:  Buffer.from(webAuthDomain),
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
 *   3. El source de la transacción es el SIGNING_KEY del servidor
 *   4. El sequence number es 0 (la tx nunca es ejecutable en el ledger)
 *   5. Timebounds presentes y vigentes (challenge no expirado)
 *   6. La primera operación es manage_data con nombre `<home_domain> auth`
 *      y su source es el accountId del cliente
 *   7. La transacción conserva la firma del SERVIDOR (SIGNING_KEY) — garantiza
 *      que el challenge fue emitido por nosotros y no fabricado por el cliente
 *   8. La transacción está firmada por la cuenta del cliente (accountId)
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

  const serverKeypair = sep10SigningKeypair();

  // 1. El source de la tx debe ser el SIGNING_KEY del servidor (spec SEP-10):
  //    rechaza challenges fabricados con otra cuenta como emisor
  if (tx.source !== serverKeypair.publicKey()) {
    throw Object.assign(new Error('Challenge not issued by this server'), { status: 400 });
  }

  // 2. Sequence 0 obligatorio — la tx del challenge jamás debe ser ejecutable on-chain
  if (String(tx.sequence) !== '0') {
    throw Object.assign(new Error('Challenge sequence number must be 0'), { status: 400 });
  }

  // 3. Timebounds obligatorios y vigentes
  const now = Math.floor(Date.now() / 1000);
  if (!tx.timeBounds) {
    throw Object.assign(new Error('Challenge is missing timebounds'), { status: 400 });
  }
  if (now < Number(tx.timeBounds.minTime) || now > Number(tx.timeBounds.maxTime)) {
    throw Object.assign(new Error('Challenge has expired'), { status: 400 });
  }

  // 4. Extraer el accountId del cliente (source de la primera manage_data op)
  //    y validar el nombre de la operación contra nuestro home_domain
  const firstOp = tx.operations[0];
  if (!firstOp || firstOp.type !== 'manageData') {
    throw Object.assign(new Error('Invalid challenge operation'), { status: 400 });
  }

  const homeDomain = process.env.HOME_DOMAIN ?? 'alyto.app';
  if (firstOp.name !== `${homeDomain} auth`) {
    throw Object.assign(new Error('Challenge home domain mismatch'), { status: 400 });
  }

  const clientAccountId = firstOp.source;
  if (!clientAccountId || !StrKey.isValidEd25519PublicKey(clientAccountId)) {
    throw Object.assign(new Error('Cannot determine client account from challenge'), { status: 400 });
  }

  // 4b. Si hay operación web_auth_domain, su valor debe ser nuestro host de auth
  //     (mismo check que hacen las wallets externas — rechaza challenges cuyo
  //     web_auth_domain fue alterado para apuntar a otro servidor).
  const webAuthOp = tx.operations.find(
    op => op.type === 'manageData' && op.name === 'web_auth_domain',
  );
  if (webAuthOp) {
    const expectedWebAuthDomain = resolveWebAuthDomain(homeDomain);
    if ((webAuthOp.value?.toString() ?? '') !== expectedWebAuthDomain) {
      throw Object.assign(new Error('Challenge web_auth_domain mismatch'), { status: 400 });
    }
  }

  const txHash = tx.hash();

  // 5. Verificar la firma del SERVIDOR: el challenge debe conservar la firma
  //    con la que lo emitimos en buildChallenge. Sin este check, un atacante
  //    podría construir su propio "challenge" con datos arbitrarios y firmarlo
  //    solo con su llave.
  const serverSigned = tx.signatures.some(sig => {
    try { return serverKeypair.verify(txHash, sig.signature()); }
    catch { return false; }
  });
  if (!serverSigned) {
    throw Object.assign(new Error('Challenge not signed by server'), { status: 400 });
  }

  // 6. Verificar que el cliente firmó la transacción
  const clientKeypair    = Keypair.fromPublicKey(clientAccountId);
  const clientSignatures = tx.signatures.filter(sig => {
    try { return clientKeypair.verify(txHash, sig.signature()); }
    catch { return false; }
  });

  if (clientSignatures.length === 0) {
    throw Object.assign(new Error('Transaction not signed by the claimed account'), { status: 400 });
  }

  // 7. Buscar el usuario por publicKey en MongoDB
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

  // 8. Emitir JWT Alyto completo para usuario registrado
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
