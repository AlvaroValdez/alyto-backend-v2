/**
 * AccessLog.js — Registro de accesos e intentos de acceso a la plataforma.
 *
 * Cumple el Artículo 2°, inciso d, Sección 4 del Reglamento para Empresas de
 * Tecnología Financiera: "Mantener registros de los accesos, intentos de acceso
 * y actividades realizadas".
 *
 * Antes de esto sólo existía `User.lastLoginAt`, que se SOBREESCRIBE en cada
 * ingreso: no había historial, no quedaba rastro de los intentos fallidos y era
 * imposible detectar un ataque por fuerza bruta después del hecho. Es decir, la
 * capacidad que la norma enumera no existía.
 *
 * Las tres partes del inciso d se cubren así:
 *   accesos              → este registro, outcome 'success'
 *   intentos de acceso   → este registro, outcome 'failed' | 'blocked'
 *   actividades          → AdminAuditLog (acciones de administración) y
 *                          WalletTransaction (movimientos de saldo)
 *
 * ⚠️ APPEND-ONLY: mismo criterio que AdminAuditLog. Un registro de acceso que se
 * puede editar no sirve como evidencia.
 *
 * ⚠️ Sobre el correo: se conserva el identificador que la persona escribió,
 * incluso cuando no corresponde a ninguna cuenta. Es necesario — sin él no se
 * puede investigar un intento contra una cuenta inexistente ni distinguir un
 * error de tipeo de un barrido de credenciales. Se normaliza a minúsculas y no
 * se guarda ningún otro dato personal.
 */

import mongoose from 'mongoose'

const accessLogSchema = new mongoose.Schema(
  {
    /** Usuario resuelto. Null cuando el intento no corresponde a una cuenta. */
    userId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'User',
      default: null,
      index: true,
    },

    /** Identificador intentado, normalizado. Se conserva aunque no exista la cuenta. */
    email: { type: String, trim: true, lowercase: true, index: true },

    /**
     * Resultado del intento.
     *   success     — acceso concedido: la sesión SE EMITIÓ
     *   pending_2fa — primer factor válido, sesión NO emitida a la espera del segundo
     *   failed      — credenciales inválidas, cuenta inexistente o suspendida
     *   blocked     — rechazado por bloqueo temporal tras intentos fallidos
     *
     * `pending_2fa` existe porque, con segundo factor exigido, validar la
     * contraseña dejó de ser un acceso. Anotarlo como 'success' afirmaría que se
     * entró cuando no se entró; anotarlo como 'failed' ocultaría que la
     * contraseña sí era correcta, que es justo el dato que interesa al
     * investigar una credencial sustraída.
     */
    outcome: {
      type:     String,
      enum:     ['success', 'pending_2fa', 'failed', 'blocked'],
      required: true,
      index:    true,
    },

    /**
     * Factor que produjo el asiento. Separa, dentro de una misma cuenta, lo que
     * ocurrió en el punto de contraseña de lo que ocurrió en el de segundo
     * factor. Los registros anteriores a su incorporación lo tienen en null, que
     * se lee como 'password'.
     */
    factor: {
      type:    String,
      enum:    ['password', 'totp', 'recovery_code', null],
      default: null,
      index:   true,
    },

    /**
     * Motivo, sólo para outcome distinto de 'success'. Nunca se devuelve al
     * cliente: la respuesta de login es genérica a propósito, para no revelar
     * si una cuenta existe. Esta precisión es para el operador, no para quien
     * intenta entrar.
     *
     * Los cuatro últimos corresponden al segundo factor:
     *   totp_invalid       — código que no coincide con ningún paso de la ventana
     *   totp_replayed      — código correcto pero ya consumido durante su vigencia
     *   totp_not_enrolled  — cuenta con privilegios sin segundo factor configurado
     *   recovery_invalid   — código de recuperación inexistente o ya gastado
     */
    reason: {
      type: String,
      enum: [
        'bad_password', 'user_not_found', 'account_inactive', 'locked_out',
        'totp_invalid', 'totp_replayed', 'totp_not_enrolled', 'recovery_invalid',
        null,
      ],
      default: null,
    },

    /** Rol al momento del acceso. Permite aislar los ingresos con privilegios. */
    role: { type: String, default: null },

    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },

    /** Intentos fallidos acumulados tras este evento. Útil para reconstruir una racha. */
    failedStreak: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'accesslogs' },
)

// Consultas habituales: historial de una cuenta, y barridos por franja horaria.
accessLogSchema.index({ userId: 1, createdAt: -1 })
accessLogSchema.index({ outcome: 1, createdAt: -1 })
accessLogSchema.index({ email: 1, createdAt: -1 })

const APPEND_ONLY = new Error(
  'AccessLog es append-only: no se puede modificar ni eliminar un registro de acceso.',
)
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
                  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace']) {
  accessLogSchema.pre(op, function () { throw APPEND_ONLY })
}
accessLogSchema.pre('save', function () {
  if (!this.isNew) throw APPEND_ONLY
})

export default mongoose.model('AccessLog', accessLogSchema)
