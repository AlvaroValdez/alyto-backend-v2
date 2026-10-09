/**
 * srlBankData.js — Única fuente de verdad de la cuenta bancaria de AV Finance SRL
 *
 * La cuenta que se le informa al usuario boliviano para que transfiera sus BOB
 * se leía en tres lugares distintos y con criterios distintos:
 *
 *   - `paymentController.initCrossBorderPayment`  → SRLConfig, fallback a env
 *   - `paymentController.getSRLPayinInstructions` → SRLConfig, fallback a env
 *   - `walletController.initiateDeposit`          → **env directo, sin mirar la DB**
 *
 * El tercero divergía de los otros dos. El 2026-10-01 se verificó contra
 * producción que `SRL_ACCOUNT_NUMBER` del `.env` del VPS apunta a una cuenta
 * **distinta** de `srl_config.bankData.accountNumber`, y que esta última es la
 * misma que `BEC_ACCOUNT_CREDIT`, o sea la cuenta donde realmente cobra el QR.
 * Resultado: el depósito de wallet le dictaba al usuario una cuenta a la que no
 * llega ningún cobro automático. No es un detalle cosmético — es plata que un
 * usuario podría transferir a destino equivocado.
 *
 * Por eso la lectura vive acá y en un solo sitio. La DB manda porque es lo que
 * el admin edita desde `/admin/srl-config`; el env queda como red de seguridad
 * para un arranque sin configurar, nunca como fuente concurrente.
 */

import SRLConfig   from '../models/SRLConfig.js';
import { logger }  from '../utils/logger.js';

/** Última lectura buena, para no dejar al usuario sin datos si Mongo parpadea. */
let _ultimaBuena = null;

/** Propósitos con cuenta propia. Mismos valores que `bankQr.purpose`. */
const PROPOSITOS = ['wallet_deposit', 'crossborder_payin'];

/**
 * Datos bancarios de la SRL para instrucciones de pago en BOB.
 *
 * Precedencia por campo:
 *   `srl_config.bankAccounts[purpose]` → `srl_config.bankData` → env → default
 *
 * Es por campo y no por objeto a propósito: una cuenta a medio cargar no debe
 * dejar los otros tres campos en blanco.
 *
 * El primer escalón es la segregación de octubre de 2026: cada destino de fondos
 * cobra en su propia cuenta, para poder rendir el dinero de clientes por separado
 * del gasto operativo. **Mientras `bankAccounts` esté vacío el comportamiento es
 * idéntico al anterior**, así que esto se puede desplegar antes de tener las
 * cuentas nuevas y encender cargándolas desde el admin, sin redeploy.
 *
 * @param {'wallet_deposit'|'crossborder_payin'} [purpose] — destino de los fondos
 * @returns {Promise<{bankName: string, accountHolder: string, accountNumber: string, accountType: string}>}
 */
export async function getSrlBankData(purpose) {
  let db = {};
  let porProposito = {};
  try {
    const cfg = await SRLConfig.findOne({ key: 'srl_bolivia' })
      .select('bankData bankAccounts')
      .lean();
    db = cfg?.bankData ?? {};
    porProposito = (PROPOSITOS.includes(purpose) ? cfg?.bankAccounts?.[purpose] : null) ?? {};
    _ultimaBuena = { db, porProposito, purpose };
  } catch (err) {
    // Sin DB usamos la última lectura buena antes que el env: el env es el que
    // demostró estar desactualizado en producción.
    const cache = _ultimaBuena?.purpose === purpose ? _ultimaBuena : null;
    db = cache?.db ?? {};
    porProposito = cache?.porProposito ?? {};
    logger.warn('[srlBankData] No se pudo leer SRLConfig, usando caché/env', { error: err.message });
  }

  const elegir = (campo, ...respaldos) =>
    porProposito[campo] || db[campo] || respaldos.find(Boolean) || '';

  return {
    bankName:      elegir('bankName',      process.env.SRL_BANK_NAME,      'Banco Económico'),
    accountHolder: elegir('accountHolder', process.env.SRL_ACCOUNT_HOLDER, 'AV Finance SRL'),
    accountNumber: elegir('accountNumber', process.env.SRL_ACCOUNT_NUMBER),
    accountType:   elegir('accountType',   process.env.SRL_ACCOUNT_TYPE,   'Cuenta Corriente'),
  };
}
