/**
 * harborReversion.test.js — Harbor también puede revertir un payout ya completado.
 *
 * Es el mismo hueco que se cerró en Vita (ALY-C-1792511020004-YDNVM3: revertida 4
 * horas después de reportarse completada, con el usuario viendo "Entregado"), pero
 * Harbor NO es Vita y las pruebas se concentran justo en las diferencias:
 *
 *   1. **El ancla es `updatedAt`, no `completedAt`.** Las 3 tx Harbor completadas de
 *      producción tienen `completedAt` NULO; las 4 de Vita lo tienen. Copiar el
 *      filtro de Vita habría dejado la fase mirando el vacío, que es peor que no
 *      tenerla: parece puesta y no detecta nada.
 *   2. **Acá el dinero se movió de verdad**: el USDC salió on-chain de la tesorería,
 *      así que la reversión tiene que registrar a dónde devuelve Harbor.
 *   3. **Harbor dice `refunded` y nosotros igual marcamos `failed`**, porque lo que
 *      Harbor devuelve es el USDC a la tesorería, no los bolivianos al cliente.
 */
import '../setup.env.js';
import { jest } from '@jest/globals';

const mockGetTransferStatus = jest.fn();
await jest.unstable_mockModule('../../src/services/owlPayService.js', () => ({
  getTransferStatus: mockGetTransferStatus,
  getCustomerUuid:   () => 'cus_test',
}));

const mockFind = jest.fn();
await jest.unstable_mockModule('../../src/models/Transaction.js', () => ({
  default: { find: mockFind },
}));

await jest.unstable_mockModule('../../src/models/TransactionConfig.js', () => ({
  default: { findOne: () => ({ lean: async () => null }) },
}));

const mockSendRawEmail = jest.fn(async () => {});
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  sendRawEmail: mockSendRawEmail,
}));

const mockNotifyFailed = jest.fn(async () => {});
await jest.unstable_mockModule('../../src/controllers/ipnController.js', () => ({
  tryOwlPayV2:                     jest.fn(),
  generateComprobanteOnCompletion: jest.fn(async () => {}),
  notifyTransactionCompleted:      jest.fn(async () => {}),
  notifyTransactionFailed:         mockNotifyFailed,
}));

await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  registerAuditTrail: jest.fn(async () => null),
}));

await jest.unstable_mockModule('../../src/utils/harborErrorMapper.js', () => ({
  mapHarborError: () => ({ adminMessage: 'x', category: 'TRANSIENT_ERROR', retryable: false }),
}));

await jest.unstable_mockModule('../../src/utils/paymentLegs.js', () => ({
  recordPayoutLeg:  jest.fn(),
  completePayinLeg: jest.fn(),
}));

const { reconcileHarborTransfers } = await import('../../src/jobs/reconcileHarborTransfers.js');

/** Transacción Harbor completada. `completedAt` NULO, como en producción. */
const completada = (over = {}) => ({
  alytoTransactionId: 'ALY-C-1783034406134-5T1HCY',
  status:             'completed',
  completedAt:        null,
  updatedAt:          new Date(Date.now() - 3 * 60 * 60 * 1000),
  harborTransfer:     { transferId: 'transfer_4vTqSnsxU' },
  digitalAssetAmount: 37.07,
  originalAmount:     480,
  originCurrency:     'BOB',
  destinationCountry: 'US',
  stellarTxId:        'abc123',
  ipnLog:             [],
  save:               jest.fn(async function () { return this; }),
  ...over,
});

/** Respuesta real de Harbor: el estado va anidado en `data`. */
const respuesta = (status, extra = {}) => ({
  data: { uuid: 'transfer_4vTqSnsxU', object: 'transfer', status, ...extra },
});

