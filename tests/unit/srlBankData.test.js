/**
 * srlBankData.test.js
 *
 * La cuenta bancaria que se le informa al usuario boliviano se leía en tres
 * lugares con criterios distintos. El de `walletController.initiateDeposit` iba
 * directo al env y se había desalineado: el 2026-10-01 se verificó contra
 * producción que `SRL_ACCOUNT_NUMBER` del `.env` del VPS apunta a una cuenta
 * distinta de `srl_config.bankData.accountNumber`, y que esta última es la misma
 * donde cobra el QR de BANECO. El depósito de billetera le dictaba al usuario
 * una cuenta a la que no llega ningún cobro automático.
 *
 * Run: NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/srlBankData.test.js
 */

import { jest } from '@jest/globals';

const mockLean = jest.fn();

await jest.unstable_mockModule('../../src/models/SRLConfig.js', () => ({
  default: {
    findOne: () => ({ select: () => ({ lean: mockLean }) }),
  },
}));

const { getSrlBankData } = await import('../../src/services/srlBankData.js');

/** Lo que hay hoy en el `.env` del VPS: otra cuenta, y con el banco mal escrito. */
function envDesalineado() {
  process.env.SRL_BANK_NAME      = 'Banco Economico';
  process.env.SRL_ACCOUNT_HOLDER = 'AV Finance SRL';
  process.env.SRL_ACCOUNT_NUMBER = '9999999999';
  process.env.SRL_ACCOUNT_TYPE   = 'Cuenta Corriente';
}

/** Lo que hay hoy en Mongo: la cuenta donde realmente cobra el QR. */
const BANK_DATA_DB = {
  bankName:      'Banco Económico',
  accountHolder: 'AV FINANCE SRL',
  accountNumber: '2111088816',
  accountType:   'Caja de Ahorro',
};

beforeEach(() => {
  mockLean.mockReset();
  envDesalineado();
});

describe('getSrlBankData', () => {
  test('la DB le gana al env — es la cuenta donde cobra el QR', async () => {
    mockLean.mockResolvedValue({ bankData: BANK_DATA_DB });

    await expect(getSrlBankData()).resolves.toEqual(BANK_DATA_DB);
  });

  test('no devuelve la cuenta del env cuando la DB tiene una distinta', async () => {
    mockLean.mockResolvedValue({ bankData: BANK_DATA_DB });

    const { accountNumber } = await getSrlBankData();

    expect(accountNumber).toBe('2111088816');
    expect(accountNumber).not.toBe(process.env.SRL_ACCOUNT_NUMBER);
  });

  test('la precedencia es por campo: un bankData a medias no borra el resto', async () => {
    mockLean.mockResolvedValue({ bankData: { accountNumber: '2111088816' } });

    const datos = await getSrlBankData();

    expect(datos.accountNumber).toBe('2111088816');   // de la DB
    expect(datos.bankName).toBe('Banco Economico');   // cae al env, no queda vacío
  });

  test('sin documento en la DB cae al env', async () => {
    mockLean.mockResolvedValue(null);

    await expect(getSrlBankData()).resolves.toMatchObject({ accountNumber: '9999999999' });
  });

  test('si Mongo falla reusa la última lectura buena antes que el env', async () => {
    mockLean.mockResolvedValueOnce({ bankData: BANK_DATA_DB });
    await getSrlBankData();

    mockLean.mockRejectedValueOnce(new Error('conexión caída'));

    // El env es justamente el que demostró estar desactualizado: preferimos el
    // último dato bueno antes que volver a dictar una cuenta equivocada.
    await expect(getSrlBankData()).resolves.toMatchObject({ accountNumber: '2111088816' });
  });
});

describe('segregación por destino de fondos', () => {
  const CUENTA_WALLET = {
    bankName: 'Banco Económico', accountHolder: 'AV FINANCE SRL',
    accountNumber: '1111111111', accountType: 'Caja de Ahorro',
  };
  const CUENTA_XB = {
    bankName: 'Banco Económico', accountHolder: 'AV FINANCE SRL',
    accountNumber: '2222222222', accountType: 'Caja de Ahorro',
  };

  test('cada propósito cobra en su propia cuenta', async () => {
    mockLean.mockResolvedValue({
      bankData: BANK_DATA_DB,
      bankAccounts: { wallet_deposit: CUENTA_WALLET, crossborder_payin: CUENTA_XB },
    });

    await expect(getSrlBankData('wallet_deposit')).resolves.toMatchObject({ accountNumber: '1111111111' });
    await expect(getSrlBankData('crossborder_payin')).resolves.toMatchObject({ accountNumber: '2222222222' });
  });

  test('sin bankAccounts el comportamiento es el de antes', async () => {
    // Es lo que permite desplegar esto antes de tener las cuentas nuevas.
    mockLean.mockResolvedValue({ bankData: BANK_DATA_DB });

    await expect(getSrlBankData('wallet_deposit')).resolves.toEqual(BANK_DATA_DB);
    await expect(getSrlBankData('crossborder_payin')).resolves.toEqual(BANK_DATA_DB);
    await expect(getSrlBankData()).resolves.toEqual(BANK_DATA_DB);
  });

  test('una cuenta a medio cargar completa con bankData, no deja campos vacíos', async () => {
    mockLean.mockResolvedValue({
      bankData: BANK_DATA_DB,
      bankAccounts: { wallet_deposit: { accountNumber: '1111111111' } },
    });

    const d = await getSrlBankData('wallet_deposit');
    expect(d.accountNumber).toBe('1111111111');       // de la cuenta del propósito
    expect(d.accountType).toBe('Caja de Ahorro');     // completado con bankData
    expect(d.bankName).toBe('Banco Económico');
  });

  test('un propósito desconocido no toma una cuenta ajena', async () => {
    mockLean.mockResolvedValue({
      bankData: BANK_DATA_DB,
      bankAccounts: { wallet_deposit: CUENTA_WALLET },
    });

    await expect(getSrlBankData('gasto_empresa')).resolves.toEqual(BANK_DATA_DB);
  });
});
