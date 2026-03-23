/**
 * server.js — Entry Point de Alyto Backend V2.0
 *
 * Responsabilidades:
 *  1. Configurar Express (CORS, JSON, seguridad básica)
 *  2. Conectar Mongoose a MongoDB
 *  3. Registrar rutas base
 *  4. Exponer healthcheck para load balancers y monitoreo
 */

// ⚠️  Sentry debe inicializarse ANTES que cualquier otro módulo
import './services/sentry.js';
import * as Sentry from '@sentry/node';

import 'dotenv/config';
import { checkEnv }  from '../scripts/checkEnv.js';
import express        from 'express';
import cors           from 'cors';
import helmet         from 'helmet';
import { generalLimiter, paymentsLimiter } from './config/rateLimiters.js';
import compression    from 'compression';
import mongoose       from 'mongoose';
import authRoutes          from './routes/authRoutes.js';
import paymentRoutes       from './routes/paymentRoutes.js';
import payoutRoutes        from './routes/payoutRoutes.js';
import institutionalRoutes from './routes/institutionalRoutes.js';
import userRoutes          from './routes/userRoutes.js';
import identityRoutes      from './routes/identityRoutes.js';
import adminRoutes         from './routes/adminRoutes.js';
import regionalRoutes      from './routes/regionalRoutes.js';
import ipnRoutes           from './routes/ipn.js';
import dashboardRoutes     from './routes/dashboardRoutes.js';
import kycRoutes           from './routes/kycRoutes.js';
import { sentryContext }   from './middlewares/sentryContext.js';
import { handleStripeWebhook }     from './webhooks/stripeWebhook.js';
import { createQuoteSocketServer }  from './services/quoteSocket.js';
import User        from './models/User.js';
import Transaction from './models/Transaction.js';

// ─── Configuración ───────────────────────────────────────────────────────────

const PORT        = process.env.PORT        ?? 3000;
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/alyto-v2';

// JWT_SECRET es obligatorio en producción — fail fast para evitar tokens inseguros
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[Alyto Server] FATAL: JWT_SECRET no definido en producción. Abortando.');
  process.exit(1);
}
// En desarrollo se asigna un valor por defecto para facilitar el onboarding local
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'alyto_dev_jwt_secret_change_in_production';
  console.warn('[Alyto Server] ⚠️  JWT_SECRET no configurado — usando valor de desarrollo. NO usar en producción.');
}

// ─── Verificación de variables de entorno ────────────────────────────────────
// En producción, aborta el proceso si faltan variables críticas.
// En desarrollo, emite warnings y continúa.
checkEnv({ fatal: process.env.NODE_ENV === 'production' });

// Rate limiters importados desde src/config/rateLimiters.js
// La configuración es consciente del entorno: solo aplica en producción.

// ─── App Express ─────────────────────────────────────────────────────────────

const app = express();

// Trust proxy — necesario para que express-rate-limit y otros middlewares
// lean la IP real del cliente cuando el servidor corre detrás de un proxy
// (Render, Nginx, AWS ALB). En desarrollo local no hay proxy, el valor '1'
// es seguro porque solo confía en el primer proxy de la cadena.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Helmet — headers de seguridad HTTP (CSP, HSTS, X-Frame-Options, etc.)
// Debe ir ANTES de CORS para que los headers de seguridad se apliquen a toda respuesta.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   [
        "'self'",
        "'unsafe-inline'",
        'https://js.fintoc.com',
        'https://wizard.fintoc.com',
        'https://js.stripe.com',
        'https://cdn.jsdelivr.net',
      ],
      frameSrc:    [
        "'self'",
        'https://wizard.fintoc.com',
        'https://widget.fintoc.com',
        'https://js.stripe.com',
      ],
      frameAncestors: [
        "'self'",
        'https://alyto-frontend-v2.onrender.com',
      ],
      connectSrc:  [
        "'self'",
        'https://api.fintoc.com',
        'https://wizard.fintoc.com',
        'https://widget.fintoc.com',
        'https://api.stripe.com',
        'wss://192.168.1.94:3000',
        'ws://192.168.1.94:3000',
        'https://*.ngrok-free.app',
        'wss://*.ngrok-free.app',
      ],
      imgSrc:      ["'self'", 'data:', 'https:'],
      styleSrc:    ["'self'", "'unsafe-inline'"],
    },
  },
}));

