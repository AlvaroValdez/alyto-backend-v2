/**
 * providerReference.js — Emisión de alias cortos para proveedores externos.
 *
 * El problema concreto: Red Enlace acepta 14 caracteres en `transaccionId` y
 * nuestros identificadores no entran. Truncarlos haría colisionar retiros
 * distintos bajo un mismo identificador ante el banco.
 *
 * ## Formato
 *
 *     {dígito de bloque}{9 dígitos de secuencia}   →  10 caracteres, solo dígitos
 *
 *     1000000001  primer retiro
 *     2000000001  primer cobro
 *
 * Tres razones para este formato y no para un base36 más corto:
 *
 *   1. **Solo dígitos.** La documentación de ATC declara estos campos como
 *      String, pero sus propios ejemplos mandan números sin comillas
 *      (`"numeroReferencia": 2320`). Si su backend los coerciona a entero, un
 *      alias alfanumérico se rompe y un alias numérico sobrevive.
 *   2. **10 caracteres.** Es el más chico de todos los límites del catálogo
 *      (el `numeroReferencia` del QR Binance admite máximo 10), así que un solo
 *      formato sirve para todos los productos sin excepciones por endpoint.
 *   3. **Primer dígito distinto de cero.** Si el proveedor lo convierte a
 *      número y lo devuelve, no perdemos ceros a la izquierda.
 *
 * La secuencia vive en el mismo `Counter` atómico que ya numera los
 * comprobantes. No reinicia por período: un alias repetido ante el banco sería
 * ambiguo aunque los separen meses.
 *
 * ## Desplazamiento inicial
 *
 * Un contador que arranca en 1 le cuenta al proveedor cuántas operaciones
 * llevamos: ver la referencia `2000000042` es saber que vamos por el cobro 42.
 * Para evitarlo, la primera vez que se usa una serie se le asigna un `base`
 * aleatorio que se suma a la secuencia.
 *
 * El `base` se sortea **una sola vez** y queda guardado en el propio contador,
 * no en una variable de entorno. Es deliberado: una constante en el código no
 * serviría de nada (el repositorio es público y bastaría restarla), y una
 * variable de entorno se puede bajar por accidente, lo que haría que la serie
 * vuelva sobre identificadores ya emitidos.
 *
 * `seq` sigue siendo la cuenta honesta para nosotros. Lo que se desplaza es
 * únicamente lo que ve el proveedor.
 */

import crypto            from 'node:crypto';
import Counter           from '../../models/Counter.js';
import ProviderReference from '../../models/ProviderReference.js';
import { logger }        from '../../utils/logger.js';

/** Bloque de numeración por dirección del dinero. */
const KIND_BLOCK = { payout: 1, payin: 2 };

/** 9 dígitos de secuencia por bloque. */
const BLOCK_SIZE = 1_000_000_000;

/**
 * Rango del desplazamiento inicial. El techo deja al menos 5×10⁸ identificadores
 * por serie, que a cualquier volumen imaginable no se agotan. El piso evita
 * sortear un número tan chico que el desplazamiento no disimule nada.
 */
const BASE_MIN = 100_000_000;
const BASE_MAX = 500_000_000;

const randomBase = () => BASE_MIN + crypto.randomInt(BASE_MAX - BASE_MIN);

/**
 * Siguiente número de la secuencia, atómico y a prueba de multi-instancia.
 * @param {'payin'|'payout'} kind
 * @param {string} provider
 * @returns {Promise<string>} 10 dígitos
 */
