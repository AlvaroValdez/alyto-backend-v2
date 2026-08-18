// src/services/marketing/slideRenderer.js
//
// Renderiza los slides de un carrusel: texto → SVG → PNG 1080×1080.
//
// El texto viene de ContentPiece.slides, que YA pasó por riskClassifier. Este
// módulo no decide nada de compliance: dibuja lo que se aprobó. Por eso el slide
// se guarda como texto y no como imagen — si fuera un PNG subido, su contenido
// sería opaco para el clasificador.
//
// ─── Por qué estas herramientas ──────────────────────────────────────────────
//
// SVG no hace wrap de texto: hay que cortar las líneas nosotros, y para cortarlas
// hay que conocer el ancho real de cada glifo. Eso obliga a un motor de fuentes
// sí o sí, así que la elección no fue entre "medir o no" sino entre qué mide.
//
//   fontkit  — mide. Entiende fuentes variables: getVariation({wght}) da métricas
//              correctas por peso. opentype.js NO: devuelve el mismo advance para
//              todos los pesos de una variable (verificado: 1026.6px para 200,
//              400, 700 y 800 sobre la misma cadena).
//   resvg    — rasteriza. Recibe la fuente como buffer, sin depender de que esté
//              instalada en el sistema — Render y el Docker del VPS no la tienen.
//
// La fuente va versionada en el repo (assets/fonts, OFL) por la misma razón: un
// render que depende del entorno produce PNGs distintos según dónde corra.
//
// ⚠️ resvg solo distingue DOS pesos de la Manrope variable: 400≡500 y 700≡800
// (verificado comparando los PNG byte a byte). Por eso la escala de abajo usa
// solo 400 y 700: son los que realmente dibuja, y así lo medido coincide
// exactamente con lo renderizado en vez de aproximarse. La jerarquía entre
// portada y slide la da el TAMAÑO, no el peso. Para un ExtraBold real haría
// falta una cara estática con el name table bien formado; las que publica
// Google Fonts como instancias no lo traen.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as fontkit from 'fontkit';
import { Resvg } from '@resvg/resvg-js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RUTA_FUENTE = join(AQUI, '../../../assets/fonts/Manrope-Variable.ttf');
const RUTA_LOGO   = join(AQUI, '../../../assets/LogoAlytoWB.png');

// ─── Lienzo y escala (sección Social de la skill alyto-ux) ───────────────────

export const LIENZO = 1080;
const MARGEN = Math.round(LIENZO * 0.09);        // 97px — zona segura
const UTIL   = LIENZO - MARGEN * 2;              // 886px de ancho de texto

// Paleta: navy de marca → fondo → carbón. El acento es PLATA. Alyto no usa dorado.
const COLOR = {
  gradiente: [['#1D3461', 0], ['#0F1628', 0.6], ['#1A2030', 1]],
  plata:     '#C4CBD8',
  blanco:    '#FFFFFF',
  cuerpo:    '#C7CFE2',
  alerta:    '#EF4444',
};

// Los tamaños NO son libres dentro del rango que da la skill: son los que
// hacen ciertos los presupuestos de caracteres que el prompt le pide al modelo
// y que el panel usa para avisar antes de aprobar. Medidos sobre 886px de ancho
// útil con texto español real:
//
//    96px/700 → ~18 car/línea      (portada, 3 líneas → ~54 car)
//    72px/700 → ~24 car/línea      (titular, 2 líneas → ~48 car)
//    40px/400 → ~46 car/línea      (texto,   6 líneas → ~282 car)
//
// Subirlos rompe el acuerdo en silencio: el modelo seguiría escribiendo para 18
// caracteres mientras el render acepta 14, y las piezas empezarían a rebotar sin
// motivo aparente. Si se cambian, hay que recalcular y actualizar los tres
// lugares: este archivo, el system prompt y PRESUPUESTO en el panel.
const ESCALA = {
  portada:  { size: 96, weight: 700, lh: 1.05, maxLineas: 3 },
  titulo:   { size: 72, weight: 700, lh: 1.10, maxLineas: 2 },
  texto:    { size: 40, weight: 400, lh: 1.35, maxLineas: 6 },
  etiqueta: { size: 30, weight: 700, lh: 1.0 },
};

// ─── Fuente ──────────────────────────────────────────────────────────────────

let cache = null;

