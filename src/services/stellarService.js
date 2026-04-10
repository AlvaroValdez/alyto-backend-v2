/**
 * stellarService.js — Servicio Core de Operaciones Stellar
 *
 * Implementa las operaciones fundamentales de la red Stellar para Alyto V2.0.
 * Este servicio es consumido por stellarProvider.js (capa de tránsito del orquestador)
 * y por cualquier controlador que necesite interactuar con la red.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  REGLA DE ORO (Stellar_Integration_Alyto)                               │
 * │  El usuario final NUNCA paga fees de red en XLM de su propio saldo.     │
 * │  TODA transacción de usuario debe estar envuelta en una Fee Bump         │
 * │  Transaction cuya cuenta pagadora es la channelAccount corporativa.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Flujo de una operación típica:
 *
 *   buildInnerTransaction()          ← construye la tx del usuario
 *         │
 *         ▼
 *   buildFeeBumpTransaction()        ← envuelve la tx con la channelAccount
 *         │
 *         ▼
 *   submitTransaction()              ← envía a Horizon y retorna el TXID
 *
 * Skills dependientes activos:
 *   ✅ USDC (Circle)   — asset soportado
 *   ⏸ CLPX (Anclap)   — PAUSADO, sin contrato
 *   ⏸ BP Ventures      — PAUSADO, sin integración
 */

import {
  TransactionBuilder,
  Operation,
  Keypair,
  Memo,
} from '@stellar/stellar-sdk';

import {
  horizonServer,
  NETWORK_PASSPHRASE,
  PRIORITY_FEE_STROOPS,
  BASE_FEE_STROOPS,
  TX_TIMEOUT_SECONDS,
  ASSETS,
  NETWORK_INFO,
} from '../config/stellar.js';

import { requireEnvSecret }  from '../utils/secrets.js';
import { handleStellarError } from '../utils/stellarErrors.js';
import Transaction            from '../models/Transaction.js';
import User                   from '../models/User.js';

// ─── Conversión FX CLP→USDC ──────────────────────────────────────────────────
import ExchangeRate from '../models/ExchangeRate.js';

const CLP_USD_FALLBACK = parseFloat(process.env.CLP_USD_RATE || '966');

/**
 * Obtiene la tasa CLP/USDC desde MongoDB (par CLP-USD o CLP-USDT).
 * Fallback: env CLP_USD_RATE → 950 hardcoded de último recurso.
 */
async function getCLPRate() {
  try {
    const record = await ExchangeRate.findOne({
      pair: { $in: ['CLP-USD', 'CLP-USDT'] },
    }).sort({ updatedAt: -1 });
    if (record) return record.rate;
  } catch (err) {
    console.warn('[Stellar] Error consultando CLP rate, usando fallback:', err.message);
  }
  return CLP_USD_FALLBACK;
}

// ─── 1. Fee Bump Transaction ──────────────────────────────────────────────────

/**
 * Envuelve una inner transaction en una Fee Bump Transaction.
 *
 * La Fee Bump permite que la channelAccount corporativa pague todas las
 * comisiones de red, eliminando la necesidad de que el usuario tenga XLM.
 *
 * @param {Transaction} innerTx - La transacción interna ya firmada por el usuario/servicio
 * @returns {Promise<FeeBumpTransaction>} Fee Bump lista para submit a Horizon
 *
 * Variables de entorno requeridas:
 *   STELLAR_CHANNEL_SECRET — Secret Key de la cuenta canal corporativa
 */
export async function buildFeeBumpTransaction(innerTx) {
  // La secret key de la channelAccount SIEMPRE viene de la variable de entorno
  // requireEnvSecret lanza si la variable no existe — fail fast, fail loud
  const channelKeypair = Keypair.fromSecret(
    requireEnvSecret('STELLAR_CHANNEL_SECRET'),
  );

  try {
    // Construir la Fee Bump usando la channelAccount como feeSource
    // La channelAccount paga las fees; la innerTx contiene las operaciones del usuario
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      channelKeypair,           // feeSource: channelAccount corporativa
      PRIORITY_FEE_STROOPS,     // fee en stroops (ajustar con /fee_stats en producción)
      innerTx,                  // la transacción original del usuario
      NETWORK_PASSPHRASE,       // passphrase de la red activa (testnet o mainnet)
    );

    // La channelAccount firma la Fee Bump (autoriza el pago de fees)
    feeBumpTx.sign(channelKeypair);

    return feeBumpTx;

  } catch (error) {
    handleStellarError('buildFeeBumpTransaction', error, {
      channelAccountPublic: channelKeypair.publicKey(), // public key es segura para loguear
      innerTxHash:          innerTx?.hash?.()?.toString('hex') ?? 'unknown',
    });
    throw error;
  }
}

