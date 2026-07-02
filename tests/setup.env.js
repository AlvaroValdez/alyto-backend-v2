/**
 * setup.env.js — Variables de entorno para el entorno de test
 *
 * Importar al inicio de cada test file para garantizar que las variables
 * de entorno mínimas estén disponibles antes de importar server.js.
 *
 * Uso:
 *   import './setup.env.js'  ← debe ser el PRIMER import del test file
 */

// Asegurar NODE_ENV=test
process.env.NODE_ENV = 'test';

// ⚠️ La suite debe ser AUTOCONTENIDA: jamás cargar secretos reales de AWS.
// Sin esto, un .env local con AWS_SECRETS_NAME hace que importar server.js
// inyecte los secretos de producción en el entorno de test.
delete process.env.AWS_SECRETS_NAME;

// JWT
process.env.JWT_SECRET = 'alyto_test_jwt_secret_do_not_use_in_prod';

// Vita Wallet (mock — valores que permiten generar firmas HMAC válidas)
process.env.VITA_LOGIN       = 'test_vita_login';
process.env.VITA_SECRET      = 'test_vita_secret_key';
process.env.VITA_TRANS_KEY   = 'test_vita_trans_key';
process.env.VITA_API_URL     = 'http://localhost:19999';    // Puerto inválido — nunca responderá
process.env.VITA_BUSINESS_WALLET_UUID = 'test-uuid-1234-5678-9000';
process.env.VITA_NOTIFY_URL  = 'http://localhost:19999/api/v1/ipn/vita';

// Fintoc — fintocService NO tiene modo mock interno: createWidgetLink siempre
// llama a la API real. Las suites que ejercitan el payin Fintoc DEBEN mockear
// fintocService (jest.unstable_mockModule). FINTOC_SECRET_KEY deliberadamente
// sin configurar para que cualquier llamada real no mockeada falle rápido.
process.env.FINTOC_WEBHOOK_SECRET = 'test_fintoc_webhook_secret';

// Stellar (mock — no realizará transacciones reales)
process.env.STELLAR_NETWORK         = 'testnet';
process.env.STELLAR_LLC_SECRET_KEY  = 'STEST000000000000000000000000000000000000000000000000000';
process.env.STELLAR_SPA_SECRET_KEY  = 'STEST000000000000000000000000000000000000000000000000001';
process.env.STELLAR_SRL_SECRET_KEY  = 'STEST000000000000000000000000000000000000000000000000002';
process.env.STELLAR_CHANNEL_SECRET  = 'STEST000000000000000000000000000000000000000000000000003';

// CORS
process.env.CORS_ORIGIN = '*';
