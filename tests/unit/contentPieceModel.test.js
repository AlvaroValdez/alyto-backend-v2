/**
 * contentPieceModel.test.js — Invariantes de la pieza de contenido.
 *
 * Lo que se testea acá no es Mongoose: son las condiciones sin las cuales una
 * pieza no se puede renderizar ni publicar, y que por eso no deben poder
 * existir en la base.
 *
 * El caso que justifica todo el bloque: si un carrusel lograra persistir con
 * `slides` vacío, `riskClassifier` solo vería título y cuerpo —que suelen ser
 * inofensivos—, lo marcaría BAJO y la pieza saldría autopublicada. La validación
 * del modelo es lo que convierte un parseo a medias en un error visible en vez
 * de en una publicación sin gate.
 */

import '../setup.env.js';

const { connectTestDb, disconnectTestDb, clearCollections } = await import('../helpers/db.js');
const { default: ContentPiece } = await import('../../src/models/ContentPiece.js');

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
afterEach(async () => { await clearCollections(); });

// Base válida de pieza; cada test cambia solo lo que le interesa.
const base = {
  titulo: 'Cinco señales de alerta',
  cuerpo: 'Aprendé a reconocerlas antes de mover tu dinero.',
  canal: 'facebook',
  tipo: 'educacion',
  autoevaluacionRiesgo: 'bajo',
  clasificacionFinal: 'bajo',
  estado: 'autopublicado',
};

const slides = (n) => Array.from({ length: n }, (_, i) => ({
  orden: i + 1,
  rol: i === 0 ? 'portada' : i === n - 1 ? 'cierre' : 'desarrollo',
  titulo: `Slide ${i + 1}`,
  texto: 'Contenido del slide.',
}));

describe('formato', () => {
  test('por defecto es "post" y sin slides', async () => {
    const p = await ContentPiece.create(base);
    expect(p.formato).toBe('post');
    expect(p.slides).toHaveLength(0);
  });

  test('rechaza un formato inventado', async () => {
    await expect(ContentPiece.create({ ...base, formato: 'historia' })).rejects.toThrow();
  });
});

describe('un carrusel necesita slides', () => {
  test.each([
    ['sin slides', 0],
    ['un solo slide', 1],
    ['once slides', 11],
  ])('%s → rechazado', async (_, n) => {
    await expect(
      ContentPiece.create({ ...base, formato: 'carrusel', slides: slides(n) }),
    ).rejects.toThrow(/carrusel lleva entre 2 y 10 slides|orden/i);
  });

  test.each([2, 5, 10])('%i slides → aceptado', async (n) => {
    const p = await ContentPiece.create({ ...base, formato: 'carrusel', slides: slides(n) });
    expect(p.slides).toHaveLength(n);
  });
});

describe('la numeración no puede tener huecos', () => {
  // Este es el fallo silencioso que importa: si el slide 3 no parsea, el
  // carrusel se publica con [1,2,4,5] y pierde un paso del argumento sin que
  // nadie lo note. Mejor que no se guarde.
  test('un hueco en el orden → rechazado', async () => {
    const conHueco = slides(5).filter(s => s.orden !== 3);
    await expect(
      ContentPiece.create({ ...base, formato: 'carrusel', slides: conHueco }),
    ).rejects.toThrow(/1 a 4 sin huecos|sin huecos ni repetidos/i);
  });

  test('un orden repetido → rechazado', async () => {
    const repetido = slides(3);
    repetido[2].orden = 2;
    await expect(
      ContentPiece.create({ ...base, formato: 'carrusel', slides: repetido }),
    ).rejects.toThrow(/sin huecos ni repetidos/i);
  });

  test('desordenados pero completos → aceptado (el orden lo da el campo, no el array)', async () => {
    const desordenados = [...slides(4)].reverse();
    const p = await ContentPiece.create({ ...base, formato: 'carrusel', slides: desordenados });
    expect(p.slides.map(s => s.orden).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('un post no lleva slides', () => {
  test('post con slides → rechazado', async () => {
    await expect(
      ContentPiece.create({ ...base, formato: 'post', slides: slides(3) }),
    ).rejects.toThrow(/no lleva slides/i);
  });
});

describe('campos del slide', () => {
  test('rol inventado → rechazado', async () => {
    const s = slides(2);
    s[1].rol = 'epilogo';
    await expect(
      ContentPiece.create({ ...base, formato: 'carrusel', slides: s }),
    ).rejects.toThrow();
  });

  test('un slide sin texto es válido — la portada normalmente no lo lleva', async () => {
    const p = await ContentPiece.create({
      ...base,
      formato: 'carrusel',
      slides: [
        { orden: 1, rol: 'portada', titulo: 'Cinco señales de alerta' },
        { orden: 2, rol: 'cierre',  titulo: 'Ante la duda', texto: 'Consultá.' },
      ],
    });
    expect(p.slides[0].texto).toBe('');
  });
});
