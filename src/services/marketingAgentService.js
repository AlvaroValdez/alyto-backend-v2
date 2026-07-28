// src/services/marketingAgentService.js
//
// Agente de marketing y educación financiera: genera una pieza de contenido con
// la API de Anthropic, la pasa por el clasificador de riesgo determinista y la
// persiste como ContentPiece con el estado que corresponda.
//
// Doble verificación (intencional): el modelo se autoevalúa (AUTOEVALUACION_RIESGO)
// y el código vuelve a analizar el texto (riskClassifier). Gana el código. Ambos
// veredictos quedan guardados para poder auditar la brecha entre los dos.
//
// ⚠️ En esta fase NO hay publicación real a redes. Una pieza de bajo riesgo queda
// en estado 'autopublicado', que significa "apta para publicar sin gate humano",
// no "ya salió". La publicación es la fase siguiente.
//
// Gating: todo apagado salvo MARKETING_AGENT_ENABLED=true.
//
// Contrato de errores:
//   - Flag apagado          → devuelve null + log (no es un error, es un no-op).
//   - Fallo real (API caída,
//     respuesta no parseable) → LANZA, tras loguear y reportar a Sentry.
// Se lanza a propósito en vez de devolver null: quien dispara esto es un admin
// desde el panel, y "no pasó nada" es una respuesta inútil. El controller traduce
// el error a un mensaje accionable.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';
import { complete } from './llmProvider.js';
import { getMarketingAgentSystemPrompt } from '../config/marketingAgentPrompt.js';
import { clasificarRiesgo } from './riskClassifier.js';
import ContentPiece from '../models/ContentPiece.js';

// Las env vars se leen en cada llamada, no al importar el módulo: así el flag se
// puede activar en pruebas y en local sin reiniciar el proceso, y los tests no
// dependen del orden de importación.
const cfg = () => ({
  enabled:  process.env.MARKETING_AGENT_ENABLED === 'true',
  provider: process.env.MARKETING_AGENT_PROVIDER || 'anthropic',
  // Modelo por defecto: Sonnet 4.6, elegido con evidencia y no por tier.
  // En la comparación Haiku 4.5 / Sonnet 4.6 / Opus 4.8 sobre tareas reales,
  // Sonnet escribió a la par de Opus a la mitad del costo, y es el mismo modelo
  // que ya usa marketingCampaignService (un modelo menos que mantener). Haiku
  // quedó descartado: fue el único que produjo una afirmación de precio
  // ("No hay comisiones escondidas") y el único que no trasladó las
  // restricciones de compliance a la sugerencia visual.
  model:     process.env.MARKETING_AGENT_MODEL || 'claude-sonnet-4-6',
  maxTokens: Number(process.env.MARKETING_AGENT_MAX_TOKENS || 2000),
});

