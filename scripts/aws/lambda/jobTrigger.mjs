// scripts/aws/lambda/jobTrigger.mjs
//
// AWS-2A — Lambda genérica que dispara un job del backend vía el endpoint interno.
// Una sola función para los 5 jobs; cada EventBridge rule pasa el job en `event.job`
// (o se fija con la env var JOB_NAME por-Lambda si se prefiere una función por job).
//
// Runtime: nodejs20.x (fetch nativo). Handler: jobTrigger.handler
//
// Env vars de la Lambda:
//   BACKEND_URL         e.g. https://api.alyto.app
//   INTERNAL_JOB_TOKEN  el mismo token que el backend (mejor desde Secrets Manager)
//   JOB_NAME            (opcional) nombre fijo del job si no se pasa por event
//
// EventBridge Scheduler/rule → target esta Lambda con input { "job": "reconcile-harbor" }.

export const handler = async (event) => {
  const backendUrl = process.env.BACKEND_URL;
  const token = process.env.INTERNAL_JOB_TOKEN;
  const job = event?.job || process.env.JOB_NAME;

  if (!backendUrl || !token) {
    throw new Error('Faltan BACKEND_URL / INTERNAL_JOB_TOKEN en la Lambda');
  }
  if (!job) {
    throw new Error('No se especificó job (event.job ni JOB_NAME)');
  }

  const url = `${backendUrl.replace(/\/$/, '')}/api/v1/internal/jobs/${job}`;
  const started = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Internal-Token': token, 'Content-Type': 'application/json' },
    // timeout defensivo (los jobs pesados deberían responder rápido al disparo)
    signal: AbortSignal.timeout(120000),
  });

  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - started;
  console.log(JSON.stringify({ job, httpStatus: res.status, ms, body }));

  // 4xx/5xx → throw para que EventBridge marque la invocación como fallida y reintente.
  if (res.status >= 400) {
    throw new Error(`Job ${job} respondió HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return { ok: true, job, httpStatus: res.status, ms };
};
