/**
 * ProviderReference.js — Alias corto hacia un proveedor externo, y su vuelta.
 *
 * Existe porque nuestros identificadores no entran en los campos del proveedor.
 * El `transaccionId` de Red Enlace admite **14 caracteres**; un `wtxId` tiene 24
 * y un `alytoTransactionId` más todavía. Truncar sería peor que no hacer nada:
 * dos retiros distintos podrían colapsar en el mismo identificador ante el banco.
 *
 * Guarda las dos direcciones del mapeo:
 *   - `reference`         → el alias corto que le mandamos al proveedor
 *   - `externalReference` → el identificador que el proveedor nos devuelve
 *
 * La segunda no es un lujo. El webhook de cobro de Red Enlace **no incluye
 * nuestra referencia**: solo llega la de ATC. Sin este registro, un pago entra
 * sin forma de atribuirlo a un usuario.
 *
 * En el cobro por QR ese rol ya lo cumple `Transaction.bankQr.qrId`, donde se
 * guarda el `numeroReferencia` de ATC. Este modelo es para los flujos que NO
 * tienen ese campo, empezando por la dispersión.
 */

import mongoose from 'mongoose';

const providerReferenceSchema = new mongoose.Schema({
  /** Proveedor destinatario del alias. Ej: 'redenlace'. */
  provider: { type: String, required: true },

  /** Qué dirección tiene el dinero. Determina el bloque de numeración. */
  kind: { type: String, required: true, enum: ['payin', 'payout'] },

  /** Alias corto emitido por nosotros. Único global. */
  reference: { type: String, required: true, unique: true },

  /** Identificador que devolvió el proveedor. Se completa después de la llamada. */
  externalReference: { type: String, default: null },

  /** A qué apunta el alias, para poder volver sin adivinar la colección. */
  targetModel: { type: String, required: true, enum: ['Transaction', 'WalletTransaction'] },
  targetId:    { type: String, required: true },

  /**
   * Importe y moneda al momento de emitir. Se guardan para poder contrastar
   * contra lo que informe el proveedor antes de mover saldo: es el mismo control
   * de importe que ya hace la conciliación de bankQr.
   */
  amount:   { type: Number },
  currency: { type: String },

  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'provider_references' });

/**
 * Un solo alias por retiro. Parcial a propósito: en el cobro sí puede haber
 * varios (un QR que expira y se regenera emite una referencia nueva), pero
 * emitir dos alias para el mismo retiro sería pedirle al banco que pague dos veces.
 */
providerReferenceSchema.index(
  { provider: 1, kind: 1, targetModel: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { kind: 'payout' } },
);

/** Vuelta desde lo que informa el proveedor. Único: dos destinos sería ambiguo. */
providerReferenceSchema.index(
  { provider: 1, externalReference: 1 },
  { unique: true, partialFilterExpression: { externalReference: { $type: 'string' } } },
);

export default mongoose.model('ProviderReference', providerReferenceSchema);
