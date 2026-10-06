/**
 * beneficiaryValidation.js — Ejecutabilidad de los DATOS del beneficiario,
 * verificada ANTES de emitir instrucciones de cobro.
 *
 * CAUSA DE RAÍZ QUE CIERRA (reproducida e2e el 2026-10-05, tx
 * ALY-C-1791248531719-BNBIXN): el create aceptaba cualquier beneficiaryData,
 * generaba el QR real de BANECO, el usuario pagaba, y el payout moría DESPUÉS
 * en el proveedor — Vita code 305 "Invalid pix_key_type" por mandar "cpf"
 * donde el enum real es "code_cpf". Mismo patrón que la operación de junio
 * "número de cuenta con formato inválido" (ver Bs 3.506 regularizados el
 * 2026-10-01): dinero cobrado contra un payout que nunca iba a poder ejecutarse.
 *
 * El punto de corte es initCrossBorderPayment porque es el último momento SIN
 * dinero movido — validar al llegar el IPN no sirve, ahí la plata ya entró.
 * (Misma filosofía que payoutPreflight.js, que cubre el saldo; esto cubre los
 * datos. Son complementarios.)
 *
 * FILOSOFÍA DE FALLO — cerrado solo ante lo COMPROBADAMENTE inválido:
 *   - select con un valor fuera de su enum        → bloquea (es el caso e2e)
 *   - campo condicional ACTIVO y vacío             → bloquea (la chave del tipo
 *     elegido no está: el payout no puede armarse)
 *   - Harbor: buildPayoutInstrument en seco lanza  → bloquea (campo must ausente
 *     o formato roto, p.ej. routing ABA — el caso "fondos atascados")
 * Y abierto en todo lo demás:
 *   - rules de Vita ilegibles / país sin rules     → deja pasar (un proveedor
 *     de metadatos caído no puede cerrar la caja)
 *   - campos de texto sin `when` (nombres, comentarios): NO se exige presencia
 *     — las rules de Vita no traen flag `required`, y adivinar cuáles lo son
 *     produciría falsos positivos que bloquean ventas legítimas.
 *
 * En la UI real los <select> restringen los valores, así que el vector de este
 * bug es la API directa o datos viejos de contactos; por eso la validación vive
 * en el backend y no alcanza con el formulario.
 */

import { getWithdrawalRules, getVitaCountryKey } from './vitaWalletService.js';
import { buildPayoutInstrument, resolveHarborCountry } from './owlPayService.js';

/** Kill-switch operativo. Encendido por defecto: cierra la causa de raíz. */
function validationEnabled() {
  return process.env.BENEFICIARY_VALIDATION_ENABLED !== 'false';
}

const esVacio = (v) => v == null || String(v).trim() === '';

/**
 * ¿El campo está activo para los valores enviados? Replica el filtro `when` del
 * frontend (Step3Beneficiary / VitaContactForm): sin `when` siempre activo; con
 * `when`, el valor del campo controlador debe coincidir (string o lista).
 */
function campoActivo(field, data) {
  if (!field?.when) return true;
  const refValue  = data?.[field.when.key] ?? '';
  const expected  = field.when.value;
  if (Array.isArray(expected)) return expected.includes(refValue);
  return refValue === expected;
}

/**
 * PURA — valida beneficiaryData contra los campos publicados por Vita.
 *
 * @param {object} data    beneficiaryData tal como llega al create
 * @param {Array}  fields  rules.<país>.fields de getWithdrawalRules()
 * @returns {string[]} errores accionables (vacío = ejecutable)
 */
export function validateAgainstVitaFields(data, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  const errores = [];

  for (const f of fields) {
    const key = f?.key ?? f?.name;
    if (!key || String(key).startsWith('fc_')) continue;   // fc_* = internos de display
    if (!campoActivo(f, data)) continue;

    const valor = data?.[key];

    // 1. Enum de los select: un valor presente que no está en las opciones es
    //    un rechazo GARANTIZADO del proveedor. Cero falsos positivos.
    const opciones = (f?.options ?? []).map(o => o?.value).filter(v => v != null);
    if (f?.type === 'select' && opciones.length > 0 && !esVacio(valor) && !opciones.includes(valor)) {
      errores.push(
        `El campo "${key}" tiene un valor inválido ("${valor}"). ` +
        `Valores aceptados: ${opciones.join(', ')}.`,
      );
      continue;
    }

    // 2. Campo condicional activo y vacío: el usuario eligió un tipo (ej.
    //    pix_key_type=code_cpf) y no mandó el dato de ese tipo. El payout no
    //    puede armarse — también garantizado.
    if (f?.when && esVacio(valor)) {
      errores.push(
        `Falta el campo "${key}", requerido cuando ${f.when.key} = "${Array.isArray(f.when.value) ? f.when.value.join('|') : f.when.value}".`,
      );
    }
  }

  return errores;
}

/**
 * Verifica que el beneficiario sea ejecutable por el proveedor del corredor.
 *
 * @param {object} p
 * @param {object} p.corridor         TransactionConfig (lean u objeto)
 * @param {object} p.beneficiaryData  los dynamicFields que viajarán al payout
 * @param {string|null} [p.owlPayMethod] método Harbor elegido por el usuario
 * @returns {Promise<{ok: true, skipped?: string} | {ok: false, errores: string[]}>}
 */
export async function checkBeneficiaryExecutable({ corridor, beneficiaryData, owlPayMethod = null }) {
  if (!validationEnabled()) return { ok: true, skipped: 'disabled' };
  const data = beneficiaryData ?? {};

  // ── Vita: contra las rules vivas del país ──────────────────────────────────
  if (corridor?.payoutMethod === 'vitaWallet') {
    let fields = null;
    try {
      const rules = await getWithdrawalRules();
      const key   = getVitaCountryKey(corridor.destinationCountry, corridor.destinationCurrency);
      fields      = rules?.rules?.[key]?.fields ?? rules?.[key]?.fields ?? null;
    } catch (err) {
      console.warn('[BeneficiaryValidation] Rules de Vita ilegibles (fail-open):', err.message);
      return { ok: true, skipped: 'rules_unavailable' };
    }
    if (!fields) return { ok: true, skipped: 'no_rules_for_country' };

    const errores = validateAgainstVitaFields(data, fields);
    return errores.length ? { ok: false, errores } : { ok: true };
  }

  // ── Harbor: buildPayoutInstrument en seco ──────────────────────────────────
  // Es la MISMA función que arma el instrumento en el dispatch: si lanza acá,
  // iba a lanzar allá con el cobro ya tomado. No llama a ninguna API.
  if (corridor?.payoutMethod === 'owlPay') {
    try {
      const iban = data.iban ?? data.account_number ?? null;
      buildPayoutInstrument(
        { dynamicFields: data, firstName: data.beneficiary_first_name, lastName: data.beneficiary_last_name },
        resolveHarborCountry(corridor.destinationCountry, iban),
        owlPayMethod,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, errores: [err.message.replace(/^\[Harbor\]\s*/, '')] };
    }
  }

  // anchorBolivia y otros métodos manuales: sin contrato de proveedor que validar.
  return { ok: true, skipped: 'manual_payout' };
}

export default { validateAgainstVitaFields, checkBeneficiaryExecutable };
