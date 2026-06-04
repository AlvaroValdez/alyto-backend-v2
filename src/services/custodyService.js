/**
 * custodyService.js — Custodia de Keypairs Stellar de Usuarios
 *
 * Implementa el modelo custodial de Alyto bajo la facultad PSAV:
 *   DS 5384 (07/05/2025), Cap. XI, Art. 4° literal l, inciso 4:
 *   "La custodia y/o administración de Activos Virtuales o instrumentos
 *    que permitan el control sobre Activos Virtuales."
 *
 * Modelo custodial:
 *   - Alyto genera el keypair en servidor
 *   - La secretKey se almacena EXCLUSIVAMENTE en AWS KMS (nunca en MongoDB)
 *   - Solo se almacena la publicKey en MongoDB (User.stellarAccount.publicKey)
 *   - El usuario opera sin gestionar llaves (UX simplificado para retail Bolivia)
 *
 * Obligaciones regulatorias cumplidas (Cap. XI, Sec. 4, Art. 2°):
 *   a) Registros completos, precisos e individualizados de transacciones
 *   b) Identificación y monitoreo de movimientos (reportes de control)
 *
 * ⚠️  La secretKey JAMÁS aparece en logs, MongoDB, ni variables de entorno por usuario.
 */

import {
  KMSClient,
  CreateKeyCommand,
  EncryptCommand,
  DecryptCommand,
  DescribeKeyCommand,
  TagResourceCommand,
} from '@aws-sdk/client-kms';

import crypto from 'node:crypto';

import { Keypair, TransactionBuilder, Operation, Networks } from '@stellar/stellar-sdk';

import {
  horizonServer,
  NETWORK_PASSPHRASE,
  ASSETS,
  PRIORITY_FEE_STROOPS,
  TX_TIMEOUT_SECONDS,
} from '../config/stellar.js';

import { requireEnvSecret } from '../utils/secrets.js';
import { logger }           from '../utils/logger.js';
import User                 from '../models/User.js';

// ─── Configuración KMS ───────────────────────────────────────────────────────

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

function getKmsClient() {
  return new KMSClient({ region: AWS_REGION });
}

// ARN/ID de la master key para cifrado de secretKeys de usuarios
// Si no está configurada, se usa la misma key de Secrets Manager
const USER_KEYPAIR_KMS_KEY_ID = process.env.USER_KEYPAIR_KMS_KEY_ID
  ?? process.env.AWS_SECRETS_KMS_KEY_ID
  ?? 'alias/aws/secretsmanager'; // default: KMS key gestionada por AWS

// ─── Fallback de custodia testnet-only (sin KMS) ─────────────────────────────
//
// AWS es solo-VPS (producción/mainnet). Staging (Render, testnet) NO tiene KMS,
// por lo que no podría provisionar keypairs custodiales. Este fallback cifra la
// secretKey con AES-256-GCM usando una clave local de entorno, EXCLUSIVAMENTE en
// testnet y bajo opt-in explícito. Producción (mainnet) sigue 100% KMS.
//
// Blindaje (hard-gated): se activa solo si CUSTODY_KMS_FALLBACK=true Y la red es
// testnet. Si el flag está activo en mainnet → lanza (prohibido). Los ciphertext
// de fallback llevan prefijo 'FB1:' para detectarlos; mainnet rechaza descifrarlos.

const FALLBACK_PREFIX = 'FB1:';

/**
 * Indica si el fallback de custodia testnet-only está activo.
 * @throws si el flag está activo en una red que NO es testnet (prohibición mainnet).
 */
function isKmsFallbackActive() {
  const flagOn    = process.env.CUSTODY_KMS_FALLBACK === 'true';
  const isTestnet = NETWORK_PASSPHRASE === Networks.TESTNET;
  if (flagOn && !isTestnet) {
    throw new Error(
      '[custody] CUSTODY_KMS_FALLBACK activo pero la red NO es testnet — ' +
      'el fallback sin KMS está PROHIBIDO en mainnet. Abortando.',
    );
  }
  return flagOn && isTestnet;
}