// ─── 2. Inner Transaction Builder ────────────────────────────────────────────

/**
 * Construye la transacción interna (inner transaction) para una operación de pago.
 * Esta función NO firma con la channelAccount — solo construye la tx del usuario.
 * Debe pasarse a buildFeeBumpTransaction antes de submit.
 *
 * @param {object} params
 * @param {string} params.sourcePublicKey      - Public Key de la cuenta origen (usuario o servicio)
 * @param {string} params.destinationPublicKey - Public Key de la cuenta destino
 * @param {string} params.amount               - Monto como string (ej. '10.50')
 * @param {import('@stellar/stellar-sdk').Asset} params.asset - Asset a transferir (usar ASSETS.USDC)
 * @param {string} params.signerSecretEnvKey   - Nombre de la var de entorno con la secret key del signer
 * @param {string} [params.memo]               - Memo de texto opcional (máx 28 bytes)
 * @returns {Promise<Transaction>} Inner transaction firmada, lista para Fee Bump
 */
export async function buildInnerTransaction({
  sourcePublicKey,
  destinationPublicKey,
  amount,
  asset,
  signerSecretEnvKey,
  memo,
}) {
  try {
    // Cargar la cuenta origen desde Horizon para obtener el sequence number actualizado
    const sourceAccount = await horizonServer.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee:               PRIORITY_FEE_STROOPS,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    // Operación principal: pago
    builder.addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset,
        amount: amount.toString(),
      }),
    );

    // Memo opcional — útil para trazabilidad en block explorers
    if (memo) {
      builder.addMemo(Memo.text(memo.substring(0, 28))); // Stellar limita memo text a 28 bytes
    }

    builder.setTimeout(TX_TIMEOUT_SECONDS);

    const innerTx = builder.build();

    // Firmar con la clave del signer (entidad operadora o cuenta de servicio)
    const signerKeypair = Keypair.fromSecret(requireEnvSecret(signerSecretEnvKey));
    innerTx.sign(signerKeypair);

    return innerTx;

  } catch (error) {
    handleStellarError('buildInnerTransaction', error, {
      sourcePublicKey,
      destinationPublicKey,
      asset: asset?.code ?? 'unknown',
      amount,
    });
    throw error;
  }
}

// ─── 3. Trustline — Verificación y Creación Automática ───────────────────────

/**
 * Verifica que una cuenta tiene trustline activa para un asset.
 * Si no existe, la crea automáticamente como parte del flujo.
 * NUNCA falla silenciosamente — lanza si no puede crear la trustline.
 *
 * @param {string} accountPublicKey     - Cuenta a verificar
 * @param {import('@stellar/stellar-sdk').Asset} asset - Asset a verificar (ej. ASSETS.USDC)
 * @param {string} signerSecretEnvKey   - Var de entorno con la secret key para firmar si hay que crear
 * @returns {Promise<{ exists: boolean, created: boolean, txHash?: string }>}
 */