export function isMarketingAgentEnabled() {
  return cfg().enabled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parseo de la respuesta estructurada
//
// El modelo responde con un bloque de campos ETIQUETA: valor. Se parsea por
// líneas y no con una regex gigante porque CUERPO es multilínea: cada línea que
// no abre una etiqueta conocida pertenece al campo anterior.
//
// Tolera que el modelo agregue negritas markdown (**TITULO:**) o texto de
// preámbulo antes del primer campo, aunque el prompt lo prohíbe: el formato lo
// produce un modelo, y asumir que siempre obedece es cómo se rompen los parsers.
// ─────────────────────────────────────────────────────────────────────────────

const CAMPOS = [
  'TITULO', 'CUERPO', 'SUGERENCIA_VISUAL', 'CANAL', 'TIPO',
  'AUTOEVALUACION_RIESGO', 'MOTIVO_RIESGO',
];

const RE_ETIQUETA = new RegExp(`^[\\s*#>-]*(${CAMPOS.join('|')})\\s*\\**\\s*:\\s*(.*)$`, 'i');

export function parseRespuestaAgente(texto) {
  const campos = {};
  let actual = null;

  for (const linea of String(texto || '').split(/\r?\n/)) {
    const m = linea.match(RE_ETIQUETA);
    if (m) {
      actual = m[1].toUpperCase();
      campos[actual] = m[2];
    } else if (actual) {
      campos[actual] += `\n${linea}`;
    }
    // Antes de la primera etiqueta: preámbulo, se descarta.
  }

  // El markdown de énfasis se limpia del VALOR, no solo de la etiqueta: el modelo
  // escribe "**TITULO:** texto", así que los asteriscos de cierre caen del lado
  // derecho de los dos puntos y se colarían dentro del contenido.
  for (const k of Object.keys(campos)) {
    campos[k] = campos[k].trim().replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();
  }
  return campos;
}

// Minúsculas y sin tildes — el modelo puede devolver "Facebook" o "captación".
const normalizar = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const CANALES = ['facebook', 'x', 'tiktok'];
const TIPOS   = ['captacion', 'educacion'];

function error(codigo, mensaje) {
  const e = new Error(mensaje);
  e.code = codigo;
  return e;
}

/**
 * Genera una pieza llamando al modelo y normaliza su respuesta.
 *
 * @param {string} tarea  instrucción de qué pieza generar (mensaje `user`)
 * @returns {Promise<object>} pieza normalizada + `usage`
 * @throws si el modelo falla o devuelve algo que no se puede usar
 */
export async function generarContenido(tarea) {
  const { provider, model, maxTokens } = cfg();

  if (!tarea || !String(tarea).trim()) {
    throw error('TAREA_VACIA', 'La tarea del agente de marketing no puede estar vacía');
  }

  // No se envía `temperature` a propósito, por dos razones:
  //   1. Mantiene el servicio agnóstico del modelo — Opus 4.8 la rechaza con
  //      HTTP 400, así que enviarla convertiría un cambio de env var en un 500.
  //   2. Omitirla deja el sampling por defecto, que da MÁS variedad entre piezas
  //      que fijar 0.7. Para un generador de contenido, la variedad se quiere.
  const resp = await complete({
    provider,
    model,
    system: getMarketingAgentSystemPrompt(),
    messages: [{ role: 'user', content: [{ type: 'text', text: String(tarea) }] }],
    maxTokens,
  });

  const campos = parseRespuestaAgente(resp.text);

  // Título y cuerpo son la pieza. Sin ellos no hay nada que clasificar.
  if (!campos.TITULO || !campos.CUERPO) {
    logger.warn('[marketing-agent] respuesta sin TITULO/CUERPO', {
      model, stopReason: resp.stopReason, camposDetectados: Object.keys(campos),
    });
    throw error('RESPUESTA_NO_PARSEABLE',
      'El modelo no devolvió la estructura esperada (faltan TITULO o CUERPO)');
  }

  const canal = normalizar(campos.CANAL) === 'twitter' ? 'x' : normalizar(campos.CANAL);
  if (!CANALES.includes(canal)) {
    throw error('CANAL_INVALIDO', `El modelo devolvió un canal no soportado: "${campos.CANAL}"`);
  }

  const tipo = normalizar(campos.TIPO);
  if (!TIPOS.includes(tipo)) {
    throw error('TIPO_INVALIDO', `El modelo devolvió un tipo no soportado: "${campos.TIPO}"`);
  }

  // La autoevaluación es solo una señal de entrada: si viene ilegible se asume
  // 'alto' en vez de fallar. Perder la pieza sería peor, y el clasificador
  // determinista decide igual el estado final.
  let autoevaluacionRiesgo = normalizar(campos.AUTOEVALUACION_RIESGO);
  if (!['alto', 'bajo'].includes(autoevaluacionRiesgo)) {
    logger.warn('[marketing-agent] autoevaluación ilegible, se asume alto', {
      valor: campos.AUTOEVALUACION_RIESGO,
    });
    autoevaluacionRiesgo = 'alto';
  }

  return {
    titulo:             campos.TITULO,
    cuerpo:             campos.CUERPO,
    sugerenciaVisual:   campos.SUGERENCIA_VISUAL || null,
    canal,
    tipo,
    autoevaluacionRiesgo,
    motivoRiesgoModelo: campos.MOTIVO_RIESGO || null,
    usage:              resp.usage,
  };
}

/**
 * Flujo completo: generar, clasificar, persistir.
 *
 * @param {string} tarea
 * @param {{creadoPor?: string}} [opts]
 * @returns {Promise<import('mongoose').Document|null>} la pieza, o null si el flag está apagado
 */
export async function procesarPieza(tarea, opts = {}) {
  if (!isMarketingAgentEnabled()) {
    logger.info('[marketing-agent] procesarPieza omitido: MARKETING_AGENT_ENABLED no está en true');
    return null;
  }

  const { model } = cfg();

  try {
    const generado = await generarContenido(tarea);

    // El clasificador manda: puede contradecir la autoevaluación del modelo.
    const veredicto = clasificarRiesgo(generado);

    const estado = veredicto.nivel === 'bajo' ? 'autopublicado' : 'pendiente_aprobacion';

    const pieza = await ContentPiece.create({
      titulo:              generado.titulo,
      cuerpo:              generado.cuerpo,
      sugerenciaVisual:    generado.sugerenciaVisual,
      canal:               generado.canal,
      tipo:                generado.tipo,
      autoevaluacionRiesgo: generado.autoevaluacionRiesgo,
      motivoRiesgoModelo:  generado.motivoRiesgoModelo,
      clasificacionFinal:  veredicto.nivel,
      motivosClasificador: veredicto.motivos,
      coincidenciasClasificador: veredicto.coincidencias,
      estado,
      tarea:               String(tarea),
      creadoPor:           opts.creadoPor || 'marketing-agent',
    });

    // La divergencia se loguea aparte porque es la métrica que dice si el gate
    // humano se puede relajar algún día. Modelo dice bajo + código dice alto =
    // una pieza que se habría publicado sola sin este control.
    const divergencia = generado.autoevaluacionRiesgo !== veredicto.nivel;
    if (divergencia) {
      logger.warn('[marketing-agent] divergencia modelo vs clasificador', {
        piezaId: pieza._id.toString(),
        autoevaluacion: generado.autoevaluacionRiesgo,
        clasificacionFinal: veredicto.nivel,
        motivos: veredicto.motivos,
        coincidencias: veredicto.coincidencias,
      });
    }

    logger.info('[marketing-agent] pieza procesada', {
      piezaId: pieza._id.toString(),
      canal: generado.canal,
      tipo: generado.tipo,
      clasificacionFinal: veredicto.nivel,
      estado,
      divergencia,
      model,
      // ⚠️ Nombres cortados a propósito: el sanitizador de logger.js redacta todo
      // campo cuyo nombre contenga "token", así que `inputTokens` se publicaba
      // como "[REDACTED]" y el consumo era inobservable. No renombrar a
      // inputTokens/outputTokens.
      inTok:  generado.usage?.inputTokens,
      outTok: generado.usage?.outputTokens,
    });

    return pieza;
  } catch (err) {
    logger.error('[marketing-agent] procesarPieza falló', {
      code: err.code, error: err.message, model,
    });
    Sentry.captureException(err, { tags: { service: 'marketingAgentService' } });
    throw err;
  }
}

export default {
  isMarketingAgentEnabled,
  generarContenido,
  procesarPieza,
  parseRespuestaAgente,
};
