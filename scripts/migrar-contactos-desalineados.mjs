/**
 * migrar-contactos-desalineados.mjs — Realinea contactos guardados con el
 * corredor VIGENTE de su destino.
 *
 * Un contacto guarda formType ('vita'|'owlpay'), destinationCurrency y un
 * beneficiaryData con las claves del formulario del momento. Cuando un corredor
 * cambia de proveedor (EU pasó de Harbor a Vita) o de moneda (JP/CA→USD), el
 * contacto queda mintiendo: claves que el form nuevo no entiende y monedas que
 * ya no existen. El prefill del FE ya se defiende (no vuelca formatos viejos),
 * pero los datos siguen sucios y este script los corrige donde se puede.
 *
 * Qué hace por contacto (solo formType vita/owlpay):
 *   1. Resuelve el corredor activo del destino ('ES' legacy cuenta como 'EU').
 *      Sin corredor activo → solo REPORTA (no borra: puede reactivarse).
 *   2. destinationCurrency ≠ la del corredor (o vacía) → la estampa.
 *   3. formType ≠ proveedor vigente → intenta convertir beneficiaryData con
 *      mapeos de claves conocidos (Harbor-EU → Vita-EU es directo: iban→
 *      account_bank, bic→swift_bic…). Lo que no mapea queda para que el usuario
 *      lo complete — el form ya lo pedirá. Sin mapeo conocido → solo reporta.
 *
 * Uso:
 *   node scripts/migrar-contactos-desalineados.mjs           # dry-run
 *   node scripts/migrar-contactos-desalineados.mjs --apply
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Contact from '../src/models/Contact.js';
import TransactionConfig from '../src/models/TransactionConfig.js';
import User from '../src/models/User.js';
import { isEuSepaDestination } from '../src/routing/euAmountRouter.js';

const APPLY = process.argv.includes('--apply');

/** Harbor → Vita: mapeos por par de claves. Solo pares con equivalencia real. */
function harborToVita(b) {
  const out = {};
  const nombre = (b.beneficiary_name ?? b.account_holder_name ?? '').trim();
  if (nombre) {
    const partes = nombre.split(/\s+/);
    out.beneficiary_first_name = partes[0] ?? '';
    out.beneficiary_last_name  = partes.slice(1).join(' ');
  }
  if (b.iban)           out.account_bank        = b.iban;           // IBAN es la cuenta en Vita EU
  if (b.bic)            out.swift_bic           = b.bic;
  if (b.swift_code)     out.swift_bic           = out.swift_bic ?? b.swift_code;
  if (b.account_number) out.account_bank        = out.account_bank ?? b.account_number;
  if (b.street)         out.beneficiary_address = b.street;
  if (b.city)           out.city                = b.city;
  out.beneficiary_type = 'Individual';
  return out;
}

/**
 * ⚠️ El corredor se resuelve con la legalEntity del DUEÑO del contacto — igual
 * que el controller. Sin ese filtro, un destino multi-entidad devuelve cualquier
 * corredor: en el primer dry-run, US resolvió a un corredor Vita de otra entidad
 * y el script quería "convertir" contactos Harbor de bo-us perfectamente sanos.
 */
async function corridorFor(dest, legalEntity, cache) {
  const key = `${dest === 'ES' ? 'EU' : dest}:${legalEntity ?? ''}`;
  if (!cache.has(key)) {
    const destination = dest === 'ES' ? 'EU' : dest;
    // Mismo orden que withdrawal-rules/contactsController: EU prefiere Vita
    // (bo-es y bo-eu-srl son ambos SRL — sin esto el findOne era una moneda al
    // aire y llegó a marcar "sin mapeo" contactos EU perfectamente vigentes).
    const sortSpec = isEuSepaDestination(destination) ? { payoutMethod: -1 } : { payoutMethod: 1 };
    let c = legalEntity
      ? await TransactionConfig.findOne({ destinationCountry: destination, isActive: true, legalEntity }).sort(sortSpec).lean()
      : null;
    if (!c) c = await TransactionConfig.findOne({ destinationCountry: destination, isActive: true }).sort(sortSpec).lean();
    cache.set(key, c);
  }
  return cache.get(key);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`BD: ${mongoose.connection.name}${APPLY ? '  · MODO APLICAR' : '  · dry-run'}\n`);

  const contacts = await Contact.find({ formType: { $in: ['vita', 'owlpay'] } });
  const cache = new Map();
  let ok = 0, corregidos = 0, huerfanos = 0, sinMapeo = 0;

  const entityCache = new Map();
  for (const c of contacts) {
    if (!entityCache.has(String(c.userId))) {
      const u = await User.findById(c.userId).select('legalEntity').lean();
      entityCache.set(String(c.userId), u?.legalEntity ?? null);
    }
    const corridor = await corridorFor(c.destinationCountry, entityCache.get(String(c.userId)), cache);
    const etiqueta = `${String(c.destinationCountry).padEnd(4)} ${c.formType.padEnd(8)} "${c.nickname || c.firstName || c._id}"`;

    if (!corridor) {
      console.log(`  ⚠ ${etiqueta} → destino SIN corredor activo (GT/HT/SV/IN…). Se conserva tal cual.`);
      huerfanos++;
      continue;
    }

    const expectedType = corridor.payoutMethod === 'owlPay' ? 'owlpay' : 'vita';
    const expectedCur  = corridor.destinationCurrency ?? '';
    const cambios = [];

    if ((c.destinationCurrency ?? '') !== expectedCur) {
      cambios.push(`moneda '${c.destinationCurrency || '(vacía)'}'→'${expectedCur}'`);
      c.destinationCurrency = expectedCur;
    }

    if (c.formType !== expectedType) {
      if (c.formType === 'owlpay' && expectedType === 'vita') {
        const convertido = harborToVita(c.beneficiaryData ?? {});
        cambios.push(`formato owlpay→vita (${Object.keys(convertido).length} campos mapeados; ` +
                     'el form pedirá los faltantes)');
        c.beneficiaryData = convertido;
        c.formType = 'vita';
        c.markModified('beneficiaryData');
      } else {
        // vita→owlpay no tiene mapeo confiable (Harbor exige campos que Vita no pide)
        console.log(`  ⚠ ${etiqueta} → formato '${c.formType}' pero el corredor es '${expectedType}': ` +
                    'sin mapeo automático confiable. El FE ya avisa al usuario; se conserva.');
        sinMapeo++;
        continue;
      }
    }

    if (!cambios.length) { ok++; continue; }

    console.log(`  ✎ ${etiqueta} → ${cambios.join(' · ')}`);
    corregidos++;
    if (APPLY) await c.save();
  }

  console.log(`\n  ${contacts.length} contactos: ${ok} ya alineados · ${corregidos} corregidos` +
              `${APPLY ? '' : ' (dry-run)'} · ${huerfanos} de destinos inactivos · ${sinMapeo} sin mapeo`);
  if (!APPLY && corregidos) console.log('  Re-ejecutar con --apply para escribir.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
