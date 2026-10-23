/**
 * transformVitaField.test.js
 *
 * Fija el contrato del mapeador que normaliza los campos de Vita para el
 * frontend. Existe por un fallo concreto: `regex_validate` y `regex_message`
 * no se copiaban, y como el frontend valida contra `field.pattern` y muestra
 * `field.hint`, la validación de formato y el texto de ayuda llevaban muertos
 * en los 27 destinos de Vita sin que nadie lo notara.
 *
 * Se descubrió porque tres envíos a Venezuela fueron rechazados por Vita por
 * el formato de `account_bank` y de `document_number`, errores que el usuario
 * solo veía DESPUÉS de confirmar la transferencia.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/transformVitaField.test.js
 */

import { jest } from '@jest/globals'

process.env.VITA_LOGIN     = 'test-login'
process.env.VITA_TRANS_KEY = 'test-transkey'
process.env.VITA_SECRET    = 'test-secret'

const { transformVitaField } = await import('../src/controllers/paymentController.js')

// Campo real de la respuesta de Vita para Venezuela: la expresión trae la lista
// de códigos de banco válidos mantenida por ellos, más 16 dígitos. 20 en total.
const CAMPO_VE_CUENTA = {
  type: 'text',
  name: 'Número de cuenta',
  key:  'account_bank',
  min:  20,
  max:  20,
  regex_validate: '^(0102|0156|0172|0114|0171|0166|0175|0128|0163|0115|0151|0173|0105|0191|0138|0137|0104|0168|0134|0177|0146|0174|0108|0157|0169|0116)\\d{16}$',
  regex_message:  'Debe comenzar con el código de su banco seguido de 16 dígitos.',
}

describe('transformVitaField', () => {
  test('propaga regex_validate a pattern — el frontend valida contra ese nombre', () => {
    const out = transformVitaField(CAMPO_VE_CUENTA)
    expect(out.pattern).toBe(CAMPO_VE_CUENTA.regex_validate)
  })

  test('propaga regex_message a hint — el frontend lo muestra bajo el campo', () => {
    const out = transformVitaField(CAMPO_VE_CUENTA)
    expect(out.hint).toBe(CAMPO_VE_CUENTA.regex_message)
  })

  test('la expresión propagada rechaza lo que Vita rechazaba y acepta lo válido', () => {
    const { pattern } = transformVitaField(CAMPO_VE_CUENTA)
    const re = new RegExp(pattern)

    // Lo que falló en producción el 14-oct: con espacios y sin 20 dígitos.
    expect(re.test('0102 1234 5678 9012 3456')).toBe(false)
    expect(re.test('123456')).toBe(false)
    // Código de banco inexistente, con la longitud correcta.
    expect(re.test('99991234567890123456')).toBe(false)
    // Válido: código 0102 (Banco de Venezuela) + 16 dígitos.
    expect(re.test('01021234567890123456')).toBe(true)
  })

  test('sin regex, pattern y hint quedan en null y no rompen al frontend', () => {
    const out = transformVitaField({ type: 'text', name: 'Nombres', key: 'beneficiary_first_name', min: 3, max: 50 })
    expect(out.pattern).toBeNull()
    expect(out.hint).toBeNull()
  })

  test('conserva el resto del contrato que ya consumía el frontend', () => {
    const out = transformVitaField(CAMPO_VE_CUENTA)
    expect(out).toMatchObject({
      key:      'account_bank',
      label:    'Número de cuenta',
      type:     'text',
      required: true,
      min:      20,
      max:      20,
      options:  [],
      when:     null,
    })
  })

  test('un tipo desconocido cae a text, y un campo sin key se descarta', () => {
    expect(transformVitaField({ key: 'x', type: 'datetime-picker' }).type).toBe('text')
    expect(transformVitaField({ type: 'text' })).toBeNull()
    expect(transformVitaField(null)).toBeNull()
  })
})
