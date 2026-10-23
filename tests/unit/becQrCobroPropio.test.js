/**
 * becQrCobroPropio.test.js
 *
 * Dos defectos que se detectaron el 2026-10-01 cruzando producción contra el
 * extracto de BANECO de septiembre:
 *
 *   1. El banco informa el momento del pago sin zona horaria, en hora de Bolivia.
 *      Al reconcatenarlo, el VPS (que corre en UTC) lo guardaba cuatro horas
 *      antes. Caso real: el cobro de Bs 1 del 07/Sep figura en el banco a las
 *      19:27:27 de Bolivia y en nuestra base quedó como 19:27:28Z.
 *
 *   2. `statusQR` responde por cualquier QR del banco, también los de otros
 *      comercios. `paidQR` sí está acotado a nuestra cuenta. Sin esa distinción
 *      un cobro ajeno notificado por error y un cobro propio del que perdimos el
 *      registro se ven idénticos en el log.
 *
 * Corre con TZ=UTC, que es como corre el VPS.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/becQrCobroPropio.test.js
 */

import { jest } from '@jest/globals';

process.env.BEC_BASE_URL       = 'https://apimkt.example.test/ApiGateway';
process.env.BEC_USERNAME       = 'usuario-test';
process.env.BEC_PASSWORD       = 'clave-test';
process.env.BEC_AES_KEY        = '01234567890123456789012345678901'; // 32 chars = AES-256
process.env.BEC_ACCOUNT_CREDIT = '2111088816';
delete process.env.BEC_MOCK_ENABLED;

/** El pago real del 07/Sep tal como lo devolvió BANECO, con los nombres anonimizados. */
const PAGO_REAL = {
  qrId:          '26090701016749150217',
  transactionId: '386842717',
  paymentDate:   '2026-09-07T00:00:00',
  paymentTime:   '19:27:28',
  currency:      'BOB',
  amount:        1,
  description:   'Alyto prueba WTX-1788823585280-WBO14U',
};

/** Respuestas por ruta. Login incluido porque apiFetch pide token antes de cada llamada. */
function mockBanco(porRuta) {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/authentication/authenticate')) {
      return { ok: true, status: 200, json: async () => ({ responseCode: 0, token: 'tok', message: '' }) };
    }
    for (const [fragmento, cuerpo] of Object.entries(porRuta)) {
      if (u.includes(fragmento)) {
        return { ok: true, status: 200, json: async () => cuerpo };
      }
    }
    throw new Error(`ruta no mockeada: ${u}`);
  });
}

const bec = await import('../../src/services/bankQr/banks/becQrService.js');

describe('BEC — hora de Bolivia en el momento del pago', () => {
  test('getQRStatus resuelve paidAt al instante real, no cuatro horas antes', async () => {
    mockBanco({ '/statusQR/': { responseCode: 0, statusQrCode: 1, payment: [PAGO_REAL] } });

    const { status, payment } = await bec.getQRStatus(PAGO_REAL.qrId);

    expect(status).toBe('paid');
    // 19:27:28 en Bolivia (UTC-4) es 23:27:28 UTC. Antes del arreglo se guardaba 19:27:28Z.
    expect(payment.paidAt.toISOString()).toBe('2026-09-07T23:27:28.000Z');
    expect(payment.paidAt.toISOString()).not.toBe('2026-09-07T19:27:28.000Z');
  });

  test('la hora normalizada lleva el desplazamiento pegado, para los consumidores que reconcatenan', async () => {
    mockBanco({ '/statusQR/': { responseCode: 0, statusQrCode: 1, payment: [PAGO_REAL] } });

    const { payment } = await bec.getQRStatus(PAGO_REAL.qrId);

    expect(payment.paymentTime).toBe('19:27:28-04:00');
    // Esta es la concatenación que hacen ipnController, walletController y el job.
    const reconcatenado = new Date(`${payment.paymentDate.split('T')[0]}T${payment.paymentTime}`);
    expect(reconcatenado.toISOString()).toBe('2026-09-07T23:27:28.000Z');
  });

  test('no vuelve a desplazar una hora que ya trae zona', async () => {
    const yaZonificado = { ...PAGO_REAL, paymentTime: '19:27:28-04:00' };
    mockBanco({ '/statusQR/': { responseCode: 0, statusQrCode: 1, payment: [yaZonificado] } });

    const { payment } = await bec.getQRStatus(PAGO_REAL.qrId);

    expect(payment.paymentTime).toBe('19:27:28-04:00');
    expect(payment.paidAt.toISOString()).toBe('2026-09-07T23:27:28.000Z');
  });

  test('un pago sin hora no revienta ni inventa un instante', async () => {
    const sinHora = { ...PAGO_REAL, paymentTime: '' };
    mockBanco({ '/statusQR/': { responseCode: 0, statusQrCode: 1, payment: [sinHora] } });

    const { payment } = await bec.getQRStatus(PAGO_REAL.qrId);

    expect(payment.paidAt).toBeNull();
  });

  test('getPaidQRs normaliza toda la lista', async () => {
    mockBanco({ '/paidQR/': { responseCode: 0, paymentList: [PAGO_REAL] } });

    const lista = await bec.getPaidQRs(new Date('2026-09-07T12:00:00Z'));

    expect(lista).toHaveLength(1);
    expect(lista[0].paidAt.toISOString()).toBe('2026-09-07T23:27:28.000Z');
  });
});

