/**
 * sep24Service.js — SEP-24 Interactive Anchor (Deposit & Withdraw)
 *
 * Permite a usuarios con wallets Stellar externas (Lobstr, Freighter, Solar)
 * depositar BOB/USDC en Alyto y retirar fondos a través de la interfaz Alyto.
 *
 * Spec: https://stellar.org/protocol/sep-24
 *
 * Flujo Deposit (usuario envía fondos a Alyto):
 *   1. POST /transactions/deposit  → Alyto retorna URL del widget + transaction_id
 *   2. Usuario abre el widget en el browser (formulario Alyto de payin)
 *   3. Usuario completa el depósito (transferencia bancaria, QR Bolivia)
 *   4. Admin confirma → Alyto acredita en la wallet Stellar del usuario
 *
 * Flujo Withdraw (usuario retira fondos de Alyto):
 *   1. POST /transactions/withdraw → Alyto retorna URL del widget + transaction_id
 *   2. Usuario especifica destino (banco local)
 *   3. Usuario envía USDC a la dirección de la cuenta SRL
 *   4. Alyto detecta USDC → ejecuta payout bancario local
 *
 * Status SEP-24:
 *   pending_user_transfer_start → Usuario debe hacer la transferencia
 *   pending_external            → Esperando confirmación externa (banco)
 *   pending_anchor              → Alyto procesando internamente
 *   completed                   → Completado
 *   error                       → Error — ver `message`
 */

import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import WalletUSDC        from '../models/WalletUSDC.js';
import { calculateQuote } from './quoteCalculator.js';
import { logger }         from '../utils/logger.js';
import { ASSETS }         from '../config/stellar.js';
import { resolveWithdrawFeePercent, computeFee } from './sep24Fees.js';

const randomId = () => Math.random().toString(36).substring(2, 10).toUpperCase();

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://alyto-frontend-v2.onrender.com';

// ─── GET /info ────────────────────────────────────────────────────────────────

/**
 * Retorna los activos y operaciones soportadas como anchor SEP-24.
 *
 * La comisión de retiro se resuelve desde el tarifario (`sep24Fees`) y no está fija
 * acá: antes este `/info` publicaba 6,5% mientras `/fee` calculaba con 0,065 por
 * separado, de modo que un cambio en el tarifario no alcanzaba a ninguno de los dos.
 */
export async function getAnchorInfo() {
  const withdrawFeePercent = await resolveWithdrawFeePercent();

  return {
    deposit: {
      USDC: {
        enabled:      true,
        authentication_required: true,
        min_amount:   10,
        max_amount:   9998,
        fee_fixed:    0,
        fee_percent:  0,
        fields: {
          amount: {
            description: 'Monto a depositar en USDC',
            optional: false,
          },
        },
      },
    },
    withdraw: {
      USDC: {
        enabled:      true,
        authentication_required: true,
        min_amount:   10,
        max_amount:   9998,
        fee_fixed:    0,
        fee_percent:  withdrawFeePercent,
        types: {
          bank_account: {
            fields: {
              dest:       { description: 'Número de cuenta bancaria' },
              dest_extra: { description: 'Código bancario (CBU/CCI/CLABE)' },
            },
          },
        },
      },
    },
    fee: {
      enabled: true,
    },
  };
}

// ─── POST /transactions/deposit ───────────────────────────────────────────────

/**
 * Inicia un depósito SEP-24.
 * El usuario tiene USDC en una wallet externa y quiere depositarlo en Alyto.
 *
 * @param {object} body - { asset_code, account, amount?, memo_type?, memo?, lang? }
 * @param {object} user - req.user del token SEP-10
 */