export async function ensureTrustline(accountPublicKey, asset, signerSecretEnvKey) {
  try {
    const account = await horizonServer.loadAccount(accountPublicKey);

    // Verificar si la trustline ya existe
    const hasTrustline = account.balances.some(
      balance =>
        balance.asset_type !== 'native' &&
        balance.asset_code   === asset.code &&
        balance.asset_issuer === asset.issuer,
    );

    if (hasTrustline) {
      return { exists: true, created: false };
    }

    // La trustline no existe — crearla como operación ChangeTrust
    console.info('[Alyto Stellar] Trustline no encontrada. Creando automáticamente.', {
      accountPublicKey,
      assetCode: asset.code,
    });

    const signerKeypair = Keypair.fromSecret(requireEnvSecret(signerSecretEnvKey));

    const trustlineTx = new TransactionBuilder(account, {
      fee:               PRIORITY_FEE_STROOPS,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    trustlineTx.sign(signerKeypair);

    // Envolver la trustline en Fee Bump → channelAccount paga las fees
    const feeBumpTx = await buildFeeBumpTransaction(trustlineTx);
    const result    = await horizonServer.submitTransaction(feeBumpTx);

    console.info('[Alyto Stellar] Trustline creada exitosamente.', {
      accountPublicKey,
      assetCode: asset.code,
      txHash:    result.hash,
    });

    return { exists: false, created: true, txHash: result.hash };

  } catch (error) {
    handleStellarError('ensureTrustline', error, {
      accountPublicKey,
      assetCode: asset?.code ?? 'unknown',
    });
    throw error;
  }
}

// ─── 4. Submit con manejo de errores ─────────────────────────────────────────

/**
 * Envía una Fee Bump Transaction a Horizon y retorna el hash (TXID).
 * Centraliza el submit para que todos los flujos pasen por aquí.
 *
 * @param {FeeBumpTransaction} feeBumpTx - Transacción lista para enviar
 * @returns {Promise<{ txid: string, ledger: number }>}
 */
export async function submitTransaction(feeBumpTx) {
  try {
    const result = await horizonServer.submitTransaction(feeBumpTx);

    console.info('[Alyto Stellar] Transacción confirmada en ledger.', {
      txid:   result.hash,
      ledger: result.ledger,
    });

    return {
      txid:   result.hash,
      ledger: result.ledger,
    };

  } catch (error) {
    handleStellarError('submitTransaction', error, {
      feeBumpTxHash: feeBumpTx?.hash?.()?.toString('hex') ?? 'unknown',
    });
    throw error;
  }
}

// ─── 5. Flujo Completo — crossBorderPayment via Stellar ──────────────────────

/**
 * Ejecuta un pago cross-border completo sobre Stellar:
 *   1. Verificar trustline del destino
 *   2. Construir inner transaction
 *   3. Envolver en Fee Bump
 *   4. Submit a Horizon
 *
 * Este es el método que stellarProvider.js llama como provider.execute().
 *
 * @param {object} params
 * @param {string} params.sourcePublicKey       - Public Key del origen
 * @param {string} params.destinationPublicKey  - Public Key del destino
 * @param {string} params.amount                - Monto (ej. '100.00')
 * @param {string} params.assetCode             - 'USDC' (único asset activo)
 * @param {string} params.signerSecretEnvKey    - Var de entorno del signer
 * @param {string} [params.memo]                - Memo para trazabilidad
 * @returns {Promise<{ txid: string, ledger: number }>}
 */
export async function executeStellarPayment({
  sourcePublicKey,
  destinationPublicKey,
  amount,
  assetCode = 'USDC',
  signerSecretEnvKey,
  memo,
}) {
  const asset = ASSETS[assetCode];
  if (!asset) {
    throw new Error(`[Alyto Stellar] Asset no soportado o pausado: "${assetCode}". Assets activos: USDC`);
  }

  // Paso 1: Verificar/crear trustline en la cuenta destino
  await ensureTrustline(destinationPublicKey, asset, signerSecretEnvKey);

  // Paso 2: Construir inner transaction (operaciones del usuario)
  const innerTx = await buildInnerTransaction({
    sourcePublicKey,
    destinationPublicKey,
    amount,
    asset,
    signerSecretEnvKey,
    memo,
  });

  // Paso 3: Envolver en Fee Bump (channelAccount paga las fees)
  const feeBumpTx = await buildFeeBumpTransaction(innerTx);

  // Paso 4: Submit y retornar TXID para trazabilidad y Compliance Bolivia (Escenario C)
  return submitTransaction(feeBumpTx);
}

// ─── 6. Audit Trail — Registro inmutable de transacciones Alyto en Stellar ───

/**
 * registerAuditTrail(transaction)
 *
 * Registra el alytoTransactionId en Stellar como evidencia inmutable de que
 * el pago fue completado. No mueve fondos — solo escribe datos en la blockchain.
 *
 * Operación: manageData('alyto_tx', alytoTransactionId) + memo text
 * Firmante: cuenta corporativa de la entidad legal del corredor (SpA / SRL / LLC)
 * Fees:     la cuenta corporativa paga sus propias fees (no se usa Fee Bump aquí)
 *
 * Resiliente: captura internamente todos los errores y retorna null en vez de lanzar.
 * Un fallo de Stellar NUNCA bloquea el flujo del pago.
 *
 * @param {object} transaction — Mongoose doc con alytoTransactionId y legalEntity
 * @returns {Promise<string|null>}  TXID de Stellar, o null si falló
 */
export async function registerAuditTrail(transaction) {
  console.log('[Stellar] registerAuditTrail llamado para:', transaction?.alytoTransactionId,
    '| entity:', transaction?.legalEntity);
  const entity = transaction.legalEntity ?? 'LLC';

  const secretKeyEnvMap = {
    SpA: 'STELLAR_SPA_SECRET_KEY',
    SRL: 'STELLAR_SRL_SECRET_KEY',
    LLC: 'STELLAR_LLC_SECRET_KEY',
  };
  const secretKey = process.env[secretKeyEnvMap[entity] ?? 'STELLAR_LLC_SECRET_KEY'];

  if (!secretKey) {
    console.warn(`[Stellar Audit] Secret key no configurada para entidad ${entity}. Audit trail omitido.`);
    return null;
  }

  try {
    const sourceKeypair   = Keypair.fromSecret(secretKey);
    const sourcePublicKey = sourceKeypair.publicKey();
    const alytoTxId       = transaction.alytoTransactionId;

    console.log('[Stellar Audit] Registrando audit trail:', alytoTxId,
      '| entidad:', entity, '| red:', NETWORK_INFO.name);

    const account = await horizonServer.loadAccount(sourcePublicKey);

    const auditTx = new TransactionBuilder(account, {
      fee:               BASE_FEE_STROOPS,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.manageData({
          name:  'alyto_tx',
          value: alytoTxId,          // máx 64 bytes — IDs Alyto son ~26 chars
        }),
      )
      .addMemo(Memo.text(alytoTxId.slice(0, 28)))  // memo text: máx 28 bytes
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    auditTx.sign(sourceKeypair);
    const result = await horizonServer.submitTransaction(auditTx);

    console.log('[Stellar Audit] ✅ Registrado:', result.hash,
      '| alytoTxId:', alytoTxId);

    return result.hash;

  } catch (error) {
    // NUNCA propagar — el audit trail es best-effort, nunca bloquea el pago
    console.error('[Stellar Audit] ❌ Error registrando audit trail:', error.message);
    if (error.response?.data?.extras) {
      console.error('[Stellar Audit] Extras:', JSON.stringify(error.response.data.extras));
    }
    return null;
  }
}

/**
 * getAuditTrail(stellarTxId)
 *
 * Consulta Horizon para obtener los detalles de una transacción de audit trail
 * previamente registrada. Usado por el endpoint GET /:transactionId/audit.
 *
 * @param {string} stellarTxId — Hash de la transacción Stellar
 * @returns {Promise<object|null>}
 */
export async function getAuditTrail(stellarTxId) {
  try {
    const tx = await horizonServer.transactions().transaction(stellarTxId).call();

    return {
      hash:        tx.hash,
      ledger:      tx.ledger,
      createdAt:   tx.created_at,
      memo:        tx.memo ?? null,
      explorerUrl: NETWORK_INFO.name === 'mainnet'
        ? `https://stellar.expert/explorer/public/tx/${tx.hash}`
        : `https://stellar.expert/explorer/testnet/tx/${tx.hash}`,
    };
  } catch (error) {
    console.error('[Stellar Audit] Error consultando audit trail:', error.message);
    return null;
  }
}

// ─── 7. executeWeb3Transit — Trigger automático post-payin ───────────────────

/**
 * Ejecuta el tránsito Web3 de una transacción que ya recibió el fiat (payin_completed).
 *
 * Este método es el puente entre el mundo fiat y la red Stellar:
 *   1. Lee la transacción y el usuario desde BD
 *   2. Convierte el monto CLP → USDC (tipo de cambio simulado)
 *   3. Verifica trustline USDC en la wallet del usuario
 *   4. Construye inner transaction: SpA corporativa → wallet del usuario
 *   5. ⭐ Envuelve en Fee Bump (channelAccount paga los fees — Regla de Oro)
 *   6. Submit a Horizon Testnet
 *   7. Actualiza la transacción en BD: stellarTxId + status = 'in_transit'
 *
 * LLAMADA FIRE-AND-FORGET desde el webhook de Fintoc:
 *   No usar await — Fintoc exige un 200 inmediato. Los errores se loguean
 *   para revisión manual sin bloquear la respuesta HTTP.
 *
 * Cuenta origen del tránsito: AV Finance SpA (STELLAR_SPA_PUBLIC_KEY)
 * Cuenta destino:             wallet Stellar del usuario (user.stellarAccount.publicKey)
 *
 * Variables de entorno requeridas:
 *   STELLAR_SPA_PUBLIC_KEY   — Public Key de la cuenta SpA (segura para logs)
 *   STELLAR_SPA_SECRET_KEY   — Secret Key de la cuenta SpA (solo para firmar)
 *   STELLAR_CHANNEL_SECRET   — Secret Key de channelAccount (Fee Bump)
 *
 * @param {string|import('mongoose').Types.ObjectId} transactionId - _id de Transaction en BD
 * @returns {Promise<void>} — no retorna valor; actualiza la BD como efecto secundario
 */
export async function executeWeb3Transit(transactionId) {
  const logCtx = { transactionId: transactionId.toString() };

  // ── 1. Leer la transacción desde BD ─────────────────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findById(transactionId);
  } catch (err) {
    console.error('[Alyto Stellar] executeWeb3Transit: error leyendo transacción.', {
      ...logCtx, error: err.message,
    });
    return;
  }

  if (!transaction) {
    console.error('[Alyto Stellar] executeWeb3Transit: transacción no encontrada.', logCtx);
    return;
  }

  // Guardar estado previo para rollback de status si el submit falla
  const previousStatus = transaction.status;

  // Verificar que el payin ya fue confirmado antes de proceder al tránsito
  if (transaction.status !== 'payin_completed') {
    console.warn('[Alyto Stellar] executeWeb3Transit: estado inesperado, se esperaba payin_completed.', {
      ...logCtx, currentStatus: transaction.status,
    });
    return;
  }

  // ── 2. Leer el usuario para obtener su Stellar public key ────────────────
  let user;
  try {
    user = await User.findById(transaction.userId).lean();
  } catch (err) {
    console.error('[Alyto Stellar] executeWeb3Transit: error leyendo usuario.', {
      ...logCtx, error: err.message,
    });
    return;
  }

  if (!user?.stellarAccount?.publicKey) {
    console.error('[Alyto Stellar] executeWeb3Transit: el usuario no tiene wallet Stellar configurada.', {
      ...logCtx, userId: transaction.userId.toString(),
    });
    await Transaction.findByIdAndUpdate(transactionId, {
      status:        'failed',
      failureReason: 'Usuario sin cuenta Stellar registrada. Tránsito Web3 no puede ejecutarse.',
    });
    return;
  }

  const clientStellarAddress = user.stellarAccount.publicKey;
  const spaCorporateAddress  = process.env.STELLAR_SPA_PUBLIC_KEY;

  if (!spaCorporateAddress) {
    console.error('[Alyto Stellar] executeWeb3Transit: STELLAR_SPA_PUBLIC_KEY no configurada.', logCtx);
    return;
  }

  // ── 3. Calcular conversión fxConversion: CLP → USDC ─────────────────────
  // Tasa dinámica: MongoDB → env CLP_USD_RATE → fallback 950
  const clpPerUsdc = await getCLPRate();
  const usdcAmount = (transaction.originalAmount / clpPerUsdc).toFixed(7);

  console.info('[Alyto Stellar] executeWeb3Transit: iniciando tránsito Web3.', {
    ...logCtx,
    alytoTransactionId: transaction.alytoTransactionId,
    clpAmount:          transaction.originalAmount,
    usdcAmount,
    fxRate:             clpPerUsdc,
    clientStellarAddress,
    // spaCorporateAddress es pública — seguro para logs
    spaCorporateAddress,
  });

  // ── 4. Verificar trustline USDC en la wallet del usuario ─────────────────
  // Si el usuario no tiene trustline para USDC, la creamos automáticamente.
  // La trustline también se envuelve en Fee Bump (channelAccount paga la fee).
  try {
    await ensureTrustline(
      clientStellarAddress,
      ASSETS.USDC,
      'STELLAR_SPA_SECRET_KEY', // SpA firma la creación de la trustline
    );
  } catch (err) {
    handleStellarError('executeWeb3Transit.ensureTrustline', err, {
      clientStellarAddress,
      assetCode: 'USDC',
    });
    await Transaction.findByIdAndUpdate(transactionId, {
      status:        'failed',
      failureReason: `No se pudo verificar/crear la trustline USDC: ${err.message}`,
    });
    return;
  }

  // ── 5. Construir inner transaction: SpA → wallet del usuario ────────────
  // La inner tx mueve los USDC desde la cuenta SpA al usuario final.
  // El memo incluye el ID de la transacción Alyto para trazabilidad on-chain.
  let innerTx;
  try {
    innerTx = await buildInnerTransaction({
      sourcePublicKey:      spaCorporateAddress,
      destinationPublicKey: clientStellarAddress,
      amount:               usdcAmount,
      asset:                ASSETS.USDC,
      signerSecretEnvKey:   'STELLAR_SPA_SECRET_KEY',
      memo:                 transaction.alytoTransactionId,  // visible en block explorer
    });
  } catch (err) {
    handleStellarError('executeWeb3Transit.buildInnerTransaction', err, {
      spaCorporateAddress,
      clientStellarAddress,
      usdcAmount,
    });
    await Transaction.findByIdAndUpdate(transactionId, {
      status:        'failed',
      failureReason: `Error construyendo inner transaction: ${err.message}`,
    });
    return;
  }

  // ── 6. ⭐ Envolver en Fee Bump — Regla de Oro ────────────────────────────
  // La channelAccount corporativa absorbe los fees de red.
  // El usuario NUNCA paga XLM de su propio saldo.
  let feeBumpTx;
  try {
    feeBumpTx = await buildFeeBumpTransaction(innerTx);
  } catch (err) {
    handleStellarError('executeWeb3Transit.buildFeeBumpTransaction', err, { ...logCtx });
    await Transaction.findByIdAndUpdate(transactionId, {
      status:        'failed',
      failureReason: `Error construyendo Fee Bump transaction: ${err.message}`,
    });
    return;
  }

  // ── 7. Submit a Horizon Testnet ──────────────────────────────────────────
  let stellarResult;
  try {
    stellarResult = await submitTransaction(feeBumpTx);
  } catch (err) {
    handleStellarError('executeWeb3Transit.submitTransaction', err, { ...logCtx });
    await Transaction.findByIdAndUpdate(transactionId, {
      status:        'failed',
      failureReason: `Submit a Horizon falló: ${err.message}`,
    });
    return;
  }

  // ── 8. Actualizar la transacción en BD con TXID y nuevo estado ───────────
  try {
    await Transaction.findByIdAndUpdate(transactionId, {
      $set: {
        status:              'in_transit',
        stellarTxId:         stellarResult.txid,
        stellarLedger:       stellarResult.ledger,
        digitalAsset:        'USDC',
        digitalAssetAmount:  parseFloat(usdcAmount),
        exchangeRate:        clpPerUsdc,
        exchangeRateLockedAt: new Date(),
        stellarSourceAddress: spaCorporateAddress,
        stellarDestAddress:   clientStellarAddress,
        $push: {
          providersUsed: 'transit:stellar',
          paymentLegs: {
            stage:       'transit',
            provider:    'stellar',
            status:      'completed',
            externalId:  stellarResult.txid,
            completedAt: new Date(),
          },
        },
      },
    });

    console.info('[Alyto Stellar] executeWeb3Transit: tránsito completado.', {
      ...logCtx,
      alytoTransactionId: transaction.alytoTransactionId,
      stellarTxId:        stellarResult.txid,
      stellarLedger:      stellarResult.ledger,
      usdcAmount,
    });

  } catch (err) {
    // El submit a Stellar fue exitoso pero no se actualizó la BD.
    // CRÍTICO: loguear el txid para reconciliación manual — el dinero ya se movió.
    console.error('[Alyto Stellar] executeWeb3Transit: ALERTA — submit exitoso pero error al persistir en BD.', {
      ...logCtx,
      stellarTxId:  stellarResult.txid,
      stellarLedger: stellarResult.ledger,
      error:         err.message,
    });
  }
}

// ─── 8. Trustline Freeze / Unfreeze — Compliance ASFI/UIF (Fase 26) ──────────

/**
 * freezeUserTrustline(stellarPublicKey, assetCode)
 *
 * Registra en Stellar un evento de congelamiento por compliance ASFI/UIF.
 * Actual implementación: manageData con clave 'alyto_freeze' firmado por la
 * cuenta SRL corporativa → evidencia inmutable en blockchain.
 *
 * Ruta de actualización (cuando SRL emita su propio asset Stellar):
 *   Reemplazar el manageData por:
 *   Operation.setTrustLineFlags({ trustor: stellarPublicKey, asset, flags: { authorized: false } })
 *   firmado por el issuer del asset SRL. Requiere AUTH_REQUIRED + AUTH_REVOCABLE
 *   en la cuenta emisora.
 *
 * FIRE-AND-FORGET: nunca bloquea el congelamiento MongoDB. Los errores
 * se loguean pero no propagan.
 *
 * @param {string} stellarPublicKey - Public key del usuario a congelar
 * @param {string} [assetCode]      - Código del asset (referencia para el registro)
 * @returns {Promise<string|null>}  TXID de Stellar, o null si falló / no configurado
 */
export async function freezeUserTrustline(stellarPublicKey, assetCode = 'USDC') {
  if (!stellarPublicKey) {
    console.warn('[Stellar Compliance] freezeUserTrustline: sin stellarPublicKey — evento omitido.');
    return null;
  }

  const secretKey = process.env.STELLAR_SRL_SECRET_KEY;
  if (!secretKey) {
    console.warn('[Stellar Compliance] STELLAR_SRL_SECRET_KEY no configurada — freeze omitido.');
    return null;
  }

  try {
    const srlKeypair  = Keypair.fromSecret(secretKey);
    const srlPublic   = srlKeypair.publicKey();
    const account     = await horizonServer.loadAccount(srlPublic);

    // Valor del manageData: «FREEZE:<publicKey_recortada>:<asset>:<timestamp>»
    // Se recorta la public key para mantenerse dentro del límite de 64 bytes de Stellar
    const freezeValue = `FREEZE:${stellarPublicKey.slice(0, 20)}:${assetCode}:${Date.now()}`;

    const freezeTx = new TransactionBuilder(account, {
      fee:               BASE_FEE_STROOPS,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.manageData({
          name:  'alyto_freeze',
          value: freezeValue.slice(0, 64),
        }),
      )
      .addMemo(Memo.text(`FREEZE ${stellarPublicKey.slice(0, 22)}`))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    freezeTx.sign(srlKeypair);
    const result = await horizonServer.submitTransaction(freezeTx);

    console.info('[Stellar Compliance] ✅ Freeze registrado en Stellar:', {
      txHash:         result.hash,
      stellarPublicKey,
      assetCode,
    });

    return result.hash;

  } catch (error) {
    // NUNCA propagar — el congelamiento MongoDB ya se ejecutó; Stellar es auditoría
    console.error('[Stellar Compliance] ❌ Error registrando freeze en Stellar:', error.message);
    if (error.response?.data?.extras) {
      console.error('[Stellar Compliance] Extras:', JSON.stringify(error.response.data.extras));
    }
    return null;
  }
}

/**
 * unfreezeUserTrustline(stellarPublicKey, assetCode)
 *
 * Registra en Stellar un evento de descongelamiento por compliance ASFI.
 * Mismo patrón que freezeUserTrustline — manageData 'alyto_unfreeze'.
 *
 * Ruta de actualización futura:
 *   Operation.setTrustLineFlags({ trustor: stellarPublicKey, asset, flags: { authorized: true } })
 *
 * FIRE-AND-FORGET: nunca bloquea el descongelamiento MongoDB.
 *
 * @param {string} stellarPublicKey - Public key del usuario a descongelar
 * @param {string} [assetCode]      - Código del asset
 * @returns {Promise<string|null>}  TXID de Stellar, o null si falló / no configurado
 */
export async function unfreezeUserTrustline(stellarPublicKey, assetCode = 'USDC') {
  if (!stellarPublicKey) {
    console.warn('[Stellar Compliance] unfreezeUserTrustline: sin stellarPublicKey — evento omitido.');
    return null;
  }

  const secretKey = process.env.STELLAR_SRL_SECRET_KEY;
  if (!secretKey) {
    console.warn('[Stellar Compliance] STELLAR_SRL_SECRET_KEY no configurada — unfreeze omitido.');
    return null;
  }

  try {
    const srlKeypair  = Keypair.fromSecret(secretKey);
    const srlPublic   = srlKeypair.publicKey();
    const account     = await horizonServer.loadAccount(srlPublic);

    const unfreezeValue = `UNFREEZE:${stellarPublicKey.slice(0, 20)}:${assetCode}:${Date.now()}`;

    const unfreezeTx = new TransactionBuilder(account, {
      fee:               BASE_FEE_STROOPS,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.manageData({
          name:  'alyto_unfreeze',
          value: unfreezeValue.slice(0, 64),
        }),
      )
      .addMemo(Memo.text(`UNFREEZE ${stellarPublicKey.slice(0, 20)}`))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    unfreezeTx.sign(srlKeypair);
    const result = await horizonServer.submitTransaction(unfreezeTx);

    console.info('[Stellar Compliance] ✅ Unfreeze registrado en Stellar:', {
      txHash:         result.hash,
      stellarPublicKey,
      assetCode,
    });

    return result.hash;

  } catch (error) {
    // NUNCA propagar — el descongelamiento MongoDB ya se ejecutó
    console.error('[Stellar Compliance] ❌ Error registrando unfreeze en Stellar:', error.message);
    if (error.response?.data?.extras) {
      console.error('[Stellar Compliance] Extras:', JSON.stringify(error.response.data.extras));
    }
    return null;
  }
}

// ─── Fase 35: Detección de Depósitos USDC Entrantes (Stub Manual) ─────────────

/**
 * detectIncomingUSDC — Verifica pagos USDC entrantes en la cuenta SRL compartida.
 *
 * FASE 35 (manual): esta función es un stub. El flujo de acreditación en Fase 35
 * es manual: el admin detecta el depósito en Stellar Laboratory o Horizon Explorer,
 * luego lo confirma directamente desde el panel admin acreditando el saldo USDC.
 *
 * FASE 36 (automático, pendiente implementación):
 *   - Abrir stream Horizon para la cuenta STELLAR_SRL_PUBLIC_KEY
 *   - Filtrar operaciones de tipo 'payment' con asset_code === 'USDC'
 *   - Leer el memo de la transacción
 *   - Buscar WalletUSDC por stellarMemo
 *   - Acreditar saldo automáticamente con sesión atómica
 *
 * Variables de entorno requeridas (Fase 36):
 *   STELLAR_SRL_PUBLIC_KEY — dirección pública de la cuenta SRL compartida
 *   STELLAR_HORIZON_URL    — URL del servidor Horizon
 *
 * @returns {Promise<{ detected: false, message: string }>}
 */
export async function detectIncomingUSDC() {
  // Fase 35: detección manual. No se automatiza hasta Fase 36.
  console.info('[Stellar USDC] detectIncomingUSDC: modo manual (Fase 35). Ver Horizon Explorer para verificar depósitos.');
  return {
    detected: false,
    message:  'Detección automática pendiente (Fase 36). Acreditar manualmente desde el panel admin.',
  };
}
