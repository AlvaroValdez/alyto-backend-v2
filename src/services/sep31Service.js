/**
 * sep31Service.js — SEP-31 Cross-Border Payments
 *
 * Expone los corredores Alyto como un endpoint estándar SEP-31.
 * Permite que sending anchors externos inicien pagos cross-border
 * a través de Alyto como receiving anchor.
 *
 * Spec: https://stellar.org/protocol/sep-31
 *
 * Flujo SEP-31:
 *   1. GET  /info          — qué pares soporta Alyto como receiving anchor
 *   2. POST /transactions  — crear transacción cross-border (sending anchor → Alyto)
 *   3. GET  /transactions/:id — estado de la transacción
 *   4. PATCH /transactions/:id — callback cuando el sending anchor envía el USDC
 *
 * Arquitectura: Alyto actúa como RECEIVING ANCHOR.
 *   Sending anchor envía USDC → Alyto → payout local vía Vita/Harbor
 */

import TransactionConfig from '../models/TransactionConfig.js';
import Transaction       from '../models/Transaction.js';
import { calculateQuote } from './quoteCalculator.js';
import { logger }         from '../utils/logger.js';
import { ASSETS }         from '../config/stellar.js';

const randomId = () => Math.random().toString(36).substring(2, 10).toUpperCase();
import ExchangeRate       from '../models/ExchangeRate.js';

// ─── GET /info ────────────────────────────────────────────────────────────────

/**
 * Retorna los activos y corredores disponibles como receiving anchor.
 * Formato SEP-31 /info.
 */
export async function getInfo() {
  const corridors = await TransactionConfig.find({ isActive: true })
    .select('corridorId originCountry destinationCountry originCurrency destinationCurrency payoutMethod legalEntity minAmountUSD maxAmountUSD')
    .lean();

  // SEP-31: el receive_asset es siempre USDC (lo que recibe el anchor)
  // El send_asset es lo que el sending anchor envía (también USDC en Stellar)
  const receiveAssets = {
    USDC: {
      enabled:        true,
      min_amount:     10,
      max_amount:     9998,
      sep12: {
        sender: {
          types: {
            'sep12-sender': {
              description: 'Cuenta del remitente verificada con SEP-12 KYC',
            },
          },
        },
        receiver: {
          types: {
            'sep12-receiver': {
              description: 'Cuenta del beneficiario verificada con SEP-12 KYC',
            },
          },
        },
      },
      fields: {
        transaction: {
          receiver_routing_number: {
            description: 'Número de cuenta bancaria del beneficiario',
            optional: true,
          },
          receiver_account_number: {
            description: 'Cuenta bancaria destino',
            optional: true,
          },
          type: {
            description: 'Tipo de transferencia (bank_transfer, mobile_money)',
            choices: ['bank_transfer'],
          },
          corridor_id: {
            description: 'ID del corredor Alyto (ej: bo-ar, bo-us). Ver /corridors para la lista.',
            optional: false,
          },
        },
      },
    },
  };

  return {
    receive: receiveAssets,
    corridors: corridors.map(c => ({
      id:                   c.corridorId,
      origin_country:       c.originCountry,
      destination_country:  c.destinationCountry,
      origin_currency:      c.originCurrency,
      destination_currency: c.destinationCurrency,
      payout_method:        c.payoutMethod,
      min_amount_usd:       c.minAmountUSD ?? 10,
      max_amount_usd:       c.maxAmountUSD ?? 9998,
      legal_entity:         c.legalEntity,
    })),
  };
}

// ─── POST /transactions ───────────────────────────────────────────────────────

/**
 * Crea una transacción SEP-31 como receiving anchor.
 *
 * El sending anchor:
 *   1. Llama a este endpoint con los datos del pago
 *   2. Recibe la instrucción de a dónde enviar el USDC (instruction_address)
 *   3. Envía el USDC a esa dirección via Stellar
 *   4. Alyto detecta el USDC entrante y ejecuta el payout local
 *
 * @param {object} body   - { amount, asset_code, asset_issuer, fields, sender_id, receiver_id, lang }
 * @param {object} user   - req.user del token SEP-10
 */
