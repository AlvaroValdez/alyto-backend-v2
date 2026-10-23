/**
 * providerContract.test.js — El contrato con el proveedor.
 *
 * Los fixtures de abajo NO son inventados: son la forma REAL de la respuesta de
 * Vita, capturada de producción el 2026-10-14. Eso importa, porque el bug que
 * esta prueba previene nació justamente de escribir código contra la
 * documentación en vez de contra la API.
 *
 * El primer caso es la regresión de `bo-ve`: el corredor decía USD, Vita declara
 * VES, y la cotización prometía "USD 17.252,88" por Bs 240.
 */

import '../setup.env.js'
import {
  compararCorredor,
  camposNoConsumidos,
  atributosDeCampoNoConsumidos,
  SEVERIDAD,
} from '../../src/services/providerContract.js'

// Reglas reales de Venezuela, de producción.
const REGLAS_VE = {
  name: 'Venezuela',
  currency_iso_code: 'VES',
  currency_name: 'Bolívar Soberano',
  currency_decimals: 2,
  flag_url: 'https://api.vitawallet.io/mailers/flags/VE.png',
  fields: [
    { type: 'text', key: 'beneficiary_document_number', min: 6, max: 10,
      regex_validate: '^\\d+$', regex_message: 'Solo se permiten números' },
    { type: 'text', key: 'account_bank', min: 20, max: 20,
      regex_validate: '^(0102|0156)\\d{16}$',
      regex_message: 'El número de cuenta debe tener 20 dígitos y comenzar con un código de banco válido.' },
  ],
}

// Chile: el caso de decimales. CLP no tiene centavos.
const REGLAS_CL = { name: 'Chile', currency_iso_code: 'CLP', currency_decimals: 0, fields: [] }

describe('contrato con el proveedor — moneda', () => {
  it('REGRESIÓN bo-ve: detecta que el corredor dice USD y Vita liquida VES', () => {
    const h = compararCorredor(
      { corridorId: 'bo-ve', destinationCountry: 'VE', destinationCurrency: 'USD' },
      REGLAS_VE,
    )
    const moneda = h.find(x => x.check === 'moneda')
    expect(moneda).toBeDefined()
    expect(moneda.severidad).toBe(SEVERIDAD.CRITICO)
    expect(moneda.esperado).toBe('VES')
    expect(moneda.encontrado).toBe('USD')
  })

  it('no reporta nada cuando la moneda coincide', () => {
    const h = compararCorredor(
      { corridorId: 'bo-ve', destinationCountry: 'VE', destinationCurrency: 'VES' },
      REGLAS_VE,
    )
    expect(h.filter(x => x.check === 'moneda')).toHaveLength(0)
  })
})

describe('contrato con el proveedor — decimales', () => {
  it('avisa (sin bloquear) cuando el proveedor declara 0 decimales', () => {
    const h = compararCorredor(
      { corridorId: 'bo-cl', destinationCountry: 'CL', destinationCurrency: 'CLP' },
      REGLAS_CL,
    )
    const dec = h.find(x => x.check === 'decimales')
    expect(dec).toBeDefined()
    // Aviso y no crítico: verificamos contra el histórico que Vita los acepta.
    expect(dec.severidad).toBe(SEVERIDAD.AVISO)
    expect(dec.esperado).toBe(0)
  })

  it('no avisa cuando el proveedor declara 2 decimales', () => {
    const h = compararCorredor(
      { corridorId: 'bo-ve', destinationCountry: 'VE', destinationCurrency: 'VES' },
      REGLAS_VE,
    )
    expect(h.filter(x => x.check === 'decimales')).toHaveLength(0)
  })
})

describe('contrato con el proveedor — mínimo', () => {
  it('bloquea si el mínimo efectivo cae por debajo del piso del proveedor', () => {
    const h = compararCorredor(
      { corridorId: 'bo-au', destinationCountry: 'AU', destinationCurrency: 'AUD' },
      { currency_iso_code: 'AUD', currency_decimals: 2, fields: [] },
      { minProveedorUSD: 50, minEfectivoUSD: 20 },
    )
    const min = h.find(x => x.check === 'minimo')
    expect(min).toBeDefined()
    expect(min.severidad).toBe(SEVERIDAD.CRITICO)
  })

  it('congela el comportamiento actual: con el piso aplicado no hay hallazgo', () => {
    const h = compararCorredor(
      { corridorId: 'bo-au', destinationCountry: 'AU', destinationCurrency: 'AUD' },
      { currency_iso_code: 'AUD', currency_decimals: 2, fields: [] },
      { minProveedorUSD: 50, minEfectivoUSD: 51.69 },   // valor real de producción
    )
    expect(h.filter(x => x.check === 'minimo')).toHaveLength(0)
  })
})

describe('contrato con el proveedor — bordes', () => {
  it('un país sin reglas publicadas no genera hallazgos', () => {
    // GT y SV no traen withdrawal_rules. "No sé" no es "está mal".
    expect(compararCorredor({ corridorId: 'bo-gt', destinationCurrency: 'GTQ' }, null)).toEqual([])
  })

  it('no inventa hallazgos si el proveedor omite la moneda', () => {
    const h = compararCorredor(
      { corridorId: 'x', destinationCurrency: 'USD' },
      { currency_decimals: 2, fields: [] },
    )
    expect(h.filter(x => x.check === 'moneda')).toHaveLength(0)
  })
})

describe('detección de datos que el proveedor manda y no consumimos', () => {
  it('lista los campos de país no consumidos', () => {
    const fuera = camposNoConsumidos(REGLAS_VE, ['currency_iso_code', 'currency_decimals', 'name'])
    expect(fuera).toContain('currency_name')
    expect(fuera).toContain('flag_url')
    expect(fuera).not.toContain('fields')          // se recorre aparte
    expect(fuera).not.toContain('currency_iso_code')
  })

  it('REGRESIÓN: habría expuesto `regex_validate` antes de que costara dos operaciones', () => {
    // Lo que la validación miraba ANTES del 2026-10-14.
    const consumidosViejos = ['type', 'key', 'name', 'options', 'when']
    const fuera = atributosDeCampoNoConsumidos(REGLAS_VE.fields, consumidosViejos)
    const attrs = fuera.map(x => x.atributo)
    expect(attrs).toContain('regex_validate')
    expect(attrs).toContain('min')
    expect(attrs).toContain('max')
  })

  it('con la validación actual, los atributos de formato ya no figuran como ignorados', () => {
    const consumidosHoy = ['type', 'key', 'name', 'options', 'when', 'regex_validate', 'regex_message', 'min', 'max']
    const fuera = atributosDeCampoNoConsumidos(REGLAS_VE.fields, consumidosHoy)
    expect(fuera).toHaveLength(0)
  })

  it('tolera entradas vacías o mal formadas sin romper', () => {
    expect(camposNoConsumidos(null)).toEqual([])
    expect(atributosDeCampoNoConsumidos(undefined)).toEqual([])
    expect(atributosDeCampoNoConsumidos([null])).toEqual([])
  })
})
