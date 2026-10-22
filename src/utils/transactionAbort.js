/**
 * transactionAbort.js — Abortar una transacción a propósito, sin que parezca un error.
 *
 * ## Por qué hace falta
 *
 * `session.withTransaction()` reintenta los fallos transitorios de MongoDB
 * (conflictos de escritura, cambios de catálogo, un primario que rota) en vez de
 * perder la operación. Es lo que recomienda el driver y lo que queremos cuando el
 * dinero ya se movió del lado del banco.
 *
 * Pero cambia una regla con respecto al `startTransaction()` manual:
 *
 *   - manual:  para abortar se llama `abortTransaction()` y se retorna.
 *   - withTransaction: **retornar hace commit**. Para abortar hay que LANZAR.
 *
 * Esa diferencia es la trampa del cambio. Un `return` que antes descartaba las
 * escrituras ahora las confirma, y el síntoma sería plata acreditada en un camino
 * escrito justamente para no acreditarla.
 *
 * ## Qué resuelve esta clase
 *
 * Distingue "decidí cortar acá" de "algo salió mal":
 *
 *   - no se reintenta, porque no es transitorio;
 *   - no se reporta a Sentry, porque no es un incidente;
 *   - lleva un `code` para que el llamador responda sin leer mensajes.
 *
 * Uso:
 *
 *     await session.withTransaction(async () => {
 *       const claim = await Model.updateOne(..., { session })
 *       if (claim.modifiedCount === 0) throw new AbortoDeliberado('race', 'otro lo tomó')
 *     })
 *     // afuera:
 *     catch (err) { if (err instanceof AbortoDeliberado) return fail(err.code, err.reason) }
 */

export class AbortoDeliberado extends Error {
  /**
   * @param {string} code     — identificador estable para decidir la respuesta.
   * @param {string} [reason]  — explicación; por omisión, el propio código.
   * @param {object} [payload] — valor exacto a devolver, para los casos en que el
   *   `ok` no se deduce del código. En `settleDispatchedWithdrawal`, por ejemplo,
   *   'already-settled' y 'race' son resultados correctos (`ok: true`) mientras
   *   'not-found' y 'bad-status' son fallas: sin esto, los cuatro colapsarían en
   *   la misma respuesta y un webhook repetido pasaría por error.
   */
  constructor(code, reason = code, payload = undefined) {
    super(reason);
    this.name    = 'AbortoDeliberado';
    this.code    = code;
    this.reason  = reason;
    this.payload = payload;
  }
}

export default AbortoDeliberado;
