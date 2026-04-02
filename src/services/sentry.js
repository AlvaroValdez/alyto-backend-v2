/**
 * sentry.js — Inicialización y configuración de Sentry para Alyto Backend V2.0
 *
 * Debe importarse ANTES que cualquier otro módulo en server.js para que
 * la instrumentación automática de Sentry capture todo el tráfico Express.
 *
 * Errores esperados ignorados (no son bugs — no ensucian el dashboard):
 *   - 401 Unauthorized  (token inválido / ausente)
 *   - 404 Not Found     (rutas inexistentes)
 */

import * as Sentry from '@sentry/node';

const isProduction = process.env.NODE_ENV === 'production';

// Solo inicializar si SENTRY_DSN está configurado.
// El import de @sentry/profiling-node se hace dinámico para evitar que el
// native addon falle al cargar en entornos de desarrollo sin las bindings.
if (process.env.SENTRY_DSN) {
  const integrations = [];
  try {
    const { nodeProfilingIntegration } = await import('@sentry/profiling-node');
    integrations.push(nodeProfilingIntegration());
  } catch {
    // Native profiling addon no disponible en este entorno — continuar sin él
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,

    environment: process.env.NODE_ENV ?? 'development',

    integrations,

    // Muestra de trazas: 20% en producción para no saturar la cuota,
    // 100% en desarrollo/QA para ver todo el flujo
    tracesSampleRate: isProduction ? 0.2 : 1.0,

    // Muestra de perfiles: 10% de las trazas trazadas
    profilesSampleRate: 0.1,

    // Filtrar errores esperados — no son bugs, son flujos normales
    beforeSend(event, hint) {
      const err = hint?.originalException;

      // Ignorar errores con status 401 / 404 adjunto
      if (err?.status === 401 || err?.status === 404) return null;
      if (err?.statusCode === 401 || err?.statusCode === 404) return null;

      return event;
    },
  });
}

export default Sentry;
