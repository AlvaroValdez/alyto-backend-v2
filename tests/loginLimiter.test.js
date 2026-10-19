/**
 * loginLimiter.test.js
 *
 * El limitador de acceso debe contar SOLO los intentos fallidos.
 *
 * Contaba todo, y eso bloqueaba a quien no se había equivocado nunca: cinco
 * accesos correctos en quince minutos dejaban al usuario fuera. Con los
 * operadores móviles bolivianos compartiendo IP por CGNAT, varios probadores
 * agotaban el cupo entre ellos.
 *
 * Se levanta un Express real porque lo que se prueba es el comportamiento de
 * express-rate-limit ante códigos 2xx y 4xx, no una función nuestra.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/loginLimiter.test.js
 */

import { jest } from '@jest/globals';

process.env.NODE_ENV = 'development';   // que no entre el skip de IS_TEST
process.env.RATE_LIMIT_STRICT = 'true'; // umbrales de producción: 5/15min

const express = (await import('express')).default;
const { loginLimiter } = await import('../src/config/rateLimiters.js');

/** Servidor mínimo: /ok responde 200, /falla responde 401. */
function montar() {
  const app = express();
  app.post('/ok',    loginLimiter, (req, res) => res.status(200).json({ ok: true }));
  app.post('/falla', loginLimiter, (req, res) => res.status(401).json({ error: 'malo' }));
  return app;
}

/** Hace una petición sin depender de supertest. */
function pedir(server, ruta) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${ruta}`, { method: 'POST' });
}

let server;
beforeAll(async () => {
  server = montar().listen(0);
  await new Promise(r => server.once('listening', r));
});
afterAll(() => new Promise(r => server.close(r)));

describe('loginLimiter', () => {
  test('diez accesos CORRECTOS seguidos no bloquean', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await pedir(server, '/ok');
      expect(res.status).toBe(200);
    }
  });

  test('al sexto intento FALLIDO bloquea con 429', async () => {
    const vistos = [];
    for (let i = 1; i <= 6; i++) {
      const res = await pedir(server, '/falla');
      vistos.push(res.status);
    }
    // Los cinco primeros pasan al handler (401); el sexto lo corta el limitador.
    expect(vistos.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(vistos[5]).toBe(429);
  });

  test('una vez bloqueado, el acceso correcto también queda cortado', async () => {
    // Esto es lo esperado y conviene dejarlo escrito: el cupo es por IP y
    // ventana, así que tras agotarlo con fallos ni siquiera la credencial buena
    // entra hasta que la ventana expire. Lo que se arregló es que los aciertos
    // ya no GASTAN cupo, no que lo esquiven.
    const res = await pedir(server, '/ok');
    expect(res.status).toBe(429);
  });
});
