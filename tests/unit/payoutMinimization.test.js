/**
 * payoutMinimization.test.js — Minimización de datos hacia las redes de liquidación.
 *
 * Acredita el control declarado ante ASFI: la instrucción que se envía a la red de
 * liquidación contiene únicamente los datos del BENEFICIARIO necesarios para el pago,
 * y NINGÚN dato del ordenante. La prueba construye la instrucción para varios destinos
 * y verifica que el objeto resultante no contiene datos del ordenante.
 */
import '../setup.env.js';

const { buildPayoutInstrument } = await import('../../src/services/owlPayService.js');

// Beneficiario completo. Se le agregan a propósito datos del ORDENANTE que NO deben
// aparecer en la instrucción a la red.
const beneficiario = {
  firstName: 'Beneficiario', lastName: 'Destino',
  dynamicFields: {
    account_holder_name: 'Beneficiario Destino',
    bank_name: 'Banco Destino', account_number: '1234567890', swift_code: 'ABCDEFGH',
    // Ruido: campos del ordenante que jamás deberían viajar a la red.
    sender_name: 'Ordenante Boliviano', sender_document: '9876543',
    ordenante: 'AV Finance S.R.L.', origin_account: 'BO-000',
  },
};

// Denominaciones de datos del ordenante que NO deben aparecer en ninguna instrucción.
const CLAVES_ORDENANTE = /sender|ordenante|origin|remitente|payer|from_/i;
const VALORES_ORDENANTE = ['Ordenante Boliviano', '9876543', 'AV Finance S.R.L.', 'BO-000'];

describe('la instrucción a la red de liquidación no transporta datos del ordenante', () => {

  it.each(['CN', 'NG'])('destino %s: la instrucción sólo contiene datos del beneficiario', (pais) => {
    const instr = buildPayoutInstrument(beneficiario, pais);
    const serial = JSON.stringify(instr);

    // Ninguna clave del ordenante.
    for (const k of Object.keys(instr)) {
      expect(k).not.toMatch(CLAVES_ORDENANTE);
    }
    // Ningún valor del ordenante, ni siquiera embebido.
    for (const v of VALORES_ORDENANTE) {
      expect(serial).not.toContain(v);
    }
    // Y sí contiene el dato del beneficiario que corresponde.
    expect(instr.account_holder_name).toBe('Beneficiario Destino');
    expect(instr.bank_name).toBe('Banco Destino');
  });

  it('el titular cae al nombre del beneficiario, nunca al del ordenante', () => {
    const soloNombre = { firstName: 'Ana', lastName: 'Pérez', dynamicFields: {
      bank_name: 'B', account_number: '1', swift_code: 'S',
      sender_name: 'NO-DEBE-APARECER',
    } };
    const instr = buildPayoutInstrument(soloNombre, 'CN');
    expect(instr.account_holder_name).toBe('Ana Pérez');
    expect(JSON.stringify(instr)).not.toContain('NO-DEBE-APARECER');
  });
});
