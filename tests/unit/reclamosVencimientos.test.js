/**
 * reclamosVencimientos.test.js — Monitor del plazo regulatorio PRILI.
 *
 * El plazo de 10 días hábiles es compromiso declarado ante ASFI (Fase 27). El
 * monitor lo convierte en alerta operativa: clasifica vencidos / por vencer,
 * avisa por SSE siempre y por email con freno persistente — el aviso suave no
 * silencia al crítico, y el crítico no se repite cada 6 h.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js';

// ─── Mocks: email y SSE (el throttle es real — persiste en la DB de test) ─────

const mockSendRawEmail = jest.fn().mockResolvedValue(undefined);
const mockBroadcast    = jest.fn();

const actualEmail = await import('../../src/services/email.js');
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  ...actualEmail,
  sendRawEmail: mockSendRawEmail,
}));
const actualSSE = await import('../../src/routes/adminSSE.js');
await jest.unstable_mockModule('../../src/routes/adminSSE.js', () => ({
  ...actualSSE,
  broadcastToAdmins: mockBroadcast,
}));

const { reclamosVencimientosMonitor } = await import('../../src/jobs/reclamosVencimientosMonitor.js');
const { default: Reclamo }            = await import('../../src/models/Reclamo.js');
const { default: mongoose }           = await import('mongoose');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  await clearCollections();
  mockSendRawEmail.mockClear();
  mockBroadcast.mockClear();
});

const DIA = 24 * 60 * 60 * 1000;

/** Crea un reclamo y le fija el plazo a mano (updateOne esquiva el pre-save). */
async function seedReclamo({ status = 'recibido', venceEnDias }) {
  const r = await Reclamo.create({
    userId: new mongoose.Types.ObjectId(),
    tipo: 'demora',
    descripcion: 'Reclamo de prueba para el monitor de vencimientos PRILI.',
    status,
  });
  await Reclamo.updateOne(
    { _id: r._id },
    { plazoVence: new Date(Date.now() + venceEnDias * DIA) },
  );
  return r;
}

describe('clasificación y alerta', () => {
  test('vencidos y por vencer: email crítico (⛔) + SSE con el detalle', async () => {
    await seedReclamo({ venceEnDias: -2 });                       // vencido hace 2 días
    await seedReclamo({ status: 'en_revision', venceEnDias: 2 }); // por vencer
    await seedReclamo({ venceEnDias: 9 });                        // lejano — fuera de ventana
    await seedReclamo({ status: 'resuelto', venceEnDias: -5 });   // cerrado — no cuenta

    const r = await reclamosVencimientosMonitor();

    expect(r).toEqual(expect.objectContaining({ vencidos: 1, porVencer: 1, emailEnviado: true }));

    expect(mockSendRawEmail).toHaveBeenCalledTimes(1);
    const [, asunto, html] = mockSendRawEmail.mock.calls[0];
    expect(asunto).toMatch(/⛔.*VENCIDO/);
    expect(html).toMatch(/VENCIDO hace 2 día/);
    expect(html).toMatch(/quedan 2 día/);

    expect(mockBroadcast).toHaveBeenCalledWith('reclamos_vencimientos',
      expect.objectContaining({
        vencidos:  [expect.objectContaining({ diasRestantes: -2 })],
        porVencer: [expect.objectContaining({ diasRestantes: 2 })],
      }));
  });

  test('solo por vencer: asunto de aviso (⏳), no de incumplimiento', async () => {
    await seedReclamo({ venceEnDias: 1 });

    const r = await reclamosVencimientosMonitor();
    expect(r).toEqual(expect.objectContaining({ vencidos: 0, porVencer: 1 }));
    expect(mockSendRawEmail.mock.calls[0][1]).toMatch(/⏳.*por vencer/);
  });

  test('sin reclamos en la ventana no molesta a nadie', async () => {
    await seedReclamo({ venceEnDias: 8 });

    const r = await reclamosVencimientosMonitor();
    expect(r).toEqual({ vencidos: 0, porVencer: 0 });
    expect(mockSendRawEmail).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('freno de correo (persistente, sobrevive reinicios)', () => {
  test('la segunda corrida dentro del cooldown omite el email pero mantiene el SSE', async () => {
    await seedReclamo({ venceEnDias: -1 });

    const r1 = await reclamosVencimientosMonitor();
    expect(r1.emailEnviado).toBe(true);

    const r2 = await reclamosVencimientosMonitor();
    expect(r2.emailOmitido).toBe(true);
    expect(mockSendRawEmail).toHaveBeenCalledTimes(1);   // un solo correo
    expect(mockBroadcast).toHaveBeenCalledTimes(2);      // el panel se entera siempre
  });

  test('el freno del aviso suave NO silencia al crítico: llaves separadas', async () => {
    // 1ª corrida: solo "por vencer" → consume la llave suave.
    const porVencer = await seedReclamo({ venceEnDias: 1 });
    await reclamosVencimientosMonitor();
    expect(mockSendRawEmail).toHaveBeenCalledTimes(1);

    // El plazo se vence entre corridas → ahora es un incumplimiento EN CURSO.
    await Reclamo.updateOne({ _id: porVencer._id }, { plazoVence: new Date(Date.now() - DIA) });

    const r = await reclamosVencimientosMonitor();
    // La llave crítica está fresca: el email sale aunque el suave esté en cooldown.
    expect(r.emailEnviado).toBe(true);
    expect(mockSendRawEmail).toHaveBeenCalledTimes(2);
    expect(mockSendRawEmail.mock.calls[1][1]).toMatch(/⛔/);
  });
});
