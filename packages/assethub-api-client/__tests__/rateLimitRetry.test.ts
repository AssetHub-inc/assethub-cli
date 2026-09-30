import {afterEach, expect, it, vi} from 'vitest'
import {AssetHubApiError, createAssetHubClient, rateLimitDelayMs} from '../src/index'

afterEach(() => vi.useRealTimers())

const limited = (retryAfter: string) =>
  new Response(JSON.stringify({success: false, error: {code: 'RATE_LIMITED', message: 'Rate limit exceeded.'}}), {
    status: 429,
    headers: {'content-type': 'application/json', 'Retry-After': retryAfter},
  })
const ok = () =>
  new Response(JSON.stringify({success: true, data: {agents: []}}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

// @testdoc A rate-limited GET (status polling) waits for Retry-After and retries instead of failing the command.
it('retries a rate-limited GET after Retry-After', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(limited('2')).mockResolvedValueOnce(ok())
  const client = createAssetHubClient({apiKey: 'k', fetch: fetcher})
  const pending = client.v1.getProductionAgents()
  await vi.advanceTimersByTimeAsync(2_300)
  await expect(pending).resolves.toEqual({agents: []})
  expect(fetcher).toHaveBeenCalledTimes(2)
})

// @testdoc A rate-limited POST is not replayed by the client: the caller owns idempotency.
it('does not retry a rate-limited POST', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(limited('1'))
  const client = createAssetHubClient({apiKey: 'k', fetch: fetcher})
  await expect(
    client.v1.analyzeProduction({agentVersion: 'V2.1-beta'} as never),
  ).rejects.toBeInstanceOf(AssetHubApiError)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

// @testdoc Persistent rate limiting still surfaces as an error after the bounded retries.
it('gives up after bounded retries', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => limited('1'))
  const client = createAssetHubClient({apiKey: 'k', fetch: fetcher})
  const pending = client.v1.getProductionAgents().catch(error => error)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await pending).toBeInstanceOf(AssetHubApiError)
  expect(fetcher).toHaveBeenCalledTimes(6)
})

it('caps and defaults the wait', () => {
  expect(rateLimitDelayMs('6', 1)).toBe(6_250)
  expect(rateLimitDelayMs('999', 1)).toBe(60_000)
  expect(rateLimitDelayMs(null, 3)).toBe(8_250)
})
