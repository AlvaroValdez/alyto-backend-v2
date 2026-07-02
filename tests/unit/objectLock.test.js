/**
 * objectLock.test.js — Inmutabilidad ASFI (AWS-1D)
 *
 * Verifica que la capa de storage fija Object Lock COMPLIANCE POR OBJETO en cada
 * PutObject de un comprobante (key `pdfs/*`), con retención de 5 años, y que la
 * omite correctamente cuando NO corresponde (flag off, key no inmutable, endpoint R2).
 *
 * Mocking: se mockea @aws-sdk/client-s3 para capturar el input del PutObjectCommand
 * sin tocar AWS real.
 */

import '../setup.env.js';
import { jest } from '@jest/globals';

// ─── Captura de comandos enviados al cliente S3 mockeado ──────────────────────
const sentInputs = [];

await jest.unstable_mockModule('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(input) { this.input = input; this.__type = 'Put'; } }
  class GetObjectCommand { constructor(input) { this.input = input; this.__type = 'Get'; } }
  class GetObjectRetentionCommand { constructor(input) { this.input = input; this.__type = 'GetRetention'; } }
  class S3Client {
    async send(cmd) {
      sentInputs.push(cmd);
      if (cmd.__type === 'GetRetention') {
        return { Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date('2031-07-02T00:00:00Z') } };
      }
      return {};
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, GetObjectRetentionCommand };
});

await jest.unstable_mockModule('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/url'),
}));

await jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }));

// El módulo lee S3_OBJECT_LOCK_DAYS en import-time → fijar antes de importar.
process.env.S3_BUCKET            = 'alyto-pdfs-compliance';
process.env.S3_ACCESS_KEY_ID     = 'test-access';
process.env.S3_SECRET_ACCESS_KEY = 'test-secret';
process.env.S3_OBJECT_LOCK_DAYS  = '1825';
delete process.env.S3_ENDPOINT;

const storage = await import('../../src/services/storageService.js');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Devuelve el input del último PutObjectCommand capturado. */
function lastPut() {
  const puts = sentInputs.filter((c) => c.__type === 'Put');
  return puts[puts.length - 1]?.input;
}

beforeEach(() => {
  sentInputs.length = 0;
  // Estado base: AWS S3 nativo con Object Lock activo.
  delete process.env.S3_ENDPOINT;
  process.env.S3_OBJECT_LOCK_ENABLED = 'true';
});

describe('Object Lock COMPLIANCE por objeto (ASFI 5 años)', () => {

  test('comprobante pdfs/* en S3 nativo → PutObject con COMPLIANCE + retención ~5 años', async () => {
    const before = Date.now();
    await storage.uploadBuffer(Buffer.from('pdf'), 'pdfs/bolivia/BOL-202607-000001_comprobante.pdf');
    const after = Date.now();

    const input = lastPut();
    expect(input).toBeTruthy();
    expect(input.ObjectLockMode).toBe('COMPLIANCE');
    expect(input.ObjectLockRetainUntilDate).toBeInstanceOf(Date);

    const retainMs = input.ObjectLockRetainUntilDate.getTime();
    // retain-until debe caer entre (inicio + 1825d) y (fin + 1825d)
    expect(retainMs).toBeGreaterThanOrEqual(before + 1825 * DAY_MS - 5000);
    expect(retainMs).toBeLessThanOrEqual(after + 1825 * DAY_MS + 5000);

    // El cifrado en reposo se mantiene.
    expect(input.ServerSideEncryption).toBe('AES256');
  });

  test('flag OFF → sin ObjectLock (reversibilidad)', async () => {
    process.env.S3_OBJECT_LOCK_ENABLED = 'false';
    await storage.uploadBuffer(Buffer.from('pdf'), 'pdfs/bolivia/X.pdf');
    const input = lastPut();
    expect(input.ObjectLockMode).toBeUndefined();
    expect(input.ObjectLockRetainUntilDate).toBeUndefined();
  });

  test('key NO inmutable (fuera de pdfs/) → sin ObjectLock', async () => {
    await storage.uploadBuffer(Buffer.from('x'), 'assets/logo.png', { contentType: 'image/png' });
    const input = lastPut();
    expect(input.ObjectLockMode).toBeUndefined();
  });

  test('endpoint R2 → sin ObjectLock (no simular cumplimiento)', async () => {
    process.env.S3_ENDPOINT = 'https://abc.r2.cloudflarestorage.com';
    await storage.uploadBuffer(Buffer.from('pdf'), 'pdfs/bolivia/X.pdf');
    const input = lastPut();
    expect(input.ObjectLockMode).toBeUndefined();
  });
});

describe('getObjectLockStatus (verificación auditable)', () => {

  test('S3 nativo → reporta COMPLIANCE + fecha de retención', async () => {
    const st = await storage.getObjectLockStatus('s3key://pdfs/bolivia/X.pdf');
    expect(st.supported).toBe(true);
    expect(st.mode).toBe('COMPLIANCE');
    expect(st.retainUntilDate).toBeInstanceOf(Date);
    expect(st.isR2).toBe(false);
  });

  test('endpoint R2 → supported:false y nota de no-inmutabilidad', async () => {
    process.env.S3_ENDPOINT = 'https://abc.r2.cloudflarestorage.com';
    const st = await storage.getObjectLockStatus('pdfs/bolivia/X.pdf');
    expect(st.supported).toBe(false);
    expect(st.isR2).toBe(true);
    expect(st.mode).toBeNull();
  });
});
