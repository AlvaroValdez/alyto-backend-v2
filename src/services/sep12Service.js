/**
 * sep12Service.js — SEP-12 KYC API
 *
 * Mapea el estado KYC de Alyto (Stripe Identity) al formato estándar SEP-12.
 * Expone los datos del cliente para consumo por other anchors de Stellar.
 *
 * Spec: https://stellar.org/protocol/sep-12
 *
 * Estado KYC Alyto → Estado SEP-12:
 *   pending      → NEEDS_INFO
 *   in_review    → PROCESSING
 *   approved     → ACCEPTED
 *   rejected     → REJECTED
 *   expired      → NEEDS_INFO (requiere nuevo KYC)
 */

import User from '../models/User.js';
import { logger } from '../utils/logger.js';

// ─── Mapeo de estados ────────────────────────────────────────────────────────

const KYC_STATUS_MAP = {
  pending:   'NEEDS_INFO',
  in_review: 'PROCESSING',
  approved:  'ACCEPTED',
  rejected:  'REJECTED',
  expired:   'NEEDS_INFO',
};

// ─── Campos requeridos por entidad ───────────────────────────────────────────

const REQUIRED_FIELDS_RETAIL = {
  first_name:       { description: 'Nombre legal del titular' },
  last_name:        { description: 'Apellido legal del titular' },
  email_address:    { description: 'Correo electrónico' },
  date_of_birth:    { description: 'Fecha de nacimiento (YYYY-MM-DD)' },
  id_type:          { description: 'Tipo de documento (passport, national_id, drivers_license)' },
  id_number:        { description: 'Número de documento de identidad' },
  id_issuer:        { description: 'País emisor del documento (ISO 3166-1 alpha-2)' },
  address:          { description: 'Dirección de residencia' },
  city:             { description: 'Ciudad de residencia' },
  country_code:     { description: 'País de residencia (ISO 3166-1 alpha-2)' },
};

const REQUIRED_FIELDS_BUSINESS = {
  ...REQUIRED_FIELDS_RETAIL,
  organization_name:     { description: 'Razón social de la empresa' },
  organization_tax_id:   { description: 'NIT / RUT / Tax ID de la empresa' },
  organization_country:  { description: 'País de constitución' },
};

// ─── GET /customer ────────────────────────────────────────────────────────────

/**
 * Retorna el estado KYC del cliente en formato SEP-12.
 *
 * @param {string} accountId - G... (Stellar public key del cliente)
 * @param {string} [id]      - customer_id Alyto (MongoDB _id)
 * @returns {Promise<object>} Respuesta SEP-12 /customer
 */
export async function getCustomer({ accountId, id }) {
  // Buscar por publicKey Stellar o por MongoDB _id
  const query = id
    ? { _id: id }
    : { 'stellarAccount.publicKey': accountId };

  const user = await User.findOne(query)
    .select('firstName lastName email kycStatus kybStatus accountType identityDocument address legalEntity sanctionsFlag')
    .lean();

  if (!user) {
    // SEP-12: si no existe, retornar NEEDS_INFO con required_fields
    return {
      id:     null,
      status: 'NEEDS_INFO',
      fields: REQUIRED_FIELDS_RETAIL,
    };
  }

  if (user.sanctionsFlag) {
    return {
      id:     String(user._id),
      status: 'REJECTED',
      message: 'Account flagged by compliance screening',
    };
  }

  const sep12Status = KYC_STATUS_MAP[user.kycStatus] ?? 'NEEDS_INFO';
  const isApproved  = sep12Status === 'ACCEPTED';
  const isBusiness  = user.accountType === 'business';

  const response = {
    id:     String(user._id),
    status: sep12Status,
  };

  // Si está aprobado, retornar los campos provistos
  if (isApproved) {
    response.provided_fields = buildProvidedFields(user, isBusiness);
  } else {
    // Si no está aprobado, indicar qué campos faltan
    response.fields = buildMissingFields(user, isBusiness);
  }

  return response;
}

// ─── PUT /customer ────────────────────────────────────────────────────────────

/**
 * Actualiza datos del cliente (pre-KYC o corrección de datos).
 * Los campos opcionales que Alyto no use hoy se almacenan para futura integración.
 *
 * @param {string} accountId - G... Stellar public key
 * @param {object} fields    - Campos SEP-12 a actualizar
 * @returns {Promise<{id: string}>}
 */
