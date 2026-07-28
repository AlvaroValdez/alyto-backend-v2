// src/config/marketingAgentPrompt.js
//
// Carga del system prompt del agente de marketing.
//
// ⚠️ El TEXTO del prompt no vive en este repositorio, a propósito.
//
// Es un artefacto de negocio: define el posicionamiento de la marca, la
// terminología aprobada y las prohibiciones de comunicación. Recibe el mismo
// trato que el resto del material interno del proyecto, que ya está excluido
// del repositorio vía .gitignore.
//
// Y hay una razón práctica además de la de confidencialidad: lo escribe y lo
// revisa marketing/compliance, no ingeniería. Tenerlo fuera del código permite
// corregir una regla de comunicación sin abrir un pull request.
//
// ⚠️ Este prompt NO es el control de riesgo. El agente se autoevalúa, pero la
// decisión final la toma services/riskClassifier.js con reglas deterministas.
// Si el texto se relaja por error, el clasificador sigue de pie.
//
// Configuración, en orden de precedencia:
//
//   1. MARKETING_AGENT_SYSTEM_PROMPT — el prompt completo como variable de
//      entorno. Es la vía para Render (staging) y AWS Secrets Manager (prod).
//      Los saltos de línea pueden viajar escapados como \n literal.
//
//   2. MARKETING_AGENT_PROMPT_PATH — ruta a un archivo de texto en disco.
//      Comodidad para desarrollo local; ese archivo va gitignoreado.
//
// Si no hay ninguna de las dos se lanza un error controlado con código
// PROMPT_NO_CONFIGURADO. Se lanza al USARLO, no al importar el módulo: así el
// servidor arranca igual y solo falla el endpoint del agente, con un mensaje
// que dice exactamente qué falta configurar.

import { readFileSync } from 'fs';

let cache = null;

/**
 * Devuelve el system prompt del agente de marketing.
 * @returns {string}
 * @throws {Error & {code:'PROMPT_NO_CONFIGURADO'}} si no está configurado
 */
export function getMarketingAgentSystemPrompt() {
  if (cache) return cache;

  const inline = process.env.MARKETING_AGENT_SYSTEM_PROMPT;
  if (inline && inline.trim()) {
    // Las env vars multilínea suelen viajar con \n escapado — mismo tratamiento
    // que FIREBASE_PRIVATE_KEY en este proyecto.
    cache = inline.replace(/\\n/g, '\n').trim();
    return cache;
  }

  const ruta = process.env.MARKETING_AGENT_PROMPT_PATH;
  if (ruta) {
    let texto;
    try {
      texto = readFileSync(ruta, 'utf8').trim();
    } catch (err) {
      const e = new Error(
        `No se pudo leer el system prompt desde MARKETING_AGENT_PROMPT_PATH (${ruta}): ${err.message}`,
      );
      e.code = 'PROMPT_NO_CONFIGURADO';
      throw e;
    }
    if (texto) {
      cache = texto;
      return cache;
    }
  }

  const e = new Error(
    'El system prompt del agente de marketing no está configurado. Definí ' +
    'MARKETING_AGENT_SYSTEM_PROMPT (el prompt completo) o ' +
    'MARKETING_AGENT_PROMPT_PATH (ruta a un archivo de texto).',
  );
  e.code = 'PROMPT_NO_CONFIGURADO';
  throw e;
}

/** Solo para tests: limpia el cache entre casos. */
export function __resetPromptCache() {
  cache = null;
}

export default { getMarketingAgentSystemPrompt };
