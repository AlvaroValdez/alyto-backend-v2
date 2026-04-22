/**
 * adminSSE.js — Server-Sent Events para el admin.
 *
 * Abre un stream persistente a /admin/events y transmite notificaciones
 * en tiempo real (nueva tx accionable, payout manual pendiente, etc.).
 *
 * Auth: cookie `alyto_token` (misma que el resto del panel admin). El middleware
 * `protect` + `checkAdmin` se aplica a nivel de router en adminRoutes.js — no
 * hace falta repetirlos aquí. NO se acepta token por query-string: tokens en
 * URLs contaminan access logs, historial del navegador y headers Referer.
 *
 * Limitación: el Set de clientes vive en memoria del proceso. Si el backend
 * escala horizontalmente (múltiples instancias en Render), el broadcast sólo
 * alcanza clientes conectados a esta instancia. Migrar a Redis pub/sub si se
 * requiere fan-out cross-process.
 */

import { Router } from 'express';

const router = Router();

const adminClients = new Set();

router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const clientId = Date.now() + Math.random().toString(36).slice(2, 8);
  const client   = { id: clientId, res };
  adminClients.add(client);
  console.log('[SSE] admin connected:', clientId, '| total:', adminClients.size);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); }
    catch { /* stream closed, cleanup below */ }
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    adminClients.delete(client);
    console.log('[SSE] admin disconnected:', clientId, '| total:', adminClients.size);
  });
});

/**
 * Emite un evento a todos los admins conectados a esta instancia.
 * No lanza: si el stream está cerrado, el cliente se elimina silenciosamente.
 */
export function broadcastToAdmins(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of adminClients) {
    try {
      client.res.write(payload);
    } catch {
      adminClients.delete(client);
    }
  }
}

export default router;
