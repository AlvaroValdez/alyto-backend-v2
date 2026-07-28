/**
 * riskClassifier.test.js — Clasificador de riesgo regulatorio del agente de marketing.
 *
 * Este es el control que protege a AV Finance ante ASFI. Un falso negativo acá
 * significa una pieza publicada sin revisión humana que no debía salir, así que
 * los tests cubren tanto los casos obvios como los caminos de evasión: tildes,
 * mayúsculas, señales escondidas en el título o en la sugerencia visual, y
 * entradas rotas.
 *
 * También se testea explícitamente lo que NO debe disparar. Un clasificador que
 * marca todo en alto es tan inútil como uno que no marca nada: la cola se llena
 * de ruido y el revisor humano termina aprobando sin leer.
 */

import '../setup.env.js'
import {
  clasificarRiesgo,
  verificarProhibiciones,
  normalizar,
  MOTIVOS,
  TERMINOS_REGULACION,
  TERMINOS_PROMESA,
  TERMINOS_MARCA,
} from '../../src/services/riskClassifier.js'

// Atajo: arma una pieza con solo cuerpo.
const pieza = (cuerpo, extra = {}) => ({ titulo: 'Título neutro', cuerpo, ...extra })

// ─────────────────────────────────────────────────────────────────────────────
// Caso base: la pieza educativa limpia debe pasar
// ─────────────────────────────────────────────────────────────────────────────
describe('piezas limpias → BAJO riesgo', () => {
  test('pieza educativa canónica sobre custodia institucional', () => {
    const r = clasificarRiesgo({
      titulo: '¿Qué significa que tus activos estén en custodia institucional?',
      cuerpo: 'Cuando escuchas "custodia institucional", significa que una entidad regulada se encarga de guardar y proteger tus activos digitales bajo normas estrictas de seguridad. En Alyto, tus activos están resguardados bajo el marco de la máxima autoridad financiera de Bolivia. No tienes que preocuparte por claves complicadas ni por perder acceso a tu dinero: la plataforma se encarga de la seguridad por ti, con transparencia y respaldo regulatorio.',
      sugerenciaVisual: 'Aly de pie junto a un ícono de bóveda digital, paleta navy y dorado, estilo limpio y profesional.',
    })
    expect(r.nivel).toBe('bajo')
    expect(r.motivos).toEqual([])
    expect(r.coincidencias).toEqual([])
  })

  test('"plataforma regulada" sola es fórmula aprobada, NO dispara', () => {
    expect(clasificarRiesgo(pieza('Alyto es una plataforma regulada y segura.')).nivel).toBe('bajo')
  })

  test('"bajo el marco de la máxima autoridad financiera" es fórmula aprobada', () => {
    const r = clasificarRiesgo(pieza('Operamos bajo el marco de la máxima autoridad financiera del país.'))
    expect(r.nivel).toBe('bajo')
  })

  test('"regulada" / "regulado" / "regulatorio" no se confunden con "regulador"', () => {
    const r = clasificarRiesgo(pieza('Una entidad regulada, con respaldo regulatorio, en un entorno regulado.'))
    expect(r.nivel).toBe('bajo')
  })

  test('"la mejor tasa del mercado" sin cifra es fórmula aprobada', () => {
    expect(clasificarRiesgo(pieza('Te damos la mejor tasa del mercado, sin letra chica.')).nivel).toBe('bajo')
  })

  test('mencionar USDC o bolivianos sin número no dispara', () => {
    const r = clasificarRiesgo(pieza('USDC es un activo digital estable. Muchos bolivianos ya lo usan para transferencias internacionales.'))
    expect(r.nivel).toBe('bajo')
  })

  test('números NO económicos no disparan (pasos, minutos, horarios)', () => {
    const r = clasificarRiesgo(pieza('En 3 pasos y menos de 2 minutos abres tu cuenta. Soporte disponible 24/7 todos los días.'))
    expect(r.nivel).toBe('bajo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 1 — CIFRAS
// ─────────────────────────────────────────────────────────────────────────────
describe('señal CIFRAS → ALTO riesgo', () => {
  test.each([
    ['porcentaje pegado',        'Cobramos apenas 2% por cada operación.'],
    ['porcentaje con decimal',   'La comisión es de 6,5 % sobre el monto.'],
    ['porcentaje en palabras',   'Solo 2 por ciento de costo.'],
    ['monto en bolivianos',      'Te cuesta 5 bolivianos enviar dinero.'],
    ['monto con Bs.',            'Desde Bs. 500 puedes empezar.'],
    ['monto con símbolo dólar',  'Envía desde $10 a cualquier país.'],
    ['código de moneda antes',   'Recibe USD 20 en tu wallet.'],
    ['código de moneda después', 'Guarda 100 USDC en tu wallet.'],
    ['miles con separador',      'Transfiere hasta 1.000 bolivianos por día.'],
    ['número antes de comisión', 'Pagas 2 de comisión, nada más.'],
    ['comisión antes de número', 'Nuestra comisión es de apenas 3.'],
    ['número cerca de tasa',     'La tasa de hoy es 9,31.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.CIFRAS)
    expect(r.coincidencias.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 1b — CIFRAS escritas en palabras
//
// Vía de evasión principal: al agente se le prohíben las cifras, así que la
// salida natural para decir "2%" es escribirlo con letras.
// ─────────────────────────────────────────────────────────────────────────────
describe('cifras escritas en palabras → ALTO riesgo', () => {
  test.each([
    ['porcentaje en letras',   'La comisión es del dos por ciento.'],
    ['monto en letras',        'Te cuesta cinco bolivianos enviar dinero.'],
    ['cerca de costo',         'Pagas tres de comisión, nada más.'],
    ['cero como número',       'Comisión cero para tus transferencias.'],
    ['cantidades grandes',     'Envía hasta mil bolivianos por día.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.CIFRAS)
  })

  test('"un"/"una" NO cuentan como número: son artículos', () => {
    // Si contaran, "una tasa competitiva" dispararía y con eso casi cualquier frase.
    expect(clasificarRiesgo(pieza('Te damos una tasa competitiva y un costo claro.')).motivos)
      .not.toContain(MOTIVOS.CIFRAS)
  })

  test('"medio" NO cuenta como número: "medio de pago" es vocabulario de Alyto', () => {
    expect(clasificarRiesgo(pieza('Alyto es un medio de pago con tarifas claras.')).motivos)
      .not.toContain(MOTIVOS.CIFRAS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 5 — Gratuidad / costo cero
// ─────────────────────────────────────────────────────────────────────────────
describe('señal COSTO_CERO → ALTO riesgo', () => {
  test.each([
    ['sin comisiones',      'Sin comisiones ocultas, sin letra chica.'],
    ['sin costo',           'Abre tu cuenta sin costo.'],
    ['sin ningún cargo',    'Transfiere sin ningún cargo adicional.'],
    ['libre de comisiones', 'Una cuenta libre de comisiones.'],
    ['gratis',              'Envía dinero gratis este mes.'],
    ['gratuito',            'El registro es completamente gratuito.'],
    // ⚠️ Regresión de campo: esta frase la escribió un modelo real en la primera
    // corrida contra la API y se coló como bajo riesgo. Negar un costo tiene
    // muchas formas en español; cubrir solo "sin" era cubrir ninguna.
    ['no hay comisiones',   'No hay sorpresas. No hay comisiones escondidas.'],
    ['no cobramos',         'No cobramos comisión por recibir.'],
    ['no tienes cargos',    'No tienes cargos mensuales.'],
    ['nada de comisiones',  'Nada de comisiones sorpresa.'],
    ['olvidate de',         'Olvidate de las comisiones ocultas.'],
    ['exento de',           'Un servicio exento de cargos.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.COSTO_CERO)
  })

  test('"sin letra chica" sola no dispara: no afirma nada sobre el precio', () => {
    expect(clasificarRiesgo(pieza('Todo claro, sin letra chica ni sorpresas.')).nivel).toBe('bajo')
  })

  test('una negación sin término de costo cerca no dispara', () => {
    // "no hay" es negador, pero "fronteras" no es un término de costo.
    expect(clasificarRiesgo(pieza('Para tu negocio no hay fronteras.')).nivel).toBe('bajo')
  })

  test('"la mejor tasa del mercado" y "costos insignificantes" siguen siendo aprobadas', () => {
    // Fórmulas explícitamente permitidas por el system prompt. Si esto empieza a
    // fallar, el clasificador está bloqueando el copy on-brand oficial.
    const r = clasificarRiesgo(pieza(
      'Accedes a la mejor tasa del mercado con costos insignificantes para tu negocio.'
    ))
    expect(r.nivel).toBe('bajo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 2 — REGULACIÓN
// ─────────────────────────────────────────────────────────────────────────────
describe('señal REGULACION → ALTO riesgo', () => {
  test.each([
    ['sigla de la autoridad',   'Estamos trabajando con ASFI en el proceso.'],
    ['autoridad por nombre',    'Presentamos todo ante la Autoridad de Supervisión del sistema financiero.'],
    ['estatus de licencia',     'Ya tenemos nuestra licencia para operar.'],
    ['la palabra regulador',    'El regulador aprobó nuestro modelo.'],
    ['sigla PSAV',              'Alyto es un PSAV en Bolivia.'],
    ['sigla ETF',               'Operamos como ETF ante el sistema financiero.'],
    ['decreto supremo',         'Todo esto nace del Decreto Supremo 5384.'],
    ['resolución',              'Según la resolución vigente, podemos custodiar activos.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.REGULACION)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 3 — PROMESA / INVERSIÓN
// ─────────────────────────────────────────────────────────────────────────────
describe('señal PROMESA → ALTO riesgo', () => {
  test.each([
    ['haz crecer tu dinero', 'Con Alyto puedes haz crecer tu dinero sin esfuerzo.'],
    ['crecer tu dinero',     'Es la forma de crecer tu dinero.'],
    ['invierte',             'Invierte hoy y descubre el mundo digital.'],
    ['inversión',            'Alyto es la mejor inversión para tu futuro.'],
    ['gana',                 'Gana con cada transferencia que realizas.'],
    ['ganancia',             'Tu ganancia crece mes a mes.'],
    ['rendimiento',          'Un rendimiento constante para tu dinero.'],
    ['retorno',              'El retorno es inmediato.'],
    ['rentabilidad',         'Máxima rentabilidad garantizada.'],
    ['duplica',              'Duplica lo que tienes en pocos meses.'],
    ['multiplica tu',        'Multiplica tu dinero con nosotros.'],
    ['beneficio económico',  'Un beneficio económico real para tu familia.'],
    ['utilidad',             'La utilidad se acredita automáticamente.'],
    ['intereses',            'Acumula intereses mes a mes.'],
    // Modismos: dicen "rendimiento" sin usar ninguna palabra de la lista.
    ['dinero trabaja',       'Tu dinero trabaja para ti mientras duermes.'],
    ['dinero trabaje',       'Haz que tu dinero trabaje solo.'],
    ['trabajar tu dinero',   'Pon a trabajar tu dinero desde hoy.'],
    ['ingresos pasivos',     'Genera ingresos pasivos con Alyto.'],
    ['libertad financiera',  'El primer paso hacia tu libertad financiera.'],
    ['dinero fácil',         'Nada de dinero fácil: esto es serio.'],
    ['hazte rico',           'Hazte rico con la nueva economía digital.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.PROMESA)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 4 — TERMINOLOGÍA DE MARCA
// ─────────────────────────────────────────────────────────────────────────────
describe('señal MARCA → ALTO riesgo', () => {
  test.each([
    ['remesa singular',  'Manda tu remesa con Alyto.'],
    ['remesas plural',   'Las remesas ahora son más simples.'],
    ['remittance inglés','Send your remittance with Alyto.'],
    ['exchange',         'Alyto es el exchange más seguro de Bolivia.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.MARCA)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Señal 6 — Afirmaciones legales / certificaciones
//
// Regresión de la unificación: esta señal vivía SOLO en la deny-list de
// marketingCampaignService. El clasificador no la tenía, así que una pieza que
// dijera "asegurado por FDIC" salía BAJO y se autopublicaba sin ver un humano.
// ─────────────────────────────────────────────────────────────────────────────
describe('señal LEGAL → ALTO riesgo', () => {
  test.each([
    ['FDIC',                'Tus fondos están asegurados por FDIC.'],
    ['SOC 2',               'Somos una empresa certificada SOC 2.'],
    ['SOC-2 con guion',     'Contamos con certificación SOC-2.'],
    ['FinCEN',              'Estamos registrados ante FinCEN.'],
    ['regulados por ASFI',  'Alyto está regulado por ASFI.'],
    ['licenciados por ASFI','Somos licenciados por ASFI.'],
    ['autorizados por ASFI','Estamos autorizados por ASFI para operar.'],
    ['aprobados por ASFI',  'Nuestro modelo fue aprobado por ASFI.'],
  ])('%s', (_, cuerpo) => {
    const r = clasificarRiesgo(pieza(cuerpo))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.LEGAL)
  })

  test('"bajo el marco de ASFI" NO es sobre-afirmación (va a revisión, no es falsedad)', () => {
    // Fórmula correcta: la SRL opera dentro del Entorno Controlado de Pruebas.
    // Dispara REGULACION (mención a la autoridad) pero NO LEGAL.
    const r = clasificarRiesgo(pieza('Operamos bajo el marco de ASFI.'))
    expect(r.motivos).toContain(MOTIVOS.REGULACION)
    expect(r.motivos).not.toContain(MOTIVOS.LEGAL)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// verificarProhibiciones — guard duro compartido con marketingCampaignService
//
// Es la fuente ÚNICA de las prohibiciones absolutas. Antes había dos listas
// paralelas que vetaban cosas distintas.
// ─────────────────────────────────────────────────────────────────────────────
describe('verificarProhibiciones (guard duro)', () => {
  test.each([
    ['remesa',            'Manda tu remesa hoy.',                    MOTIVOS.MARCA],
    ['remittance',        'Send your remittance today.',             MOTIVOS.MARCA],
    ['exchange',          'Alyto es el exchange más seguro.',        MOTIVOS.MARCA],
    ['FDIC',              'Asegurado por FDIC.',                     MOTIVOS.LEGAL],
    ['SOC 2',             'Certificación SOC 2 vigente.',            MOTIVOS.LEGAL],
    ['FinCEN',            'Registrados ante FinCEN.',                MOTIVOS.LEGAL],
    ['regulados por ASFI','Somos regulados por ASFI.',               MOTIVOS.LEGAL],
  ])('veta %s', (_, texto, motivo) => {
    const v = verificarProhibiciones(texto)
    expect(v.ok).toBe(false)
    expect(v.motivo).toBe(motivo)
    expect(v.coincidencia).toBeTruthy()
  })

  test.each([
    ['fórmula ASFI correcta',  'Operamos bajo el marco de ASFI, la máxima autoridad financiera.'],
    ['plataforma regulada',    'Alyto es una plataforma regulada y segura.'],
    ['copy educativo',         'La custodia institucional protege tus activos digitales.'],
    ['cifra económica',        'La comisión es de 2%.'],
  ])('deja pasar %s', (_, texto) => {
    // ⚠️ La última fila es intencional: una cifra es "revisable", no "prohibida".
    // El guard duro solo veta lo que ningún humano debería poder aprobar.
    expect(verificarProhibiciones(texto).ok).toBe(true)
  })

  test('texto vacío o no-string no veta nada', () => {
    for (const v of ['', '   ', null, undefined, 42]) {
      expect(verificarProhibiciones(v).ok).toBe(true)
    }
  })

  test('es determinístico entre llamadas (regex con flag /g/)', () => {
    const t = 'Manda tu remesa hoy.'
    expect(verificarProhibiciones(t)).toEqual(verificarProhibiciones(t))
    expect(verificarProhibiciones(t).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Evasión: tildes, mayúsculas, y señales fuera del cuerpo
// ─────────────────────────────────────────────────────────────────────────────
describe('resistencia a evasión', () => {
  test('detecta términos escritos SIN tilde', () => {
    const r = clasificarRiesgo(pieza('Segun la resolucion vigente, tu inversion esta protegida.'))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toEqual(expect.arrayContaining([MOTIVOS.REGULACION, MOTIVOS.PROMESA]))
  })

  test('detecta términos escritos CON tilde', () => {
    const r = clasificarRiesgo(pieza('Según la resolución vigente, tu inversión está protegida.'))
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toEqual(expect.arrayContaining([MOTIVOS.REGULACION, MOTIVOS.PROMESA]))
  })

  test('es insensible a mayúsculas y minúsculas', () => {
    expect(clasificarRiesgo(pieza('asfi aprobó todo')).nivel).toBe('alto')
    expect(clasificarRiesgo(pieza('AsFi aprobó todo')).nivel).toBe('alto')
    expect(clasificarRiesgo(pieza('INVIERTE HOY')).nivel).toBe('alto')
  })

  test('detecta la señal cuando está SOLO en el título', () => {
    const r = clasificarRiesgo({
      titulo: 'Gana más con cada transferencia',
      cuerpo: 'Alyto te permite mover tu dinero de forma segura y transparente.',
    })
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.PROMESA)
  })

  test('detecta la señal cuando está SOLO en la sugerencia visual', () => {
    const r = clasificarRiesgo({
      titulo: 'Transferencias internacionales simples',
      cuerpo: 'Mueve tu dinero con respaldo y transparencia.',
      sugerenciaVisual: 'Aly señalando un cartel que dice 2% de comisión, paleta navy y dorado.',
    })
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.CIFRAS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Acumulación de señales
// ─────────────────────────────────────────────────────────────────────────────
describe('múltiples señales', () => {
  test('una pieza con las cuatro señales acumula los cuatro motivos', () => {
    const r = clasificarRiesgo({
      titulo: 'Invierte en remesas con ASFI',
      cuerpo: 'Gana 5% de rentabilidad. Ya tenemos nuestra licencia y somos un exchange regulado.',
    })
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toEqual(expect.arrayContaining([
      MOTIVOS.CIFRAS, MOTIVOS.REGULACION, MOTIVOS.PROMESA, MOTIVOS.MARCA,
    ]))
    expect(r.motivos).toHaveLength(4)
  })

  test('cada motivo aparece UNA sola vez aunque la señal se repita', () => {
    const r = clasificarRiesgo(pieza('ASFI, ASFI y otra vez ASFI. Y la licencia también.'))
    expect(r.motivos).toEqual([MOTIVOS.REGULACION])
  })

  test('basta UNA señal para clasificar toda la pieza como alto (regla conservadora)', () => {
    const r = clasificarRiesgo(pieza(
      'Alyto es una plataforma regulada, con custodia institucional y transparencia total. ' +
      'Un solo detalle: la comisión es de 2%.'
    ))
    expect(r.nivel).toBe('alto')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entradas rotas — el clasificador falla CERRADO
// ─────────────────────────────────────────────────────────────────────────────
describe('entradas inválidas → falla cerrado (ALTO)', () => {
  test.each([
    ['undefined',      undefined],
    ['null',           null],
    ['objeto vacío',   {}],
    ['campos vacíos',  { titulo: '', cuerpo: '' }],
    ['solo espacios',  { titulo: '   ', cuerpo: '\n\t ' }],
    ['tipos erróneos', { titulo: 42, cuerpo: { a: 1 } }],
  ])('%s → alto con motivo VACIO', (_, entrada) => {
    const r = clasificarRiesgo(entrada)
    expect(r.nivel).toBe('alto')
    expect(r.motivos).toContain(MOTIVOS.VACIO)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Determinismo — regresión contra el bug clásico de regex con flag /g/
// ─────────────────────────────────────────────────────────────────────────────
describe('determinismo', () => {
  test('la misma pieza da el mismo veredicto en llamadas sucesivas', () => {
    const p = pieza('Invierte con ASFI y gana 5% en remesas.')
    const a = clasificarRiesgo(p)
    const b = clasificarRiesgo(p)
    const c = clasificarRiesgo(p)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  test('alternar piezas de alto y bajo no arrastra estado entre llamadas', () => {
    const alta  = pieza('La comisión es 2%.')
    const baja  = pieza('La custodia institucional protege tus activos.')
    for (let i = 0; i < 5; i++) {
      expect(clasificarRiesgo(alta).nivel).toBe('alto')
      expect(clasificarRiesgo(baja).nivel).toBe('bajo')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de salida y utilidades
// ─────────────────────────────────────────────────────────────────────────────
describe('contrato de salida', () => {
  test('siempre devuelve nivel, motivos y coincidencias', () => {
    for (const p of [pieza('texto limpio sobre custodia'), pieza('gana 2%'), null]) {
      const r = clasificarRiesgo(p)
      expect(['alto', 'bajo']).toContain(r.nivel)
      expect(Array.isArray(r.motivos)).toBe(true)
      expect(Array.isArray(r.coincidencias)).toBe(true)
    }
  })

  test('nivel bajo implica motivos vacíos, y viceversa', () => {
    const bajo = clasificarRiesgo(pieza('La custodia institucional protege tus activos digitales.'))
    expect(bajo.nivel).toBe('bajo')
    expect(bajo.motivos).toHaveLength(0)

    const alto = clasificarRiesgo(pieza('Invierte hoy.'))
    expect(alto.nivel).toBe('alto')
    expect(alto.motivos.length).toBeGreaterThan(0)
  })

  test('coincidencias explica POR QUÉ se marcó (sin duplicados)', () => {
    const r = clasificarRiesgo(pieza('ASFI y ASFI otra vez, con 2% de comisión.'))
    expect(r.coincidencias).toEqual([...new Set(r.coincidencias)])
    expect(r.coincidencias.some(c => c.includes('asfi'))).toBe(true)
  })

  test('normalizar quita tildes y baja a minúsculas', () => {
    expect(normalizar('Resolución ASFI Inversión')).toBe('resolucion asfi inversion')
    expect(normalizar(null)).toBe('')
    expect(normalizar(123)).toBe('')
  })

  test('las listas de términos están exportadas y no vacías (son ajustables)', () => {
    for (const lista of [TERMINOS_REGULACION, TERMINOS_PROMESA, TERMINOS_MARCA]) {
      expect(Array.isArray(lista)).toBe(true)
      expect(lista.length).toBeGreaterThan(0)
    }
  })
})
