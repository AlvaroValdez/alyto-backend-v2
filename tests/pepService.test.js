/**
 * pepService.test.js
 *
 * Clasificación de riesgo para PEP y diligencia reforzada.
 *
 * Lo que se fija aquí es una regla de criterio, no una función: ser PEP obliga a
 * revisar, NO a excluir. Si alguien convierte esto en un bloqueo, estas pruebas
 * tienen que empezar a fallar.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/pepService.test.js
 */

import { jest } from '@jest/globals';

const entradas = [];

jest.unstable_mockModule('../src/models/SanctionsList.js', () => ({
  default: {
    find: () => ({ select: () => ({ limit: () => ({ lean: async () => entradas }) }) }),
  },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { clasificarRiesgo, buscarEnListaPep, RELACIONES_PEP } =
  await import('../src/services/pepService.js');

beforeEach(() => { entradas.length = 0; });

describe('clasificarRiesgo', () => {
  test('quien se declara PEP queda en riesgo alto y con EDD pendiente', () => {
    const r = clasificarRiesgo({ declarado: true, relacion: 'self' });
    expect(r.riskLevel).toBe('high');
    expect(r.eddStatus).toBe('pending');
    expect(r.motivo).toContain('self');
  });

  test('un allegado también abre revisión: lo pondera el humano, no el código', () => {
    expect(clasificarRiesgo({ declarado: true, relacion: 'associate' }).eddStatus).toBe('pending');
  });

  test('aparecer en la lista basta aunque no se haya declarado', () => {
    const r = clasificarRiesgo({ declarado: false, enLista: true });
    expect(r.riskLevel).toBe('high');
    expect(r.motivo).toContain('lista de PEP');
  });

  test('no haber preguntado todavía NO es riesgo bajo: es desconocido', () => {
    const r = clasificarRiesgo({ declarado: null });
    expect(r.riskLevel).toBe('medium');
    expect(r.eddStatus).toBe('not_required');
  });

  test('quien declara que no lo es y no está en lista queda en riesgo bajo', () => {
    const r = clasificarRiesgo({ declarado: false, enLista: false });
    expect(r.riskLevel).toBe('low');
    expect(r.eddStatus).toBe('not_required');
  });

  test('una coincidencia de sanciones manda sobre todo lo demás', () => {
    const r = clasificarRiesgo({ declarado: false, enLista: false, sancionado: true });
    expect(r.riskLevel).toBe('high');
    expect(r.motivo).toContain('sanciones');
  });

  // Esta es la regla de criterio, y por eso tiene prueba propia.
  test('ningún caso produce un estado que impida operar', () => {
    const casos = [
      { declarado: true, relacion: 'self' },
      { declarado: true, relacion: 'family' },
      { enLista: true },
      { sancionado: true },
      { declarado: null },
      { declarado: false },
    ];
    for (const c of casos) {
      const r = clasificarRiesgo(c);
      expect(['low', 'medium', 'high']).toContain(r.riskLevel);
      expect(['not_required', 'pending', 'approved', 'rejected']).toContain(r.eddStatus);
      expect(r).not.toHaveProperty('blocked');
    }
  });
});

describe('buscarEnListaPep', () => {
  test('sin nombre ni documento no consulta nada', async () => {
    const r = await buscarEnListaPep({});
    expect(r.hit).toBe(false);
  });

  test('un solo apellido no basta para señalar a nadie', async () => {
    entradas.push({ entryId: 'PEP-1', fullName: 'QUISPE MAMANI, Ana', nameVariants: ['QUISPE MAMANI, Ana'] });
    const r = await buscarEnListaPep({ lastName: 'Quispe' });
    expect(r.hit).toBe(false);
  });

  test('nombre y apellido completos sí coinciden', async () => {
    entradas.push({ entryId: 'PEP-1', fullName: 'QUISPE MAMANI, Ana', nameVariants: ['QUISPE MAMANI, Ana'] });
    const r = await buscarEnListaPep({ firstName: 'Ana', lastName: 'Quispe' });
    expect(r.hit).toBe(true);
    expect(r.entradas[0].entryId).toBe('PEP-1');
  });

  test('el documento exacto coincide aunque el nombre no se parezca', async () => {
    entradas.push({ entryId: 'PEP-2', fullName: 'OTRO NOMBRE', nameVariants: ['OTRO NOMBRE'],
                    documentsNormalized: ['12345678K'] });
    const r = await buscarEnListaPep({ firstName: 'Zzz', lastName: 'Yyy', documentNumber: '12.345.678-k' });
    expect(r.hit).toBe(true);
  });
});

describe('contrato del módulo', () => {
  test('las relaciones admitidas son las tres esperadas', () => {
    expect(RELACIONES_PEP).toEqual(['self', 'family', 'associate']);
  });
});
