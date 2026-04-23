/**
 * owlPayService.test.js
 *
 * Tests for the clean v2 exports: createQuote, getRequirementsSchema,
 * createTransfer, getTransferStatus, verifyWebhookSignature,
 * and the timeout/abort behavior of owlPayRequest.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/owlPayService.test.js
 */

import { jest } from '@jest/globals';
import crypto   from 'crypto';

// Set required env vars before importing the module
process.env.OWLPAY_API_KEY        = 'test-api-key';
process.env.OWLPAY_BASE_URL       = 'https://harbor-sandbox.owlpay.com/api';
process.env.OWLPAY_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.OWLPAY_SOURCE_CHAIN   = 'stellar';

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockFetchOk(body) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve(body),
    }),
  );
}

function mockFetchError(status, body) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok:     false,
      status,
      json:   () => Promise.resolve(body),
    }),
  );
}

function mockFetchHang() {
  global.fetch = jest.fn((url, options) =>
    new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const err  = new Error('The operation was aborted');
        err.name   = 'AbortError';
        reject(err);
      });
    }),
  );
}

// ─── Import module after env vars are set ────────────────────────────────────
const {
  createQuote,
  getRequirementsSchema,
  createTransfer,
  getTransferStatus,
  verifyWebhookSignature,
} = await import('../src/services/owlPayService.js');

// ─── createQuote ─────────────────────────────────────────────────────────────

