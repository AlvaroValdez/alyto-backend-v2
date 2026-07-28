/**
 * marketingAgentService.test.js — Orquestación del agente de marketing.
 *
 * Lo que importa verificar acá no es que el modelo escriba bien (eso no se
 * testea), sino que el gate funcione: que el clasificador determinista PISE la
 * autoevaluación del modelo, y que el estado con el que la pieza se persiste sea
 * consecuencia de esa decisión y no de lo que el modelo dijo de sí mismo.
 *
 * Mocking: se mockea llmProvider para no tocar la API de Anthropic. La base es
 * MongoMemoryServer — la persistencia sí se ejerce de verdad.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

const completeMock = jest.fn();

await jest.unstable_mockModule('../../src/services/llmProvider.js', () => ({
  complete: completeMock,
  default: { complete: completeMock },
}));
await jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }));

const { connectTestDb, disconnectTestDb, clearCollections } = await import('../helpers/db.js');
const { procesarPieza, generarContenido, isMarketingAgentEnabled } =
  await import('../../src/services/marketingAgentService.js');
const { default: ContentPiece } = await import('../../src/models/ContentPiece.js');
const { MOTIVOS } = await import('../../src/services/riskClassifier.js');
const { __resetPromptCache } = await import('../../src/config/marketingAgentPrompt.js');

// Arma una respuesta del modelo en el formato estructurado del system prompt.
function respuesta({
  titulo = 'Qué es la custodia institucional',
  cuerpo = 'Una entidad regulada guarda y protege tus activos digitales con transparencia.',
  visual = 'Aly junto a una bóveda digital, paleta navy y dorado.',
  canal = 'facebook',
  tipo = 'educacion',
  riesgo = 'bajo',
  motivo = 'Pieza educativa, sin cifras ni promesas.',
} = {}) {
  return {
    text: [
      `TITULO: ${titulo}`, '',
      `CUERPO: ${cuerpo}`, '',
      `SUGERENCIA_VISUAL: ${visual}`, '',
      `CANAL: ${canal}`, '',
      `TIPO: ${tipo}`, '',
      `AUTOEVALUACION_RIESGO: ${riesgo}`,
      `MOTIVO_RIESGO: ${motivo}`,
    ].join('\n'),
    stopReason: 'end_turn',
    usage: { inputTokens: 900, outputTokens: 150 },
  };
}

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });
afterEach(async () => { await clearCollections(); completeMock.mockReset(); });

beforeEach(() => { process.env.MARKETING_AGENT_ENABLED = 'true'; });

describe('feature flag', () => {
  test('con el flag apagado, procesarPieza no llama al modelo ni escribe en Mongo', async () => {
    process.env.MARKETING_AGENT_ENABLED = 'false';
    expect(isMarketingAgentEnabled()).toBe(false);

    const r = await procesarPieza('Generá una pieza educativa.');

    expect(r).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
    expect(await ContentPiece.countDocuments()).toBe(0);
  });
});

describe('flujo completo', () => {
  test('pieza limpia → clasificación bajo → estado autopublicado', async () => {
    completeMock.mockResolvedValue(respuesta());

    const pieza = await procesarPieza('Explicá la custodia institucional para Facebook.');

    expect(pieza.clasificacionFinal).toBe('bajo');
    expect(pieza.motivosClasificador).toEqual([]);
    expect(pieza.estado).toBe('autopublicado');
    expect(pieza.canal).toBe('facebook');
    expect(pieza.tipo).toBe('educacion');
    expect(pieza.creadoPor).toBe('marketing-agent');
    expect(pieza.aprobadoPor).toBeNull();
    expect(pieza.tarea).toContain('custodia institucional');
  });

  test('pieza con cifra → clasificación alto → cae en la cola de aprobación', async () => {
    completeMock.mockResolvedValue(respuesta({
      cuerpo: 'Enviá dinero al exterior con una comisión de apenas 2%.',
      riesgo: 'alto',
    }));

    const pieza = await procesarPieza('Generá una pieza de captación.');

    expect(pieza.clasificacionFinal).toBe('alto');
    expect(pieza.motivosClasificador).toContain(MOTIVOS.CIFRAS);
    expect(pieza.estado).toBe('pendiente_aprobacion');
  });

  test('el modelo dice BAJO pero el clasificador detecta ASFI → gana el clasificador', async () => {
    // Este es el caso que justifica que exista la doble verificación.
    completeMock.mockResolvedValue(respuesta({
      cuerpo: 'Trabajamos de la mano con ASFI para llevar seguridad a Bolivia.',
      riesgo: 'bajo',
      motivo: 'Creo que es una pieza inofensiva.',
    }));

    const pieza = await procesarPieza('Contá nuestro avance regulatorio.');

    expect(pieza.autoevaluacionRiesgo).toBe('bajo');   // lo que dijo el modelo
    expect(pieza.clasificacionFinal).toBe('alto');     // lo que decidió el código
    expect(pieza.motivosClasificador).toContain(MOTIVOS.REGULACION);
    expect(pieza.estado).toBe('pendiente_aprobacion'); // manda el código
  });

  test('guarda ambos veredictos para poder auditar la brecha', async () => {
    completeMock.mockResolvedValue(respuesta({ riesgo: 'alto', motivo: 'Por las dudas.' }));

    const pieza = await procesarPieza('Generá una pieza educativa.');

    expect(pieza.autoevaluacionRiesgo).toBe('alto');
    expect(pieza.motivoRiesgoModelo).toBe('Por las dudas.');
    expect(pieza.clasificacionFinal).toBe('bajo');
  });
});

describe('normalización de la respuesta del modelo', () => {
  test('acepta "Twitter", mayúsculas y tildes en canal y tipo', async () => {
    completeMock.mockResolvedValue(respuesta({ canal: 'Twitter', tipo: 'Captación' }));

    const g = await generarContenido('tarea');

    expect(g.canal).toBe('x');
    expect(g.tipo).toBe('captacion');
  });

  test('autoevaluación ilegible se asume ALTO (falla cerrado)', async () => {
    completeMock.mockResolvedValue(respuesta({ riesgo: 'no estoy seguro' }));

    const g = await generarContenido('tarea');

    expect(g.autoevaluacionRiesgo).toBe('alto');
  });
});

describe('respuestas del modelo que no sirven', () => {
  test.each([
    ['sin estructura',   { text: 'Claro, con gusto te ayudo con eso.' },              'RESPUESTA_NO_PARSEABLE'],
    ['sin cuerpo',       { text: 'TITULO: Solo un título' },                          'RESPUESTA_NO_PARSEABLE'],
    ['canal inventado',  respuesta({ canal: 'instagram' }),                           'CANAL_INVALIDO'],
    ['tipo inventado',   respuesta({ tipo: 'entretenimiento' }),                      'TIPO_INVALIDO'],
  ])('%s → lanza %s y no persiste nada', async (_, resp, code) => {
    completeMock.mockResolvedValue({ stopReason: 'end_turn', usage: {}, ...resp });

    await expect(procesarPieza('tarea')).rejects.toMatchObject({ code });
    expect(await ContentPiece.countDocuments()).toBe(0);
  });

  test('tarea vacía se rechaza antes de llamar al modelo', async () => {
    await expect(procesarPieza('   ')).rejects.toMatchObject({ code: 'TAREA_VACIA' });
    expect(completeMock).not.toHaveBeenCalled();
  });

  test('si la API falla, el error se propaga y no queda pieza a medias', async () => {
    completeMock.mockRejectedValue(new Error('overloaded_error'));

    await expect(procesarPieza('tarea')).rejects.toThrow('overloaded_error');
    expect(await ContentPiece.countDocuments()).toBe(0);
  });
});

describe('system prompt cargado desde fuera del repo', () => {
  // El texto del prompt no vive en el repositorio (es material de compliance).
  // Que falte es un modo de fallo real en un despliegue nuevo, no una hipótesis.

  test('sin prompt configurado → error con código accionable, sin llamar al modelo', async () => {
    const previo = process.env.MARKETING_AGENT_SYSTEM_PROMPT;
    delete process.env.MARKETING_AGENT_SYSTEM_PROMPT;
    __resetPromptCache();
    try {
      await expect(procesarPieza('tarea')).rejects.toMatchObject({ code: 'PROMPT_NO_CONFIGURADO' });
      expect(completeMock).not.toHaveBeenCalled();
      expect(await ContentPiece.countDocuments()).toBe(0);
    } finally {
      process.env.MARKETING_AGENT_SYSTEM_PROMPT = previo;
      __resetPromptCache();
    }
  });

  test('el mensaje nombra las variables que hay que setear', async () => {
    const previo = process.env.MARKETING_AGENT_SYSTEM_PROMPT;
    delete process.env.MARKETING_AGENT_SYSTEM_PROMPT;
    __resetPromptCache();
    try {
      await expect(generarContenido('tarea')).rejects.toThrow(/MARKETING_AGENT_SYSTEM_PROMPT/);
    } finally {
      process.env.MARKETING_AGENT_SYSTEM_PROMPT = previo;
      __resetPromptCache();
    }
  });

  test('se puede cargar desde un archivo en disco (desarrollo local)', async () => {
    const previo = process.env.MARKETING_AGENT_SYSTEM_PROMPT;
    delete process.env.MARKETING_AGENT_SYSTEM_PROMPT;
    const ruta = `${tmpdir()}/prompt-test-${Date.now()}.txt`;
    writeFileSync(ruta, 'Prompt cargado desde archivo.');
    process.env.MARKETING_AGENT_PROMPT_PATH = ruta;
    __resetPromptCache();
    completeMock.mockResolvedValue(respuesta());
    try {
      await generarContenido('tarea');
      expect(completeMock.mock.calls[0][0].system).toBe('Prompt cargado desde archivo.');
    } finally {
      unlinkSync(ruta);
      delete process.env.MARKETING_AGENT_PROMPT_PATH;
      process.env.MARKETING_AGENT_SYSTEM_PROMPT = previo;
      __resetPromptCache();
    }
  });
});

describe('llamada al modelo', () => {
  test('NO envía temperature: mantiene el servicio agnóstico del modelo (Opus 4.8 la rechaza con 400)', async () => {
    completeMock.mockResolvedValue(respuesta());

    await generarContenido('tarea');

    const args = completeMock.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
    expect(args.model).toBe('claude-sonnet-4-6');
    expect(args.system).toContain('agente de contenido');
    expect(args.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'tarea' }] },
    ]);
  });

  test('el modelo es configurable por env var', async () => {
    process.env.MARKETING_AGENT_MODEL = 'claude-opus-4-8';
    completeMock.mockResolvedValue(respuesta());

    await generarContenido('tarea');

    expect(completeMock.mock.calls[0][0].model).toBe('claude-opus-4-8');
    delete process.env.MARKETING_AGENT_MODEL;
  });
});
