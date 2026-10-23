/**
 * refreshSanctionsLists.test.js
 *
 * La recarga semanal. Lo que se protege no es el conteo: es que una respuesta
 * truncada del origen NO deje el cribado a medias.
 *
 * Un fallo silencioso aquí es peor que no tener listas, porque la colección
 * sigue pareciendo poblada mientras ya no refleja el origen. Es exactamente el
 * estado del que se venía.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/refreshSanctionsLists.test.js
 */

import { jest } from '@jest/globals';

const estado = { activas: 0, bulk: [], baja: 0 };

jest.unstable_mockModule('../src/models/SanctionsList.js', () => ({
  default: {
    countDocuments: jest.fn(async () => estado.activas),
    bulkWrite:      jest.fn(async (ops) => { estado.bulk.push(ops.length); return { upsertedCount: ops.length, modifiedCount: 0 }; }),
    updateMany:     jest.fn(async () => ({ modifiedCount: estado.baja })),
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mod = await import('../src/jobs/refreshSanctionsLists.js');
const { refreshSanctionsLists, parsearOfac, parsearOnu, filasCsv, aDocumento } = mod;

/** Dos entradas de OFAC con el formato real: 12 columnas y `-0-` por vacío. */
const SDN = '1,"PEREZ ROJAS, Daniel","individual","CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Passport A1234567"\n' +
            '2,"ACME SHIPPING CO.",-0- ,"IRAN",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n' +
            '3,"BARCO FANTASMA","vessel","CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n';
const ALT = '1,1,"aka","ROJAS, Danilo"\n';

/**
 * Ojo con `Buffer.from(str).buffer`: devuelve el POOL entero de 8 KB que Node
 * reutiliza, no solo la cadena. El parser recibia bytes contiguos de otras
 * cadenas y se inventaba filas. Hay que recortar al tramo propio.
 */
function comoArrayBuffer(str) {
  const b = Buffer.from(str, 'latin1');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function fetchDevuelve(sdn, alt, onu) {
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    arrayBuffer: async () => comoArrayBuffer(
      url.includes('SDN') ? sdn : url.includes('ALT') ? alt : onu),
  }));
}

beforeEach(() => { estado.activas = 0; estado.bulk = []; estado.baja = 0; });

describe('parseo', () => {
  test('descarta buques: no pueden ser usuarios', () => {
    const e = parsearOfac(SDN, ALT);
    expect(e.map(x => x.fullName)).toEqual(['PEREZ ROJAS, Daniel', 'ACME SHIPPING CO.']);
  });

  test('asocia los alias a su entrada y distingue persona de entidad', () => {
    const [persona, entidad] = parsearOfac(SDN, ALT);
    expect(persona.type).toBe('individual');
    expect(persona.aliases).toEqual(['ROJAS, Danilo']);
    expect(entidad.type).toBe('entity');
    expect(entidad.aliases).toEqual([]);
  });

  test('saca el documento del campo Remarks', () => {
    const [persona] = parsearOfac(SDN, ALT);
    expect(persona.documentNumbers).toEqual(['A1234567']);
  });

  test('las variantes NO se mezclan entre sí', () => {
    const d = aDocumento(parsearOfac(SDN, ALT)[0]);
    expect(d.nameVariants).toEqual(['PEREZ ROJAS, Daniel', 'ROJAS, Danilo']);
  });

  test('el CSV respeta las comas dentro de comillas', () => {
    expect(filasCsv('1,"ACME, INC.",x\n')[0]).toEqual(['1', 'ACME, INC.', 'x']);
  });

  test('la ONU toma el nombre por partes', () => {
    const xml = '<INDIVIDUAL><DATAID>99</DATAID><FIRST_NAME>JUAN</FIRST_NAME>' +
                '<SECOND_NAME>PEREZ</SECOND_NAME><UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE></INDIVIDUAL>';
    const [e] = parsearOnu(xml);
    expect(e.fullName).toBe('JUAN PEREZ');
    expect(e.sourceId).toBe('99');
  });
});

describe('guard de recarga a medias', () => {
  test('ABORTA si el origen trae menos de la mitad de lo que ya había', async () => {
    estado.activas = 18000;              // lo que hay cargado
    fetchDevuelve(SDN, ALT, '');         // el origen devuelve 2 entradas
    const r = await refreshSanctionsLists();

    expect(r.abortado).toBe(true);
    expect(r.ok).toBe(false);
    expect(estado.bulk).toHaveLength(0); // no escribió nada
  });

  test('en la primera carga no aborta: no hay nada que proteger', async () => {
    estado.activas = 0;
    fetchDevuelve(SDN, ALT, '');
    const r = await refreshSanctionsLists();

    expect(r.abortado).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(estado.bulk).toHaveLength(1);
  });

  test('una recarga normal escribe y reporta las bajas', async () => {
    estado.activas = 2;
    estado.baja = 7;
    fetchDevuelve(SDN, ALT, '');
    const r = await refreshSanctionsLists();

    expect(r.ok).toBe(true);
    expect(r.escritas).toBe(2);
    expect(r.dadasDeBaja).toBe(7);
  });
});
