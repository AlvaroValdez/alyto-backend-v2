/**
 * minimoCoherente.test.js — Un corredor, un mínimo, una moneda.
 *
 * El 2026-10-04 el cotizador le mostraba al usuario TRES números distintos para la
 * misma magnitud, en dos monedas:
 *
 *   hint de pantalla  →  "Mínimo requerido: USD 20,07 (≈ 246,00 BOB)"
 *   error del socket  →  "El monto mínimo para este corredor es 241 BOB"
 *   validación al crear →  el piso exacto, un tercer valor
 *
 * El usuario tecleaba 241, que es lo que le decía el error, y el botón seguía
 * muerto porque el bloqueo usaba el 246 del hint. No había forma de avanzar ni de
 * entender por qué.
 *
 * Lo que fijan estas pruebas:
 *
 *   1. El número ANUNCIADO nunca es menor que el EXIGIDO. Si se invirtiera, estaríamos
 *      dando una instrucción que el propio sistema rechaza, que es el caso peor.
 *   2. Los importes del usuario se escriben en SU moneda. Un precio en dólares a
 *      alguien que paga en bolivianos le obliga a convertir para saber si puede
 *      operar.
 */

import '../setup.env.js'
import { effectiveMinOrigin, MIN_FLOOR_BUFFER_PCT } from '../../src/services/corridorMinimums.js'
import { formatOriginAmount } from '../../src/utils/currencyDisplay.js'

// Corredor tipo bo-cl: 6.5% spread + Bs 6 fija, origen Bolivia.
const CORRIDOR    = { alytoCSpread: 6.5, fixedFee: 6, payinFeePercent: 0, profitRetentionPercent: 0 }
const BOB_PER_USD = 12.0

/** Mismo par de valores que devuelve resolveEffectiveMinimum: exacto y anunciado. */
function ambos({ configuredMin, floorUSD }) {
  const base = { corridor: CORRIDOR, configuredMin, originPerUsd: BOB_PER_USD, floorUSD }
  return {
    exacto:    effectiveMinOrigin({ ...base, bufferPct: 0 }).min,
    anunciado: effectiveMinOrigin({ ...base, bufferPct: MIN_FLOOR_BUFFER_PCT }).min,
  }
}

describe('el mínimo anunciado nunca queda por debajo del exigido', () => {

  test('cuando manda el piso del proveedor, el anunciado lleva colchón y es mayor', () => {
    const { exacto, anunciado } = ambos({ configuredMin: 100, floorUSD: 20 })
    expect(anunciado).toBeGreaterThanOrEqual(exacto)
  })

  test('cuando manda el mínimo configurado, ambos coinciden: no hay colchón que aplicar', () => {
    // El colchón sólo existe para absorber el redondeo del piso del proveedor.
    // Si el configurado ya es más alto, inventar un margen encima sería subir el
    // mínimo del producto sin que nadie lo haya decidido.
    const { exacto, anunciado } = ambos({ configuredMin: 5000, floorUSD: 20 })
    expect(anunciado).toBe(exacto)
    expect(anunciado).toBe(5000)
  })

  test('sin piso de proveedor, el configurado manda en los dos', () => {
    const { exacto, anunciado } = ambos({ configuredMin: 241, floorUSD: null })
    expect(exacto).toBe(241)
    expect(anunciado).toBe(241)
  })

  test('la invariante se sostiene en todo el rango, no sólo en los casos elegidos', () => {
    for (const configuredMin of [0, 50, 100, 241, 500, 1000, 5000]) {
      for (const floorUSD of [null, 5, 20, 40, 300]) {
        const { exacto, anunciado } = ambos({ configuredMin, floorUSD })
        expect(anunciado).toBeGreaterThanOrEqual(exacto)
      }
    }
  })
})

describe('formatOriginAmount — el dinero del usuario, en su moneda', () => {

  test('bolivianos con símbolo local y sin el código ISO al lado', () => {
    // Ni "USD 20,07" ni "Bs246 BOB": una sola moneda, la del usuario.
    expect(formatOriginAmount(246, 'BOB')).toBe('Bs 246,00')
    expect(formatOriginAmount(21.67, 'BOB')).toBe('Bs 21,67')
  })

  test('pesos chilenos sin decimales', () => {
    expect(formatOriginAmount(12500, 'CLP')).toBe('$ 12.500')
  })

  test('una moneda sin símbolo conocido cae al código ISO en vez de inventar uno', () => {
    expect(formatOriginAmount(100, 'XAF')).toBe('100,00 XAF')
  })

  test('un importe inválido no imprime NaN en pantalla', () => {
    expect(formatOriginAmount(undefined, 'BOB')).toBe('—')
    expect(formatOriginAmount('abc', 'BOB')).toBe('—')
  })
})
