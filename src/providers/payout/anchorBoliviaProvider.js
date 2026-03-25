/**
 * anchorBoliviaProvider.js — Off-ramp Escenario C (AV Finance SRL)
 *
 * AV Finance SRL ES el anchor de Bolivia — no usamos Vita para pagos en BOB.
 * Este provider señaliza que el payout queda en estado manual pendiente.
 *
 * La lógica de registro en BD, notificación admin e ipnLog vive en dispatchPayout
 * (ipnController.js) bajo el bloque `if (payoutMethod === 'anchorBolivia')`.
 * Este provider implementa la interfaz del providerRegistry para el orchestrator.
 */
export default {
  id:    'anchorBolivia',
  stage: 'payout',

  /**
   * Registra el payout manual y lo deja en estado pendiente.
   * AV Finance SRL procesa el pago en BOB fuera de cadena.
   * No llama a ninguna API externa — el procesamiento es humano/manual.
   */
  async execute({ amount, destinationCountry, userId, stellarTxid }) {
    console.info('[anchorBoliviaProvider] Payout manual Bolivia encolado.', {
      amount,
      destinationCountry,
      userId,
      stellarTxid,
    });

    // Retornamos estado 'payout_pending' — dispatchPayout actualizará la BD
    // y notificará al admin vía email + ipnLog.
    return {
      status:   'payout_pending',
      provider: 'anchorBolivia',
      message:  'Payout manual Bolivia registrado. AV Finance SRL procesará el pago en BOB.',
    };
  },

  /**
   * El anchor manual siempre está disponible (procesamiento humano).
   */
  async healthCheck() {
    return true;
  },
};