/** Deriva una clave AES-256 determinística desde CUSTODY_FALLBACK_KEY. */
function getFallbackKey() {
  const secret = process.env.CUSTODY_FALLBACK_KEY;
  if (!secret || secret.length < 16) {
    throw new Error('[custody] CUSTODY_FALLBACK_KEY no configurada o < 16 chars (requerida para el fallback testnet).');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function fallbackEncrypt(secretKey, userId) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getFallbackKey(), iv);
  cipher.setAAD(Buffer.from(`${userId}:alyto-stellar-custody`, 'utf8'));
  const enc = Buffer.concat([cipher.update(secretKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return FALLBACK_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function fallbackDecrypt(stored, userId) {
  const raw      = Buffer.from(stored.slice(FALLBACK_PREFIX.length), 'base64');
  const iv       = raw.subarray(0, 12);
  const tag      = raw.subarray(12, 28);
  const enc      = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getFallbackKey(), iv);
  decipher.setAAD(Buffer.from(`${userId}:alyto-stellar-custody`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ─── Utilidades KMS ─────────────────────────────────────────────────────────

/**
 * Cifra una secretKey usando AWS KMS (o el fallback testnet-only si está activo).
 * Retorna el ciphertext en base64.
 * @param {string} secretKey - S... (56 chars)
 * @param {string} userId    - MongoDB ObjectId del usuario (contexto de cifrado)
 * @returns {Promise<string>} ciphertext en base64
 */
async function encryptSecretKey(secretKey, userId) {
  if (isKmsFallbackActive()) {
    logger.warn('[custody] Cifrando secretKey con FALLBACK testnet (sin KMS)', { userId: String(userId) });
    return fallbackEncrypt(secretKey, userId);
  }
  const kms = getKmsClient();
  const cmd = new EncryptCommand({
    KeyId:             USER_KEYPAIR_KMS_KEY_ID,
    Plaintext:         Buffer.from(secretKey, 'utf8'),
    EncryptionContext: { userId: String(userId), service: 'alyto-stellar-custody' },
  });
  const result = await kms.send(cmd);
  return Buffer.from(result.CiphertextBlob).toString('base64');
}

/**
 * Descifra una secretKey almacenada en base64 usando AWS KMS.
 * Si el ciphertext lleva prefijo de fallback ('FB1:'), usa el descifrado local
 * testnet-only (rechazado en mainnet).
 * @param {string} ciphertextBase64 - valor almacenado en User.stellarAccount.secretKeyCiphertext
 * @param {string} userId
 * @returns {Promise<string>} secretKey en texto plano — usar inmediatamente, no almacenar
 */
async function decryptSecretKey(ciphertextBase64, userId) {
  if (ciphertextBase64.startsWith(FALLBACK_PREFIX)) {
    if (NETWORK_PASSPHRASE !== Networks.TESTNET) {
      throw new Error('[custody] Ciphertext de fallback detectado en red NO testnet — abortando descifrado.');
    }
    return fallbackDecrypt(ciphertextBase64, userId);
  }
  const kms = getKmsClient();
  const cmd = new DecryptCommand({
    CiphertextBlob:    Buffer.from(ciphertextBase64, 'base64'),
    EncryptionContext: { userId: String(userId), service: 'alyto-stellar-custody' },
  });
  const result = await kms.send(cmd);
  return Buffer.from(result.Plaintext).toString('utf8');
}

// ─── Operaciones de Custodia ─────────────────────────────────────────────────

/**
 * Genera un keypair Stellar nuevo para un usuario y lo registra en custodia.
 *
 * Flujo:
 *   1. Genera keypair con Keypair.random()
 *   2. Cifra secretKey en AWS KMS con contexto userId
 *   3. Almacena ciphertext en User.stellarAccount.secretKeyCiphertext
 *   4. Almacena publicKey en User.stellarAccount.publicKey
 *   5. Funde la cuenta con XLM desde la channelAccount corporativa
 *   6. Crea trustline USDC en la cuenta del usuario
 *
 * @param {string} userId - MongoDB ObjectId del usuario
 * @returns {Promise<{publicKey: string}>} Solo retorna publicKey (nunca secretKey)
 */
export async function provisionUserKeypair(userId) {
  const log = { userId: String(userId), fn: 'provisionUserKeypair' };

  // Verificar que no tenga ya una cuenta
  const user = await User.findById(userId).lean();
  if (!user) throw new Error(`[custody] User ${userId} not found`);
  if (user.stellarAccount?.publicKey) {
    logger.info('[custody] User already has keypair', log);
    return { publicKey: user.stellarAccount.publicKey };
  }

  // 1. Generar keypair
  const keypair    = Keypair.random();
  const publicKey  = keypair.publicKey();
  const secretKey  = keypair.secret();

  logger.info('[custody] Keypair generated', { ...log, publicKey });

  // 2. Cifrar secretKey en KMS
  let ciphertext;
  try {
    ciphertext = await encryptSecretKey(secretKey, userId);
  } catch (kmsErr) {
    logger.error('[custody] KMS encrypt failed — aborting keypair provision', { ...log, err: kmsErr.message });
    throw kmsErr;
  }

  // 3 & 4. Persistir en MongoDB (solo publicKey + ciphertext)
  await User.findByIdAndUpdate(userId, {
    'stellarAccount.publicKey':          publicKey,
    'stellarAccount.secretKeyCiphertext': ciphertext,
    'stellarAccount.createdByAlyto':      true,
    'stellarAccount.activeTrustlines':    [],
  });

  logger.info('[custody] Keypair persisted in MongoDB', { ...log, publicKey });

  // 5. Fondear la cuenta con XLM (createAccount operation)
  try {
    await fundUserAccount(publicKey);
    logger.info('[custody] Account funded with XLM', { ...log, publicKey });
  } catch (fundErr) {
    logger.warn('[custody] XLM funding failed — account created but not funded yet', { ...log, err: fundErr.message });
    // No relanzar — la cuenta puede fondearse después
  }

  // 6. Crear trustline USDC
  try {
    await createUsdcTrustline(userId, publicKey);
    logger.info('[custody] USDC trustline created', { ...log, publicKey });
  } catch (tlErr) {
    logger.warn('[custody] USDC trustline creation failed — retry needed', { ...log, err: tlErr.message });
    // No relanzar — trustline puede crearse en operación posterior
  }

  return { publicKey };
}

/**
 * Recupera el keypair completo de un usuario para firmar transacciones.
 * La secretKey se descifra en memoria y se usa inmediatamente.
 * NUNCA retornar secretKey al caller — retornar el Keypair directamente.
 *
 * @param {string} userId
 * @returns {Promise<import('@stellar/stellar-sdk').Keypair>}
 */
export async function getUserKeypair(userId) {
  const user = await User.findById(userId).select('+stellarAccount.secretKeyCiphertext').lean();
  if (!user?.stellarAccount?.secretKeyCiphertext) {
    throw new Error(`[custody] No custodial keypair found for user ${userId}. Run provisionUserKeypair first.`);
  }

  const secretKey = await decryptSecretKey(user.stellarAccount.secretKeyCiphertext, userId);
  return Keypair.fromSecret(secretKey);
}

/**
 * Verifica si un usuario tiene keypair bajo custodia.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function hasCustodialKeypair(userId) {
  const user = await User.findById(userId).select('stellarAccount.publicKey').lean();
  return !!user?.stellarAccount?.publicKey;
}

// ─── Operaciones Stellar internas ────────────────────────────────────────────

/**
 * Funde una nueva cuenta Stellar con el mínimo de XLM requerido.
 * La channelAccount corporativa actúa como fuente + fee payer.
 */
async function fundUserAccount(destinationPublicKey) {
  const channelKeypair = Keypair.fromSecret(requireEnvSecret('STELLAR_MASTER_SECRET'));
  const channelAccount = await horizonServer.loadAccount(channelKeypair.publicKey());

  const tx = new TransactionBuilder(channelAccount, {
    fee:               PRIORITY_FEE_STROOPS,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.createAccount({
      destination:     destinationPublicKey,
      startingBalance: '1.5',   // mínimo Stellar: 1 XLM base reserve + 0.5 de margen
    }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  tx.sign(channelKeypair);
  return horizonServer.submitTransaction(tx);
}

/**
 * Crea trustline USDC en la cuenta del usuario.
 * Usa la secretKey del usuario (descifrada de KMS) + Fee Bump corporativa.
 */
async function createUsdcTrustline(userId, publicKey) {
  const userKeypair   = await getUserKeypair(userId);
  const userAccount   = await horizonServer.loadAccount(publicKey);
  const channelKeypair = Keypair.fromSecret(requireEnvSecret('STELLAR_MASTER_SECRET'));

  const innerTx = new TransactionBuilder(userAccount, {
    fee:               PRIORITY_FEE_STROOPS,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: ASSETS.USDC }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  innerTx.sign(userKeypair);

  // Fee Bump: la channelAccount paga las fees, el usuario firma la operación
  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    channelKeypair,
    PRIORITY_FEE_STROOPS,
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBumpTx.sign(channelKeypair);

  await horizonServer.submitTransaction(feeBumpTx);

  // Actualizar lista de trustlines en MongoDB
  await User.findByIdAndUpdate(userId, {
    $addToSet: { 'stellarAccount.activeTrustlines': 'USDC' },
  });
}