export async function initiateDeposit({ body, user }) {
  const { asset_code, account, amount, lang = 'es' } = body;

  if (asset_code !== 'USDC') {
    throw Object.assign(new Error(`Asset ${asset_code} not supported`), { status: 400 });
  }

  const transactionId = `ALY-D-${Date.now()}-${randomId()}`;
  const userId        = user._id ?? null;
  if (!userId) {
    throw Object.assign(new Error('SEP-24 deposit requiere una cuenta Alyto vinculada'), { status: 400 });
  }
  const amt = amount ? parseFloat(amount) : 0;

  // Camino A (Fase 40): el depósito custodial va a la dirección Stellar PROPIA del
  // usuario (SIN memo), NO a la tesorería SRL compartida. Reutiliza los helpers
  // canónicos del flujo wallet para mantener consistencia con monitorUSDCDeposits,
  // que acredita por dirección custodial. (Antes apuntaba a STELLAR_SRL_PUBLIC_KEY
  // + memo `ALY-D-…`, que el monitor ignoraba como fondeo de tesorería → el
  // depósito nunca se acreditaba y la tx quedaba colgada en sep24_deposit_pending.)
  const { ensureCustodialDepositAddress, getOrCreateWalletUSDC } =
    await import('../controllers/walletUSDCController.js');
  const wallet = await getOrCreateWalletUSDC(userId);
  const { publicKey: depositAddress, usdcTrustline } = await ensureCustodialDepositAddress(userId);
  if (!depositAddress) {
    throw Object.assign(new Error('No se pudo provisionar la dirección custodial del usuario'), { status: 500 });
  }
  // Sincronizar la dirección de la WalletUSDC (lazy-migración legacy → custodial)
  // para que el monitor matchee por `stellarAddress`.
  if (wallet.stellarAddress !== depositAddress || wallet.stellarMemo) {
    await WalletUSDC.updateOne({ _id: wallet._id }, { stellarAddress: depositAddress, stellarMemo: null });
  }

  // Crear registro de transacción en MongoDB (campos conformes al schema Transaction)
  const tx = await Transaction.create({
    alytoTransactionId:  transactionId,
    userId,
    legalEntity:         'SRL',
    operationType:       'payin',          // depósito = entrada de fondos
    routingScenario:     'C',
    status:              'sep24_deposit_pending',
    originalAmount:      amt,
    originCurrency:      'USD',            // valor fiat del USDC (ISO 3 chars)
    destinationCurrency: 'USD',
    digitalAsset:        'USDC',
    digitalAssetAmount:  amt,
    sep24Type:           'deposit',
    instructionAddress:  depositAddress,
    instructionMemo:     null,             // modelo custodial: sin memo
    expiresAt:           new Date(Date.now() + 60 * 60 * 1000), // 1 hora
  });

  // URL del widget interactivo (frontend Alyto)
  const interactiveUrl = `${FRONTEND_URL}/sep24/deposit?transaction_id=${transactionId}&lang=${lang}`;

  logger.info('[sep24] Deposit initiated', { transactionId, userId, depositAddress, usdcTrustline });

  return {
    type:           'interactive_customer_info_needed',
    url:            interactiveUrl,
    id:             transactionId,
    // Camino A: dirección custodial exclusiva del usuario, SIN memo.
    instruction:    {
      stellar_account: depositAddress,
      memo_type:       'none',
      memo:            null,
    },
    ready:           usdcTrustline,   // si false, la trustline USDC aún se está estableciendo
  };
}

// ─── POST /transactions/withdraw ──────────────────────────────────────────────

/**
 * Inicia un retiro SEP-24.
 * El usuario quiere retirar USDC de Alyto a su banco local.
 *
 * @param {object} body - { asset_code, account, dest, dest_extra, amount?, type? }
 * @param {object} user - req.user del token SEP-10
 */
export async function initiateWithdraw({ body, user }) {
  const {
    asset_code,
    account,
    dest,
    dest_extra,
    amount,
    type = 'bank_account',
    lang = 'es',
  } = body;

  if (asset_code !== 'USDC') {
    throw Object.assign(new Error(`Asset ${asset_code} not supported`), { status: 400 });
  }

  const transactionId = `ALY-W-${Date.now()}-${randomId()}`;
  const userId        = user._id ?? null;
  if (!userId) {
    throw Object.assign(new Error('SEP-24 withdraw requiere una cuenta Alyto vinculada'), { status: 400 });
  }
  const amt = amount ? parseFloat(amount) : 0;

  // La cuenta Stellar SRL recibe el USDC del usuario
  const withdrawAddress = process.env.STELLAR_SRL_PUBLIC_KEY;
  const withdrawMemo    = transactionId;

  const tx = await Transaction.create({
    alytoTransactionId:  transactionId,
    userId,
    legalEntity:         'SRL',
    operationType:       'payout',         // retiro = salida de fondos
    routingScenario:     'C',
    status:              'sep24_withdraw_pending',
    originalAmount:      amt,
    originCurrency:      'USD',            // origen: USDC (valor fiat USD)
    destinationCurrency: 'BOB',           // destino: banco local boliviano
    digitalAsset:        'USDC',
    digitalAssetAmount:  amt,
    sep24Type:           'withdraw',
    beneficiary: {
      accountBank: dest,
      bankCode:    dest_extra,
    },
    instructionAddress:  withdrawAddress,
    instructionMemo:     withdrawMemo,
    expiresAt:           new Date(Date.now() + 60 * 60 * 1000),
  });

  const interactiveUrl = `${FRONTEND_URL}/sep24/withdraw?transaction_id=${transactionId}&lang=${lang}`;

  logger.info('[sep24] Withdraw initiated', { transactionId, userId, dest });

  return {
    type:        'interactive_customer_info_needed',
    url:         interactiveUrl,
    id:          transactionId,
    instruction: {
      stellar_account: withdrawAddress,
      memo_type:       'text',
      memo:            withdrawMemo,
    },
  };
}

