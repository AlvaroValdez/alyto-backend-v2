/**
 * reconcileCustodialAccounts.js — Red de seguridad de la provisión custodial.
 *
 * `provisionUserKeypair` persiste la publicKey en MongoDB (paso 3) y recién entonces
 * funde la cuenta (paso 5) y crea la trustline USDC (paso 6). Ninguno de los dos
 * relanza si falla: la función retorna como si todo hubiera salido bien. Y quien la
 * llama es el webhook de KYC, fire-and-forget, que ante un error solo deja un
 * console.error. Resultado: si el `createAccount` muere (canal sin XLM, `tx_bad_seq`
 * por concurrencia, timeout de Horizon), el usuario queda con una dirección que
 * Horizon responde 404 y **nada lo reintenta**.
 *
 * Este job cierra ese hueco. El síntoma que elimina es doble: la cuenta no puede
 * recibir USDC, y `monitorUSDCDeposits` la sondea cada 30s para siempre.
 *
 * Garantía: ninguna cuenta custodial queda indefinidamente a medio provisionar sin
 * que se vea. Si tras agotar el presupuesto de intentos sigue rota, se registra en
 * ERROR (no en silencio), para que un supervisor pueda verlo.
 *
 * Acotado a propósito:
 *   - `batch`        techo de cuentas por corrida.
 *   - `maxAttempts`  presupuesto por cuenta a lo largo de las corridas — evita
 *                    martillar un fallo permanente.
 *   - `cooldownMs`   separación mínima entre intentos de la MISMA cuenta.
 *   - guard de XLM   si el canal no alcanza, NO se intenta fondear: reintentar sin
 *                    XLM repite el fallo original y además consume fees. Se avisa.
 */

import User                   from '../models/User.js';
import { ensureAccountOnChain } from '../services/custodyService.js';
import { getXLMBalance }      from '../services/stellarService.js';
import { logger }             from '../utils/logger.js';

/** startingBalance que usa fundUserAccount por cuenta creada. */
const XLM_PER_ACCOUNT = 1.5;
/** Colchón sobre lo estrictamente necesario, para no dejar el canal en cero. */
const XLM_HEADROOM    = 2;

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Guard de solapamiento. Este job corre in-process cada 30 min Y sigue registrado en
// jobRegistry, así que un disparo manual (o una regla de EventBridge, si algún día se
// agrega) puede caer encima de una corrida en curso. Dos corridas simultáneas verían
// las mismas candidatas y la segunda intentaría crear una cuenta que la primera ya está
// creando: `op_already_exists` se contaría como fallo y gastaría un intento del
// presupuesto. Mismo patrón que monitorUSDCDeposits y reconcileBankQrPayments.
let _isRunning = false;

/**
 * Filtro de las cuentas candidatas a reparar. PURO, para probarlo sin base de datos.
 *
 * Candidata = tiene publicKey (hay algo que completar) y está dentro del presupuesto
 * de intentos y fuera del cooldown. El estado real on-chain NO se filtra acá: eso
 * exige hablar con Horizon y se evalúa cuenta por cuenta.
 *
 * @param {{ now:Date, maxAttempts:number, cooldownMs:number }} p
 */
export function buildRepairFilter({ now, maxAttempts, cooldownMs }) {
  const cooldownCutoff = new Date(now.getTime() - cooldownMs);
  return {
    'stellarAccount.publicKey': { $nin: [null, ''] },
    $and: [
      { $or: [
        { 'stellarAccount.repairAttempts': { $exists: false } },
        { 'stellarAccount.repairAttempts': { $lt: maxAttempts } },
      ] },
      { $or: [
        { 'stellarAccount.repairLastAttemptAt': { $exists: false } },
        { 'stellarAccount.repairLastAttemptAt': null },
        { 'stellarAccount.repairLastAttemptAt': { $lte: cooldownCutoff } },
      ] },
    ],
  };
}

/**
 * ¿Alcanza el XLM del canal para fondear `pendientes` cuentas?
 * PURO. Separado para poder probar el guard sin red.
 *
 * @param {number|null} saldo — XLM del canal, o null si no se pudo leer
 * @param {number} pendientes
 */
export function alcanzaElCanal(saldo, pendientes) {
  if (pendientes <= 0) return true;
  // Sin lectura fiable del saldo NO se funde: asumir que alcanza es justamente el
  // error que dejó estas cuentas a medias.
  if (typeof saldo !== 'number' || !Number.isFinite(saldo)) return false;
  return saldo >= pendientes * XLM_PER_ACCOUNT + XLM_HEADROOM;
}

/**
 * Corre una pasada de reconciliación.
 * @returns {Promise<{processed:number, repaired:number, alreadyOk:number, failed:number, exhausted:number, skippedNoXLM:number}>}
 */
export async function reconcileCustodialAccounts() {
  if (_isRunning) {
    logger.warn('[custody-recon] Ciclo anterior aún en ejecución — skip');
    return { processed: 0, repaired: 0, alreadyOk: 0, failed: 0, exhausted: 0, skippedNoXLM: 0, skipped: true };
  }
  _isRunning = true;
  try {
    return await _reconcile();
  } finally {
    _isRunning = false;
  }
}

