/**
 * sentrySmokeTest.js — Verifica que Sentry está configurado y puede enviar eventos.
 *
 * Uso: npm run sentry:test
 *
 * Requiere SENTRY_DSN en .env o en el entorno. Si SENTRY_DSN no está definido,
 * el test se ejecuta en modo silencioso (no falla, pero advierte).
 */

import 'dotenv/config';
import '../src/services/sentry.js';
import * as Sentry from '@sentry/node';

if (!process.env.SENTRY_DSN) {
  console.warn('[Sentry Test] ⚠️  SENTRY_DSN no configurado — el evento no se enviará.');
  console.warn('[Sentry Test] Configura SENTRY_DSN en .env y vuelve a ejecutar.');
  process.exit(0);
}

console.log('[Sentry Test] Enviando evento de prueba a Sentry...');
console.log('[Sentry Test] DSN:', process.env.SENTRY_DSN.slice(0, 40) + '...');

Sentry.captureMessage('Test desde Alyto Backend', {
  level: 'info',
  tags:  { component: 'smokeTest', env: process.env.NODE_ENV ?? 'development' },
  extra: { timestamp: new Date().toISOString(), version: '2.0.0' },
});

// Sentry.flush() espera a que el evento sea enviado antes de salir
await Sentry.flush(3000);
console.log('[Sentry Test] ✅ Evento enviado. Verifica en sentry.io → Issues.');
