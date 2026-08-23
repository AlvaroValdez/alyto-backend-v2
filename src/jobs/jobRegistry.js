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
// NO están aquí (siguen siempre in-process, por diseño):
//   - monitorUSDCDeposits (cada 30s) — sub-minuto, no encaja en cron de EventBridge
//   - monitorChannelXLM (cada 1h) — monitoreo de infraestructura core (saldo XLM del canal)
//   - el consumer SQS — long-poll continuo

import { logger } from '../utils/logger.js';

// name → loader perezoso de la función del job
const JOBS = {
  'cleanup-orphans': () =>
    import('./cleanupOrphanTransactions.js').then((m) => m.cleanupOrphanTransactions),
  'kyc-monitor': () =>
    import('./kycIncompleteMonitor.js').then((m) => m.kycIncompleteMonitor),
  'reconcile-harbor': () =>
    import('./reconcileHarborTransfers.js').then((m) => m.reconcileHarborTransfers),
  'reconcile-vita': () =>
    import('./reconcileVitaTransfers.js').then((m) => m.reconcileVitaTransfers),
  'reconcile-stellar': () =>
    import('./reconcileStellarTransits.js').then((m) => m.reconcileStellarTransits),
  // monitorChannelXLM NO se registra aquí a propósito: corre SIEMPRE in-process
  // (monitoreo de infraestructura core, fuera del gate JOBS_EXTERNAL_SCHEDULER).
  // Registrarlo permitiría dispararlo por Lambda → doble ejecución. Ver server.js.
  'ros-monitor': () =>
    import('./rosMonitor.js').then((m) => m.rosMonitor),
  'ros-monitor-wallet': () =>
    import('./rosMonitorWallet.js').then((m) => m.rosMonitorWallet),
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
/**
 * Persiste la ejecución. Best-effort deliberado: el job YA corrió, y su resultado no
 * puede perderse por un problema de telemetría. Un fallo acá se anota en bitácora y
 * no se propaga.
 */
async function recordRun(entry) {
  try {
    const { default: JobRun } = await import('../models/JobRun.js');
    await JobRun.create(entry);
  } catch (err) {
    logger.warn('[jobs] No se pudo registrar la ejecución', { name: entry.name, error: err.message });
  }
}

/**
 * Ejecuta un job por nombre y deja constancia de la corrida.
 *
 * El registro es lo que permite distinguir un proceso que corrió y no tenía nada que
 * hacer de uno que dejó de correr. Sin él, un job caído **no produce ningún síntoma**:
 * los descuadres simplemente dejan de detectarse, en silencio. Es exactamente lo que
 * un supervisor necesita poder descartar.
 *
 * @param {string} name
 * @param {{trigger?: 'scheduler'|'interval'|'manual'}} [opts]
 */
export async function runJob(name, { trigger = 'scheduler' } = {}) {
  const loader = JOBS[name];
  if (!loader) {
    return { ok: false, name, error: 'unknown_job', known: jobNames() };
  }
  const started   = new Date();
  const startedAt = Date.now();
  try {
    const fn  = await loader();
    const res = await fn();
    const ms  = Date.now() - startedAt;
    // Volumen procesado, cuando el job lo informa: distingue "no había nada que
    // hacer" de "no hizo lo que debía", que sin este dato se ven idénticos.
    const processed = typeof res === 'number'          ? res
                    : Number.isFinite(res?.processed)  ? res.processed
                    : null;
    logger.info('[jobs] Job ejecutado', { name, ms, trigger, processed });
    await recordRun({ name, trigger, startedAt: started, finishedAt: new Date(),
                      durationMs: ms, ok: true, processed });
    return { ok: true, name, ms, processed };
  } catch (err) {
    const ms = Date.now() - startedAt;
    logger.error('[jobs] Job falló', { name, ms, trigger, error: err.message });
    await recordRun({ name, trigger, startedAt: started, finishedAt: new Date(),
                      durationMs: ms, ok: false, error: err.message });
    return { ok: false, name, ms, error: err.message };
  }
}

export default { jobNames, isExternalScheduler, runJob };