async function _reconcile() {
  const now         = new Date();
  const maxAttempts = envInt('CUSTODY_REPAIR_MAX_ATTEMPTS', 8);
  const cooldownMs  = envInt('CUSTODY_REPAIR_COOLDOWN_MS', 30 * 60 * 1000);
  const batchSize   = envInt('CUSTODY_REPAIR_BATCH', 10);

  const filter = buildRepairFilter({ now, maxAttempts, cooldownMs });
  const batch  = await User.find(filter)
    .select('_id email legalEntity stellarAccount.publicKey stellarAccount.repairAttempts')
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .lean();

  if (!batch.length) return { processed: 0, repaired: 0, alreadyOk: 0, failed: 0, exhausted: 0, skippedNoXLM: 0 };

  // El saldo del canal se lee UNA vez por corrida y acota el lote: así una tanda de
  // cuentas rotas no lo deja seco a mitad de camino.
  let canalXLM = null;
  const canal  = process.env.STELLAR_MASTER_PUBLIC;
  if (canal) {
    try {
      canalXLM = await getXLMBalance(canal);
    } catch (err) {
      logger.warn('[custody-recon] No se pudo leer el saldo del canal', { error: err.message });
    }
  }

  let repaired = 0, alreadyOk = 0, failed = 0, exhausted = 0, skippedNoXLM = 0;
  // Cuántas cuentas del lote podrían necesitar fondeo, en el peor caso.
  let presupuestoFondeo = alcanzaElCanal(canalXLM, batch.length)
    ? batch.length
    : Math.max(0, Math.floor(((canalXLM ?? 0) - XLM_HEADROOM) / XLM_PER_ACCOUNT));

  for (const u of batch) {
    const publicKey = u.stellarAccount.publicKey;
    const attempts  = (u.stellarAccount.repairAttempts ?? 0) + 1;
    const log = { userId: String(u._id), email: u.email, publicKey, attempts };

    const set = {
      'stellarAccount.repairAttempts':      attempts,
      'stellarAccount.repairLastAttemptAt': new Date(),
    };

    try {
      // Sin presupuesto no se fonde, pero sí se intenta la trustline: va por Fee Bump
      // y no consume reserva del canal, así que no le aplica el límite de XLM.
      const r = await ensureAccountOnChain(u._id, { allowFunding: presupuestoFondeo > 0 });

      if (r.needsFunding) {
        skippedNoXLM++;
        // No se consume intento: la cuenta no falló, se decidió no intentarla.
        continue;
      }

      if (r.alreadyOk) {
        alreadyOk++;
        // Estaba bien: se limpia el rastro para que un fallo viejo no gaste
        // presupuesto si la cuenta vuelve a romperse más adelante.
        await User.updateOne({ _id: u._id }, {
          $unset: {
            'stellarAccount.repairAttempts':      '',
            'stellarAccount.repairLastAttemptAt': '',
            'stellarAccount.repairLastError':     '',
          },
        });
        continue;
      }

      if (r.funded) presupuestoFondeo--;
      repaired++;
      await User.updateOne({ _id: u._id }, {
        $set:   set,
        $unset: { 'stellarAccount.repairLastError': '' },
      });
      logger.info('[custody-recon] Cuenta custodial completada', {
        ...log, fondeada: r.funded, trustline: r.trustlineCreated,
      });

    } catch (err) {
      failed++;
      set['stellarAccount.repairLastError'] = err.message;
      await User.updateOne({ _id: u._id }, { $set: set });

      if (err.isPermanent || attempts >= maxAttempts) {
        exhausted++;
        // No en silencio: una cuenta custodial que no se puede completar bloquea los
        // depósitos USDC de ese usuario, y es un hecho que alguien debe poder ver.
        logger.error('[custody-recon] Cuenta custodial sigue incompleta tras agotar el presupuesto', {
          ...log, maxAttempts, permanente: !!err.isPermanent, error: err.message,
        });
      } else {
        logger.warn('[custody-recon] Fallo al completar la cuenta, se reintentará', { ...log, error: err.message });
      }
    }
  }

  if (skippedNoXLM) {
    // El canal sin XLM es la causa raíz más probable de que estas cuentas existan.
    // Repararlas sin fondearlo primero solo repite el fallo original.
    logger.error('[custody-recon] Cuentas sin reparar por falta de XLM en el canal', {
      pendientes: skippedNoXLM,
      canal,
      canalXLM,
      necesario: `${(skippedNoXLM * XLM_PER_ACCOUNT + XLM_HEADROOM).toFixed(2)} XLM`,
    });
  }

  logger.info('[custody-recon] Reconciliación de cuentas custodiales', {
    candidates: batch.length, repaired, alreadyOk, failed, exhausted, skippedNoXLM,
  });

  return { processed: batch.length, repaired, alreadyOk, failed, exhausted, skippedNoXLM };
}

export default reconcileCustodialAccounts;
