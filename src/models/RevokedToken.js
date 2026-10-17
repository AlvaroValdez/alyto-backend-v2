/**
 * RevokedToken.js — Lista de revocación POR SESIÓN.
 *
 * POR QUÉ EXISTE
 *
 * La revocación se hacía subiendo `User.tokenVersion`, un contador por USUARIO.
 * Eso funciona para lo que debe ser global (cambio de contraseña, suspensión
 * administrativa), pero el cierre de sesión lo usaba también, y el efecto era
 * que cerrar sesión en el teléfono mataba además la del navegador, sin aviso y
 * sin que nadie hubiera decidido eso: era un efecto colateral de usar un
 * contador compartido para revocar una sola sesión.
 *
 * Un tester lo encontró por el otro lado: notó que podía entrar en dos
 * dispositivos a la vez. Lo que no se veía es que cerrar en uno tumbaba el otro.
 *
 * CÓMO FUNCIONA
 *
 * Cada token lleva ahora un `jti` único. Al cerrar sesión se anota ESE `jti`
 * aquí y el resto de sesiones del usuario siguen vivas. El índice TTL sobre
 * `expiresAt` borra el registro cuando el token habría caducado igualmente, así
 * que la colección no crece: solo contiene tokens revocados ANTES de su
 * caducidad natural, que son pocos y efímeros.
 *
 * QUÉ SIGUE SIENDO GLOBAL, Y DEBE SERLO
 *
 *   cambio de contraseña    → `tokenVersion`, mata todas las sesiones
 *   suspensión por admin    → `tokenVersion`, mata todas las sesiones
 *   cierre de sesión normal → este registro, mata SOLO la suya
 *
 * La política de privacidad publicada dice "revocamos todas las sesiones
 * abiertas cuando cambias la contraseña". Ese comportamiento no cambia.
 *
 * TRAZABILIDAD (Art. 2° inc. c y d, Sec. 4, Reglamento ETF)
 *
 * Se guarda `userId` junto al `jti` para poder responder "qué sesiones cerró
 * esta persona y cuándo" sin tener que descifrar tokens.
 */

import mongoose from 'mongoose';

const revokedTokenSchema = new mongoose.Schema(
  {
    /** Identificador único del token (claim `jti` del JWT). */
    jti: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },

    /** Titular del token. Para auditoría; la comprobación va por `jti`. */
    userId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'User',
      index: true,
    },

    /**
     * Momento en que el token habría caducado por sí solo. El índice TTL borra
     * el registro entonces: a partir de ahí el JWT ya no es válido por su propia
     * expiración y mantenerlo en la lista no aporta nada.
     */
    expiresAt: {
      type:     Date,
      required: true,
    },

    /** Por qué se revocó. Hoy sólo 'logout'; se deja abierto para futuros usos. */
    reason: {
      type:    String,
      default: 'logout',
    },
  },
  { timestamps: true, collection: 'revoked_tokens' },
);

// TTL: MongoDB borra el documento cuando se alcanza `expiresAt`.
revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.RevokedToken
  ?? mongoose.model('RevokedToken', revokedTokenSchema);
