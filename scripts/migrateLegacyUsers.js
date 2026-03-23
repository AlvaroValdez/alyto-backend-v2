/**
 * migrateLegacyUsers.js — Migración de Usuarios Legacy (V1.0 → V2.0)
 *
 * Propósito:
 *   Actualiza documentos de la colección `users` que no cuentan con el campo
 *   `legalEntity`, asignando la entidad legal AV Finance correcta según el
 *   país de registro del usuario.
 *
 * Mapeo de entidad legal:
 *   registrationCountry = 'CL'    → AV Finance SpA (Chile)
 *   registrationCountry = 'BO'    → AV Finance SRL (Bolivia)
 *   registrationCountry = 'OTHER' → AV Finance LLC (Delaware)
 *   country ausente / nulo        → AV Finance SpA (fallback conservador)
 *
 * Mapeo de estado KYC (legacy → V2.0):
 *   'unverified' → 'pending'
 *   'pending'    → 'pending'
 *   'approved'   → 'approved'
 *   'rejected'   → 'rejected'
 *   'review'     → 'in_review'
 *
 * Uso:
 *   node scripts/migrateLegacyUsers.js
 *
 * Requiere: MONGODB_URI en .env (o variable de entorno activa).
 * Opera con bulkWrite — no modifica documentos ya migrados (legalEntity presente).
 */

import 'dotenv/config';
import mongoose from 'mongoose';

// ─── Constantes de Mapeo ──────────────────────────────────────────────────────

const COUNTRY_TO_ENTITY = {
  CL:    'SpA',
  BO:    'SRL',
  OTHER: 'LLC',
};

/** Entidad por defecto cuando el país no está definido en el documento legacy */
const ENTITY_FALLBACK = 'SpA';

const KYC_STATUS_MAP = {
  unverified: 'pending',
  pending:    'pending',
  approved:   'approved',
  rejected:   'rejected',
  review:     'in_review',
};

/** kycStatus V2.0 por defecto si el documento legacy no tiene kyc.status */
const KYC_STATUS_FALLBACK = 'pending';

// ─── Tipo de documento predeterminado por entidad ─────────────────────────────

