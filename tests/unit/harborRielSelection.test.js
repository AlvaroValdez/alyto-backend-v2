/**
 * harborRielSelection.test.js — Selección de riel Harbor (2026-10-05).
 *
 * Harbor cobra ~$25 FIJOS en los rieles de tipo wire, medido contra la API en
 * producción: en `bo-jp`, WIRE sobre $75,05 de neto entregaba $49,65. El fijo no
 * se nota arriba de $300 y es demoledor en el mínimo.
 *
 * `bo-us` sólo está sano porque Harbor devuelve ACH_PUSH primero y la selección
 * tomaba `filtered[0]`. Estos tests fijan las dos cosas que eso dejaba al azar:
 * que elijamos por NUESTRO orden de preferencia, y que se avise cuando el riel
 * barato no vino en vez de liquidar por el caro en silencio.
 */

import '../setup.env.js'
import {
  selectHarborQuote, pickSupportedQuote, SUPPORTED_METHODS_BY_COUNTRY, RIELES_CON_FIJO_ALTO,
} from '../../src/utils/harborMethodSupport.js'

const q = (payment_method, exchangeRate = 1) => ({ payment_method, exchangeRate })

describe('selectHarborQuote — orden de preferencia propio', () => {
  test('elige ACH_PUSH aunque Harbor devuelva el wire primero (caso bo-us)', () => {
    // El orden de la respuesta de Harbor invertido: es exactamente el escenario
    // del que dependíamos sin saberlo.
    const r = selectHarborQuote([q('FEDWIRE', 0.598), q('DOMESTIC_WIRE', 0.6), q('ACH_PUSH', 1)], 'US')
    expect(r.method).toBe('ACH_PUSH')
    expect(r.degraded).toBe(false)
  })

  test('respeta el orden declarado en SUPPORTED_METHODS_BY_COUNTRY', () => {
    // US: ['ACH_PUSH', ...] — el barato gana esté donde esté en la respuesta.
    expect(SUPPORTED_METHODS_BY_COUNTRY.US[0]).toBe('ACH_PUSH')
    expect(selectHarborQuote([q('WIRE'), q('ACH_PUSH')], 'US').method).toBe('ACH_PUSH')
    expect(selectHarborQuote([q('ACH_PUSH'), q('WIRE')], 'US').method).toBe('ACH_PUSH')
  })

  test('la elección explícita del usuario gana y NO cuenta como degradación', () => {
    // Si pidió el wire, ya vio su tasa en el selector: es una decisión, no una falla.
    const r = selectHarborQuote([q('ACH_PUSH', 1), q('FEDWIRE', 0.598)], 'US', 'FEDWIRE')
    expect(r.method).toBe('FEDWIRE')
    expect(r.degraded).toBe(false)
  })

  test('un método pedido que no vino no secuestra la selección', () => {
    const r = selectHarborQuote([q('ACH_PUSH', 1)], 'US', 'FEDWIRE')
    expect(r.method).toBe('ACH_PUSH')
  })
})

describe('selectHarborQuote — detección de riel degradado', () => {
  test('marca degraded cuando el riel barato NO vino y queda un wire', () => {
    // El escenario que se quiere atrapar: Harbor deja de devolver ACH_PUSH.
    const r = selectHarborQuote([q('DOMESTIC_WIRE', 0.6), q('FEDWIRE', 0.598)], 'US')
    expect(r.degraded).toBe(true)
    expect(r.preferredMethod).toBe('ACH_PUSH')
    expect(r.method).toBe('DOMESTIC_WIRE')
    expect(r.available).toEqual(['DOMESTIC_WIRE', 'FEDWIRE'])
  })

  test('NO marca degraded cuando el riel preferido ES un wire', () => {
    // EU: ['WIRE'] — el wire es lo único y lo esperado, no una degradación.
    expect(SUPPORTED_METHODS_BY_COUNTRY.EU).toEqual(['WIRE'])
    expect(selectHarborQuote([q('WIRE', 0.67)], 'EU').degraded).toBe(false)
  })

  test('NO marca degraded si el fallback es un riel barato', () => {
    // GB: ['FPS', 'WIRE'] — si falta FPS pero viene BANK-TRANSFER (barato), no
    // hay pérdida que avisar. Sólo los wires disparan la alarma.
    const r = selectHarborQuote([q('BANK-TRANSFER')], 'GB')
    expect(r.degraded).toBe(false)
  })

  test('GB sin BANK-TRANSFER y con WIRE sí degrada', () => {
    // Hoy GB llega como BANK-TRANSFER. Si mañana sólo viniera WIRE, es una
    // degradación real: el wire cobra ~$25 fijos y BANK-TRANSFER no.
    const r = selectHarborQuote([q('WIRE', 0.75)], 'GB')
    expect(r.degraded).toBe(true)
    expect(r.preferredMethod).toBe('BANK-TRANSFER')
    expect(r.method).toBe('WIRE')
  })

  test('país sin preferencia declarada no degrada (no hay con qué comparar)', () => {
    const r = selectHarborQuote([q('WIRE')], 'ZZ')
    expect(r.degraded).toBe(false)
    expect(r.preferredMethod).toBeNull()
  })

  test('CN con sólo WIRE NO degrada — CIPS no se ofrece a nuestro customer', () => {
    // Regresión: CN estaba declarado ['CIPS','WIRE'] y CIPS nunca llega (medido a
    // $120/$500/$2.000 el 2026-10-05). Con el mapa viejo, cl-cn y us-cn quedaban
    // marcados como degradados SIEMPRE, y el guard los habría apagado.
    expect(SUPPORTED_METHODS_BY_COUNTRY.CN).toEqual(['WIRE'])
    expect(selectHarborQuote([q('WIRE', 0.137)], 'CN').degraded).toBe(false)
  })

  test('los rieles con fijo alto son los de la familia wire', () => {
    expect([...RIELES_CON_FIJO_ALTO].sort()).toEqual(['DOMESTIC_WIRE', 'FEDWIRE', 'WIRE'])
    expect(RIELES_CON_FIJO_ALTO.has('ACH_PUSH')).toBe(false)
    expect(RIELES_CON_FIJO_ALTO.has('PIX')).toBe(false)
  })
})

