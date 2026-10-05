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

/**
 * ⚠️ **EL ORDEN IMPORTA Y ES DE BARATO A CARO.** `selectHarborQuote` elige el primero
 * de esta lista que Harbor haya devuelto, y marca `degraded` si el primero no vino y
 * hubo que caer a un riel con fijo alto. Antes se devolvía el primero que respondiera
 * la API, así que este orden existía pero no se usaba.
 *
 * ⚠️ **Tiene que reflejar lo que Harbor OFRECE, no lo que nos gustaría.** Declarar un
 * riel que la API nunca devuelve hace que el guard grite para siempre y termine
 * apagando un corredor que funciona. Medido con quotes reales a $120, $500 y $2.000
 * el 2026-10-05: CIPS, FPS, FTS y AANI **no se ofrecen a nuestro customer** en ninguna
 * de las tres, aunque estaban declarados. Re-medir antes de agregar un riel.
 */
const SUPPORTED_METHODS_BY_COUNTRY = {
  // CN: CIPS estaba declarado como preferido pero Harbor sólo devuelve WIRE (medido a
  // $120/$500/$2.000). Dejarlo primero marcaba `cl-cn`/`us-cn` como degradados siempre.
  CN: ['WIRE'],
  // SEPA deshabilitado — Harbor requiere swift_code en SEPA también (2026-06-07); reactivar post e2e real
  EU: ['WIRE'],
  DE: ['WIRE'], FR: ['WIRE'], ES: ['WIRE'], IT: ['WIRE'],
  NL: ['WIRE'], BE: ['WIRE'], PT: ['WIRE'], AT: ['WIRE'],
  PL: ['WIRE'], SE: ['WIRE'], CH: ['WIRE'], NO: ['WIRE'],
  DK: ['WIRE'], FI: ['WIRE'], IE: ['WIRE'],
  // GB: lo que llega es BANK-TRANSFER, no FPS ni WIRE. Con el mapa viejo el filtro se
  // vaciaba en CADA cotización y caía al pass-through dejando un warning.
  GB: ['BANK-TRANSFER', 'FPS', 'WIRE'],
  NG: ['BANK-TRANSFER'],
  BR: ['PIX'],
  MX: ['SPEI'],
  // AE: FTS y AANI no se ofrecen; el real es BANK-TRANSFER y va primero.
  AE: ['BANK-TRANSFER', 'FTS', 'AANI'],
  HK: ['CHATS', 'WIRE'],
  JP: ['BANK-TRANSFER', 'WIRE'],
  SG: ['BANK-TRANSFER'],
  IN: ['IMPS'],
  // AU no estaba mapeado y cl-au/us-au están activos: caían al pass-through.
  AU: ['BANK-TRANSFER'],
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

const metodoDe = q => (q?.paymentMethod ?? q?.payment_method ?? '').toUpperCase();

/**
 * Rieles de Harbor con fee FIJO alto (~$25 por operación, medido contra la API en
 * producción el 2026-10-05). El fijo no se nota en montos grandes y es demoledor en
 * los chicos: en `bo-jp`, WIRE sobre $75,05 de neto entregaba $49,65 — 34% de pérdida.
 *
 * Son además los rieles con el piso más alto de Harbor ($75,02 contra $50,11 de
 * ACH_PUSH o ~$21 de los locales), así que caer en uno sin darse cuenta rompe DOS
 * cosas a la vez: la economía de la operación y el piso con el que se validó el
 * mínimo (`TransactionConfig.providerFloorUSD`, medido para el riel barato).
 */
const RIELES_CON_FIJO_ALTO = new Set(['WIRE', 'DOMESTIC_WIRE', 'FEDWIRE']);

/**
 * Elige el quote de Harbor y además DICE cómo lo eligió.
 *
 * Dos cosas que la selección anterior hacía mal o no hacía:
 *
 * 1. **Elegía por el orden de Harbor, no por el nuestro.** Devolvía `filtered[0]`,
 *    o sea el primero que respondiera la API. `SUPPORTED_METHODS_BY_COUNTRY` ya está
 *    escrito de barato a caro (`US: ['ACH_PUSH', 'DOMESTIC_WIRE', 'FEDWIRE']`), pero
 *    ese orden no se usaba: funcionaba de casualidad porque Harbor manda ACH_PUSH
 *    primero. El día que invierta el orden de su respuesta, `bo-us` pasa a liquidar
 *    por WIRE sin que haya cambiado nada de nuestro lado.
 *
 * 2. **No avisaba cuando el riel barato no venía.** Si Harbor deja de devolver
 *    ACH_PUSH, la ruta sigue cotizando por WIRE y la pérdida salta de 0,5% a ~50%
 *    en el mínimo, en silencio.
 *
 * `degraded` marca exactamente eso: el país tiene un riel preferido, no vino, y el
 * que quedó cobra fijo alto. Quien lo consume decide qué hacer, y la decisión NO es
 * la misma antes y después del cobro:
 *   - **Antes del payin (cotización):** no cotizar. Nadie pagó todavía.
 *   - **Después del payin (dispatch):** liquidar igual y alertar. Bloquear ahí
 *     dejaría la plata del usuario encerrada, que es peor que un payout caro.
 *
 * @param {Array} quotes                respuesta de getHarborQuote({returnAll:true})
 * @param {string} destCountry          ISO alpha-2
 * @param {string|null} requestedMethod elección explícita del usuario (gana siempre)
 * @returns {{quote: object|null, method: string|null, preferredMethod: string|null,
 *            degraded: boolean, available: string[]}}
 */
export function selectHarborQuote(quotes, destCountry, requestedMethod = null) {
  const filtered = filterSupportedQuotes(quotes, destCountry);
  const vacio = { quote: null, method: null, preferredMethod: null, degraded: false, available: [] };
  if (!Array.isArray(filtered) || filtered.length === 0) return vacio;

  const supported = SUPPORTED_METHODS_BY_COUNTRY[(destCountry ?? '').toUpperCase()] ?? null;
  const available = filtered.map(metodoDe).filter(Boolean);
  const preferido = supported?.[0] ?? null;

  // La elección explícita del usuario manda: ya vio la tasa de ese método en el
  // selector. Si eligió el caro a sabiendas, no es una degradación.
  if (requestedMethod) {
    const pedido = filtered.find(q => metodoDe(q) === requestedMethod.toUpperCase());
    if (pedido) {
      return { quote: pedido, method: metodoDe(pedido), preferredMethod: preferido, degraded: false, available };
    }
  }

  // Nuestro orden de preferencia, no el de Harbor.
  let elegido = null;
  if (supported) {
    for (const m of supported) {
      const hit = filtered.find(q => metodoDe(q) === m);
      if (hit) { elegido = hit; break; }
    }
  }
  elegido ??= filtered[0];

  const metodo = metodoDe(elegido);
  // País sin preferencia declarada → no hay con qué comparar, no se degrada.
  const degraded = Boolean(preferido) && metodo !== preferido && RIELES_CON_FIJO_ALTO.has(metodo);

  return { quote: elegido, method: metodo, preferredMethod: preferido, degraded, available };
}

/**
 * Elige el quote soportado. Envoltorio fino sobre `selectHarborQuote` para los
 * sitios a los que sólo les interesa el quote y no el diagnóstico.
 */
export function pickSupportedQuote(quotes, destCountry, requestedMethod = null) {
  return selectHarborQuote(quotes, destCountry, requestedMethod).quote;
}

export { SUPPORTED_METHODS_BY_COUNTRY, RIELES_CON_FIJO_ALTO };

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
  // Enum verificado via GET /v2/transfers/quotes/:id/requirements (2026-06-05).
  // Harbor sandbox omite CT, NJ, NY — probablemente gap de sandbox, no prod.
  // ⚠️ Hasta confirmar con Harbor: solo incluir los estados del enum real.
  US: [
    { key: 'account_holder_name', label: 'Nombre completo del titular', type: 'text',   required: true,  placeholder: 'John Doe' },
    { key: 'bank_name',           label: 'Nombre del banco',            type: 'text',   required: true,  placeholder: 'Bank of America' },
    { key: 'account_number',      label: 'Número de cuenta',            type: 'text',   required: true,  placeholder: '123456789012' },
    { key: 'routing_number',      label: 'Routing Number (ABA)',        type: 'text',   required: true,  placeholder: '021000021',
      hint: '9 dígitos — identifica al banco en EEUU', min: 9, max: 9, pattern: '^[0-9]{9}$' },
    { key: 'street',              label: 'Dirección del beneficiario',  type: 'text',   required: true,  placeholder: '123 Main St, Apt 4B' },
    { key: 'city',                label: 'Ciudad',                      type: 'text',   required: true,  placeholder: 'Los Angeles' },
    { key: 'state_province',      label: 'Estado',                      type: 'select', required: true,  placeholder: 'Selecciona un estado',
      options: [
        { value: 'AL', label: 'Alabama' },      { value: 'AK', label: 'Alaska' },
        { value: 'AZ', label: 'Arizona' },      { value: 'AR', label: 'Arkansas' },
        { value: 'CA', label: 'California' },   { value: 'CO', label: 'Colorado' },
        { value: 'DC', label: 'District of Columbia' }, { value: 'DE', label: 'Delaware' },
        { value: 'FL', label: 'Florida' },      { value: 'GA', label: 'Georgia' },
        { value: 'HI', label: 'Hawaii' },       { value: 'ID', label: 'Idaho' },
        { value: 'IL', label: 'Illinois' },     { value: 'IN', label: 'Indiana' },
        { value: 'IA', label: 'Iowa' },         { value: 'KS', label: 'Kansas' },
        { value: 'KY', label: 'Kentucky' },     { value: 'LA', label: 'Louisiana' },
        { value: 'ME', label: 'Maine' },        { value: 'MD', label: 'Maryland' },
        { value: 'MA', label: 'Massachusetts' },{ value: 'MI', label: 'Michigan' },
        { value: 'MN', label: 'Minnesota' },    { value: 'MS', label: 'Mississippi' },
        { value: 'MO', label: 'Missouri' },     { value: 'MT', label: 'Montana' },
        { value: 'NE', label: 'Nebraska' },     { value: 'NV', label: 'Nevada' },
        { value: 'NH', label: 'New Hampshire' },{ value: 'NM', label: 'New Mexico' },
        { value: 'NC', label: 'North Carolina' },{ value: 'ND', label: 'North Dakota' },
        { value: 'OH', label: 'Ohio' },         { value: 'OK', label: 'Oklahoma' },
        { value: 'OR', label: 'Oregon' },       { value: 'PA', label: 'Pennsylvania' },
        { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' },
        { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
        { value: 'TX', label: 'Texas' },        { value: 'UT', label: 'Utah' },
        { value: 'VT', label: 'Vermont' },      { value: 'VA', label: 'Virginia' },
        { value: 'WA', label: 'Washington' },   { value: 'WV', label: 'West Virginia' },
        { value: 'WI', label: 'Wisconsin' },    { value: 'WY', label: 'Wyoming' },
        // CT, NJ, NY ausentes del enum Harbor sandbox (2026-06-05) — gap de sandbox.
        // Agregar cuando Harbor confirme soporte en producción.
      ] },
    { key: 'postal_code',         label: 'Código Postal (ZIP)',         type: 'text',   required: true,  placeholder: '90001',
      hint: '5 dígitos (o ZIP+4: 90001-1234)', min: 5, max: 10, pattern: '^[0-9]{5}(-[0-9]{4})?$' },
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

  // ── GB: WIRE (USD, SWIFT) — confirmado Jolin OwlPay 2026-06-09 ─────────────
  // Harbor acepta country=GB + asset=USD vía WIRE (swift_code).
  // FPS (sort_code) es GBP-only; corredor bo-gb usa USD → siempre WIRE.
  GB: [
    { key: 'account_holder_name', label: 'Nombre del titular', type: 'text', required: true, placeholder: 'James Smith' },
    { key: 'bank_name',           label: 'Nombre del banco',   type: 'text', required: true, placeholder: 'Barclays Bank' },
    { key: 'account_number',      label: 'Número de cuenta o IBAN', type: 'text', required: true, placeholder: 'GB29NWBK60161331926819',
      hint: 'IBAN UK: GB + 2 dígitos + 4 letras banco + 14 dígitos', min: 8, max: 34 },
    { key: 'swift_code',          label: 'Código SWIFT / BIC', type: 'text', required: true, placeholder: 'BARCGB22',
      hint: '8 u 11 caracteres alfanuméricos', min: 8, max: 11 },
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

  // ── AE: BANK-TRANSFER — schema Harbor verificado 2026-06-06 ──────────────
  // payout_instrument: { account_holder_name, account_number, swift_code }
  // beneficiary_info:  { + beneficiary_dob, beneficiary_id_doc_number } (requeridos)
  AE: [
    { key: 'account_holder_name',      label: 'Nombre del titular',            type: 'text', required: true, placeholder: 'Mohammed Al Rashid' },
    { key: 'account_number',           label: 'IBAN UAE',                      type: 'text', required: true, placeholder: 'AE070331234567890123456',
      hint: 'Formato: AE + 2 dígitos + 19 caracteres', min: 23, max: 23 },
    { key: 'swift_code',               label: 'Código SWIFT / BIC',            type: 'text', required: true, placeholder: 'EBILAEAD', min: 8, max: 11 },
    { key: 'beneficiary_dob',          label: 'Fecha de nacimiento',           type: 'text', required: true, placeholder: 'YYYY-MM-DD',
      hint: 'Formato: año-mes-día (ej. 1990-01-15)', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    { key: 'beneficiary_id_doc_number', label: 'Número de documento de identidad', type: 'text', required: true, placeholder: 'A12345678',
      hint: 'Pasaporte, Emirates ID u otro documento oficial' },
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
