/**
 * sanctionsMatch.js — Normalización y coincidencia de nombres para el cribado AML.
 *
 * Vive aparte y sin dependencias para poder probarlo sin base de datos, que es
 * justo lo que no se podía hacer cuando la lógica estaba incrustada en la
 * consulta de Mongo.
 *
 * POR QUÉ EXISTE
 *
 * El cribado anterior buscaba por SUBCADENA sin anclar:
 *
 *     { fullName: { $regex: firstName, $options: 'i' } }
 *
 * y después confirmaba el acierto con un OR: bastaba que apareciera el nombre
 * O el apellido. Con una lista de dos entradas eso era inofensivo. Con las
 * ~20.500 entradas reales de OFAC y ONU es destructivo: una usuaria llamada
 * "Ana" casaría con cualquier entrada que contenga esas tres letras dentro de
 * otra palabra —"HASSANA", "ANASTASIO", "LIANA"— y el middleware responde 403,
 * bloqueando depósitos, envíos y retiros de gente legítima.
 *
 * Aquí se compara por TOKENS completos y se exigen TODOS:
 *
 *     "Ana Quispe"  vs  "ANASTASIO QUISPE"   -> NO casa ("ana" != "anastasio")
 *     "Ana Quispe"  vs  "QUISPE ANA MARIA"   -> casa (están "ana" y "quispe")
 *
 * LÍMITE CONOCIDO, Y HAY QUE DECIRLO
 *
 * Esto es coincidencia exacta por token, no difusa. No detecta transliteraciones
 * ni erratas ("Mohamed" vs "Muhammad"), que es precisamente lo que venden
 * ComplyAdvantage, Refinitiv o Dow Jones. Es un suelo defendible, no un
 * programa AML completo, y el expediente no debe decir otra cosa.
 */

/** Minúsculas, sin tildes, sin signos. Misma normalización en carga y consulta. */
export function normalizar(texto = '') {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Partículas que no aportan identidad y disparan falsos positivos: casi todo
 * nombre hispano lleva alguna, así que exigirlas o contarlas distorsiona.
 */
const PARTICULAS = new Set([
  'de', 'del', 'la', 'las', 'los', 'el', 'y', 'da', 'do', 'dos', 'das',
  'van', 'von', 'bin', 'ibn', 'al', 'el-', 'san', 'santa', 'mc', 'mac',
])

/**
 * Tokens significativos de un nombre: palabras de 2+ caracteres que no sean
 * partículas. Se descartan las de una letra (iniciales) porque casan con todo.
 */
export function tokens(nombre = '') {
  return [...new Set(
    normalizar(nombre)
      .split(' ')
      .filter(t => t.length >= 2 && !PARTICULAS.has(t)),
  )]
}

/**
 * ¿Los tokens de la persona consultada están TODOS en los de la entrada?
 *
 * Se exige que estén todos (AND). Con OR, un apellido frecuente como "Perez"
 * bastaría para bloquear a cualquiera que lo lleve.
 *
 * @param {string[]} tokensConsulta  del usuario que se criba
 * @param {string[]} tokensEntrada   de la entrada de la lista (nombre + alias)
 */
export function coincideNombre(tokensConsulta, tokensEntrada) {
  if (!tokensConsulta?.length || !tokensEntrada?.length) return false
  // Un solo token no basta para bloquear a nadie: "Juan" a secas no identifica.
  // Si solo se conoce un token, no se afirma coincidencia por nombre; el cribado
  // por documento sigue valiendo y es exacto.
  if (tokensConsulta.length < 2) return false
  const enEntrada = new Set(tokensEntrada)
  return tokensConsulta.every(t => enEntrada.has(t))
}

/**
 * ¿Coincide con ALGUNA variante de nombre de la entrada, por separado?
 *
 * Esta es la que se usa para confirmar, y la distinción no es cosmética. Si se
 * juntan el nombre principal y todos los alias en una sola bolsa de tokens, se
 * producen coincidencias CRUZADAS: "Juan" sacado de un alias y "Perez" del
 * nombre principal bastaban para señalar a cualquier Juan Pérez.
 *
 * Medido contra las 17.556 entradas reales de OFAC, con 20 nombres bolivianos
 * corrientes: la bolsa común daba 3 coincidencias cruzadas y comparando
 * variante a variante siguen saliendo 3, pero ya NO son cruzadas. Son
 * coincidencias legítimas contra ALIAS reales del SDN: "CASTRO, Jorge" figura
 * tal cual como alias, y "Juan Perez" es subconjunto de "MEDINA PEREZ, Juan
 * Manual".
 *
 * Esto último no lo arregla ningún comparador: nombres hispanos frecuentes
 * COLISIONAN con alias de la lista, y punto. Por eso un acierto por nombre no
 * puede bloquear por sí solo; hace falta documento, fecha de nacimiento o
 * revisión humana. Medido sobre la base real: 1 de cada 23 usuarios casaría
 * solo por nombre.
 *
 * @param {string[]} tokensConsulta
 * @param {string[]} variantes  nombre principal y cada alias, SIN mezclar
 */
export function coincideAlgunaVariante(tokensConsulta, variantes = []) {
  return variantes.some(v => coincideNombre(tokensConsulta, tokens(v)))
}

/** Normaliza un documento para comparar: sin guiones, espacios ni puntos. */
export function normalizarDocumento(doc = '') {
  return String(doc).toUpperCase().replace(/[^A-Z0-9]/g, '')
}