describe('selectHarborQuote — bordes', () => {
  test('sin quotes devuelve vacío sin reventar', () => {
    for (const v of [[], null, undefined]) {
      const r = selectHarborQuote(v, 'US')
      expect(r.quote).toBeNull()
      expect(r.degraded).toBe(false)
    }
  })

  test('acepta camelCase además de snake_case', () => {
    const r = selectHarborQuote([{ paymentMethod: 'ACH_PUSH' }, { paymentMethod: 'WIRE' }], 'US')
    expect(r.method).toBe('ACH_PUSH')
  })

  test('si el filtro de soportados vacía todo, el pass-through no degrada de más', () => {
    // filterSupportedQuotes devuelve el original cuando nada sobrevive, para no
    // romper el flujo. Ese camino no debe inventar una degradación falsa: el
    // método que queda no es un wire.
    const r = selectHarborQuote([q('METODO-NUEVO-DE-HARBOR')], 'SG')
    expect(r.quote).not.toBeNull()
    expect(r.degraded).toBe(false)
  })

  test('pickSupportedQuote sigue devolviendo sólo el quote (compatibilidad)', () => {
    const quotes = [q('FEDWIRE', 0.598), q('ACH_PUSH', 1)]
    expect(pickSupportedQuote(quotes, 'US')).toBe(selectHarborQuote(quotes, 'US').quote)
    expect(pickSupportedQuote([], 'US')).toBeNull()
  })
})

/**
 * Lo que Harbor devuelve HOY en producción, por ruta activa (quotes reales a $200,
 * 2026-10-05). Fija la medición: si Harbor cambia sus rieles, este test se rompe y
 * obliga a re-medir en vez de descubrirlo por una pérdida.
 *
 * Ninguna ruta activa debe quedar degradada con los datos reales — si alguna lo
 * queda, o el mapa declara un riel que no existe, o Harbor degradó de verdad.
 */
describe('ninguna ruta activa degrada con los métodos reales de producción', () => {
  const REAL = [
    ['bo-ae-srl', 'AE', ['BANK-TRANSFER']],
    ['bo-gb',     'GB', ['BANK-TRANSFER']],
    ['bo-ng',     'NG', ['BANK-TRANSFER']],
    ['bo-sg',     'SG', ['BANK-TRANSFER']],
    ['bo-us',     'US', ['ACH_PUSH', 'DOMESTIC_WIRE', 'FEDWIRE', 'WIRE']],
    ['cl-ae',     'AE', ['BANK-TRANSFER']],
    ['cl-au',     'AU', ['BANK-TRANSFER']],
    ['cl-cn',     'CN', ['WIRE']],
    ['cl-eu',     'DE', ['SEPA', 'WIRE']],
    ['cl-gb',     'GB', ['BANK-TRANSFER']],
    ['us-ae',     'AE', ['BANK-TRANSFER']],
    ['us-au',     'AU', ['BANK-TRANSFER']],
    ['us-cn',     'CN', ['WIRE']],
    ['us-eu',     'DE', ['SEPA', 'WIRE']],
    ['us-gb',     'GB', ['BANK-TRANSFER']],
    ['us-us',     'US', ['ACH_PUSH', 'DOMESTIC_WIRE', 'FEDWIRE', 'WIRE']],
  ]

  test.each(REAL)('%s (%s) no degrada', (corridorId, pais, metodos) => {
    const r = selectHarborQuote(metodos.map(m => q(m)), pais)
    expect(r.quote).not.toBeNull()
    expect(r.degraded).toBe(false)
  })

  test('todo país con ruta activa está mapeado (nada cae al pass-through)', () => {
    for (const [, pais] of REAL) {
      expect(SUPPORTED_METHODS_BY_COUNTRY[pais]).toBeDefined()
    }
  })

  test('bo-us y us-us eligen el riel barato, no el wire', () => {
    const todos = ['ACH_PUSH', 'DOMESTIC_WIRE', 'FEDWIRE', 'WIRE'].map(m => q(m))
    expect(selectHarborQuote(todos, 'US').method).toBe('ACH_PUSH')
  })
})
