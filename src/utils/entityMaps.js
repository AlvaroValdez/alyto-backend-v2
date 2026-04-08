/**
 * entityMaps.js — Single source of truth for entity ↔ currency/country mappings.
 *
 * Used across controllers to derive origin currency, country, and user defaults
 * from the user's legalEntity or residenceCountry.
 */

export const ENTITY_CURRENCY_MAP = {
  SpA: 'CLP',
  SRL: 'BOB',
  LLC: 'USD',
};

export const ENTITY_COUNTRY_MAP = {
  SpA: 'CL',
  SRL: 'BO',
  LLC: 'US',
};

/**
 * Returns the default currency for a given country code.
 * @param {string} countryCode — ISO 3166-1 alpha-2
 * @returns {string} ISO 4217 currency code
 */
export function getDefaultCurrency(countryCode) {
  if (countryCode === 'CL') return 'CLP';
  if (countryCode === 'BO') return 'BOB';
  return 'USD';
}