export async function putCustomer({ accountId, fields }) {
  const user = await User.findOne({ 'stellarAccount.publicKey': accountId });
  if (!user) {
    throw Object.assign(new Error('Customer not found'), { status: 404 });
  }

  const updates = {};

  if (fields.first_name)    updates.firstName = fields.first_name;
  if (fields.last_name)     updates.lastName  = fields.last_name;
  if (fields.email_address) updates.email     = fields.email_address;

  // Dirección
  if (fields.address || fields.city || fields.country_code) {
    updates['address.street']  = fields.address;
    updates['address.city']    = fields.city;
    updates['address.country'] = fields.country_code;
  }

  // Documento de identidad
  if (fields.id_type || fields.id_number || fields.id_issuer) {
    updates['identityDocument.type']           = mapIdType(fields.id_type);
    updates['identityDocument.number']         = fields.id_number;
    updates['identityDocument.issuingCountry'] = fields.id_issuer;
  }

  await User.findByIdAndUpdate(user._id, { $set: updates });

  logger.info('[sep12] Customer fields updated', {
    userId: String(user._id),
    fields: Object.keys(fields),
  });

  return { id: String(user._id) };
}

// ─── DELETE /customer ─────────────────────────────────────────────────────────

/**
 * SEP-12: el cliente solicita eliminación de sus datos.
 * En Alyto, se anonimiza el usuario (GDPR/compliance boliviano).
 * No elimina transacciones históricas (obligación de 10 años ASFI).
 */
export async function deleteCustomer({ id, accountId }) {
  const query = id
    ? { _id: id }
    : { 'stellarAccount.publicKey': accountId };

  const user = await User.findOne(query);
  if (!user) throw Object.assign(new Error('Customer not found'), { status: 404 });

  // Anonimización — no eliminación completa (obligación regulatoria)
  await User.findByIdAndUpdate(user._id, {
    $set: {
      firstName:     'DELETED',
      lastName:      'DELETED',
      email:         `deleted_${user._id}@alyto.deleted`,
      kycStatus:     'rejected',
      deletedAt:     new Date(),
    },
  });

  logger.info('[sep12] Customer data anonymized per SEP-12 delete request', {
    userId: String(user._id),
  });
}

// ─── Helpers privados ────────────────────────────────────────────────────────

function buildProvidedFields(user, isBusiness) {
  const fields = {
    first_name:    { status: user.firstName     ? 'ACCEPTED' : 'NEEDS_INFO' },
    last_name:     { status: user.lastName      ? 'ACCEPTED' : 'NEEDS_INFO' },
    email_address: { status: user.email         ? 'ACCEPTED' : 'NEEDS_INFO' },
    id_type:       { status: user.identityDocument?.type   ? 'ACCEPTED' : 'NEEDS_INFO' },
    id_number:     { status: user.identityDocument?.number ? 'ACCEPTED' : 'NEEDS_INFO' },
    address:       { status: user.address?.street          ? 'ACCEPTED' : 'NEEDS_INFO' },
    country_code:  { status: user.address?.country         ? 'ACCEPTED' : 'NEEDS_INFO' },
  };

  if (isBusiness) {
    fields.organization_name   = { status: 'PROCESSING' }; // KYB en Alyto es manual
    fields.organization_tax_id = { status: 'PROCESSING' };
  }

  return fields;
}

function buildMissingFields(user, isBusiness) {
  const base = isBusiness ? REQUIRED_FIELDS_BUSINESS : REQUIRED_FIELDS_RETAIL;
  const missing = {};

  for (const [key, desc] of Object.entries(base)) {
    if (!isFieldProvided(user, key)) {
      missing[key] = desc;
    }
  }

  return Object.keys(missing).length > 0 ? missing : base;
}

function isFieldProvided(user, fieldKey) {
  const map = {
    first_name:    !!user.firstName,
    last_name:     !!user.lastName,
    email_address: !!user.email,
    id_type:       !!user.identityDocument?.type,
    id_number:     !!user.identityDocument?.number,
    id_issuer:     !!user.identityDocument?.issuingCountry,
    address:       !!user.address?.street,
    city:          !!user.address?.city,
    country_code:  !!user.address?.country,
  };
  return map[fieldKey] ?? false;
}

function mapIdType(sep12Type) {
  const map = {
    passport:         'passport',
    national_id:      'ci_bolivia',
    drivers_license:  'national_id',
    tax_id:           'nit',
  };
  return map[sep12Type] ?? sep12Type;
}