/** Enruta find() por fase: la de reversiones pide status 'completed'. */
const conCompletadas = (docs) => {
  mockFind.mockImplementation((filtro) => {
    const res = filtro.status === 'completed' ? docs : [];
    return { limit: () => res };
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SENDGRID_ADMIN_EMAIL = 'admin@alyto.app';
  conCompletadas([]);
});

describe('detección de reversión', () => {
  it('detecta la reversión y deja la operación en failed', async () => {
    const tx = completada();
    conCompletadas([tx]);
    mockGetTransferStatus.mockResolvedValue(respuesta('failed'));

    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(1);
    expect(tx.status).toBe('failed');
    expect(tx.failureCategory).toBe('PROVIDER_REVERSAL');
    expect(tx.failureReason).toMatch(/REVERSIÓN tras finalización/);
  });

  it('Harbor dice "refunded" y la operación igual queda en failed', async () => {
    // Lo que Harbor devuelve es el USDC a la tesorería, no los bolivianos al
    // cliente. Marcar 'refunded' afirmaría una devolución al usuario que no ocurrió.
    const tx = completada();
    conCompletadas([tx]);
    mockGetTransferStatus.mockResolvedValue(respuesta('refunded'));

    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(1);
    expect(tx.status).toBe('failed');
  });

  it('registra a dónde devuelve Harbor el USDC, que salió de la tesorería', async () => {
    const tx = completada();
    conCompletadas([tx]);
    mockGetTransferStatus.mockResolvedValue(
      respuesta('refunded', { refund_address: 'GDESTINO123', sub_status: 'bank_rejected' }));

    await reconcileHarborTransfers();

    const asiento = tx.ipnLog.find(e => e.eventType === 'payout_reverted_after_completed');
    expect(asiento.rawPayload.refundAddress).toBe('GDESTINO123');
    expect(asiento.rawPayload.harborSubStatus).toBe('bank_rejected');
    expect(asiento.rawPayload.usdcEnviado).toBe(37.07);
    // La evidencia previa no se toca.
    expect(tx.stellarTxId).toBe('abc123');
  });

  it('alerta al admin con la dirección de devolución y avisa al usuario', async () => {
    conCompletadas([completada()]);
    mockGetTransferStatus.mockResolvedValue(respuesta('failed', { refund_address: 'GDEVUELVE' }));

    await reconcileHarborTransfers();

    const [, asunto, html] = mockSendRawEmail.mock.calls[0];
    expect(asunto).toMatch(/Reversión Harbor tras entrega/);
    expect(html).toMatch(/GDEVUELVE/);
    expect(html).toMatch(/DÓNDE ESTÁ EL USDC/);
    expect(mockNotifyFailed).toHaveBeenCalled();
  });

  it('reconoce los demás estados terminales, no solo failed', async () => {
    for (const estado of ['expired', 'cancelled', 'canceled', 'refunded']) {
      jest.clearAllMocks();
      const tx = completada();
      conCompletadas([tx]);
      mockGetTransferStatus.mockResolvedValue(respuesta(estado));

      const stats = await reconcileHarborTransfers();
      expect(stats.reverted).toBe(1);
      expect(tx.status).toBe('failed');
    }
  });
});

describe('lo que NO es una reversión', () => {
  it('si Harbor sigue diciendo completed, no toca nada', async () => {
    const tx = completada();
    conCompletadas([tx]);
    mockGetTransferStatus.mockResolvedValue(respuesta('completed'));

    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(0);
    expect(tx.status).toBe('completed');
    expect(tx.save).not.toHaveBeenCalled();
  });

  it('un error al consultar Harbor no se confunde con una reversión', async () => {
    // Sin dato no se afirma nada: marcar failed por un fallo de red le quitaría al
    // usuario una entrega que sí ocurrió.
    const tx = completada();
    conCompletadas([tx]);
    mockGetTransferStatus.mockRejectedValue(new Error('timeout'));

    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(0);
    expect(tx.status).toBe('completed');
    expect(mockSendRawEmail).not.toHaveBeenCalled();
  });

  it('un estado intermedio tampoco cuenta', async () => {
    const tx = completada();
    conCompletadas([tx]);
    mockGetTransferStatus.mockResolvedValue(respuesta('source_received'));

    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(0);
    expect(tx.status).toBe('completed');
  });
});

describe('la ventana se ancla en updatedAt, no en completedAt', () => {
  it('filtra por updatedAt — con completedAt la fase quedaría inerte en Harbor', async () => {
    // Las 3 tx Harbor completadas de producción tienen completedAt NULO. Si el
    // filtro usara ese campo, no devolvería NUNCA nada y la red de seguridad
    // existiría solo en el papel.
    conCompletadas([]);
    await reconcileHarborTransfers();

    const filtro = mockFind.mock.calls.map(c => c[0]).find(f => f.status === 'completed');
    expect(filtro).toBeDefined();
    expect(filtro.updatedAt).toBeDefined();
    expect(filtro.completedAt).toBeUndefined();
    expect(filtro['harborTransfer.transferId']).toEqual({ $exists: true, $ne: null });

    const graciaMin  = (Date.now() - filtro.updatedAt.$lt.getTime()) / 60_000;
    const ventanaHrs = (Date.now() - filtro.updatedAt.$gte.getTime()) / 3_600_000;
    expect(graciaMin).toBeGreaterThanOrEqual(9);
    expect(ventanaHrs).toBeGreaterThan(4);
  });

  it('una tx con completedAt nulo igual entra en la vigilancia', async () => {
    const tx = completada({ completedAt: null });
    conCompletadas([tx]);
    mockGetTransferStatus.mockResolvedValue(respuesta('failed'));

    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(1);
  });
});

describe('independencia de las fases', () => {
  it('un fallo en la fase de reversiones no impide el resto del job', async () => {
    mockFind.mockImplementation((filtro) => {
      if (filtro.status === 'completed') throw new Error('Mongo caído');
      return { limit: () => [] };
    });

    // No debe lanzar: el job sigue y devuelve sus estadísticas.
    const stats = await reconcileHarborTransfers();

    expect(stats.reverted).toBe(0);
    expect(stats).toHaveProperty('reconciled');
  });
});