/** Carga la fuente una sola vez. El buffer se reutiliza en cada render. */
function fuente() {
  if (cache) return cache;

  let buffer;
  try {
    buffer = readFileSync(RUTA_FUENTE);
  } catch (err) {
    const e = new Error(`No se pudo leer la fuente del renderer (${RUTA_FUENTE}): ${err.message}`);
    e.code = 'FUENTE_NO_DISPONIBLE';
    throw e;
  }

  const font = fontkit.create(buffer);
  // Una instancia por peso, memoizada: getVariation() no es gratis y se llama
  // una vez por palabra al envolver.
  const instancias = new Map();
  const instancia = (weight) => {
    if (!instancias.has(weight)) instancias.set(weight, font.getVariation({ wght: weight }));
    return instancias.get(weight);
  };

  cache = { buffer, font, instancia, unitsPerEm: font.unitsPerEm };
  return cache;
}

/** Solo para tests: fuerza recargar la fuente y el logo. */
export function __resetFuente() {
  cache = null;
  cacheLogo = null;
}

// El logo va embebido como data URI y no como <use> o ruta: el SVG tiene que ser
// autocontenido, porque resvg no resuelve rutas relativas del archivo.
const LOGO_ALTO = 56;                       // ~200px de ancho con el aspecto 604×217
let cacheLogo = null;

function logo() {
  if (cacheLogo !== null) return cacheLogo;
  try {
    cacheLogo = `data:image/png;base64,${readFileSync(RUTA_LOGO).toString('base64')}`;
  } catch {
    // Best-effort: un slide sin logo es peor que uno con logo, pero MUCHO mejor
    // que no poder publicar. La marca no puede tumbar el render.
    cacheLogo = '';
  }
  return cacheLogo;
}

/** Ancho en px de un texto a un tamaño y peso dados. */
export function medir(texto, { size, weight }) {
  const f = fuente();
  if (!texto) return 0;
  return f.instancia(weight).layout(String(texto)).advanceWidth / f.unitsPerEm * size;
}

// ─── Wrap ────────────────────────────────────────────────────────────────────

/**
 * Corta un texto en líneas que entren en `maxAncho`, midiendo de verdad.
 *
 * No parte palabras: si una sola palabra no entra, lanza. Es deliberado —
 * partir "internacionales" a la mitad se lee peor que no publicar el slide, y
 * el caso real (una palabra larguísima) casi siempre significa que el texto
 * está mal escrito para el formato.
 *
 * @throws {Error & {code:'SLIDE_DESBORDA'}}
 */
export function envolver(texto, maxAncho, estilo) {
  const palabras = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return [];

  const lineas = [];
  let actual = '';

  for (const palabra of palabras) {
    const suelta = medir(palabra, estilo);
    if (suelta > maxAncho) {
      const e = new Error(
        `La palabra "${palabra}" mide ${Math.round(suelta)}px y no entra en ${maxAncho}px de ancho.`,
      );
      e.code = 'SLIDE_DESBORDA';
      throw e;
    }

    const tentativa = actual ? `${actual} ${palabra}` : palabra;
    if (medir(tentativa, estilo) <= maxAncho) {
      actual = tentativa;
    } else {
      lineas.push(actual);
      actual = palabra;
    }
  }
  if (actual) lineas.push(actual);

  return lineas;
}

// ─── SVG ─────────────────────────────────────────────────────────────────────

const escapar = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Bloque de líneas como <text> con un <tspan> por línea. */
function bloque(lineas, { x, y, size, weight, lh, fill, anchor = 'start' }) {
  if (!lineas.length) return { svg: '', alto: 0 };

  const paso = size * lh;
  const tspans = lineas
    .map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : paso}">${escapar(l)}</tspan>`)
    .join('');

  return {
    svg: `<text x="${x}" y="${y + size * 0.8}" font-family="Manrope" font-weight="${weight}" ` +
         `font-size="${size}" fill="${fill}" text-anchor="${anchor}">${tspans}</text>`,
    alto: paso * lineas.length,
  };
}

/**
 * Compone el SVG de un slide.
 *
 * @param {{orden:number, rol:string, titulo?:string, texto?:string}} slide
 * @param {{total:number}} opts
 * @returns {string} SVG 1080×1080
 * @throws {Error & {code:'SLIDE_DESBORDA'}} si el texto no entra en el presupuesto
 */
