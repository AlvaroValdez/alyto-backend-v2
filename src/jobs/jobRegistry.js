// src/jobs/jobRegistry.js
//
// AWS-2A — Registro central de jobs programados, para que puedan dispararse
// tanto in-process (setInterval, modo actual) como on-demand vía endpoint
// interno (EventBridge → Lambda → POST /api/v1/internal/jobs/:name).
//
// Diseño:
//   - Cada job se importa de forma perezosa (no carga su árbol de deps salvo que se use).
//   - `runJob(name)` ejecuta uno por nombre, devuelve {ok, name, ms} y NUNCA lanza
//     (los jobs ya manejan sus errores; aquí lo envolvemos por seguridad).
//   - JOBS_EXTERNAL_SCHEDULER=true → server.js NO arranca los setInterval de los jobs
//     migrables (los dispara EventBridge). Default false = comportamiento histórico.
//
// monitorUSDCDeposits (cada 30s) y el consumer SQS NO están aquí: son sub-minuto /
// long-poll, no encajan en cron de EventBridge — siguen siempre in-process.

import { logger } from '../utils/logger.js';

// name → loader perezoso de la función del job
const JOBS = {
  'cleanup-orphans': () =>
    import('./cleanupOrphanTransactions.js').then((m) => m.cleanupOrphanTransactions),
  'kyc-monitor': () =>
    import('./kycIncompleteMonitor.js').then((m) => m.kycIncompleteMonitor),
  'reconcile-harbor': () =>
    import('./reconcileHarborTransfers.js').then((m) => m.reconcileHarborTransfers),
  'ros-monitor': () =>
    import('./rosMonitor.js').then((m) => m.rosMonitor),
  'refresh-rates': () =>
    import('./refreshExchangeRates.js').then((m) => m.refreshExchangeRates),
};

export function jobNames() {
  return Object.keys(JOBS);
}

export function isExternalScheduler() {
  return process.env.JOBS_EXTERNAL_SCHEDULER === 'true';
}

/**
 * Ejecuta un job por nombre. Devuelve un resultado estructurado; nunca lanza.
 */
export async function runJob(name) {
  const loader = JOBS[name];
  if (!loader) {
    return { ok: false, name, error: 'unknown_job', known: jobNames() };
  }
  const startedAt = Date.now();
  try {
    const fn = await loader();
    await fn();
    const ms = Date.now() - startedAt;
    logger.info('[jobs] Job ejecutado on-demand', { name, ms });
    return { ok: true, name, ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    logger.error('[jobs] Job falló', { name, ms, error: err.message });
    return { ok: false, name, ms, error: err.message };
  }
}

export default { jobNames, isExternalScheduler, runJob };