// ─── GET /transactions ────────────────────────────────────────────────────────

/**
 * Lista transacciones SEP-24 del usuario.
 */
export async function listTransactions({ user, query }) {
  const {
    asset_code,
    no_older_than,
    limit = 10,
    kind,
    paging_id,
  } = query;

  const filter = {
    userId:    user._id,
    sep24Type: { $exists: true, $ne: null },
  };

  if (kind) {
    filter.sep24Type = kind;
  }
  if (no_older_than) {
    filter.createdAt = { $gte: new Date(no_older_than) };
  }
  if (paging_id) {
    filter.alytoTransactionId = { $lt: paging_id };
  }

  const txs = await Transaction.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .lean();

  return {
    transactions: txs.map(buildSep24TransactionObject),
  };
}

// ─── GET /transaction ─────────────────────────────────────────────────────────

/**
 * Retorna una transacción SEP-24 por id, stellar_transaction_id o external_transaction_id.
 * Scoped al usuario autenticado (SEP-10) — sin userId no hay acceso (IDOR audit 2026-06-11).
 */
export async function getTransaction({ query, user }) {
  if (!user?._id) {
    throw Object.assign(new Error('SEP-24 requiere una cuenta Alyto vinculada'), { status: 401 });
  }
  const { id, stellar_transaction_id, external_transaction_id } = query;

  const filter = { userId: user._id };
  if (id)                          filter.alytoTransactionId    = id;
  else if (stellar_transaction_id) filter.stellarTxId           = stellar_transaction_id;
  else if (external_transaction_id) filter.externalTransactionId = external_transaction_id;
  else throw Object.assign(new Error('id, stellar_transaction_id or external_transaction_id required'), { status: 400 });

  const tx = await Transaction.findOne(filter).lean();
  if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });

  return { transaction: buildSep24TransactionObject(tx) };
}

// ─── GET /fee ─────────────────────────────────────────────────────────────────

export async function getFee({ query }) {
  const { asset_code, operation, amount } = query;

  if (asset_code !== 'USDC') {
    return { fee: '0' };
  }

  // Misma fuente que `/info`: ambos derivan de `resolveWithdrawFeePercent`, así que
  // no pueden divergir. La conversión de unidad ocurre en un solo lugar.
  const feePercent = operation === 'withdraw' ? await resolveWithdrawFeePercent() : 0;
  const fee = computeFee({ amount: parseFloat(amount), feePercent }).toFixed(2);

  return { fee };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEP24_STATUS_MAP = {
  sep24_deposit_pending:  'pending_user_transfer_start',
  sep24_withdraw_pending: 'pending_user_transfer_start',
  payin_pending:          'pending_external',
  payin_confirmed:        'pending_anchor',
  processing:             'pending_anchor',
  payout_sent:            'pending_external',
  completed:              'completed',
  failed:                 'error',
};

function buildSep24TransactionObject(tx) {
  return {
    id:                          tx.alytoTransactionId,
    kind:                        tx.sep24Type ?? 'deposit',
    status:                      SEP24_STATUS_MAP[tx.status] ?? 'pending_anchor',
    status_eta:                  null,
    more_info_url:               `${FRONTEND_URL}/transactions/${tx.alytoTransactionId}`,
    amount_in:                   tx.originalAmount?.toString() ?? null,
    amount_in_asset:             'stellar:USDC:' + ASSETS.USDC.getIssuer(),
    amount_out:                  tx.destinationAmount?.toString() ?? null,
    amount_out_asset:            tx.destinationCurrency,
    amount_fee:                  tx.fees?.totalDeducted?.toString() ?? '0',
    amount_fee_asset:            'USD',
    started_at:                  tx.createdAt?.toISOString(),
    completed_at:                tx.status === 'completed' ? tx.updatedAt?.toISOString() : null,
    stellar_transaction_id:      tx.stellarTxId ?? null,
    external_transaction_id:     tx.externalTransactionId ?? null,
    message:                     tx.statusMessage ?? null,
    to:                          tx.instructionAddress ?? null,
    from:                        null,
    deposit_memo:                tx.sep24Type === 'deposit' ? tx.instructionMemo : null,
    deposit_memo_type:           tx.sep24Type === 'deposit' ? 'text' : null,
    withdraw_anchor_account:     tx.sep24Type === 'withdraw' ? tx.instructionAddress : null,
    withdraw_memo:               tx.sep24Type === 'withdraw' ? tx.instructionMemo : null,
    withdraw_memo_type:          tx.sep24Type === 'withdraw' ? 'text' : null,
    refunds:                     null,
  };
}
