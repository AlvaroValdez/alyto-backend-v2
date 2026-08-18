/**
 * slideRenderer.test.js — Render de slides de carrusel.
 *
 * Lo que importa verificar acá no es que el PNG "se vea bien" (eso no se testea),
 * sino que el renderer FALLE cuando el texto no entra. Ese es todo su valor
 * agregado: sin él, un titular demasiado largo se publicaría cortado y nadie se
 * enteraría hasta verlo en el feed.
 *
 * El resto de los tests fijan el contrato que otros módulos ya asumen: el
 * tamaño del lienzo y que la medición dependa del peso.
 */

import '../setup.env.js';
import {
  medir, envolver, componerSlide, renderSlide, renderCarrusel, LIENZO, __resetFuente,
} from '../../src/services/marketing/slideRenderer.js';

const UTIL = LIENZO - Math.round(LIENZO * 0.09) * 2;

const slide = (over = {}) => ({
  orden: 1, rol: 'desarrollo', titulo: 'Te apuran', texto: 'La urgencia es señal de alerta.', ...over,
});

beforeEach(() => { __resetFuente(); });

describe('medición', () => {
  test('mide con la fuente real, no con un promedio de caracteres', () => {
    // 'iii' y 'MMM' tienen la misma cantidad de caracteres y anchos muy distintos.
    const finas  = medir('iii', { size: 100, weight: 400 });
    const anchas = medir('MMM', { size: 100, weight: 400 });
    expect(anchas).toBeGreaterThan(finas * 2);
  });

  test('el peso cambia la medida', () => {
    // Es la razón de usar fontkit y no opentype.js: este test falla con opentype,
    // que devuelve el mismo advance para todos los pesos de una fuente variable.
    const regular = medir('Ganancias garantizadas', { size: 96, weight: 400 });
    const bold    = medir('Ganancias garantizadas', { size: 96, weight: 700 });
    expect(bold).toBeGreaterThan(regular);
  });

  test('escala linealmente con el tamaño', () => {
    const a = medir('Alyto', { size: 50, weight: 400 });
    const b = medir('Alyto', { size: 100, weight: 400 });
    expect(b / a).toBeCloseTo(2, 1);
  });

  test('texto vacío mide cero', () => {
    expect(medir('', { size: 96, weight: 700 })).toBe(0);
  });
});

describe('wrap', () => {
  const estilo = { size: 40, weight: 400 };

  test('ninguna línea supera el ancho disponible', () => {
    const largo = 'Una plataforma legítima opera bajo la supervisión de una autoridad financiera reconocida y publica esa información.';
    for (const linea of envolver(largo, UTIL, estilo)) {
      expect(medir(linea, estilo)).toBeLessThanOrEqual(UTIL);
    }
  });

  test('no pierde ni duplica palabras', () => {
    const t = 'La urgencia artificial es una táctica clásica de las estafas financieras';
    expect(envolver(t, UTIL, estilo).join(' ')).toBe(t);
  });

  test('un texto corto entra en una línea', () => {
    expect(envolver('Ante la duda', UTIL, estilo)).toHaveLength(1);
  });

  test('texto vacío da cero líneas', () => {
    expect(envolver('', UTIL, estilo)).toEqual([]);
    expect(envolver('   ', UTIL, estilo)).toEqual([]);
  });

  test('una palabra que no entra lanza en vez de partirla', () => {
    // Partir "internacionales" a la mitad se lee peor que no publicar el slide.
    expect(() => envolver('Supercalifragilisticoexpialidoso', 120, estilo))
      .toThrow(/no entra/i);
  });
});

describe('presupuesto de líneas — el gate del renderer', () => {
  test('un titular de portada de 4 líneas no se renderiza', () => {
    // Caso real: este titular salió del modelo y necesita 4 líneas a 96px.
    expect(() => componerSlide(
      slide({ rol: 'portada', titulo: '5 señales de que te están estafando con cripto y con promesas', texto: '' }),
      { total: 3 },
    )).toThrow(/no entra en el lienzo/i);
  });

  test('el error dice qué slide y cuántas líneas se pasó', () => {
    try {
      componerSlide(slide({ orden: 4, titulo: 'Una manera larguísima de titular un slide que claramente no entra en dos líneas' }), { total: 5 });
      throw new Error('debió lanzar');
    } catch (e) {
      expect(e.code).toBe('SLIDE_DESBORDA');
      expect(e.slide).toBe(4);
      expect(e.message).toMatch(/titular \d+\/2 líneas/);
    }
  });

  test('un cuerpo de más de 6 líneas no se renderiza', () => {
    const largo = 'palabra '.repeat(90);
    expect(() => componerSlide(slide({ texto: largo }), { total: 3 })).toThrow(/no entra en el lienzo/i);
  });

  test('un slide dentro del presupuesto sí se compone', () => {
    expect(componerSlide(slide(), { total: 3 })).toContain('<svg');
  });
});

