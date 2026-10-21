/**
 * alertPendingWithdrawals.test.js
 *
 * Aviso de retiros parados en 'pending'.
 *
 * Nació de un caso real: WTX-1792430554245-FFJIJV estuvo un día entero en
 * 'pending' con el dinero ya transferido por fuera del sistema, y se descubrió
 * porque el usuario preguntó. Lo que se protege aquí es que eso vuelva a pasar
 * sin que nadie se entere, y que el aviso no se convierta en ruido.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/alertPendingWithdrawals.test.js
 */

import { jest } from '@jest/globals';

const estado = { encontrados: [], avisos: [], marcados: [] };

jest.unstable_mockModule('../src/models/WalletTransaction.js', () => ({
  default: {
    find: jest.fn((filtro) => {
      estado.ultimoFiltro = filtro;
      return { limit: () => ({ lean: async () => estado.encontrados }) };
    }),
    updateOne: jest.fn(async (filtro, upd) => { estado.marcados.push(upd.$set); return {}; }),
  },
}));
jest.unstable_mockModule('../src/services/notifications.js', () => ({
  notifyAdmins: jest.fn(async (n) => { estado.avisos.push(n); }),
  NOTIFICATIONS: {},
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }));

const { alertPendingWithdrawals } = await import('../src/jobs/alertPendingWithdrawals.js');

const retiro = (horas, extra = {}) => ({
  _id: 'x1', wtxId: 'WTX-TEST-0001', amount: 100,
  createdAt: new Date(Date.now() - horas * 3_600_000),
  ...extra,
});

beforeEach(() => {
  estado.encontrados = []; estado.avisos = []; estado.marcados = [];
  delete process.env.WITHDRAWAL_PENDING_ALERT_HOURS;
});

describe('alertPendingWithdrawals', () => {
  test('sin retiros parados no avisa a nadie', async () => {
    const r = await alertPendingWithdrawals();
    expect(r.ok).toBe(true);
    expect(r.avisados).toBe(0);
    expect(estado.avisos).toHaveLength(0);
  });

  test('avisa de un retiro parado e incluye su identificador y el monto', async () => {
    estado.encontrados = [retiro(9)];
    const r = await alertPendingWithdrawals();

    expect(r.avisados).toBe(1);
    expect(estado.avisos[0].body).toContain('WTX-TEST-0001');
    expect(estado.avisos[0].body).toContain('100.00');
    expect(estado.avisos[0].data.wtxId).toBe('WTX-TEST-0001');
  });

  // Lo que evita el ruido: una alerta por retiro, no una por corrida.
  test('marca el retiro como avisado para no repetir cada media hora', async () => {
    estado.encontrados = [retiro(9)];
    await alertPendingWithdrawals();
    expect(estado.marcados).toHaveLength(1);
    expect(estado.marcados[0]['metadata.pendingAlertedAt']).toBeInstanceOf(Date);
  });

  test('solo busca retiros pendientes y aún no avisados', async () => {
    await alertPendingWithdrawals();
    const f = estado.ultimoFiltro;
    expect(f.type).toBe('withdrawal');
    expect(f.status).toBe('pending');
    expect(f['metadata.pendingAlertedAt']).toEqual({ $exists: false });
    expect(f.createdAt.$lt).toBeInstanceOf(Date);
  });

  test('el umbral por defecto son 6 horas', async () => {
    await alertPendingWithdrawals();
    const horas = (Date.now() - estado.ultimoFiltro.createdAt.$lt.getTime()) / 3_600_000;
    expect(horas).toBeCloseTo(6, 1);
  });

  test('el umbral se puede ajustar por entorno', async () => {
    process.env.WITHDRAWAL_PENDING_ALERT_HOURS = '2';
    await alertPendingWithdrawals();
    const horas = (Date.now() - estado.ultimoFiltro.createdAt.$lt.getTime()) / 3_600_000;
    expect(horas).toBeCloseTo(2, 1);
  });

  test('un valor de entorno inválido cae al defecto en vez de romper', async () => {
    process.env.WITHDRAWAL_PENDING_ALERT_HOURS = 'muchas';
    await alertPendingWithdrawals();
    const horas = (Date.now() - estado.ultimoFiltro.createdAt.$lt.getTime()) / 3_600_000;
    expect(horas).toBeCloseTo(6, 1);
  });

  // Avisar es lo único que hace. Si alguien le añade capacidad de completar o
  // cancelar un retiro, esta prueba debe empezar a fallar.
  test('no completa, no cancela y no mueve dinero: solo marca que avisó', async () => {
    estado.encontrados = [retiro(30)];
    await alertPendingWithdrawals();
    for (const set of estado.marcados) {
      expect(Object.keys(set)).toEqual(['metadata.pendingAlertedAt']);
    }
  });

  test('si el aviso falla, el job no se cae', async () => {
    const { notifyAdmins } = await import('../src/services/notifications.js');
    notifyAdmins.mockRejectedValueOnce(new Error('push caido'));
    estado.encontrados = [retiro(9)];
    const r = await alertPendingWithdrawals();
    expect(r.ok).toBe(true);
  });
});
