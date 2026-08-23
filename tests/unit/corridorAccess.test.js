/**
 * corridorAccess.test.js — Acceso de un consumidor a un corredor.
 *
 * La prueba central es la primera del segundo bloque: un consumidor de la sociedad
 * boliviana solicitando por identificador explícito un corredor de origen Bolivia
 * pero de OTRA entidad. Ese caso pasaba el control anterior, que sólo comparaba el
 * país de origen, y la operación resultante no computaba contra los límites del
 * Entorno Controlado porque se agregan por entidad `SRL`.
 *
 * Sin la corrección, esa prueba falla.
 */

import { evaluateCorridorAccess, corridorAccessDenialBody } from '../../src/utils/corridorAccess.js';

const consumidorSRL = { legalEntity: 'SRL' };
const consumidorSpA = { legalEntity: 'SpA' };
const consumidorLLC = { legalEntity: 'LLC' };

describe('acceso admitido', () => {

  it('consumidor de la sociedad boliviana sobre corredor propio', () => {
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'bo-br', originCountry: 'BO', legalEntity: 'SRL' },
      user: consumidorSRL,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('consumidor chileno sobre corredor propio', () => {
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'cl-pe', originCountry: 'CL', legalEntity: 'SpA' },
      user: consumidorSpA,
    });
    expect(r.allowed).toBe(true);
  });

  it('consumidor chileno sobre corredor sin entidad declarada — remanente legacy', () => {
    // Mismo criterio con que el listado los expone: la rama SpA admite
    // `legalEntity: { $exists: false }`.
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'cl-legacy', originCountry: 'CL' },
      user: consumidorSpA,
    });
    expect(r.allowed).toBe(true);
  });
});

describe('acceso denegado — la brecha que se cierra', () => {

  it.each([
    ['bo-br-llc', 'BR'],
    ['bo-mx-llc', 'MX'],
    ['bo-eu',     'EU'],
  ])('consumidor SRL NO alcanza %s, corredor de origen BO bajo entidad LLC', (corridorId) => {
    // ESTE es el caso que pasaba antes: originCountry 'BO' coincide con el país de la
    // sociedad boliviana, de modo que el control anterior lo admitía. La operación
    // quedaba con entidad LLC y no sumaba al tope diario ni al del período.
    const r = evaluateCorridorAccess({
      corridor: { corridorId, originCountry: 'BO', legalEntity: 'LLC' },
      user: consumidorSRL,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ENTITY_MISMATCH');
  });

  it('el país de origen sigue controlándose', () => {
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'cl-pe', originCountry: 'CL', legalEntity: 'SpA' },
      user: consumidorSRL,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ORIGIN_COUNTRY_MISMATCH');
  });

  it('un corredor sin entidad NO se admite para la sociedad boliviana', () => {
    // Para la entidad del Entorno Controlado no hay excepción por remanente: un
    // corredor sin entidad declarada no es del perímetro de los 23.
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'bo-legacy', originCountry: 'BO' },
      user: consumidorSRL,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('CORRIDOR_WITHOUT_ENTITY');
  });

  it('tampoco para la sociedad estadounidense', () => {
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'us-legacy', originCountry: 'US' },
      user: consumidorLLC,
    });
    expect(r.allowed).toBe(false);
  });

  it('corredor inexistente', () => {
    const r = evaluateCorridorAccess({ corridor: null, user: consumidorSRL });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('CORRIDOR_NOT_FOUND');
  });
});

describe('simetría entre entidades', () => {

  it('ninguna entidad alcanza el corredor de otra, aunque compartan país', () => {
    for (const [entidadUsuario, entidadCorredor] of [
      ['SRL', 'LLC'], ['LLC', 'SRL'], ['SpA', 'LLC'], ['LLC', 'SpA'], ['SRL', 'SpA'],
    ]) {
      const r = evaluateCorridorAccess({
        corridor: { corridorId: 'x', originCountry: 'BO', legalEntity: entidadCorredor },
        user: { legalEntity: entidadUsuario, residenceCountry: 'BO' },
      });
      if (r.allowed) throw new Error(`${entidadUsuario} alcanzó un corredor de ${entidadCorredor}`);
    }
  });
});

describe('respuesta de denegación', () => {

  it('no revela a qué entidad pertenece el corredor', () => {
    const r = evaluateCorridorAccess({
      corridor: { corridorId: 'bo-br-llc', originCountry: 'BO', legalEntity: 'LLC' },
      user: consumidorSRL,
    });
    const body = JSON.stringify(corridorAccessDenialBody(r));
    expect(body).not.toMatch(/LLC/);
    expect(body).toMatch(/No tienes acceso/);
  });
});
