/**
 * vitaTimeout.test.js
 *
 * Verifies that vitaRequest() aborts with VITA_TIMEOUT when the Vita API hangs.
 * Uses getWithdrawalRules() → GET /withdrawal_rules, which is not in ENDPOINT_TIMEOUTS
 * and therefore uses the VITA_REQUEST_TIMEOUT_MS env fallback (set to 200ms here).
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/vitaTimeout.test.js
 */

import { jest } from '@jest/globals'

// Force a short global timeout via env so the test completes in <1s.
process.env.VITA_REQUEST_TIMEOUT_MS = '200'
process.env.VITA_LOGIN     = 'test-login'
process.env.VITA_TRANS_KEY = 'test-transkey'
process.env.VITA_SECRET    = 'test-secret'
process.env.VITA_API_URL   = 'https://api.stage.vitawallet.io'

// Mock fetch that hangs but respects AbortSignal — mirrors native fetch behaviour.
global.fetch = jest.fn((url, options) => new Promise((_, reject) => {
  options?.signal?.addEventListener('abort', () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    reject(err)
  })
}))

// Import after env vars are set.
const { getWithdrawalRules } = await import('../src/services/vitaWalletService.js')

describe('vitaRequest timeout', () => {
  test('aborts with VITA_TIMEOUT when fetch never resolves', async () => {
    const start = Date.now()

    await expect(getWithdrawalRules()).rejects.toMatchObject({
      code:        'VITA_TIMEOUT',
      isTransient: true,
    })

    // /withdrawal_rules uses VITA_REQUEST_TIMEOUT_MS=200ms — finish well under 2s.
    expect(Date.now() - start).toBeLessThan(2000)
  }, 5000)

  test('timeout error message includes method and path', async () => {
    await expect(getWithdrawalRules()).rejects.toThrow(
      /Vita API timeout after \d+ms for GET \/withdrawal_rules/,
    )
  }, 5000)
})
