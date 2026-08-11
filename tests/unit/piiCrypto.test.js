/**
 * piiCrypto.test.js — Cifrado de campo (envelope) para identityDocument.number.
 *
 * Usa el fallback local (sin KMS), permitido en test/testnet, para validar:
 *   round-trip, atadura AAD por usuario, esquema v1, y las reglas de dominio
 *   de readDocumentNumber / resolveDocumentNumberStorage / resolveClientDocument.
 */

import '../setup.env.js';

// Activar cifrado + fallback local ANTES de ejercitar la DEK (se lee en runtime).
process.env.PII_ENCRYPTION_ENABLED = 'true';
process.env.PII_KMS_FALLBACK       = 'true';
process.env.PII_FALLBACK_KEY       = 'test-fallback-key-1234567890';

import {
  ensureDek, encryptField, decryptField, isEncrypted,
  aadForDocumentNumber, PII_ENCRYPTED_MARKER,
} from '../../src/services/piiCrypto.js';
import {
  readDocumentNumber, resolveDocumentNumberStorage, resolveClientDocument,
  hasRealDocumentNumber, applyDocumentNumberToSet, CI_PENDING_LABEL,
} from '../../src/utils/clientDocument.js';

const UID = '64b7f0aa11223344556677aa';

beforeAll(async () => { await ensureDek(); });

describe('piiCrypto — primitivas', () => {
  test('round-trip cifra/descifra con AAD', () => {
    const ct = encryptField('7654321', aadForDocumentNumber(UID));
    expect(isEncrypted(ct)).toBe(true);
    expect(ct.startsWith('v1:')).toBe(true);
    expect(decryptField(ct, aadForDocumentNumber(UID))).toBe('7654321');
  });

  test('AAD de otro usuario NO puede descifrar (GCM auth)', () => {
    const ct = encryptField('7654321', aadForDocumentNumber(UID));
    expect(() => decryptField(ct, aadForDocumentNumber('otro-usuario'))).toThrow();
  });

  test('cada cifrado usa IV distinto (ciphertexts diferentes)', () => {
    const a = encryptField('7654321', aadForDocumentNumber(UID));
    const b = encryptField('7654321', aadForDocumentNumber(UID));
    expect(a).not.toBe(b);
  });
});

describe('resolveDocumentNumberStorage — escritura', () => {
  test('valor real → marcador + ciphertext', async () => {
    const s = await resolveDocumentNumberStorage(UID, '7654321');
    expect(s.number).toBe(PII_ENCRYPTED_MARKER);
    expect(isEncrypted(s.numberCiphertext)).toBe(true);
  });

  test('vacío / placeholder → sentinel sin ciphertext', async () => {
    expect(await resolveDocumentNumberStorage(UID, '')).toEqual({ number: 'PENDING_VERIFICATION', numberCiphertext: null });
    expect((await resolveDocumentNumberStorage(UID, 'PENDING_VERIFICATION')).numberCiphertext).toBeNull();
  });

  test('applyDocumentNumberToSet puebla claves dotted', async () => {
    const $set = {};
    await applyDocumentNumberToSet($set, UID, '7654321');
    expect($set['identityDocument.number']).toBe(PII_ENCRYPTED_MARKER);
    expect(isEncrypted($set['identityDocument.numberCiphertext'])).toBe(true);
  });
});

describe('readDocumentNumber — lectura', () => {
  let encUser;
  beforeAll(async () => {
    const s = await resolveDocumentNumberStorage(UID, '7654321');
    encUser = { _id: UID, identityDocument: { number: s.number, numberCiphertext: s.numberCiphertext } };
  });

  test('descifra el CI real', () => {
    expect(readDocumentNumber(encUser)).toBe('7654321');
  });

  test('marcador SIN ciphertext seleccionado → null (no filtra el marcador)', () => {
    expect(readDocumentNumber({ _id: UID, identityDocument: { number: PII_ENCRYPTED_MARKER } })).toBeNull();
  });

  test('valor legacy en claro (aún sin migrar) sigue legible', () => {
    expect(readDocumentNumber({ _id: UID, identityDocument: { number: '12345678-9' } })).toBe('12345678-9');
  });

  test('sentinel de pendiente se devuelve tal cual', () => {
    expect(readDocumentNumber({ _id: UID, identityDocument: { number: 'PENDING_VERIFICATION' } })).toBe('PENDING_VERIFICATION');
  });
});

describe('resolveClientDocument — comprobante con CI cifrado', () => {
  test('usuario cifrado → CI real en el comprobante', async () => {
    const s = await resolveDocumentNumberStorage(UID, '7654321');
    const u = { _id: UID, identityDocument: { number: s.number, numberCiphertext: s.numberCiphertext } };
    expect(resolveClientDocument(u)).toEqual({ nitOci: '7654321', tipoDocumento: 'CI', ciPending: false });
  });

  test('NIT business tiene prioridad sobre el CI cifrado', async () => {
    const s = await resolveDocumentNumberStorage(UID, '7654321');
    const u = { _id: UID, taxId: '706138025', identityDocument: { number: s.number, numberCiphertext: s.numberCiphertext } };
    expect(resolveClientDocument(u).tipoDocumento).toBe('NIT');
    expect(resolveClientDocument(u).nitOci).toBe('706138025');
  });

  test('marcador sin ciphertext → "En verificación" (degradación segura, nunca el marcador)', () => {
    const r = resolveClientDocument({ _id: UID, identityDocument: { number: PII_ENCRYPTED_MARKER } });
    expect(r.nitOci).toBe(CI_PENDING_LABEL);
    expect(r.ciPending).toBe(true);
  });
});

describe('hasRealDocumentNumber', () => {
  test('true cuando hay ciphertext; false para sentinel', async () => {
    const s = await resolveDocumentNumberStorage(UID, '7654321');
    expect(hasRealDocumentNumber({ identityDocument: { numberCiphertext: s.numberCiphertext } })).toBe(true);
    expect(hasRealDocumentNumber({ identityDocument: { number: 'PENDING_VERIFICATION' } })).toBe(false);
  });
});
