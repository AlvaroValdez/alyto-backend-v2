// src/routes/internalJobsRoutes.js
//
// AWS-2A — Endpoint interno para disparar jobs on-demand desde EventBridge→Lambda.
//   POST /api/v1/internal/jobs/:name   (header: X-Internal-Token: <INTERNAL_JOB_TOKEN>)
//
// Seguridad: comparación timing-safe de un token compartido (INTERNAL_JOB_TOKEN).
// Sin el token o sin la var configurada → 401/403. NO expone los jobs públicamente.
//
// La Lambda (una por job, cron de EventBridge) hace un POST a este endpoint con el
// token. Así la lógica de negocio sigue viviendo en el backend (una sola fuente de
// verdad); la Lambda solo es el disparador que sobrevive reinicios del host.

import express from 'express';
import crypto from 'crypto';
import { runJob, jobNames } from '../jobs/jobRegistry.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

function tokenValid(req) {
  const expected = process.env.INTERNAL_JOB_TOKEN;
  if (!expected) return false; // sin token configurado → endpoint cerrado
  const received = req.headers['x-internal-token'] || '';
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Listar jobs disponibles (también requiere token — no filtrar nombres a anónimos).
router.get('/jobs', (req, res) => {
  if (!tokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ jobs: jobNames() });
});

// Disparar un job por nombre.
router.post('/jobs/:name', async (req, res) => {
  if (!tokenValid(req)) {
    logger.warn('[internal-jobs] Token inválido o ausente', { ip: req.ip, name: req.params.name });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { name } = req.params;
  const result = await runJob(name);
  if (!result.ok && result.error === 'unknown_job') {
    return res.status(404).json(result);
  }
  // 200 aun si el job reportó error interno: el disparo se procesó; el detalle va en el body.
  return res.status(200).json(result);
});

export default router;