export function componerSlide(slide, { total }) {
  const esPortada = slide.rol === 'portada';
  const estTitulo = esPortada ? ESCALA.portada : ESCALA.titulo;

  const lineasTitulo = envolver(slide.titulo, UTIL, estTitulo);
  const lineasTexto  = envolver(slide.texto,  UTIL, ESCALA.texto);

  // El presupuesto se verifica DESPUÉS de medir, no antes: el límite real es
  // cuántas líneas salieron, no cuántos caracteres tenía el texto.
  const excesos = [];
  if (lineasTitulo.length > estTitulo.maxLineas) {
    excesos.push(`titular ${lineasTitulo.length}/${estTitulo.maxLineas} líneas`);
  }
  if (lineasTexto.length > ESCALA.texto.maxLineas) {
    excesos.push(`texto ${lineasTexto.length}/${ESCALA.texto.maxLineas} líneas`);
  }
  if (excesos.length) {
    // Falla ruidosamente en vez de recortar o achicar la tipografía: un slide
    // con el titular cortado se publica y no se nota hasta que ya salió.
    const e = new Error(`El slide ${slide.orden} no entra en el lienzo (${excesos.join(', ')}).`);
    e.code = 'SLIDE_DESBORDA';
    e.slide = slide.orden;
    throw e;
  }

  const paradas = COLOR.gradiente
    .map(([c, o]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');

  // Cabecera: índice a la izquierda, logo a la derecha. El logo va en TODOS los
  // slides porque en el feed cada uno se ve suelto, no como parte de una serie.
  const logoAncho = LOGO_ALTO * (604 / 217);
  const src = logo();
  const cabecera =
    `<text x="${MARGEN}" y="${MARGEN + ESCALA.etiqueta.size * 0.8}" font-family="Manrope" font-weight="700" ` +
    `font-size="${ESCALA.etiqueta.size}" fill="${COLOR.plata}" ` +
    `letter-spacing="${ESCALA.etiqueta.size * 0.08}">${slide.orden} / ${total}</text>` +
    (src
      ? `<image x="${LIENZO - MARGEN - logoAncho}" y="${MARGEN - 8}" width="${logoAncho}" height="${LOGO_ALTO}" href="${src}"/>`
      : '');

  // El bloque de contenido se ancla ABAJO, no arriba. Un titular pegado al techo
  // deja el lienzo medio vacío y se lee peor en el feed; anclarlo abajo hace que
  // slides con distinta cantidad de texto compartan la misma línea de base y el
  // carrusel se vea como una serie y no como piezas sueltas.
  const separacion = lineasTexto.length ? estTitulo.size * 0.55 : 0;
  const altoTitulo = estTitulo.size * estTitulo.lh * lineasTitulo.length;
  const altoTexto  = ESCALA.texto.size * ESCALA.texto.lh * lineasTexto.length;

  let y = LIENZO - MARGEN - (altoTitulo + separacion + altoTexto);

  const titulo = bloque(lineasTitulo, {
    x: MARGEN, y, size: estTitulo.size, weight: estTitulo.weight,
    lh: estTitulo.lh, fill: COLOR.blanco,
  });
  y += altoTitulo + separacion;

  const texto = bloque(lineasTexto, {
    x: MARGEN, y, size: ESCALA.texto.size, weight: ESCALA.texto.weight,
    lh: ESCALA.texto.lh, fill: COLOR.cuerpo,
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LIENZO}" height="${LIENZO}" viewBox="0 0 ${LIENZO} ${LIENZO}">` +
    `<defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1">${paradas}</linearGradient></defs>` +
    `<rect width="${LIENZO}" height="${LIENZO}" fill="url(#f)"/>` +
    cabecera + titulo.svg + texto.svg +
    `</svg>`
  );
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

/**
 * Renderiza un slide a PNG.
 * @returns {Buffer}
 */
export function renderSlide(slide, { total }) {
  const svg = componerSlide(slide, { total });
  const { buffer } = fuente();

  return new Resvg(svg, {
    font: { fontBuffers: [buffer], defaultFontFamily: 'Manrope', loadSystemFonts: false },
    fitTo: { mode: 'width', value: LIENZO },
  }).render().asPng();
}

/**
 * Renderiza el carrusel entero, en orden.
 *
 * Falla completo si falla un slide: publicar un carrusel al que le falta una
 * imagen es peor que no publicarlo — queda un hueco en el argumento y no hay
 * forma de saber cuál era desde el feed.
 *
 * @param {{formato:string, slides:Array}} pieza
 * @returns {Array<{orden:number, png:Buffer}>}
 * @throws {Error & {code:string}}
 */
export function renderCarrusel(pieza) {
  if (pieza?.formato !== 'carrusel') {
    const e = new Error('La pieza no es un carrusel.');
    e.code = 'NO_ES_CARRUSEL';
    throw e;
  }

  const slides = [...(pieza.slides ?? [])].sort((a, b) => a.orden - b.orden);
  if (!slides.length) {
    const e = new Error('El carrusel no tiene slides.');
    e.code = 'SIN_SLIDES';
    throw e;
  }

  return slides.map(s => ({ orden: s.orden, png: renderSlide(s, { total: slides.length }) }));
}

export default { renderSlide, renderCarrusel, componerSlide, envolver, medir, LIENZO };