describe('SVG', () => {
  test('el lienzo es 1080×1080', () => {
    const svg = componerSlide(slide(), { total: 3 });
    expect(svg).toContain(`width="${LIENZO}"`);
    expect(svg).toContain(`height="${LIENZO}"`);
    expect(svg).toContain(`viewBox="0 0 ${LIENZO} ${LIENZO}"`);
  });

  test('el texto viaja como texto, no como trazo', () => {
    // Es lo que permite auditar después qué decía una pieza publicada.
    const svg = componerSlide(slide({ titulo: 'Te apuran' }), { total: 3 });
    expect(svg).toContain('<tspan');
    expect(svg).toContain('Te apuran');
  });

  test('escapa caracteres que romperían el XML', () => {
    const svg = componerSlide(slide({ titulo: 'Comisiones & tasas', texto: 'Menos de <5 minutos' }), { total: 2 });
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;5');
    // Y sigue siendo rasterizable: un XML roto haría fallar a resvg.
    expect(() => renderSlide(slide({ titulo: 'Comisiones & tasas', texto: 'Menos de <5 minutos' }), { total: 2 })).not.toThrow();
  });

  test('muestra la posición dentro del carrusel', () => {
    expect(componerSlide(slide({ orden: 2 }), { total: 6 })).toContain('2 / 6');
  });

  test('el acento es plata, y el amarillo solo puede venir del logo', () => {
    const svg = componerSlide(slide(), { total: 3 });
    expect(svg).toContain('#C4CBD8');
    // El logo va embebido como data URI; fuera de él no puede haber amarillo.
    const sinLogo = svg.replace(/href="data:[^"]*"/g, '');
    expect(sinLogo.toUpperCase()).not.toContain('F5D419');
  });
});

describe('PNG', () => {
  test('renderSlide devuelve un PNG', () => {
    const png = renderSlide(slide(), { total: 3 });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1000);
  });

  test('es determinista: el mismo slide da el mismo PNG', () => {
    // Sin esto, un re-render tras una aprobación podría publicar algo distinto
    // de lo que se revisó.
    expect(renderSlide(slide(), { total: 3 })).toEqual(renderSlide(slide(), { total: 3 }));
  });
});

describe('carrusel completo', () => {
  const pieza = {
    formato: 'carrusel',
    slides: [
      { orden: 2, rol: 'desarrollo', titulo: 'Te apuran', texto: 'La urgencia es señal de alerta.' },
      { orden: 1, rol: 'portada',    titulo: 'Cinco señales', texto: '' },
      { orden: 3, rol: 'cierre',     titulo: 'Ante la duda', texto: 'Consultá antes de mover tu dinero.' },
    ],
  };

  test('renderiza en orden, sin importar cómo venga el array', () => {
    expect(renderCarrusel(pieza).map(s => s.orden)).toEqual([1, 2, 3]);
  });

  test('si un slide desborda, no se renderiza ninguno', () => {
    // Publicar un carrusel al que le falta una imagen deja un hueco en el
    // argumento y no hay forma de notarlo desde el feed.
    const roto = { ...pieza, slides: [...pieza.slides, { orden: 4, rol: 'cierre', titulo: 'palabra '.repeat(40), texto: '' }] };
    expect(() => renderCarrusel(roto)).toThrow(/no entra en el lienzo/i);
  });

  test.each([
    ['una pieza que no es carrusel', { formato: 'post', slides: [] },     'NO_ES_CARRUSEL'],
    ['un carrusel sin slides',       { formato: 'carrusel', slides: [] }, 'SIN_SLIDES'],
  ])('%s → %s', (_, p, code) => {
    expect(() => renderCarrusel(p)).toThrow(expect.objectContaining({ code }));
  });
});
