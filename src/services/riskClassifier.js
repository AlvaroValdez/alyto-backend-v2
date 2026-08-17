// src/services/riskClassifier.js
//
// Clasificador de riesgo regulatorio para las piezas del agente de marketing.
//
// Esta es la pieza que protege a AV Finance ante ASFI. Por eso es código puro:
// regex y listas de términos, sin llamadas a ningún modelo. Un modelo no puede
// ser el guardián de su propia salida — la autoevaluación que hace el agente es
// una señal de entrada, no la decisión. Acá se decide.
//
// REGLA CONSERVADORA: basta que UNA señal dispare para que toda la pieza quede
// clasificada como alto riesgo. Los falsos positivos son baratos (la pieza va a
// la cola de aprobación humana). Los falsos negativos son caros (una pieza que
// no debía salir, sale). Ante la duda, alto.
//
// Determinístico y sin estado: la misma pieza produce siempre el mismo veredicto.
// No lee variables de entorno ni base de datos a propósito, para que sea
// enteramente testeable.
//
// Las listas se exportan como constantes para poder testearlas y ajustarlas sin
// tocar la lógica. Cada entrada es un fragmento de regex (se le agrega \b
// alrededor al compilar), así que si agregás un término con caracteres especiales
// hay que escaparlos.

// ─────────────────────────────────────────────────────────────────────────────
// Motivos — el texto que ve el admin en la cola. Constantes para que los tests
// no dependan de literales sueltos.
// ─────────────────────────────────────────────────────────────────────────────
export const MOTIVOS = {
  CIFRAS:     'Contiene cifras económicas',
  COSTO_CERO: 'Afirma gratuidad o ausencia de costos',
  REGULACION: 'Menciona regulación o estatus de licencia',
  PROMESA:    'Lenguaje que sugiere promesa de beneficio o inversión',
  MARCA:      'Usa terminología prohibida de marca',
  LEGAL:      'Afirma una certificación o autorización que Alyto no posee',
  VACIO:      'Contenido vacío o ilegible',
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalización — minúsculas y sin tildes.
//
// Sin esto, "resolución" dispara pero "resolucion" no, y el clasificador se
// esquiva escribiendo mal a propósito o simplemente por descuido del modelo.
// Todos los términos de las listas se escriben SIN tilde.
// ─────────────────────────────────────────────────────────────────────────────
export function normalizar(texto) {
  if (typeof texto !== 'string') return '';
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")  // quita marcas diacríticas
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Señal 1 — CIFRAS económicas
//
// Criterio: un número EN CONTEXTO económico. Un número suelto ("5 pasos",
// "en 3 minutos") no dispara; un número pegado a moneda, a un símbolo de
// porcentaje o cerca de una palabra de costo, sí.
//
// Se exige el número a propósito: marcar toda aparición de "bolivianos" o "USDC"
// convertiría cada pieza educativa en alto riesgo, la cola se llenaría de ruido y
// el revisor humano terminaría aprobando en automático. Un gate que se aprueba
// sin leer no es un gate.
// ─────────────────────────────────────────────────────────────────────────────

const NUM = '\\d+(?:[.,]\\d+)*';

/**
 * Números escritos en palabras.
 *
 * Es la vía de evasión más plausible de todas: el system prompt le prohíbe al
 * agente publicar cifras, y la salida natural cuando quiere decir "2%" igual es
 * escribir "dos por ciento". Sin esto, la prohibición se esquiva sola.
 *
 * ⚠️ Excluidos a propósito:
 *   - "un"/"uno"/"una" — son artículos antes que números. Incluirlos haría que
 *     "te damos una tasa competitiva" dispare, y eso es casi cualquier frase.
 *   - "medio"/"media"  — "medio de pago" es vocabulario central de Alyto.
 */
export const TERMINOS_NUMERO_PALABRA = [
  'cero', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'quince', 'veinte', 'treinta', 'cuarenta', 'cincuenta',
  'cien', 'ciento', 'doscientos', 'quinientos', 'mil', 'millon(?:es)?',
];

// Un "número" a efectos del clasificador: dígitos o palabra.
const NUM_ANY = `(?:${NUM}|\\b(?:${TERMINOS_NUMERO_PALABRA.join('|')})\\b)`;

/** Palabras y códigos de moneda que, junto a un número, denotan un monto. */
export const TERMINOS_MONEDA = [
  'bs\\.?', 'bolivianos?', 'dolar(?:es)?', 'usd', 'bob', 'usdt', 'usdc', 'euros?', 'eur',
];

/** Palabras de costo/beneficio: un número cerca de una de estas es una cifra económica. */
export const TERMINOS_COSTO = [
  'comisiones', 'comision', 'tasas', 'tasa', 'costos', 'costo', 'precios', 'precio',
  'cobros', 'cobro', 'cargos', 'cargo', 'fees', 'fee', 'aranceles', 'arancel',
  'spread', 'tarifas', 'tarifa', 'descuentos', 'descuento',
];

const RE_CIFRAS = [
  // 2%  ·  2,5 %  ·  2 por ciento  ·  dos por ciento
  new RegExp(`${NUM_ANY}\\s*(?:%|por\\s*ciento|porciento)`, 'gi'),
  // 5 bolivianos  ·  10 USDC  ·  1.000 Bs  ·  cinco bolivianos
  new RegExp(`${NUM_ANY}\\s*(?:${TERMINOS_MONEDA.join('|')})\\b`, 'gi'),
  // $10  ·  Bs. 500  ·  USD 20  ·  5$
  new RegExp(`(?:us\\$|\\$|\\b(?:bs\\.?|usd|bob|usdt|usdc|eur))\\s*${NUM_ANY}`, 'gi'),
  new RegExp(`${NUM}\\s*\\$`, 'gi'),
  // "2 de comisión"  ·  "una comisión de 2"  ·  "comisión cero"
  // — número (dígito o palabra) a ≤3 palabras de un término de costo
  new RegExp(`${NUM_ANY}(?:\\s+\\S+){0,3}\\s+(?:${TERMINOS_COSTO.join('|')})\\b`, 'gi'),
  new RegExp(`\\b(?:${TERMINOS_COSTO.join('|')})(?:\\s+\\S+){0,3}\\s+${NUM_ANY}`, 'gi'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Señal 5 — Afirmaciones de gratuidad / costo cero
//
// "sin comisiones" y "gratis" son afirmaciones sobre el precio igual que "2%",
// solo que sin dígito, así que se escapaban por completo de la señal de cifras.
// Prometer ausencia de costo es una afirmación comercial verificable y tiene que
// pasar por ojo humano antes de publicarse.
//
// ⚠️ La lista se generaliza a propósito a TODA forma de negar un costo, no solo
// a "sin". En la primera prueba con modelos reales, una pieza escribió "No hay
// comisiones escondidas" y se coló entera: misma afirmación que "sin comisiones",
// otra redacción. Negar un costo tiene muchas formas en español y cubrir una sola
// es cubrir ninguna.
// ─────────────────────────────────────────────────────────────────────────────

/** Formas de negar un costo. Un negador cerca de un término de costo = afirmación de precio. */
export const TERMINOS_NEGACION_COSTO = [
  'sin',
  'no hay', 'no existen?', 'no tien(?:e|es|en)', 'no ten(?:es|es)',
  'no cobra(?:mos|n)?', 'no pag(?:as|an|ues|amos)',
  'nada de', 'libre de', 'exent[oa]s? de', 'ahorrate', 'olvidate de', 'olvida(?:te)? de',
];

const RE_COSTO_CERO = [
  // "sin comisiones" · "No hay comisiones escondidas" · "no cobramos ninguna comisión"
  // · "libre de cargos" · "olvidate de las comisiones"
  // — negador a ≤2 palabras de un término de costo
  new RegExp(
    `\\b(?:${TERMINOS_NEGACION_COSTO.join('|')})\\s+(?:\\S+\\s+){0,2}(?:${TERMINOS_COSTO.join('|')})\\b`,
    'gi',
  ),
  // gratis · gratuito · gratuitas
  /\b(?:gratis|gratuit[oa]s?)\b/gi,
];

// ─────────────────────────────────────────────────────────────────────────────
// Señal 2 — REGULACIÓN y estatus de licencia
//
// ⚠️ Deliberadamente NO incluye "regulada" / "regulado" / "plataforma regulada" /
// "máxima autoridad financiera": son las fórmulas genéricas aprobadas y deben
// quedar en BAJO riesgo. Lo que dispara es nombrar a la autoridad por su sigla o
// nombre propio, o hablar del estatus de la licencia.
//
// El motivo es sustantivo: el estatus regulatorio es un dato sensible y
// cambiante. Cualquier pieza que lo toque tiene que pasar por ojo humano antes
// de publicarse.
// ─────────────────────────────────────────────────────────────────────────────
export const TERMINOS_REGULACION = [
  'asfi',
  'autoridad de supervision',
  'licencias?', 'licenciad[oa]s?',
  'regulador(?:es)?',
  'psav',
  'etfs?',
  'decreto supremo',
  'resoluciones', 'resolucion',
];

// ─────────────────────────────────────────────────────────────────────────────
// Señal 3 — PROMESA de beneficio / lenguaje de inversión
//
// El mercado boliviano viene de esquemas piramidales. Cualquier eco de "ganancia
// fácil" es a la vez un riesgo regulatorio y un riesgo de marca.
// ─────────────────────────────────────────────────────────────────────────────
export const TERMINOS_PROMESA = [
  'gana', 'ganas', 'ganar', 'ganancias?',
  'rendimientos?',
  'retornos?',
  'rentabilidad', 'rentables?',
  'invierte', 'invertir', 'inversiones', 'inversion',
  'duplica(?:r)?', 'triplica(?:r)?',
  'multiplica tu', 'multiplicar tu',
  'haz crecer tu dinero', 'crecer tu dinero',
  'beneficios? economicos?',
  'utilidad(?:es)?',
  'intereses?',
  // Modismos de promesa que no contienen ninguna de las palabras de arriba pero
  // dicen exactamente lo mismo. "Tu dinero trabaja para ti" es la promesa de
  // rendimiento clásica del discurso piramidal boliviano.
  'dinero trabaj\\w*',
  'trabajar tu dinero',
  'ingresos? pasivos?',
  'libertad financiera',
  'dinero facil', 'plata facil',
  'ha(?:z|cer)te rico', 'volverte rico',
];

// ─────────────────────────────────────────────────────────────────────────────
// Señal 4 — Terminología prohibida de marca
//
// "remesa" está prohibida en todo el grupo AV Finance (código, UI, marketing) por
// exigencia de la LLC y su marco con Harbor. "exchange" no describe a Alyto.
// ─────────────────────────────────────────────────────────────────────────────
export const TERMINOS_MARCA = [
  'remesas?',
  'remittances?',
  'exchange',
];

// ─────────────────────────────────────────────────────────────────────────────
// Señal 6 — Afirmaciones legales y de certificación
//
// Certificaciones y registros que Alyto NO posee. Decir que los tiene no es
// marketing agresivo: es una afirmación falsa sobre el estatus legal de la
// empresa, con exposición regulatoria en dos jurisdicciones.
//
// ⚠️ Esta señal nació de unificar la deny-list que vivía suelta en
// marketingCampaignService. El clasificador no la tenía, así que una pieza que
// dijera "tus fondos están asegurados por FDIC" salía clasificada BAJO y se
// autopublicaba sin pasar por ningún humano.
//
// Sobre ASFI: acá se veta SOLO la sobre-afirmación ("regulados/licenciados/
// autorizados/aprobados POR ASFI"). Las fórmulas aprobadas del tipo "operamos
// bajo el marco de ASFI" son correctas y pasan. La lista concreta de fórmulas
// permitidas vive en el material de compliance, fuera de este repositorio.
// (La mención genérica a ASFI ya la captura la señal REGULACION, que manda la
// pieza a revisión humana sin prohibirla.)
// ─────────────────────────────────────────────────────────────────────────────

/** Certificaciones/registros que Alyto no tiene. */
export const TERMINOS_AFIRMACION_LEGAL = [
  'fdic',
  'soc\\s?-?\\s?2',
  'fincen',
];

/** Formas de sobre-afirmar el estatus regulatorio ante ASFI. */
export const TERMINOS_SOBREAFIRMACION_ASFI = [
  '(?:licenciad|regulad|autorizad|aprobad)[oa]s?\\s+por\\s+asfi',
];

// Compilación de listas de términos a una única alternancia con \b.
function compilar(terminos) {
  return new RegExp(`\\b(?:${terminos.join('|')})\\b`, 'gi');
}

const RE_REGULACION = compilar(TERMINOS_REGULACION);
const RE_PROMESA    = compilar(TERMINOS_PROMESA);
const RE_MARCA      = compilar(TERMINOS_MARCA);
const RE_LEGAL      = compilar([...TERMINOS_AFIRMACION_LEGAL, ...TERMINOS_SOBREAFIRMACION_ASFI]);

// ─────────────────────────────────────────────────────────────────────────────
// Prohibiciones ABSOLUTAS — el subconjunto que ningún humano debería poder
// aprobar, a diferencia del resto de las señales (que solo mandan a revisión).
//
// Fuente única compartida: marketingCampaignService la usa como guard duro sobre
// el copy generado (descarta la variante), y el clasificador la usa como una de
// sus señales. Antes eran dos listas distintas que vetaban cosas distintas.
// ─────────────────────────────────────────────────────────────────────────────
const RE_PROHIBIDOS = [
  { re: compilar(TERMINOS_MARCA),                 motivo: MOTIVOS.MARCA },
  { re: compilar(TERMINOS_AFIRMACION_LEGAL),      motivo: MOTIVOS.LEGAL },
  { re: compilar(TERMINOS_SOBREAFIRMACION_ASFI),  motivo: MOTIVOS.LEGAL },
];

/**
 * Guard duro: ¿este texto contiene algo que NO puede publicarse en ningún caso?
 *
 * A diferencia de clasificarRiesgo (que tría entre "publicable" y "revisar"),
 * esto responde binario. Pensado para pipelines que descartan la variante en vez
 * de encolarla, como el copy de landing.
 *
 * @param {string} texto
 * @returns {{ok:true} | {ok:false, motivo:string, coincidencia:string}}
 */
export function verificarProhibiciones(texto) {
  const t = normalizar(texto);
  if (!t.trim()) return { ok: true };
  for (const { re, motivo } of RE_PROHIBIDOS) {
    const m = [...t.matchAll(re)][0];
    if (m) return { ok: false, motivo, coincidencia: m[0] };
  }
  return { ok: true };
}

// Devuelve las coincidencias únicas de una lista de regex sobre el texto.
// Se usa matchAll (no test) porque test() con flag /g/ es stateful y arrastra
// lastIndex entre llamadas.
function coincidenciasDe(texto, regexes) {
  const encontradas = new Set();
  for (const re of regexes) {
    for (const m of texto.matchAll(re)) {
      const s = m[0].trim();
      if (s) encontradas.add(s);
    }
  }
  return [...encontradas];
}

/**
 * Texto publicable de los slides de un carrusel.
 *
 * En un carrusel el grueso del mensaje vive en las imágenes, no en el pie del
 * post. Si estos campos no entraran al clasificador, el control quedaría ciego
 * justo donde más se dice: una cifra o un "regulados por ASFI" en el slide 4 se
 * publicaría sin pasar por la cola, con el pie del post perfectamente limpio.
 *
 * Se recorre defensivamente porque esto viene de parsear la respuesta de un
 * modelo: `slides` puede no ser array, traer nulls o traer campos que no son
 * string. Todo eso se descarta en vez de coercionarse, igual que arriba.
 */
function textosDeSlides(p) {
  if (!Array.isArray(p.slides)) return [];

  const textos = [];
  for (const s of p.slides) {
    if (!s || typeof s !== 'object') continue;
    for (const v of [s.titulo, s.texto]) {
      if (typeof v === 'string') textos.push(v);
    }
  }
  return textos;
}

/**
 * Superficie publicable de una pieza: TODO el texto que termina a la vista.
 *
 * Definición única a propósito. Antes vivía duplicada en el controller y en el
 * servicio de publicación —ambos con el comentario "lo mismo que analiza el
 * clasificador"— y bastaba con agregar un campo acá para que dejara de ser
 * cierto en silencio. Este proyecto ya tuvo ese bug: dos deny-lists de
 * compliance que vetaban cosas distintas.
 *
 * Solo se acepta texto real. Un campo que no sea string (número, objeto,
 * undefined) se descarta en vez de coercionarse: sin este filtro
 * `{cuerpo: {...}}` se convertiría en "[object Object]", contaría como
 * contenido con texto y saldría clasificado BAJO. Sería fallar abierto justo
 * cuando el parseo salió mal.
 */
function camposPublicables(contentPiece) {
  const p = contentPiece || {};
  return [p.titulo, p.cuerpo, p.sugerenciaVisual, ...textosDeSlides(p)]
    .filter(v => typeof v === 'string');
}

/**
 * El texto publicable de una pieza, plano.
 *
 * Es lo que hay que pasarle a `verificarProhibiciones` en cualquier chequeo
 * previo a publicar, para que mire exactamente la misma superficie que miró el
 * clasificador — ni más ni menos.
 *
 * @param {object} contentPiece
 * @returns {string}
 */
export function textoPublicable(contentPiece) {
  return camposPublicables(contentPiece).filter(s => s.trim()).join('\n');
}

/**
 * Clasifica el riesgo regulatorio de una pieza de contenido.
 *
 * Analiza `titulo` + `cuerpo` + `sugerenciaVisual` + el texto de todos los
 * `slides`, juntos. La sugerencia visual se incluye porque termina siendo una
 * imagen publicada: una cifra ahí se publica igual que una cifra en el cuerpo.
 * Los slides, por el mismo motivo y con más razón.
 *
 * Falla cerrado: una pieza sin texto legible se clasifica ALTO, no BAJO. Si el
 * parseo de la respuesta del modelo salió mal, la pieza va a revisión humana en
 * vez de colarse como "apta para publicar".
 *
 * ⚠️ Un carrusel cuyos slides no parsearon NO se detecta acá — se detecta al
 * persistir (ContentPiece valida que un carrusel traiga 2–10 slides numerados).
 * Este módulo decide sobre contenido, no sobre integridad estructural.
 *
 * @param {{titulo?:string, cuerpo?:string, sugerenciaVisual?:string,
 *          slides?:Array<{titulo?:string, texto?:string}>}} contentPiece
 * @returns {{nivel:'alto'|'bajo', motivos:string[], coincidencias:string[]}}
 *   `coincidencias` son los fragmentos (ya normalizados, sin tildes) que
 *   dispararon cada señal — para que el admin vea POR QUÉ está en la cola.
 */
export function clasificarRiesgo(contentPiece) {
  const texto = normalizar(camposPublicables(contentPiece).join('\n'));

  if (!texto.trim()) {
    return { nivel: 'alto', motivos: [MOTIVOS.VACIO], coincidencias: [] };
  }

  const motivos = [];
  const coincidencias = [];

  const senales = [
    { motivo: MOTIVOS.CIFRAS,     regexes: RE_CIFRAS },
    { motivo: MOTIVOS.COSTO_CERO, regexes: RE_COSTO_CERO },
    { motivo: MOTIVOS.REGULACION, regexes: [RE_REGULACION] },
    { motivo: MOTIVOS.PROMESA,    regexes: [RE_PROMESA] },
    { motivo: MOTIVOS.MARCA,      regexes: [RE_MARCA] },
    { motivo: MOTIVOS.LEGAL,      regexes: [RE_LEGAL] },
  ];

  for (const { motivo, regexes } of senales) {
    const hits = coincidenciasDe(texto, regexes);
    if (hits.length) {
      motivos.push(motivo);
      coincidencias.push(...hits);
    }
  }

  return {
    nivel: motivos.length ? 'alto' : 'bajo',
    motivos,
    coincidencias: [...new Set(coincidencias)],
  };
}

export default {
  clasificarRiesgo,
  verificarProhibiciones,
  textoPublicable,
  normalizar,
  MOTIVOS,
  TERMINOS_REGULACION,
  TERMINOS_PROMESA,
  TERMINOS_MARCA,
  TERMINOS_MONEDA,
  TERMINOS_COSTO,
  TERMINOS_NUMERO_PALABRA,
  TERMINOS_NEGACION_COSTO,
  TERMINOS_AFIRMACION_LEGAL,
  TERMINOS_SOBREAFIRMACION_ASFI,
};