describe('BEC — distinguir un cobro propio de uno ajeno', () => {
  test('el QR que aparece en la lista del día es propio', async () => {
    mockBanco({ '/paidQR/': { responseCode: 0, paymentList: [PAGO_REAL] } });

    await expect(bec.esCobroPropio(PAGO_REAL.qrId, new Date('2026-09-07T12:00:00Z')))
      .resolves.toBe(true);
  });

  test('el QR ausente de la lista es ajeno, aunque statusQR lo reporte pagado', async () => {
    // Caso real del 17/Sep: BANECO notificó un cobro de Bs 150 de otro comercio.
    // statusQR lo da por pagado; paidQR del día vuelve vacío porque no es nuestro.
    mockBanco({
      '/paidQR/':   { responseCode: 0, paymentList: [] },
      '/statusQR/': { responseCode: 0, statusQrCode: 1, payment: [{ qrId: '26091701016906097691', amount: 150 }] },
    });

    await expect(bec.esCobroPropio('26091701016906097691', new Date('2026-09-17T12:00:00Z')))
      .resolves.toBe(false);
    // Y que quede constancia de que statusQR sí responde por un QR ajeno:
    await expect(bec.getQRStatus('26091701016906097691')).resolves.toMatchObject({ status: 'paid' });
  });

  test('si el banco falla devuelve null, nunca un false que acuse en falso', async () => {
    mockBanco({ '/paidQR/': { responseCode: 9, message: 'servicio no disponible' } });

    await expect(bec.esCobroPropio(PAGO_REAL.qrId, new Date('2026-09-07T12:00:00Z')))
      .resolves.toBeNull();
  });
});

describe('BEC — Capa 1 del webhook, sin salir a la red', () => {
  const reqCon = (headers = {}) => ({ headers, rawBody: '{}' });

  afterEach(() => { delete process.env.BEC_IPN_BEARER_TOKEN; });

  test('no hace ninguna llamada al banco', () => {
    // Es la razón de ser de esta función: el endpoint de IPN es público y sin
    // rate limit, así que autenticar no puede costar una llamada saliente, o
    // cualquiera podría usarnos de amplificador contra el banco.
    process.env.BEC_IPN_BEARER_TOKEN = 'token-bueno';
    global.fetch = jest.fn();

    bec.verifyWebhookAuth(reqCon({ authorization: 'Bearer token-bueno' }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('acepta el token correcto e informa la capa usada', () => {
    process.env.BEC_IPN_BEARER_TOKEN = 'token-bueno';

    expect(bec.verifyWebhookAuth(reqCon({ authorization: 'Bearer token-bueno' })))
      .toEqual({ ok: true, layer: 'bearer' });
  });

  test('rechaza un token distinto y uno ausente', () => {
    process.env.BEC_IPN_BEARER_TOKEN = 'token-bueno';

    expect(bec.verifyWebhookAuth(reqCon({ authorization: 'Bearer token-malo' })))
      .toMatchObject({ ok: false, reason: 'bad-bearer' });
    expect(bec.verifyWebhookAuth(reqCon()))
      .toMatchObject({ ok: false, reason: 'bad-bearer' });
  });

  test('en producción sin ningún mecanismo configurado, falla cerrado', () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(bec.verifyWebhookAuth(reqCon()))
        .toMatchObject({ ok: false, reason: 'no-webhook-auth-configured' });
    } finally {
      process.env.NODE_ENV = antes;
    }
  });
});

describe('BEC — una cuenta de abono por destino de fondos', () => {
  /** Devuelve el accountCredit cifrado que se le mandó al banco en cada generateQR. */
  function capturarCuentas() {
    const enviados = [];
    global.fetch = jest.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/api/authentication/authenticate')) {
        return { ok: true, status: 200, json: async () => ({ responseCode: 0, token: 'tok', message: '' }) };
      }
      if (u.includes('/generateQR')) {
        enviados.push(JSON.parse(init.body).accountCredit);
        return { ok: true, status: 200, json: async () => ({ responseCode: 0, qrId: 'q', qrImage: 'i' }) };
      }
      throw new Error(`ruta no mockeada: ${u}`);
    });
    return enviados;
  }

  const base = { transactionId: 'ALY-C-1', amount: 10, dueDate: '2026-10-02' };

  test('dos cuentas distintas producen cifrados distintos', async () => {
    // El bug que esto previene: con la caché anterior, de una sola variable de
    // módulo, el segundo QR se habría cobrado en la PRIMERA cuenta, sin error.
    const enviados = capturarCuentas();

    await bec.generateQR({ ...base, accountCredit: '1111111111' });
    await bec.generateQR({ ...base, accountCredit: '2222222222' });

    expect(enviados).toHaveLength(2);
    expect(enviados[0]).not.toBe(enviados[1]);
  });

  test('la misma cuenta reusa el cifrado cacheado', async () => {
    const enviados = capturarCuentas();

    await bec.generateQR({ ...base, accountCredit: '3333333333' });
    await bec.generateQR({ ...base, accountCredit: '3333333333' });

    expect(enviados[0]).toBe(enviados[1]);
  });

  test('sin cuenta explícita usa BEC_ACCOUNT_CREDIT (comportamiento previo)', async () => {
    const enviados = capturarCuentas();

    await bec.generateQR({ ...base });
    await bec.generateQR({ ...base, accountCredit: process.env.BEC_ACCOUNT_CREDIT });

    expect(enviados[0]).toBe(enviados[1]);
  });
});
