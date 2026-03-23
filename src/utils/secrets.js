/**
 * secrets.js — Gestión Segura de Llaves Privadas
 *
 * Toda secret key de Stellar debe pasar por requireEnvSecret().
 * NUNCA leer process.env directamente para secretos — usar esta función.
 * Fail fast, fail loud: si falta una variable, el servidor no arranca.
 */

/**
 * Obtiene una secret key requerida desde variables de entorno.
 * Lanza inmediatamente si la variable no está definida.
 * NUNCA loguea el valor — solo el nombre de la variable faltante.
 *
 * @param {string} envKey - Nombre de la variable de entorno
 * @returns {string} Valor de la variable
 * @throws {Error} Si la variable no está definida o está vacía
 */
export function requireEnvSecret(envKey) {
  const value = process.env[envKey];
  if (!value || value.trim() === '') {
    // Registrar el NOMBRE de la variable, NUNCA el valor
    throw new Error(
      `[Alyto Stellar] Missing required secret: "${envKey}". Verificar .env o AWS Secrets Manager.`,
    );
  }
  return value;
}
