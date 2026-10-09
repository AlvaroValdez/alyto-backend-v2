// src/routes/internalJobsRoutes.js
//
// AWS-2A — Endpoint interno para disparar jobs on-demand desde EventBridge→Lambda.
//   POST /api/v1/internal/jobs/:name   (header: X-Internal-Token: <INTERNAL_JOB_TOKEN>)
//
// Seguridad. ⚠️ Pese al nombre, esta ruta ES alcanzable desde internet: nginx no la
// bloquea, así que el token compartido es la única barrera, y es el MISMO para los 15
// jobs — varios mueven dinero y uno gasta XLM. Tres capas, por eso:
//   1. Token en SHA-256 comparado timing-safe. Se hashea para que ambos lados midan
//      32 bytes: comparar la longitud antes delataba el largo del token.
//   2. Limitador por IP (internalJobsLimiter), ANTES del token, para que un sondeo sin
//      credencial también consuma cupo.
//   3. Rechazo con 404, no 401: un 401 confirma que el endpoint existe.
// Sin la variable configurada el endpoint queda cerrado.
//
// Lo que esto NO resuelve: si el token se filtra, el acceso sigue siendo total. Cerrarlo
// de verdad pide restringir en el proxy, y un allowlist por IP no sirve —una Lambda sin
// VPC tiene IPs de salida dinámicas—; haría falta NAT con IP fija o mover la ruta a un
// host no publicado. Es una decisión de infraestructura, no de este archivo.
//
// La Lambda (una por job, cron de EventBridge) hace un POST a este endpoint con el
// token. Así la lógica de negocio sigue viviendo en el backend (una sola fuente de
// verdad); la Lambda solo es el disparador que sobrevive reinicios del host.

import express from 'express';
import crypto from 'crypto';
import { runJob, jobNames } from '../jobs/jobRegistry.js';
import { internalJobsLimiter } from '../config/rateLimiters.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

function tokenValid(req) {
  const expected = process.env.INTERNAL_JOB_TOKEN;
  if (!expected) return false; // sin token configurado → endpoint cerrado
  const received = req.headers['x-internal-token'] || '';

  // Se comparan los SHA-256, no las cadenas. `timingSafeEqual` exige igual longitud, y
  // comprobarla antes —el `return false` por length que había acá— delataba el largo
  // del token y metía una rama de tiempo distinta de la comparación real. Hasheando,
  // las dos entradas miden 32 bytes siempre: una sola rama y nada que deducir del
  // tamaño. Además desaparece el try/catch, que solo existía para ese borde.
  const a = crypto.createHash('sha256').update(String(received)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Rechazo uniforme: 404, no 401.
 *
 * Un 401 confirma que el endpoint existe, que es justo lo que no conviene regalar en
 * una ruta llamada `/internal` y alcanzable desde internet. Con 404 se parece a
 * cualquier path inexistente. El llamador legítimo (la Lambda) manda el token, así que
 * nunca ve esta rama.
 *
 * Se registra en bitácora pero NO se manda a Sentry: un escáner cualquiera generaría
 * ruido suficiente para enterrar las alertas que importan, que es el mismo error que
 * tenía el monitor de depósitos con los 404 de Horizon. El limitador acota el volumen
 * y CloudWatch queda consultable por IP.
 */
function rechazar(req, res, motivo) {
  logger.warn('[internal-jobs] Acceso rechazado', {
    motivo,
    ip:   req.ip,
    name: req.params?.name ?? null,
  });
  return res.status(404).json({ error: 'Not found' });
}

// El limitador va ANTES del chequeo de token y cubre las dos rutas: si fuera después,
// un atacante sin token no consumiría cupo y podría sondear sin tope.
router.use(internalJobsLimiter);

// Listar jobs disponibles (también requiere token — no filtrar nombres a anónimos).
router.get('/jobs', (req, res) => {
  if (!tokenValid(req)) return rechazar(req, res, 'token inválido o ausente');
  res.json({ jobs: jobNames() });
});

// Disparar un job por nombre.
router.post('/jobs/:name', async (req, res) => {
  if (!tokenValid(req)) return rechazar(req, res, 'token inválido o ausente');

  const { name } = req.params;
  const result = await runJob(name);
  if (!result.ok && result.error === 'unknown_job') {
    return res.status(404).json(result);
  }
  // 200 aun si el job reportó error interno: el disparo se procesó; el detalle va en el body.
  return res.status(200).json(result);
});

export default router;