export async function createTransaction({ body, user }) {
  const {
    amount,
    asset_code,
    asset_issuer,
    fields = {},
    sender_id,
    receiver_id,
    lang = 'es',
  } = body;

  // Validar asset
  if (asset_code !== 'USDC') {
    throw Object.assign(new Error(`Asset ${asset_code} not supported. Only USDC accepted.`), { status: 400 });
  }

  const corridorId = fields.transaction?.corridor_id;
  if (!corridorId) {
    throw Object.assign(new Error('fields.transaction.corridor_id is required'), { status: 400 });
  }

  // Buscar corredor
  const corridor = await TransactionConfig.findOne({ corridorId, isActive: true }).lean();
  if (!corridor) {
    throw Object.assign(new Error(`Corridor ${corridorId} not found or inactive`), { status: 400 });
  }

  const usdAmount = parseFloat(amount);
  if (isNaN(usdAmount) || usdAmount < (corridor.minAmountUSD ?? 10)) {
    throw Object.assign(
      new Error(`Minimum amount is ${corridor.minAmountUSD ?? 10} USD for corridor ${corridorId}`),
      { status: 400 },
    );
  }

  // Calcular quote usando la firma canónica de quoteCalculator
  const rateDoc   = await ExchangeRate.findOne({ pair: 'BOB/USDT' }).lean();
  const bobPerUsdc = rateDoc?.rate ?? parseFloat(process.env.BOB_USD_RATE) ?? 9.31;

  const quote = calculateQuote({
    amount:      usdAmount,
    corridor,
    bobPerUsdc,
    accountType: 'personal',
  });

  // ID de transacción Alyto
  const legalEntity   = corridor.legalEntity ?? 'SRL';
  const prefix        = { SRL: 'C', SpA: 'B', LLC: 'A' }[legalEntity] ?? 'C';
  const transactionId = `ALY-${prefix}-${Date.now()}-${randomId()}`;

  // Dirección de depósito USDC (cuenta Stellar SRL donde el anchor envía el USDC)
  const instructionAddress = process.env.STELLAR_SRL_PUBLIC_KEY;
  const instructionMemo    = transactionId;

  if (!user._id) {
    throw Object.assign(new Error('SEP-31 requiere una cuenta Alyto vinculada (sending anchor sin userId)'), { status: 400 });
  }

  // Crear Transaction en MongoDB (campos conformes al schema Transaction)
  const tx = await Transaction.create({
    alytoTransactionId:  transactionId,
    userId:              user._id,
    legalEntity,
    operationType:       'crossBorderPayment',
    routingScenario:     prefix,                  // C=SRL, B=SpA, A=LLC
    corridorCode:        corridorId,
    status:              'sep31_waiting',
    originCountry:       corridor.originCountry,
    destinationCountry:  corridor.destinationCountry,
    originalAmount:      usdAmount,
    originCurrency:      'USD',
    destinationAmount:   quote.destinationAmount,
    destinationCurrency: corridor.destinationCurrency,
    digitalAsset:        'USDC',
    digitalAssetAmount:  usdAmount,
    sep31Fields:         fields,
    senderId:            sender_id,
    receiverId:          receiver_id,
    instructionAddress,
    instructionMemo,
    expiresAt:           new Date(Date.now() + 60 * 60 * 1000), // 1 hora
  });

  logger.info('[sep31] Transaction created', {
    transactionId,
    corridorId,
    amount: usdAmount,
    instructionAddress,
  });

  return {
    id:                   transactionId,
    stellar_account_id:   instructionAddress,
    stellar_memo_type:    'text',
    stellar_memo:         instructionMemo,
    expires_at:           tx.expiresAt.toISOString(),
    fee_total:            quote.totalDeducted?.toString() ?? '0',
    amount_in:            amount,
    amount_in_asset:      `stellar:USDC:${ASSETS.USDC.getIssuer()}`,
    amount_out:           quote.destinationAmount?.toString(),
    amount_out_asset:     corridor.destinationCurrency,
  };
}

// ─── GET /transactions/:id ────────────────────────────────────────────────────

/**
 * Retorna el estado de una transacción SEP-31 en formato estándar.
 */
export async function getTransaction({ transactionId }) {
  const tx = await Transaction.findOne({ alytoTransactionId: transactionId }).lean();

  if (!tx) {
    throw Object.assign(new Error('Transaction not found'), { status: 404 });
  }

  return {
    transaction: buildSep31TransactionObject(tx),
  };
}

// ─── PATCH /transactions/:id ──────────────────────────────────────────────────

/**
 * Actualización del estado por el sending anchor (callback).
 * Principalmente para recibir info cuando el USDC ha sido enviado.
 */
export async function patchTransaction({ transactionId, body }) {
  const tx = await Transaction.findOne({ alytoTransactionId: transactionId });
  if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });

  if (body.status) {
    tx.status = body.status === 'pending_external' ? 'payin_pending' : tx.status;
  }
  if (body.fields) {
    tx.sep31Fields = { ...tx.sep31Fields, ...body.fields };
  }

  await tx.save();
  logger.info('[sep31] Transaction patched', { transactionId, body });

  return { transaction: buildSep31TransactionObject(tx.toObject()) };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_MAP = {
  sep31_waiting:    'pending_sender',
  payin_pending:    'pending_external',
  payin_confirmed:  'pending_receiver',
  processing:       'pending_receiver',
  payout_sent:      'pending_external',
  completed:        'completed',
  failed:           'error',
  cancelled:        'refunded',
};

function buildSep31TransactionObject(tx) {
  return {
    id:                  tx.alytoTransactionId,
    status:              STATUS_MAP[tx.status] ?? 'pending_sender',
    status_eta:          null,
    amount_in:           tx.originalAmount?.toString(),
    amount_in_asset:     'USDC',
    amount_out:          tx.destinationAmount?.toString(),
    amount_out_asset:    tx.destinationCurrency,
    amount_fee:          tx.fees?.totalDeducted?.toString() ?? '0',
    amount_fee_asset:    tx.originCurrency ?? 'USD',
    stellar_account_id:  tx.instructionAddress,
    stellar_memo:        tx.instructionMemo,
    stellar_memo_type:   'text',
    started_at:          tx.createdAt?.toISOString(),
    completed_at:        tx.status === 'completed' ? tx.updatedAt?.toISOString() : null,
    stellar_transaction_id: tx.stellarTxId ?? null,
    external_transaction_id: tx.externalTransactionId ?? null,
    message:             tx.statusMessage ?? null,
    refunds:             null,
  };
}
