/**
 * harborMethodSupport.js — Single source of truth de métodos Harbor que
 * nuestro sistema (FE form + BE buildPayoutInstrument) sabe procesar.
 *
 * Si Harbor devuelve un método NO listado aquí, BE filtra el quote antes
 * de mostrarlo al usuario — evita que la cotización inicial use una tasa
 * (ej. SEPA 0.85 EUR/USDC) que después no podemos ejecutar (porque hay
 * un bug Harbor en SEPA y forzamos WIRE = 0.67 EUR/USDC).
 *
 * Debe mantenerse en sync con FE/src/components/SendMoney/Step3Beneficiary.jsx
 * → SUPPORTED_HARBOR_METHODS.
 */

const SUPPORTED_METHODS_BY_COUNTRY = {
  CN: ['CIPS', 'WIRE'],
  EU: ['WIRE'],                                     // SEPA deshabilitado por bug Harbor
  DE: ['WIRE'], FR: ['WIRE'], ES: ['WIRE'], IT: ['WIRE'],
  NL: ['WIRE'], BE: ['WIRE'], PT: ['WIRE'], AT: ['WIRE'],
  PL: ['WIRE'], SE: ['WIRE'], CH: ['WIRE'], NO: ['WIRE'],
  DK: ['WIRE'], FI: ['WIRE'], IE: ['WIRE'],
  GB: ['FPS'],
  NG: ['BANK-TRANSFER'],
  BR: ['PIX'],
  MX: ['SPEI'],
  AE: ['FTS', 'AANI', 'BANK-TRANSFER'],
  HK: ['CHATS', 'WIRE'],
  JP: ['BANK-TRANSFER', 'WIRE'],
  SG: ['BANK-TRANSFER'],
  IN: ['IMPS'],
  US: ['ACH_PUSH', 'DOMESTIC_WIRE', 'FEDWIRE', 'WIRE'],
};

/**
 * Filtra un array de quotes Harbor para mantener solo los métodos soportados
 * por el sistema Alyto. Si ningún quote sobrevive, devuelve el array original
 * para no romper el flujo (mejor cotización imperfecta que cotización vacía).
 *
 * @param {Array<{paymentMethod?: string, payment_method?: string}>} quotes
 * @param {string} destCountry  ISO alpha-2
 * @returns {Array} quotes filtradas
 */
export function filterSupportedQuotes(quotes, destCountry) {
  if (!Array.isArray(quotes) || quotes.length === 0) return quotes;
  const supported = SUPPORTED_METHODS_BY_COUNTRY[(destCountry ?? '').toUpperCase()];
  if (!supported) return quotes;  // país no mapeado — pass-through

  const filtered = quotes.filter(q => {
    const method = (q.paymentMethod ?? q.payment_method ?? '').toUpperCase();
    return supported.includes(method);
  });

  // Safety: si filtramos TODO, devolver original para que el flujo no muera
  // (en peor caso vuelve el bug original pero al menos la tx llega al final).
  if (filtered.length === 0) {
    console.warn(`[harborMethodSupport] Ningún quote sobrevivió al filtro para ${destCountry}. ` +
                 `Quotes Harbor: ${quotes.map(q => q.paymentMethod ?? q.payment_method).join(',')}. ` +
                 `Supported: ${supported.join(',')}. Usando pass-through.`);
    return quotes;
  }
  return filtered;
}

/**
 * Picks the best supported quote (filtra + retorna primero).
 * Si requestedMethod (preferred user choice) está dentro de supported, lo prefiere.
 */
export function pickSupportedQuote(quotes, destCountry, requestedMethod = null) {
  const filtered = filterSupportedQuotes(quotes, destCountry);
  if (!Array.isArray(filtered) || filtered.length === 0) return null;

  if (requestedMethod) {
    const match = filtered.find(q => (q.paymentMethod ?? q.payment_method) === requestedMethod);
    if (match) return match;
  }
  return filtered[0];
}

export { SUPPORTED_METHODS_BY_COUNTRY };
