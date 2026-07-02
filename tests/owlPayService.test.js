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

    // Contrato Harbor v2 real: body anidado source/destination + on_behalf_of
    // (siempre el UUID de AV Finance LLC — MSA 30/03/2026).
    const body = JSON.parse(opts.body);
    expect(body.source).toMatchObject({
      type:    'business',
      chain:   'stellar',
      country: 'US',
      asset:   'USDC',
      amount:  '100.00',        // Number(source_amount).toFixed(2)
    });
    expect(body.destination).toMatchObject({
      type:    'individual',
      country: 'CN',
      asset:   'CNY',
    });
    expect(body.on_behalf_of).toBe('cust-uuid-001');
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

  // Contrato actual (Harbor Transfer v2): quote_id + on_behalf_of (UUID LLC) +
  // application_transfer_uuid (idempotencia, reemplaza external_reference) +
  // source_address (wallet Stellar SRL) + beneficiary_info + payout_instrument.
  const validParams = {
    quote_id:                  'q-abc',
    on_behalf_of:              'cust-uuid-001',
    application_transfer_uuid: 'ALY-C-1234-NANO',
    source_address:            'GA7BUSWQTESTSRLPUBLICKEY',
    beneficiary_info: {
      beneficiary_name:    'John Doe',
      beneficiary_address: {
        street: 'Av. Siempre Viva 123', city: 'Shanghai',
        state_province: 'Shanghai', postal_code: '200120', country: 'CN',
      },
    },
    payout_instrument: { account_number: '123456', swift_code: 'CCBKCNBJ' },
  };

  test('sends correct payload shape', async () => {
    mockFetchOk({ uuid: 't-123', status: 'pending' });

    await createTransfer(validParams);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/v2/transfers');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.quote_id).toBe('q-abc');
    expect(body.on_behalf_of).toBe('cust-uuid-001');
    expect(body.application_transfer_uuid).toBe('ALY-C-1234-NANO');
    expect(body.source).toEqual({
      payment_instrument: { address: 'GA7BUSWQTESTSRLPUBLICKEY' },
    });
    expect(body.destination).toMatchObject({
      beneficiary_info:  validParams.beneficiary_info,
      payout_instrument: validParams.payout_instrument,
      transfer_purpose:  'FAMILY_MAINTENANCE',   // default
      is_self_transfer:  false,                  // default
    });
  });

  test('throws if quote_id is missing', async () => {
    const { quote_id, ...rest } = validParams;
    await expect(createTransfer(rest)).rejects.toThrow('quote_id required');
  });

  test('throws if on_behalf_of is missing', async () => {
    const { on_behalf_of, ...rest } = validParams;
    await expect(createTransfer(rest)).rejects.toThrow('on_behalf_of required');
  });

  test('throws if application_transfer_uuid is missing', async () => {
    const { application_transfer_uuid, ...rest } = validParams;
    await expect(createTransfer(rest)).rejects.toThrow('application_transfer_uuid required');
  });

  test('throws if source_address is missing', async () => {
    const { source_address, ...rest } = validParams;
    await expect(createTransfer(rest)).rejects.toThrow('source_address required');
  });

  test('throws if beneficiary_info is missing', async () => {
    const { beneficiary_info, ...rest } = validParams;
    await expect(createTransfer(rest)).rejects.toThrow('beneficiary_info required');
  });

  test('throws if payout_instrument is missing', async () => {
    const { payout_instrument, ...rest } = validParams;
    await expect(createTransfer(rest)).rejects.toThrow('payout_instrument required');
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

  // Formato real del header harbor-signature: "t=<unix_ts>,v1=<hmac_hex>"
  // signed_payload = "<timestamp>.<rawBody>". Tolerancia anti-replay: 60s.
  function makeHeader(buf, ts = Math.floor(Date.now() / 1000)) {
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${ts}.${buf.toString('utf8')}`)
      .digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  test('returns true for valid signature', () => {
    expect(verifyWebhookSignature(payload, makeHeader(payload))).toBe(true);
  });

  test('returns false for tampered signature', () => {
    const header   = makeHeader(payload);
    const tampered = header.slice(0, -2) + 'ff';
    expect(verifyWebhookSignature(payload, tampered)).toBe(false);
  });

  test('returns false when timestamp is outside the 60s anti-replay window', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 120;   // 2 min atrás
    expect(verifyWebhookSignature(payload, makeHeader(payload, staleTs))).toBe(false);
  });

  test('returns false for legacy header without t=/v1= format', () => {
    const bareHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyWebhookSignature(payload, bareHmac)).toBe(false);
  });

  test('returns false when OWLPAY_WEBHOOK_SECRET is missing', () => {
    const original = process.env.OWLPAY_WEBHOOK_SECRET;
    delete process.env.OWLPAY_WEBHOOK_SECRET;
    expect(verifyWebhookSignature(payload, makeHeader(payload))).toBe(false);
    process.env.OWLPAY_WEBHOOK_SECRET = original;
  });

  test('returns false for null/undefined signature', () => {
    expect(verifyWebhookSignature(payload, null)).toBe(false);
    expect(verifyWebhookSignature(payload, undefined)).toBe(false);
  });

  test('returns false when buffer lengths differ (padding attack)', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(payload, `t=${ts},v1=aabb`)).toBe(false);
  });
});

// ─── Timeout / AbortController ────────────────────────────────────────────────

describe('owlPayRequest timeout', () => {
  // Fake timers: el timeout real de createQuote es 10s — avanzamos el reloj
  // en lugar de esperar, para que la suite no tarde 20s.
  afterEach(() => {
    jest.useRealTimers();
  });

  test('aborts with OWLPAY_TIMEOUT when fetch never resolves', async () => {
    jest.useFakeTimers();
    mockFetchHang();

    const promise = createQuote({
      source_amount:        100,
      destination_country:  'CN',
      destination_currency: 'CNY',
      customer_uuid:        'cust-001',
    });
    const assertion = expect(promise).rejects.toMatchObject({
      code:        'OWLPAY_TIMEOUT',
      isTransient: true,
    });

    await jest.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  test('timeout error message includes endpoint', async () => {
    jest.useFakeTimers();
    mockFetchHang();

    const promise = createQuote({
      source_amount:        50,
      destination_country:  'NG',
      destination_currency: 'NGN',
      customer_uuid:        'cust-001',
    });
    const assertion = expect(promise).rejects.toThrow(
      /OwlPay API timeout after \d+ms for POST \/v2\/transfers\/quotes/,
    );

    await jest.advanceTimersByTimeAsync(10_001);
    await assertion;
  });
});
