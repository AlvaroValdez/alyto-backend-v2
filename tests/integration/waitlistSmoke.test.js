// Prueba de humo del alta de la waitlist tal como la invoca la landing alyto.io:
// CORS con Origin externo, alta nueva, idempotencia, honeypot y validación.
import { jest } from '@jest/globals';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import waitlistRoutes from '../../src/routes/waitlistRoutes.js';
import WaitlistEntry from '../../src/models/WaitlistEntry.js';

jest.setTimeout(60000);

// Réplica de la allowlist estricta de server.js, con el origen de la landing.
const ALLOWED = ['https://alyto.app', 'https://alyto.io', 'https://www.alyto.io'];

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  app = express();
  app.use(express.json());
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origen no permitido (${origin})`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use('/api/v1/waitlist', waitlistRoutes);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('POST /api/v1/waitlist desde la landing', () => {
  it('acepta el preflight del navegador desde https://alyto.io', async () => {
    const res = await request(app)
      .options('/api/v1/waitlist')
      .set('Origin', 'https://alyto.io')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('https://alyto.io');
  });

  it('acepta también el preflight desde https://www.alyto.io', async () => {
    const res = await request(app)
      .options('/api/v1/waitlist')
      .set('Origin', 'https://www.alyto.io')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBe('https://www.alyto.io');
  });

  it('registra una empresa con atribución UTM y devuelve alta nueva', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .set('Origin', 'https://alyto.io')
      .send({
        email: 'Empresa.Test@Example.COM',
        tipo: 'empresa',
        empresa: 'Importadora Test SRL',
        website: '',
        source: { utmSource: 'corresponsal', utmMedium: 'visita', utmCampaign: 'scz-ago26' },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyRegistered: false });

    const saved = await WaitlistEntry.findOne({ email: 'empresa.test@example.com' });
    expect(saved).not.toBeNull();
    expect(saved.tipo).toBe('empresa');
    expect(saved.empresa).toBe('Importadora Test SRL');
    expect(saved.source.utmCampaign).toBe('scz-ago26');
  });

  it('es idempotente: el mismo correo no duplica ni falla', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .set('Origin', 'https://alyto.io')
      .send({ email: 'empresa.test@example.com', tipo: 'empresa', empresa: 'Importadora Test SRL' });

    expect(res.status).toBe(200);
    expect(res.body.alreadyRegistered).toBe(true);
    expect(await WaitlistEntry.countDocuments({ email: 'empresa.test@example.com' })).toBe(1);
  });

  it('rechaza un correo inválido con 400', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .set('Origin', 'https://alyto.io')
      .send({ email: 'no-es-un-correo' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('descarta bots por honeypot sin persistir', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .set('Origin', 'https://alyto.io')
      .send({ email: 'bot@example.com', website: 'http://spam.example' });

    expect(res.status).toBe(200);
    expect(await WaitlistEntry.countDocuments({ email: 'bot@example.com' })).toBe(0);
  });

  it('bloquea un origen que no está en la allowlist', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .set('Origin', 'https://sitio-malicioso.example')
      .send({ email: 'otro@example.com' });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
