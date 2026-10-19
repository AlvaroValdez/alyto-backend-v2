/**
 * sanctionsMatch.test.js
 *
 * Fija la comparación de nombres del cribado AML. Lo que se protege aquí no es
 * una utilidad: es la diferencia entre bloquear a un sancionado y bloquear a un
 * usuario que se apellida igual que un alias.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/sanctionsMatch.test.js
 */

import { tokens, coincideNombre, coincideAlgunaVariante, normalizar, normalizarDocumento }
  from '../src/utils/sanctionsMatch.js'

describe('normalizar y tokens', () => {
  test('quita tildes, signos y mayúsculas', () => {
    expect(normalizar('MUÑOZ-PÉREZ, José Á.')).toBe('munoz perez jose a')
  })

  test('descarta partículas e iniciales sueltas', () => {
    expect(tokens('José de la Cruz Q.')).toEqual(['jose', 'cruz'])
  })

  test('no repite tokens', () => {
    expect(tokens('PEREZ PEREZ, Juan')).toEqual(['perez', 'juan'])
  })
})

describe('coincideNombre', () => {
  test('la trampa que motivó el cambio: "Ana" dentro de "ANASTASIO" NO casa', () => {
    expect(coincideNombre(tokens('Ana Quispe'), tokens('ANASTASIO QUISPE'))).toBe(false)
  })

  test('casa cuando están todos los tokens, aunque sobren y estén desordenados', () => {
    expect(coincideNombre(tokens('Ana Quispe'), tokens('QUISPE MAMANI, Ana Maria'))).toBe(true)
  })

  test('NO casa si falta alguno: el apellido solo no identifica', () => {
    expect(coincideNombre(tokens('Ana Quispe'), tokens('QUISPE MAMANI, Carlos'))).toBe(false)
  })

  test('un solo token nunca casa, por frecuente que sea', () => {
    expect(coincideNombre(tokens('Quispe'), tokens('QUISPE MAMANI, Ana'))).toBe(false)
  })
})

describe('coincideAlgunaVariante', () => {
  // Este es el caso por el que existe la función. Con el nombre principal y los
  // alias mezclados en una sola bolsa, "Juan" del alias y "Perez" del nombre
  // principal bastaban para señalar a cualquier Juan Pérez.
  test('NO cruza tokens entre el nombre principal y un alias', () => {
    const entrada = ['CASTILLO PEREZ, Jose', 'MEDINA LOPEZ, Juan Manuel']
    expect(coincideAlgunaVariante(tokens('Juan Perez'), entrada)).toBe(false)
  })

  test('casa si UNA variante contiene todos los tokens', () => {
    const entrada = ['DELOS REYES, Feliciano', 'CASTRO, Jorge']
    expect(coincideAlgunaVariante(tokens('Jorge Castro'), entrada)).toBe(true)
  })

  test('sin variantes no casa nada', () => {
    expect(coincideAlgunaVariante(tokens('Jorge Castro'), [])).toBe(false)
  })
})

describe('normalizarDocumento', () => {
  test('ignora guiones, puntos y espacios', () => {
    expect(normalizarDocumento('12.345.678-K')).toBe('12345678K')
    expect(normalizarDocumento('12345678k')).toBe('12345678K')
  })
})
