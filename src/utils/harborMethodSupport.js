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

/**
 * HARBOR_FORM_FIELDS — campos del formulario de beneficiario por país Harbor.
 *
 * Fuente de verdad para getWithdrawalRulesController y el frontend.
 * Derivado de buildPayoutInstrument() + esquemas Harbor verificados en prod.
 *
 * Formato de cada field:
 *   key         — clave que buildPayoutInstrument espera en beneficiary.dynamicFields
 *   label       — etiqueta en español para el frontend
 *   type        — 'text' | 'select' | 'email' | 'tel'
 *   required    — boolean
 *   placeholder — ejemplo visible en el input
 *   hint        — texto de ayuda bajo el campo
 *   min/max     — longitud mínima/máxima (para validación frontend)
 *   pattern     — regex string para validación frontend (sin delimitadores)
 *   options     — [{ value, label }] para type='select'
 */
export const HARBOR_FORM_FIELDS = {

  // ── US: ACH_PUSH / DOMESTIC_WIRE / FEDWIRE / WIRE — mismo schema ─────────
  // Harbor valida beneficiary_address.state_province contra enum de abreviaturas
  // de estados. Los 4 campos de dirección son requeridos por Harbor (verificado).
  US: [
    { key: 'account_holder_name', label: 'Nombre completo del titular', type: 'text',   required: true,  placeholder: 'John Doe' },
    { key: 'bank_name',           label: 'Nombre del banco',            type: 'text',   required: true,  placeholder: 'Bank of America' },
    { key: 'account_number',      label: 'Número de cuenta',            type: 'text',   required: true,  placeholder: '123456789012' },
    { key: 'routing_number',      label: 'Routing Number (ABA)',        type: 'text',   required: true,  placeholder: '021000021',
      hint: '9 dígitos — identifica al banco en EEUU', min: 9, max: 9, pattern: '^[0-9]{9}$' },
    { key: 'street',              label: 'Dirección del beneficiario',  type: 'text',   required: true,  placeholder: '123 Main St, Apt 4B' },
    { key: 'city',                label: 'Ciudad',                      type: 'text',   required: true,  placeholder: 'New York' },
    { key: 'state_province',      label: 'Estado',                      type: 'select', required: true,  placeholder: 'Selecciona un estado',
      options: [
        { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' },
        { value: 'AZ', label: 'Arizona' }, { value: 'AR', label: 'Arkansas' },
        { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
        { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' },
        { value: 'DC', label: 'District of Columbia' }, { value: 'FL', label: 'Florida' },
        { value: 'GA', label: 'Georgia' }, { value: 'HI', label: 'Hawaii' },
        { value: 'ID', label: 'Idaho' }, { value: 'IL', label: 'Illinois' },
        { value: 'IN', label: 'Indiana' }, { value: 'IA', label: 'Iowa' },
        { value: 'KS', label: 'Kansas' }, { value: 'KY', label: 'Kentucky' },
        { value: 'LA', label: 'Louisiana' }, { value: 'ME', label: 'Maine' },
        { value: 'MD', label: 'Maryland' }, { value: 'MA', label: 'Massachusetts' },
        { value: 'MI', label: 'Michigan' }, { value: 'MN', label: 'Minnesota' },
        { value: 'MS', label: 'Mississippi' }, { value: 'MO', label: 'Missouri' },
        { value: 'MT', label: 'Montana' }, { value: 'NE', label: 'Nebraska' },
        { value: 'NV', label: 'Nevada' }, { value: 'NH', label: 'New Hampshire' },
        { value: 'NJ', label: 'New Jersey' }, { value: 'NM', label: 'New Mexico' },
        { value: 'NY', label: 'New York' }, { value: 'NC', label: 'North Carolina' },
        { value: 'ND', label: 'North Dakota' }, { value: 'OH', label: 'Ohio' },
        { value: 'OK', label: 'Oklahoma' }, { value: 'OR', label: 'Oregon' },
        { value: 'PA', label: 'Pennsylvania' }, { value: 'RI', label: 'Rhode Island' },
        { value: 'SC', label: 'South Carolina' }, { value: 'SD', label: 'South Dakota' },
        { value: 'TN', label: 'Tennessee' }, { value: 'TX', label: 'Texas' },
        { value: 'UT', label: 'Utah' }, { value: 'VT', label: 'Vermont' },
        { value: 'VA', label: 'Virginia' }, { value: 'WA', label: 'Washington' },
        { value: 'WV', label: 'West Virginia' }, { value: 'WI', label: 'Wisconsin' },
        { value: 'WY', label: 'Wyoming' },
      ] },
    { key: 'postal_code',         label: 'Código Postal (ZIP)',         type: 'text',   required: true,  placeholder: '10001',
      hint: '5 dígitos (o ZIP+4: 10001-1234)', min: 5, max: 10, pattern: '^[0-9]{5}(-[0-9]{4})?$' },
  ],

  // ── EU / Eurozona: WIRE (SEPA deshabilitado por bug Harbor) ───────────────
  EU: [
    { key: 'account_holder_name', label: 'Nombre del titular',         type: 'text', required: true, placeholder: 'Hans Müller' },
    { key: 'bank_name',           label: 'Nombre del banco',           type: 'text', required: true, placeholder: 'Deutsche Bank' },
    { key: 'iban',                label: 'IBAN',                       type: 'text', required: true, placeholder: 'DE89370400440532013000',
      hint: 'Número IBAN internacional del beneficiario', min: 15, max: 34 },
    { key: 'swift_code',          label: 'Código BIC / SWIFT',         type: 'text', required: true, placeholder: 'DEUTDEDB',
      hint: '8 u 11 caracteres alfanuméricos', min: 8, max: 11 },
  ],

  // ── GB: FPS (Faster Payments) ─────────────────────────────────────────────
  GB: [
    { key: 'account_holder_name', label: 'Nombre del titular',   type: 'text', required: true, placeholder: 'James Smith' },
    { key: 'account_number',      label: 'Número de cuenta',     type: 'text', required: true, placeholder: '12345678', min: 8, max: 8 },
    { key: 'sort_code',           label: 'Sort Code',            type: 'text', required: true, placeholder: '12-34-56',
      hint: '6 dígitos del banco UK (formato: 12-34-56)', min: 6, max: 8 },
  ],

  // ── BR: PIX ───────────────────────────────────────────────────────────────
  // br_cpf + exactamente UNO de: phone_number | email | br_pix_evp
  BR: [
    { key: 'br_cpf',       label: 'CPF del beneficiario', type: 'text', required: true,  placeholder: '12345678901',
      hint: '11 dígitos numéricos sin puntos ni guiones', min: 11, max: 11, pattern: '^[0-9]{11}$' },
    { key: 'phone_number', label: 'Celular (chave PIX)',  type: 'tel',  required: false, placeholder: '+5511987654321',
      hint: 'Chave PIX: número de celular con código de país (+55...)' },
    { key: 'email',        label: 'Email (chave PIX)',    type: 'email',required: false, placeholder: 'beneficiario@email.com',
      hint: 'Chave PIX: correo electrónico del beneficiario' },
    { key: 'br_pix_evp',  label: 'Chave aleatória (EVP)',type: 'text', required: false, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      hint: 'Chave PIX aleatória en formato UUID' },
  ],

  // ── MX: SPEI ──────────────────────────────────────────────────────────────
  MX: [
    { key: 'mx_clabe', label: 'CLABE Interbancaria', type: 'text', required: true, placeholder: '012345678901234567',
      hint: '18 dígitos — estándar SPEI México', min: 18, max: 18, pattern: '^[0-9]{18}$' },
  ],

  // ── CN: CIPS / WIRE ───────────────────────────────────────────────────────
  CN: [
    { key: 'account_holder_name', label: 'Nombre del titular',   type: 'text', required: true, placeholder: 'Zhang Wei' },
    { key: 'bank_name',           label: 'Nombre del banco',     type: 'text', required: true, placeholder: 'Bank of China' },
    { key: 'account_number',      label: 'Número de cuenta',     type: 'text', required: true, placeholder: '6222021234567890123' },
    { key: 'swift_code',          label: 'Código SWIFT',         type: 'text', required: true, placeholder: 'BKCHCNBJ',
      hint: '8 u 11 caracteres', min: 8, max: 11 },
  ],

  // ── HK: CHATS / WIRE ──────────────────────────────────────────────────────
  // bank_code: requerido para CHATS, opcional para WIRE
  HK: [
    { key: 'account_holder_name', label: 'Nombre del titular', type: 'text', required: true,  placeholder: 'Chan Tai Man' },
    { key: 'bank_name',           label: 'Nombre del banco',   type: 'text', required: true,  placeholder: 'HSBC Hong Kong' },
    { key: 'account_number',      label: 'Número de cuenta',   type: 'text', required: true,  placeholder: '123456789012' },
    { key: 'swift_code',          label: 'Código SWIFT',       type: 'text', required: true,  placeholder: 'HSBCHKHH', min: 8, max: 11 },
    { key: 'bank_code',           label: 'Código bancario HK', type: 'text', required: false, placeholder: '004',
      hint: '3 dígitos — requerido para transferencias CHATS' },
  ],

  // ── IN: IMPS ──────────────────────────────────────────────────────────────
  IN: [
    { key: 'bank_code',      label: 'Código IFSC', type: 'text', required: true, placeholder: 'SBIN0001234',
      hint: '11 caracteres alfanuméricos (ej: SBIN0001234)', min: 11, max: 11, pattern: '^[A-Z]{4}0[A-Z0-9]{6}$' },
    { key: 'account_number', label: 'Número de cuenta bancaria', type: 'text', required: true, placeholder: '12345678901' },
  ],

  // ── AE: FTS / AANI / BANK-TRANSFER ───────────────────────────────────────
  AE: [
    { key: 'account_holder_name', label: 'Nombre del titular', type: 'text', required: true, placeholder: 'Mohammed Al Rashid' },
    { key: 'phone_number',        label: 'Teléfono UAE',       type: 'tel',  required: true, placeholder: '+971501234567',
      hint: 'Número local UAE: +971 seguido de 8-9 dígitos', pattern: '^\\+971[0-9]{8,9}$' },
    { key: 'swift_code',          label: 'Código SWIFT',       type: 'text', required: true, placeholder: 'EBILAEAD', min: 8, max: 11 },
    { key: 'account_number',      label: 'IBAN UAE',           type: 'text', required: true, placeholder: 'AE070331234567890123456',
      hint: 'IBAN formato: AE + 2 dígitos + 19 caracteres', min: 23, max: 23 },
  ],

  // ── SG: BANK-TRANSFER ─────────────────────────────────────────────────────
  SG: [
    { key: 'account_holder_name', label: 'Nombre del titular', type: 'text', required: true, placeholder: 'Lee Kuan' },
    { key: 'bank_name',           label: 'Nombre del banco',   type: 'text', required: true, placeholder: 'DBS Bank' },
    { key: 'account_number',      label: 'Número de cuenta',   type: 'text', required: true, placeholder: '1234567890' },
    { key: 'swift_code',          label: 'Código SWIFT',       type: 'text', required: true, placeholder: 'DBSSSGSG', min: 8, max: 11 },
  ],

  // ── JP: BANK-TRANSFER / WIRE ──────────────────────────────────────────────
  JP: [
    { key: 'account_holder_name', label: 'Nombre del titular', type: 'text', required: true, placeholder: 'Yamamoto Taro' },
    { key: 'bank_name',           label: 'Nombre del banco',   type: 'text', required: true, placeholder: 'Mitsubishi UFJ Bank' },
    { key: 'account_number',      label: 'Número de cuenta',   type: 'text', required: true, placeholder: '1234567' },
    { key: 'swift_code',          label: 'Código SWIFT',       type: 'text', required: true, placeholder: 'BOTKJPJT', min: 8, max: 11 },
  ],

  // ── NG: BANK-TRANSFER ─────────────────────────────────────────────────────
  NG: [
    { key: 'account_holder_name', label: 'Nombre del titular', type: 'text', required: true, placeholder: 'Emeka Okafor' },
    { key: 'bank_name',           label: 'Nombre del banco',   type: 'text', required: true, placeholder: 'Zenith Bank' },
    { key: 'account_number',      label: 'Número de cuenta',   type: 'text', required: true, placeholder: '1234567890', min: 10, max: 10 },
  ],
};
