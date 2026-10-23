/**
 * reconcileVitaReversal.test.js — Vita puede revertir un payout DESPUÉS de haberlo
 * reportado completado.
 *
 * Caso real que originó esta fase: ALY-C-1792511020004-YDNVM3. Vita la reportó
 * `completed` y el job la finalizó a las 16:06 con sello en Stellar y comprobante
 * emitido; a las 19:50 Vita la pasó a `denied` y devolvió el dinero. La beneficiaria
 * nunca recibió nada y el usuario siguió viendo "Entregado" durante un día.
 *
 * Por qué el polling es el único canal que se puede probar: de las 7 transacciones con
 * payout Vita en producción, NINGUNA se cerró por un IPN (4 por reconcile, 1 denied por
 * reconcile x2, 1 manual, 1 forzada por admin). El canal de IPN de payout de Vita no se
 * ha disparado nunca, así que la red de seguridad del "Caso D" de handleVitaIPN —que sí
 * atraparía un rechazo tardío— no puede dispararse. Si el polling se detiene en
 * `completed`, no queda ningún camino por el que enterarse.
 *
 * Lo que se protege acá:
 *   • que una reversión se detecte y deje la operación en `failed`
 *   • que un 404 o un estado intermedio NO se confundan con una reversión
 *   • que la ventana de vigilancia no re-consulte lo que acaba de completarse
 *   • que un fallo de la fase A no se lleve puesta la fase B
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockGetVitaTransaction = jest.fn();
await jest.unstable_mockModule('../../src/services/vitaWalletService.js', () => ({
  getVitaTransaction: mockGetVitaTransaction,
}));

const mockFind = jest.fn();
await jest.unstable_mockModule('../../src/models/Transaction.js', () => ({
  default: { find: mockFind },
}));

await jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findById: () => ({ lean: async () => ({ email: 'u@x.com' }) }) },
}));

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  registerAuditTrail: jest.fn(async () => null),
}));

await jest.unstable_mockModule('../../src/controllers/ipnController.js', () => ({
  generateComprobanteOnCompletion: jest.fn(async () => {}),
  notifyAdminManualPayout:         jest.fn(async () => {}),
}));

await jest.unstable_mockModule('../../src/controllers/contactsController.js', () => ({
  recordSent: jest.fn(async () => {}),
}));

const mockNotify = jest.fn(async () => {});
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notify:        mockNotify,
  NOTIFICATIONS: {
    paymentFailed:    () => ({ title: 'falló' }),
    paymentCompleted: () => ({ title: 'ok' }),
  },
}));

const mockSendRawEmail = jest.fn(async () => {});
const mockSendEmail    = jest.fn(async () => {});
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  sendRawEmail: mockSendRawEmail,
  sendEmail:    mockSendEmail,
  EMAILS:       { paymentFailed: () => ['u@x.com', 'asunto', 'html'] },
}));

await jest.unstable_mockModule('../../src/utils/vitaErrorMapper.js', () => ({
  mapVitaIpnFailure: () => ({
    adminMessage: 'documento inválido',
    userMessage:  'El documento del beneficiario no es válido',
    userAction:   'Corregí el documento',
    category:     'beneficiary_data',
    retryable:    true,
  }),
}));

await jest.unstable_mockModule('../../src/utils/paymentLegs.js', () => ({
  recordPayoutLeg:  jest.fn(),
  completePayinLeg: jest.fn(),
}));

await jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { reconcileVitaTransfers } = await import('../../src/jobs/reconcileVitaTransfers.js');

/** Cadena de Mongoose: find().limit().lean(false) */
const chain = (docs) => ({ limit: () => ({ lean: async () => docs }) });

/** Transacción completada hace `haceMin` minutos, como la devuelve Mongoose. */
const completada = (over = {}) => ({
  alytoTransactionId: 'ALY-C-1792511020004-YDNVM3',
  status:             'completed',
  payoutReference:    '5dc786b8-58c6-4662-83b7-949b94cc753c',
  completedAt:        new Date(Date.now() - 4 * 60 * 60 * 1000),
  originalAmount:     240,
  originCurrency:     'BOB',
  destinationCountry: 'VE',
  userId:             'u1',
  stellarTxId:        'b55976eb',
  ipnLog:             [],
  save:               jest.fn(async function () { return this; }),
  ...over,
});

/** Devuelve la forma REAL de Vita: { transaction: { attributes: { status } } } */
const respuestaVita = (status) => ({ transaction: { attributes: { status } } });

/** Enruta find() por fase: A pide payout_sent, B pide completed. */
const conFases = ({ atascadas = [], completadas = [] }) => {
  mockFind.mockImplementation((filtro) =>
    chain(filtro.status === 'completed' ? completadas : atascadas));
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SENDGRID_ADMIN_EMAIL = 'admin@alyto.app';
  conFases({});
});

