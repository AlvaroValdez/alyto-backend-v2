/**
 * clientDocument.test.js — Resolución del documento del cliente para el comprobante ASFI.
 *
 * Garantiza que el Comprobante Oficial NUNCA imprima 'NO REGISTRADO' ni el
 * placeholder crudo 'PENDING_VERIFICATION', y que muestre el CI real cuando existe.
 */

import '../setup.env.js';
import {
  resolveClientDocument,
  isRealDocumentNumber,
  CI_PENDING_LABEL,
} from '../../src/utils/clientDocument.js';

describe('isRealDocumentNumber', () => {
  test('acepta un CI real', () => {
    expect(isRealDocumentNumber('7654321')).toBe(true);
    expect(isRealDocumentNumber('  12345678-9 ')).toBe(true);
  });
  test('rechaza vacío / placeholder / no-string', () => {
    expect(isRealDocumentNumber('')).toBe(false);
    expect(isRealDocumentNumber('   ')).toBe(false);
    expect(isRealDocumentNumber('PENDING_VERIFICATION')).toBe(false);
    expect(isRealDocumentNumber('pending')).toBe(false);
    expect(isRealDocumentNumber('in_verification')).toBe(false);
    expect(isRealDocumentNumber(undefined)).toBe(false);
    expect(isRealDocumentNumber(null)).toBe(false);
    expect(isRealDocumentNumber(12345)).toBe(false);
  });
});

describe('resolveClientDocument', () => {
  test('cuenta business con taxId → NIT', () => {
    const r = resolveClientDocument({ taxId: '706138025', identityDocument: { number: 'PENDING_VERIFICATION' } });
    expect(r).toEqual({ nitOci: '706138025', tipoDocumento: 'NIT', ciPending: false });
  });

  test('persona con CI real → CI con el número', () => {
    const r = resolveClientDocument({ identityDocument: { number: '7654321' } });
    expect(r).toEqual({ nitOci: '7654321', tipoDocumento: 'CI', ciPending: false });
  });

  test('CI placeholder → "En verificación" (nunca NO REGISTRADO ni el placeholder crudo)', () => {
    const r = resolveClientDocument({ identityDocument: { number: 'PENDING_VERIFICATION' } });
    expect(r).toEqual({ nitOci: CI_PENDING_LABEL, tipoDocumento: 'CI', ciPending: true });
    expect(r.nitOci).not.toMatch(/NO REGISTRADO|PENDING_VERIFICATION/);
  });

  test('sin identityDocument → "En verificación"', () => {
    expect(resolveClientDocument({}).ciPending).toBe(true);
    expect(resolveClientDocument({ identityDocument: {} }).nitOci).toBe(CI_PENDING_LABEL);
    expect(resolveClientDocument(null).ciPending).toBe(true);
  });

  test('CI real tiene prioridad como número; taxId gana sobre CI', () => {
    const r = resolveClientDocument({ taxId: 'NIT-1', identityDocument: { number: '7654321' } });
    expect(r.tipoDocumento).toBe('NIT');
    expect(r.nitOci).toBe('NIT-1');
  });
});