async function nextReference(provider, kind) {
  const block = KIND_BLOCK[kind];
  if (!block) throw new Error(`providerReference: kind inválido '${kind}'`);

  // `$setOnInsert` sortea el desplazamiento solo al crear la serie. No puede
  // ir sobre `seq` (MongoDB rechaza $inc y $setOnInsert sobre el mismo campo),
  // y separarlos además deja `seq` como la cuenta real para nosotros.
  const doc = await Counter.findOneAndUpdate(
    { _id: `PREF-${provider}-${kind}` },
    { $inc: { seq: 1 }, $setOnInsert: { base: randomBase() } },
    { upsert: true, returnDocument: 'after' },
  );

  // `?? 0` cubre una serie creada antes de que existiera `base`: sin eso, un
  // contador viejo produciría NaN y de ahí una referencia inválida.
  const offset = (doc.base ?? 0) + doc.seq;

  // Agotar el bloque produciría un alias de 11 dígitos que el proveedor
  // truncaría en silencio. Preferimos fallar ruidosamente: con el volumen
  // actual esto no ocurre nunca, y si ocurriera querríamos enterarnos acá y no
  // en una conciliación.
  if (offset >= BLOCK_SIZE) {
    throw new Error(
      `providerReference: bloque '${provider}/${kind}' agotado (base=${doc.base} seq=${doc.seq})`,
    );
  }

  return String(block * BLOCK_SIZE + offset);
}

/**
 * Emite (o recupera) el alias de un objetivo.
 *
 * Para `kind: 'payout'` es idempotente: pedir dos veces el alias del mismo
 * retiro devuelve el mismo valor. Es la garantía que evita mandarle al banco
 * dos identificadores para un único retiro si el dispatch se reintenta.
 *
 * Para `kind: 'payin'` NO lo es, a propósito: un QR que expira y se regenera
 * es un cobro nuevo y merece una referencia nueva.
 *
 * @param {object}  p
 * @param {string}  p.provider     — 'redenlace'
 * @param {'payin'|'payout'} p.kind
 * @param {'Transaction'|'WalletTransaction'} p.targetModel
 * @param {string}  p.targetId     — alytoTransactionId | wtxId
 * @param {number} [p.amount]
 * @param {string} [p.currency]
 * @param {object} [p.meta]
 * @returns {Promise<import('mongoose').Document>}
 */
export async function issueReference({ provider, kind, targetModel, targetId, amount, currency, meta }) {
  if (!provider || !targetId) throw new Error('providerReference: faltan provider o targetId');

  const isPayout = kind === 'payout';
  const query    = { provider, kind, targetModel, targetId };

  if (isPayout) {
    const existing = await ProviderReference.findOne(query);
    if (existing) return existing;
  }

  const reference = await nextReference(provider, kind);

  try {
    const doc = await ProviderReference.create({
      ...query, reference, amount, currency, meta: meta ?? {},
    });
    logger.info('[providerReference] Alias emitido', { provider, kind, reference, targetId });
    return doc;
  } catch (err) {
    // Carrera entre dos dispatch del mismo retiro: el índice parcial único hizo
    // su trabajo. Devolvemos el que ganó. El número que acabamos de consumir
    // queda sin usar; un hueco en la secuencia es inocuo, un doble pago no.
    if (err?.code === 11000 && isPayout) {
      const winner = await ProviderReference.findOne(query);
      if (winner) {
        logger.warn('[providerReference] Carrera resuelta, se reusa el alias existente', {
          provider, kind, targetId, reference: winner.reference,
        });
        return winner;
      }
    }
    throw err;
  }
}

/**
 * Anota el identificador que devolvió el proveedor, para poder volver desde él.
 * @param {string} reference         — nuestro alias
 * @param {string} externalReference — el del proveedor
 */
export async function attachExternalReference(reference, externalReference) {
  if (!externalReference) return null;
  return ProviderReference.findOneAndUpdate(
    { reference },
    { $set: { externalReference: String(externalReference) } },
    { returnDocument: 'after' },
  );
}

/** Vuelta desde el identificador del proveedor (lo que llega en un webhook). */
export async function resolveByExternal(provider, externalReference) {
  if (!externalReference) return null;
  return ProviderReference.findOne({ provider, externalReference: String(externalReference) });
}

/** Vuelta desde nuestro propio alias. */
export async function resolveByReference(reference) {
  if (!reference) return null;
  return ProviderReference.findOne({ reference: String(reference) });
}