describe('detección de reversión tras finalización', () => {
  it('marca failed cuando Vita pasó a denied una transacción ya completada', async () => {
    const tx = completada();
    conFases({ completadas: [tx] });
    mockGetVitaTransaction.mockResolvedValue(respuestaVita('denied'));

    const stats = await reconcileVitaTransfers();

    expect(stats.reverted).toBe(1);
    expect(tx.status).toBe('failed');
    expect(tx.save).toHaveBeenCalled();
    expect(tx.failureReason).toMatch(/REVERSIÓN tras finalización/);
  });

  it('asienta la reversión en ipnLog sin borrar la evidencia ya emitida', async () => {
    const tx = completada();
    conFases({ completadas: [tx] });
    mockGetVitaTransaction.mockResolvedValue(respuestaVita('denied'));

    await reconcileVitaTransfers();

    const asiento = tx.ipnLog.find(e => e.eventType === 'payout_reverted_after_completed');
    expect(asiento).toBeDefined();
    expect(asiento.rawPayload.vitaStatus).toBe('denied');
    // El sello en Stellar sigue en su lugar: la reversión se suma, no reemplaza.
    expect(tx.stellarTxId).toBe('b55976eb');
    expect(asiento.rawPayload.comprobanteYaEmitido).toBe(true);
  });

  it('alerta al admin y corrige al usuario, que ya había visto "Entregado"', async () => {
    conFases({ completadas: [completada()] });
    mockGetVitaTransaction.mockResolvedValue(respuestaVita('denied'));

    await reconcileVitaTransfers();

    const [, asunto] = mockSendRawEmail.mock.calls[0];
    expect(asunto).toMatch(/Reversión tras entrega/);
    expect(mockNotify).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalled();
  });

  it('reconoce todos los estados terminales de fallo, no solo denied', async () => {
    for (const estado of ['denied', 'rejected', 'returned', 'cancelled', 'failed', 'expired']) {
      jest.clearAllMocks();
      const tx = completada();
      conFases({ completadas: [tx] });
      mockGetVitaTransaction.mockResolvedValue(respuestaVita(estado));

      const stats = await reconcileVitaTransfers();
      expect(stats.reverted).toBe(1);
      expect(tx.status).toBe('failed');
    }
  });
});

describe('lo que NO es una reversión', () => {
  it('deja intacta la transacción si Vita sigue informando completed', async () => {
    const tx = completada();
    conFases({ completadas: [tx] });
    mockGetVitaTransaction.mockResolvedValue(respuestaVita('completed'));

    const stats = await reconcileVitaTransfers();

    expect(stats.reverted).toBe(0);
    expect(tx.status).toBe('completed');
    expect(tx.save).not.toHaveBeenCalled();
  });

  it('un 404 de Vita no se confunde con una reversión', async () => {
    // 3 de las 8 completadas de producción devuelven 404. "No sé" no es "se revirtió":
    // marcar failed por falta de dato le quitaría al usuario una entrega que sí ocurrió.
    const tx = completada();
    conFases({ completadas: [tx] });
    mockGetVitaTransaction.mockRejectedValue(
      Object.assign(new Error('Transaction was not found'), { response: { status: 404 } }));

    const stats = await reconcileVitaTransfers();

    expect(stats.reverted).toBe(0);
    expect(tx.status).toBe('completed');
    expect(mockSendRawEmail).not.toHaveBeenCalled();
  });

  it('un estado intermedio tampoco cuenta como reversión', async () => {
    const tx = completada();
    conFases({ completadas: [tx] });
    mockGetVitaTransaction.mockResolvedValue(respuestaVita('processing'));

    const stats = await reconcileVitaTransfers();

    expect(stats.reverted).toBe(0);
    expect(tx.status).toBe('completed');
  });
});

describe('ventana de vigilancia', () => {
  it('pide solo completadas con referencia, dentro de la ventana y pasada la gracia', async () => {
    conFases({});
    await reconcileVitaTransfers();

    const filtro = mockFind.mock.calls.map(c => c[0]).find(f => f.status === 'completed');
    expect(filtro).toBeDefined();
    expect(filtro.providersUsed).toBe('payout:vitaWallet');
    expect(filtro.payoutReference).toEqual({ $exists: true, $ne: null });

    // La gracia evita re-consultar lo que el propio job acaba de completar; la ventana
    // acota el costo. La reversión observada llegó a las ~4h, así que debe caer dentro.
    const { $gte, $lt } = filtro.completedAt;
    const graciaMin  = (Date.now() - $lt.getTime()) / 60_000;
    const ventanaHrs = (Date.now() - $gte.getTime()) / 3_600_000;
    expect(graciaMin).toBeGreaterThanOrEqual(9);
    expect(ventanaHrs).toBeGreaterThan(4);
  });
});

describe('independencia de las fases', () => {
  it('un fallo al leer las atascadas no impide detectar una reversión', async () => {
    // Si la fase A se lleva puesta a la B, el hueco vuelve a abrirse justo cuando algo
    // ya anda mal, que es cuando más hace falta.
    const tx = completada();
    mockFind.mockImplementation((filtro) => {
      if (filtro.status === 'completed') return chain([tx]);
      throw new Error('Mongo caído para la fase A');
    });
    mockGetVitaTransaction.mockResolvedValue(respuestaVita('denied'));

    const stats = await reconcileVitaTransfers();

    expect(stats.reverted).toBe(1);
    expect(tx.status).toBe('failed');
  });
});
