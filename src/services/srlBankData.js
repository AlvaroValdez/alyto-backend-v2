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

/**
 * Datos bancarios de la SRL para instrucciones de pago en BOB.
 *
 * Precedencia por campo: `srl_config.bankData` → variable de entorno → default.
 * Es por campo y no por objeto a propósito: un `bankData` a medio cargar no debe
 * dejar los otros tres campos en blanco.
 *
 * @returns {Promise<{bankName: string, accountHolder: string, accountNumber: string, accountType: string}>}
 */
export async function getSrlBankData() {
  let db = {};
  try {
    const cfg = await SRLConfig.findOne({ key: 'srl_bolivia' }).select('bankData').lean();
    db = cfg?.bankData ?? {};
    _ultimaBuena = db;
  } catch (err) {
    // Sin DB usamos la última lectura buena antes que el env: el env es el que
    // demostró estar desactualizado en producción.
    db = _ultimaBuena ?? {};
    logger.warn('[srlBankData] No se pudo leer SRLConfig, usando caché/env', { error: err.message });
  }

  return {
    bankName:      db.bankName      || process.env.SRL_BANK_NAME      || 'Banco Económico',
    accountHolder: db.accountHolder || process.env.SRL_ACCOUNT_HOLDER || 'AV Finance SRL',
    accountNumber: db.accountNumber || process.env.SRL_ACCOUNT_NUMBER || '',
    accountType:   db.accountType   || process.env.SRL_ACCOUNT_TYPE   || 'Cuenta Corriente',
  };
}
