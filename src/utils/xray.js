// src/utils/xray.js
//
// AWS-3C — Tracing distribuido con AWS X-Ray (gated por XRAY_ENABLED).
//
// Diseño:
//   - Apagado por defecto (XRAY_ENABLED!=true) → todos los helpers son no-op.
//     Cero overhead y cero dependencia en runtime si no se activa.
//   - El SDK (CJS) se carga de forma perezosa vía createRequire SOLO si X-Ray
//     está activo, para no pagar el require ni requerir el daemon en dev.
//   - openSegment debe ser el PRIMER middleware; closeSegment el ÚLTIMO
//     (después de las rutas, antes del error handler). Ver server.js.
//
// Requiere un daemon X-Ray accesible (sidecar / AWS_XRAY_DAEMON_ADDRESS) en prod.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XRAY_ENABLED = process.env.XRAY_ENABLED === 'true';

let _core = null;
let _express = null;
let _loaded = false;

function load() {
  if (!XRAY_ENABLED || _loaded) return _core;
  _loaded = true;
  try {
    // aws-xray-sdk-core es CJS y debe instrumentar http/https ANTES de su uso.
    // Solo se ejecuta si X-Ray está activo.
    _core = require('aws-xray-sdk-core');
    _express = require('aws-xray-sdk-express');
    _core.captureHTTPsGlobal(require('node:http'), true);
    _core.captureHTTPsGlobal(require('node:https'), true);
  } catch (err) {
    console.warn(`[xray] No disponible: ${err.message}. Tracing deshabilitado.`);
    _core = null;
    _express = null;
  }
  return _core;
}

export function isXrayEnabled() {
  return XRAY_ENABLED && !!load();
}

/** Middleware de apertura de segmento. No-op si X-Ray está apagado. */
export function xrayOpenSegment(name = 'alyto-backend') {
  if (!isXrayEnabled()) return (req, res, next) => next();
  return _express.openSegment(name);
}

/** Middleware de cierre de segmento. No-op si X-Ray está apagado. */
export function xrayCloseSegment() {
  if (!isXrayEnabled()) return (req, res, next) => next();
  return _express.closeSegment();
}

export default { isXrayEnabled, xrayOpenSegment, xrayCloseSegment };