const ENTITY_DEFAULT_DOC_TYPE = {
  SpA: 'rut',
  SRL: 'ci_bolivia',
  LLC: 'passport',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determina la entidad legal AV Finance a partir del campo registrationCountry
 * del esquema V1.0.
 *
 * @param {string|undefined} registrationCountry
 * @returns {'SpA'|'SRL'|'LLC'}
 */
function resolveEntity(registrationCountry) {
  if (!registrationCountry) return ENTITY_FALLBACK;
  const normalized = registrationCountry.toString().toUpperCase().trim();
  return COUNTRY_TO_ENTITY[normalized] ?? ENTITY_FALLBACK;
}

/**
 * Traduce el kyc.status del esquema V1.0 al enum del esquema V2.0.
 *
 * @param {string|undefined} legacyStatus
 * @returns {string}
 */
function resolveKycStatus(legacyStatus) {
  if (!legacyStatus) return KYC_STATUS_FALLBACK;
  return KYC_STATUS_MAP[legacyStatus] ?? KYC_STATUS_FALLBACK;
}

/**
 * Construye el array kycDocuments V2.0 a partir de los campos de documentos
 * del esquema legacy (documentNumber + documentType o URLs de kyc.documents).
 *
 * @param {object} doc — Documento Mongoose raw del usuario legacy
 * @param {string} legalEntity — Entidad asignada
 * @returns {Array}
 */
function buildKycDocuments(doc, legalEntity) {
  const docs = [];

  // ── Documento de identidad principal ──────────────────────────────────────
  if (doc.documentNumber && doc.documentNumber !== 'PENDING_VERIFICATION') {
    const rawType    = (doc.documentType ?? '').toLowerCase();
    const mappedType = ['rut', 'nit', 'ein', 'passport', 'ci_bolivia', 'national_id'].includes(rawType)
      ? rawType
      : ENTITY_DEFAULT_DOC_TYPE[legalEntity];

    docs.push({
      docType:    mappedType,
      fileRef:    `legacy_doc_number:${doc.documentNumber}`,
      uploadedAt: doc.createdAt ?? new Date(),
    });
  }

  // ── Imágenes de documentos KYC (Niveles 2 y 3) ───────────────────────────
  const kycDocs = doc.kyc?.documents ?? {};

  if (kycDocs.idFront) {
    docs.push({ docType: 'national_id_front', fileRef: kycDocs.idFront, uploadedAt: doc.kyc?.submittedAt ?? new Date() });
  }
  if (kycDocs.idBack) {
    docs.push({ docType: 'national_id_back',  fileRef: kycDocs.idBack,  uploadedAt: doc.kyc?.submittedAt ?? new Date() });
  }
  if (kycDocs.selfie) {
    docs.push({ docType: 'selfie',            fileRef: kycDocs.selfie,  uploadedAt: doc.kyc?.submittedAt ?? new Date() });
  }
  if (kycDocs.proofOfAddress) {
    docs.push({ docType: 'proof_of_address',  fileRef: kycDocs.proofOfAddress, uploadedAt: doc.kyc?.submittedAt ?? new Date() });
  }

  return docs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function migrate() {
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    console.error('[Migración] ERROR: MONGODB_URI no está definida en .env.');
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Alyto V2.0 — Migración de Usuarios Legacy');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── Conexión ───────────────────────────────────────────────────────────────
  await mongoose.connect(MONGODB_URI);
  console.log(`[Migración] Conectado a MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, '//<credenciales>@')}`);

  const collection = mongoose.connection.collection('users');

  // ── Consulta: solo documentos sin legalEntity ──────────────────────────────
  const filter = {
    $or: [
      { legalEntity: { $exists: false } },
      { legalEntity: null },
    ],
  };

  const totalFound = await collection.countDocuments(filter);
  console.log(`[Migración] Usuarios sin legalEntity encontrados: ${totalFound}`);

  if (totalFound === 0) {
    console.log('[Migración] No hay documentos pendientes de migración. Base de datos al día.');
    await mongoose.connection.close();
    return;
  }

  // ── Construcción de operaciones BulkWrite ─────────────────────────────────
  const cursor = collection.find(filter);

  const bulkOps   = [];
  const counters  = { SpA: 0, SRL: 0, LLC: 0, errors: 0 };
  const errorList = [];

  for await (const doc of cursor) {
    try {
      const legalEntity = resolveEntity(doc.registrationCountry);
      const kycStatus   = resolveKycStatus(doc.kyc?.status);
      const kycDocuments = buildKycDocuments(doc, legalEntity);

      // Determina el país ISO para residenceCountry
      const residenceCountry =
        doc.registrationCountry === 'CL'    ? 'CL' :
        doc.registrationCountry === 'BO'    ? 'BO' :
        doc.registrationCountry === 'OTHER' ? 'US' :
        null;

      // Construye identityDocument si el usuario no lo tiene aún
      const hasIdentityDoc = doc.identityDocument?.type && doc.identityDocument?.number;
      const identityDocumentUpdate = hasIdentityDoc ? {} : {
        identityDocument: {
          type:           ENTITY_DEFAULT_DOC_TYPE[legalEntity],
          number:         doc.documentNumber?.trim() || 'PENDING_VERIFICATION',
          issuingCountry: residenceCountry ?? 'BO',
        },
      };

      // Separa firstName/lastName del campo legacy `name` si no existen
      let nameFields = {};
      if (!doc.firstName && doc.name) {
        const parts = doc.name.trim().split(/\s+/);
        nameFields = {
          firstName: parts[0] ?? 'Usuario',
          lastName:  parts.slice(1).join(' ') || 'Alyto',
        };
      }

      // Migra stellarAccount (string legacy → objeto V2.0)
      let stellarFields = {};
      if (typeof doc.stellarAccount === 'string' && doc.stellarAccount.startsWith('G')) {
        stellarFields = {
          stellarAccount: {
            publicKey:       doc.stellarAccount,
            createdByAlyto:  false,
            activeTrustlines: [],
          },
        };
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              legalEntity,
              kycStatus,
              kycDocuments,
              ...(residenceCountry ? { residenceCountry } : {}),
              ...identityDocumentUpdate,
              ...nameFields,
              ...stellarFields,
            },
          },
        },
      });

      counters[legalEntity]++;

    } catch (err) {
      counters.errors++;
      errorList.push({ userId: doc._id.toString(), error: err.message });
    }
  }

  // ── Ejecución BulkWrite ────────────────────────────────────────────────────
  let bulkResult = { modifiedCount: 0, matchedCount: 0 };

  if (bulkOps.length > 0) {
    bulkResult = await collection.bulkWrite(bulkOps, { ordered: false });
  }

  // ── Reporte Final ──────────────────────────────────────────────────────────
  const migrated = bulkResult.modifiedCount;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' REPORTE DE MIGRACIÓN — ALYTO V2.0');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Usuarios encontrados (sin legalEntity) : ${totalFound}`);
  console.log(`  Operaciones enviadas a MongoDB         : ${bulkOps.length}`);
  console.log(`  Documentos migrados exitosamente       : ${migrated}`);
  console.log('');
  console.log('  Distribución por entidad legal:');
  console.log(`    AV Finance SpA (Chile)               : ${counters.SpA} usuarios`);
  console.log(`    AV Finance SRL (Bolivia)             : ${counters.SRL} usuarios`);
  console.log(`    AV Finance LLC (Delaware)            : ${counters.LLC} usuarios`);

  if (counters.errors > 0) {
    console.warn(`\n  ⚠  Errores en construcción de operaciones : ${counters.errors}`);
    errorList.forEach(e => console.warn(`     • userId=${e.userId} → ${e.error}`));
  }

  if (bulkResult.modifiedCount < bulkOps.length) {
    const skipped = bulkOps.length - bulkResult.modifiedCount;
    console.warn(`\n  ⚠  Documentos no modificados (sin cambios o ya actualizados): ${skipped}`);
  }

  console.log('\n  Estado: MIGRACIÓN COMPLETADA');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── Cierre seguro de conexión ──────────────────────────────────────────────
  await mongoose.connection.close();
  console.log('[Migración] Conexión a MongoDB cerrada correctamente.');
}

migrate().catch(err => {
  console.error('[Migración] ERROR FATAL:', err.message);
  mongoose.connection.close().finally(() => process.exit(1));
});