// Compression — reduce el tamaño de las respuestas JSON/text (gzip/br)
app.use(compression());

// CORS — en producción usar ALLOWED_ORIGINS (comma-separated).
// Fallback a CORS_ORIGIN para retrocompatibilidad con entornos existentes.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : (process.env.CORS_ORIGIN ?? '*');

app.use(cors({
  origin:      allowedOrigins,
  credentials: true,
}));

// Rate limiting general — protege todas las rutas contra DDoS/brute-force
app.use(generalLimiter);

// ⚠️  WEBHOOK: debe registrarse ANTES de express.json() para recibir body raw
// Stripe requiere el cuerpo sin parsear para verificar la firma HMAC
app.post(
  '/api/v1/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook,
);

// Parseo de JSON con límite de payload
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging — registra método, ruta y latencia de cada petición
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} +${ms}ms`);
  });
  next();
});

// Sentry: enriquece cada request con tags de transacción y corridorId
app.use(sentryContext);

// ─── Rutas de Redirect Fintoc ────────────────────────────────────────────────
// Deben registrarse ANTES que cualquier ruta /api/v1 y ANTES del catch-all 404.
// Fintoc redirige al usuario aquí tras completar o cancelar el pago en el widget.

app.get('/success', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://alyto-frontend-v2.onrender.com';
  return res.redirect(302, `${frontendUrl}/payment-success`);
});

app.get('/cancel', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://alyto-frontend-v2.onrender.com';
  return res.redirect(302, `${frontendUrl}/send`);
});

// ─── Rutas Base ──────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Healthcheck para load balancers, uptime monitors y CI/CD pipelines.
 * Retorna estado del servidor y de la conexión a MongoDB.
 */
app.get('/api/health', (req, res) => {
  const mongoStatus = mongoose.connection.readyState;
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const mongoStates = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

  const isHealthy = mongoStatus === 1;

  res.status(isHealthy ? 200 : 503).json({
    status:    isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version:   '2.0.0',
    services: {
      mongodb: {
        status: mongoStates[mongoStatus] ?? 'unknown',
      },
      stellar: {
        network: process.env.STELLAR_NETWORK ?? 'testnet',
      },
    },
  });
});

// ─── Rutas de la API ─────────────────────────────────────────────────────────

// Alias versionado del healthcheck (para Render y load balancers que prefieren /api/v1/)
app.get('/api/v1/health', (req, res) => res.redirect(307, '/api/health'));

app.use('/api/v1/auth',          authRoutes);        // limiters por ruta en authRoutes.js
app.use('/api/v1/dashboard',     dashboardRoutes);
app.use('/api/v1/payments',      paymentsLimiter, paymentRoutes);
app.use('/api/v1/payouts',       payoutRoutes);
app.use('/api/v1/institutional', institutionalRoutes);
app.use('/api/v1/user',          userRoutes);
app.use('/api/v1/identity',      identityRoutes);
app.use('/api/v1/admin',         adminRoutes);
app.use('/api/v1/regional',      regionalRoutes);
app.use('/api/v1/ipn',           ipnRoutes);
app.use('/api/v1/kyc',           kycRoutes);

// ─── Rutas de Desarrollo (solo disponibles fuera de producción) ──────────────

if (process.env.NODE_ENV !== 'production') {
  /**
   * GET /api/v1/dev/test-user
   * Devuelve el ID del usuario de prueba sembrado al arrancar.
   * El frontend lo usa como userId en el flujo de payin.
   */
  app.get('/api/v1/dev/test-user', async (req, res) => {
    const user = await User.findOne({ email: 'dev@alyto.test' }).lean();
    if (!user) return res.status(404).json({ error: 'Usuario dev no encontrado.' });
    res.json({ userId: user._id.toString(), email: user.email, legalEntity: user.legalEntity });
  });

  /**
   * GET /api/v1/dev/srl-transactions
   * Devuelve las transacciones SRL in_transit sembradas al arrancar.
   * El frontend las usa para poblar la SettlementView con IDs reales.
   */
  app.get('/api/v1/dev/srl-transactions', async (req, res) => {
    const txs = await Transaction.find({ legalEntity: 'SRL', status: 'in_transit' })
      .select('_id alytoTransactionId originalAmount digitalAssetAmount stellarTxId status createdAt exchangeRate')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ transactions: txs });
  });

  /**
   * GET /api/v1/dev/fintoc-success
   * Simula la pantalla de éxito del widget de Fintoc.
   * En producción, Fintoc redirige aquí tras el pago real.
   */
  app.get('/api/v1/dev/fintoc-success', (req, res) => {
    const { amount, id } = req.query;
    res.send(`
      <!DOCTYPE html><html lang="es"><head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pago simulado — Alyto Dev</title>
        <style>
          body { background:#0F1628; color:#fff; font-family:sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; flex-direction:column; gap:16px; }
          .card { background:#1A2340; border-radius:20px; padding:32px 40px; text-align:center; max-width:360px; }
          .check { font-size:3rem; margin-bottom:8px; }
          h2 { color:#22C55E; margin:0 0 8px; }
          p  { color:#8A96B8; margin:4px 0; font-size:.875rem; }
          a  { display:inline-block; margin-top:20px; padding:12px 28px; background:#C4A84F; color:#0F1628; border-radius:12px; font-weight:700; text-decoration:none; }
        </style>
      </head><body>
        <div class="card">
          <div class="check">✅</div>
          <h2>Pago autorizado</h2>
          <p><strong>Monto:</strong> $${Number(amount ?? 0).toLocaleString('es-CL')} CLP</p>
          <p><strong>ID Fintoc (dev):</strong> ${id ?? 'N/A'}</p>
          <p style="margin-top:12px;color:#4E5A7A;font-size:.75rem">Ambiente de desarrollo — sin cargo real</p>
          <a href="http://localhost:5173">← Volver a Alyto</a>
        </div>
      </body></html>
    `);
  });
}

// Ruta catch-all — 404 (debe ser la ÚLTIMA ruta registrada)
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado.' });
});

// Sentry: captura errores de rutas Express antes del handler genérico
// Debe estar DESPUÉS de todas las rutas y ANTES del error handler propio
Sentry.setupExpressErrorHandler(app);

// Manejador de errores global — evita que Express crashee el proceso
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[Alyto Server] Error no manejado:', err.message);
  // Capturar en Sentry solo errores 5xx (los 4xx son esperados y filtrados en sentry.js)
  if (!err.status || err.status >= 500) {
    Sentry.captureException(err);
  }
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ─── Conexión a MongoDB y arranque ───────────────────────────────────────────

async function resolveMongoUri() {
  if (process.env.NODE_ENV !== 'production' && !process.env.MONGODB_URI) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    console.info('[Alyto DB] Usando MongoDB en memoria (desarrollo):', uri);

    process.on('SIGTERM', () => mongod.stop());
    process.on('SIGINT',  () => mongod.stop());

    return uri;
  }
  return MONGODB_URI;
}

async function seedDevUser() {
  if (process.env.NODE_ENV === 'production') return;
  const existing = await User.findOne({ email: 'dev@alyto.test' });
  if (existing) return;
  const user = await User.create({
    firstName:        'Dev',
    lastName:         'Alyto',
    email:            'dev@alyto.test',
    legalEntity:      'SpA',
    kycStatus:        'approved',
    kycApprovedAt:    new Date(),
    kycProvider:      'dev_mock',
    residenceCountry: 'CL',
    identityDocument: { type: 'rut', number: '12345678-9', issuingCountry: 'CL' },
    address:          { street: 'Av. Test 123', city: 'Santiago', country: 'CL' },
    dateOfBirth:      new Date('1990-01-01'),
  });
  console.info(`[Alyto Dev] Usuario SpA sembrado — userId: ${user._id}`);

  // Seed usuario SRL (Bolivia) + transacciones en_tránsito para SettlementView
  const srlUser = await User.create({
    firstName:        'Operador',
    lastName:         'Bolivia',
    email:            'dev-srl@alyto.test',
    legalEntity:      'SRL',
    kycStatus:        'approved',
    kycApprovedAt:    new Date(),
    kycProvider:      'dev_mock',
    residenceCountry: 'BO',
    taxId:            '1023456789',
    identityDocument: { type: 'ci_bolivia', number: '7654321', issuingCountry: 'BO' },
    address:          { street: 'Calle Comercio 456', city: 'La Paz', country: 'BO' },
    dateOfBirth:      new Date('1985-06-15'),
  });

  const srlTxBase = {
    userId:          srlUser._id,
    legalEntity:     'SRL',
    operationType:   'crossBorderPayment',
    routingScenario: 'C',
    originCurrency:  'CLP',
    originCountry:   'CL',
    destinationCountry: 'BO',
    destinationCurrency: 'BOB',
    digitalAsset:    'USDC',
    status:          'in_transit',
    providersUsed:   ['payin:fintoc', 'transit:stellar'],
    paymentLegs: [
      { stage: 'payin',   provider: 'fintoc',  status: 'completed' },
      { stage: 'transit', provider: 'stellar', status: 'completed' },
    ],
    exchangeRate:    6.98,
  };

  const txSeed = [
    { ...srlTxBase, originalAmount: 25500, digitalAssetAmount: 25.50, stellarTxId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', alytoTransactionId: `ALY-C-${Date.now()}-TX001` },
    { ...srlTxBase, originalAmount: 51000, digitalAssetAmount: 51.00, stellarTxId: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', alytoTransactionId: `ALY-C-${Date.now()}-TX002` },
    { ...srlTxBase, originalAmount: 10200, digitalAssetAmount: 10.20, stellarTxId: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', alytoTransactionId: `ALY-C-${Date.now()}-TX003` },
  ];

  const createdTxs = await Transaction.insertMany(txSeed);
  console.info(`[Alyto Dev] Usuario SRL sembrado — userId: ${srlUser._id}`);
  console.info(`[Alyto Dev] ${createdTxs.length} transacciones SRL in_transit sembradas.`);
}

/**
 * Elimina índices legacy de colecciones V1.0 que no existen en el esquema V2.0
 * y que causarían conflictos al insertar documentos sin esos campos.
 * Solo se ejecuta si el índice existe — operación idempotente.
 */
async function dropLegacyIndexes() {
  try {
    const txCollection = mongoose.connection.collection('transactions');
    const indexes = await txCollection.indexes();
    const hasOrderIndex = indexes.some(idx => idx.name === 'order_1');
    if (hasOrderIndex) {
      await txCollection.dropIndex('order_1');
      console.info('[Alyto DB] Índice legacy "order_1" eliminado de transactions.');
    }
  } catch (err) {
    // No bloquear el arranque si falla — el índice puede no existir
    console.warn('[Alyto DB] No se pudo limpiar índice legacy:', err.message);
  }
}

async function startServer() {
  try {
    const uri = await resolveMongoUri();
    await mongoose.connect(uri);
    console.info('[Alyto DB] MongoDB conectado.');

    await dropLegacyIndexes();

    await seedDevUser();

    // Capturar el servidor HTTP para montar el WebSocket sobre él
    const httpServer = app.listen(PORT, () => {
      console.info(`[Alyto Server] Escuchando en http://0.0.0.0:${PORT}`);
      console.info(`[Alyto Server] Entorno: ${process.env.NODE_ENV ?? 'development'}`);
      console.info(`[Alyto Server] Stellar network: ${process.env.STELLAR_NETWORK ?? 'testnet'}`);
    });

    // WebSocket de cotizaciones en tiempo real — montado sobre el mismo puerto HTTP
    const wss = createQuoteSocketServer(httpServer);

    // Guardar referencias para el shutdown graceful
    app._httpServer = httpServer;
    app._wss        = wss;

  } catch (error) {
    console.error('[Alyto Server] Error al iniciar:', error.message);
    process.exit(1);
  }
}

// Manejo de señales de cierre graceful (Docker, PM2, K8s)
process.on('SIGTERM', async () => {
  console.info('[Alyto Server] SIGTERM recibido. Cerrando conexiones...');
  if (app._wss) app._wss.close();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.info('[Alyto Server] SIGINT recibido. Cerrando conexiones...');
  if (app._wss) app._wss.close();
  await mongoose.connection.close();
  process.exit(0);
});

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export default app;