describe('createQuote', () => {
  test('sends correct POST body', async () => {
    mockFetchOk({ data: [{ id: 'q-123' }] });

    await createQuote({
      source_amount:        100,
      destination_country:  'CN',
      destination_currency: 'CNY',
      customer_uuid:        'cust-uuid-001',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/v2/transfers/quotes');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.source_amount).toBe(100);
    expect(body.destination_country).toBe('CN');
    expect(body.destination_currency).toBe('CNY');
    expect(body.source_currency).toBe('USD');
    expect(body.customer_uuid).toBe('cust-uuid-001');
    expect(body.source_chain).toBe('stellar');
  });

  test('throws if source_amount is zero', async () => {
    await expect(createQuote({
      source_amount:        0,
      destination_country:  'CN',
      destination_currency: 'CNY',
      customer_uuid:        'cust-uuid-001',
    })).rejects.toThrow('source_amount must be positive');
  });

  test('throws if destination_country is missing', async () => {
    await expect(createQuote({
      source_amount:        100,
      destination_currency: 'CNY',
      customer_uuid:        'cust-uuid-001',
    })).rejects.toThrow('destination_country and destination_currency required');
  });

  test('throws if customer_uuid is missing', async () => {
    await expect(createQuote({
      source_amount:        100,
      destination_country:  'CN',
      destination_currency: 'CNY',
    })).rejects.toThrow('customer_uuid required');
  });
});

// ─── getRequirementsSchema ────────────────────────────────────────────────────

describe('getRequirementsSchema', () => {
  beforeEach(() => {
    if (global.fetch) global.fetch.mockReset();
  });

  test('throws if quoteId is missing', async () => {
    await expect(getRequirementsSchema(null)).rejects.toThrow('quoteId required');
  });

  test('fetches schema on first call', async () => {
    const schema = { schema: { type: 'object' } };
    mockFetchOk(schema);

    const result = await getRequirementsSchema('q-fresh-001');
    expect(result).toEqual(schema);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('returns cached value on second call without re-fetching', async () => {
    const schema = { schema: { type: 'object', properties: { name: {} } } };
    mockFetchOk(schema);

    await getRequirementsSchema('q-cache-001');
    const second = await getRequirementsSchema('q-cache-001');
    expect(second).toEqual(schema);
    expect(global.fetch).toHaveBeenCalledTimes(1); // still only 1 fetch
  });
});

// ─── createTransfer ───────────────────────────────────────────────────────────

describe('createTransfer', () => {
  beforeEach(() => {
    if (global.fetch) global.fetch.mockReset();
  });

  test('sends correct payload shape', async () => {
    mockFetchOk({ uuid: 't-123', status: 'pending' });

    await createTransfer({
      quote_id:           'q-abc',
      beneficiary:        { name: 'John Doe', account: '123456' },
      external_reference: 'ALY-C-1234-NANO',
    });

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/v2/transfers');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.quote_id).toBe('q-abc');
    expect(body.external_reference).toBe('ALY-C-1234-NANO');
  });

  test('throws if quote_id is missing', async () => {
    await expect(createTransfer({
      beneficiary:        {},
      external_reference: 'ref',
    })).rejects.toThrow('quote_id required');
  });

  test('throws if beneficiary is missing', async () => {
    await expect(createTransfer({
      quote_id:           'q-1',
      external_reference: 'ref',
    })).rejects.toThrow('beneficiary required');
  });

  test('throws if external_reference is missing', async () => {
    await expect(createTransfer({
      quote_id:    'q-1',
      beneficiary: {},
    })).rejects.toThrow('external_reference required');
  });
});

// ─── getTransferStatus ────────────────────────────────────────────────────────

describe('getTransferStatus', () => {
  test('calls correct endpoint', async () => {
    mockFetchOk({ uuid: 't-abc', status: 'completed' });

    const result = await getTransferStatus('t-abc');
    expect(result).toEqual({ uuid: 't-abc', status: 'completed' });
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/v2/transfers/t-abc');
  });

  test('throws if transferId is missing', async () => {
    await expect(getTransferStatus(null)).rejects.toThrow('transferId required');
  });
});

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  const secret  = 'test-webhook-secret';
  const payload = Buffer.from('{"event":"transfer.completed"}');

  function makeSignature(buf) {
    return crypto.createHmac('sha256', secret).update(buf).digest('hex');
  }

  test('returns true for valid signature', () => {
    const sig    = makeSignature(payload);
    expect(verifyWebhookSignature(payload, sig)).toBe(true);
  });

  test('returns false for tampered signature', () => {
    const sig    = makeSignature(payload);
    const tampered = sig.slice(0, -2) + 'ff';
    expect(verifyWebhookSignature(payload, tampered)).toBe(false);
  });

  test('returns false when OWLPAY_WEBHOOK_SECRET is missing', () => {
    const original = process.env.OWLPAY_WEBHOOK_SECRET;
    delete process.env.OWLPAY_WEBHOOK_SECRET;
    expect(verifyWebhookSignature(payload, makeSignature(payload))).toBe(false);
    process.env.OWLPAY_WEBHOOK_SECRET = original;
  });

  test('returns false for null/undefined signature', () => {
    expect(verifyWebhookSignature(payload, null)).toBe(false);
    expect(verifyWebhookSignature(payload, undefined)).toBe(false);
  });

  test('returns false when buffer lengths differ (padding attack)', () => {
    const shortSig = 'aabb';
    expect(verifyWebhookSignature(payload, shortSig)).toBe(false);
  });
});

// ─── Timeout / AbortController ────────────────────────────────────────────────

describe('owlPayRequest timeout', () => {
  test('aborts with OWLPAY_TIMEOUT when fetch never resolves', async () => {
    mockFetchHang();

    const start = Date.now();
    await expect(
      createQuote({
        source_amount:        100,
        destination_country:  'CN',
        destination_currency: 'CNY',
        customer_uuid:        'cust-001',
      }),
    ).rejects.toMatchObject({ code: 'OWLPAY_TIMEOUT', isTransient: true });

    expect(Date.now() - start).toBeLessThan(15000);
  }, 20000);

  test('timeout error message includes endpoint', async () => {
    mockFetchHang();

    await expect(
      createQuote({
        source_amount:        50,
        destination_country:  'NG',
        destination_currency: 'NGN',
        customer_uuid:        'cust-001',
      }),
    ).rejects.toThrow(/OwlPay API timeout after \d+ms for POST \/v2\/transfers\/quotes/);
  }, 20000);
});
