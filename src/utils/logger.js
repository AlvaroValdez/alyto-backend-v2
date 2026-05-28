/**
 * logger.js — Logger estructurado Alyto (Winston + CloudWatch)
 *
 * Estrategia de transports:
 *   - Siempre:      Console (stdout) — formato legible en dev, JSON en prod
 *   - Si CW config: CloudWatch Logs — JSON estructurado para análisis en AWS
 *
 * Uso:
 *   import { logger } from '../utils/logger.js';
 *   logger.info('Mensaje', { key: 'value' });
 *   logger.error('Error', { error: err.message, transactionId });
 *   logger.warn('Advertencia', { context });
 *
 * REGLA: NUNCA loguear valores de secretos, private keys, ni tokens JWT.
 * Solo loguear: IDs, estados, montos, países, códigos de error.
 */

import winston from 'winston';

// ─── Configuración ────────────────────────────────────────────────────────────

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';

const CW_LOG_GROUP  = process.env.CLOUDWATCH_LOG_GROUP  ?? '/alyto/backend';
const CW_LOG_STREAM = process.env.CLOUDWATCH_LOG_STREAM ?? `${process.env.NODE_ENV ?? 'development'}`;
const AWS_REGION    = process.env.AWS_REGION            ?? 'us-east-1';

// CloudWatch activo solo si el log group está configurado explícitamente en prod
const CW_ENABLED = IS_PROD && !!process.env.CLOUDWATCH_LOG_GROUP;

// ─── Formato de logs ──────────────────────────────────────────────────────────

// Filtro de seguridad: elimina cualquier campo que parezca un secreto
const sanitizeFields = winston.format((info) => {
  const FORBIDDEN = ['secret', 'privatekey', 'private_key', 'password', 'token', 'seed', 'mnemonic', 'apikey', 'api_key'];
  const sanitized = { ...info };
  for (const key of Object.keys(sanitized)) {
    if (FORBIDDEN.some(f => key.toLowerCase().includes(f))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
});

// Formato producción: JSON estructurado para CloudWatch Insights
const jsonFormat = winston.format.combine(
  sanitizeFields(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Formato desarrollo: legible en terminal con colores
const devFormat = winston.format.combine(
  sanitizeFields(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  }),
);

// ─── Transports ───────────────────────────────────────────────────────────────

const transports = [];

// Console — siempre activo excepto en tests
if (!IS_TEST) {
  transports.push(
    new winston.transports.Console({
      format: IS_PROD ? jsonFormat : devFormat,
    }),
  );
}

// CloudWatch — solo en producción con config explícita
if (CW_ENABLED) {
  try {
    // Import dinámico para no romper si winston-cloudwatch tiene problemas
    const { default: WinstonCloudWatch } = await import('winston-cloudwatch');

    transports.push(
      new WinstonCloudWatch({
        logGroupName:  CW_LOG_GROUP,
        logStreamName: `${CW_LOG_STREAM}-${new Date().toISOString().slice(0, 10)}`,
        awsRegion:     AWS_REGION,
        jsonMessage:   true,
        // Batch para no saturar la API de CW en picos
        uploadRate:    2000,    // flush cada 2s
        messageFormatter: ({ level, message, ...meta }) => JSON.stringify({ level, message, ...meta }),
      }),
    );

    console.info(`[Logger] ✅ CloudWatch Logs activo → ${CW_LOG_GROUP}/${CW_LOG_STREAM}`);
  } catch (err) {
    console.warn(`[Logger] ⚠️  CloudWatch no disponible: ${err.message}. Usando solo console.`);
  }
}

// ─── Instancia del logger ─────────────────────────────────────────────────────

export const logger = winston.createLogger({
  level:      IS_PROD ? 'info' : 'debug',
  transports,
  // No lanzar excepciones si un transport falla — el log no puede tirar el servidor
  exitOnError: false,
});

// ─── Helpers de contexto ──────────────────────────────────────────────────────

/**
 * Logger con contexto de transacción preinyectado.
 * Uso: const txLog = transactionLogger(transaction.alytoTransactionId);
 *      txLog.info('Payout iniciado', { amount, country });
 */
export function transactionLogger(transactionId) {
  return {
    info:  (msg, meta = {}) => logger.info(msg,  { transactionId, ...meta }),
    error: (msg, meta = {}) => logger.error(msg, { transactionId, ...meta }),
    warn:  (msg, meta = {}) => logger.warn(msg,  { transactionId, ...meta }),
    debug: (msg, meta = {}) => logger.debug(msg, { transactionId, ...meta }),
  };
}

/**
 * Logger con contexto de usuario preinyectado.
 * Uso: const userLog = userLogger(req.user._id);
 */
export function userLogger(userId) {
  return {
    info:  (msg, meta = {}) => logger.info(msg,  { userId: String(userId), ...meta }),
    error: (msg, meta = {}) => logger.error(msg, { userId: String(userId), ...meta }),
    warn:  (msg, meta = {}) => logger.warn(msg,  { userId: String(userId), ...meta }),
  };
}

// Log de inicio del logger
if (!IS_TEST) {
  logger.info('[Logger] Inicializado', {
    level:      IS_PROD ? 'info' : 'debug',
    cloudwatch: CW_ENABLED,
    env:        process.env.NODE_ENV ?? 'development',
  });
}

// ─── patchConsole ─────────────────────────────────────────────────────────────
/**
 * Redirige console.* global a través de Winston.
 * Llamar una sola vez en server.js después de inicializar Secrets Manager.
 * Cubre los 59 archivos existentes sin modificarlos individualmente.
 */
export function patchConsole() {
  const fmt = (args) =>
    args
      .map(a =>
        a instanceof Error           ? a.stack :
        typeof a === 'object' && a !== null ? JSON.stringify(a) :
        String(a),
      )
      .join(' ');

  console.log   = (...args) => logger.info(fmt(args));
  console.info  = (...args) => logger.info(fmt(args));
  console.warn  = (...args) => logger.warn(fmt(args));
  console.error = (...args) => logger.error(fmt(args));
  console.debug = (...args) => logger.debug(fmt(args));
}
