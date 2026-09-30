import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const RESULT = {
  orderId: 'ord-1',
  graphId: 'ord-1',
  resumeCount: 1,
  epoch: 1,
  resetRuns: 0,
  alreadyResumed: false,
}

describe('production resume', () => {
  it('posts the expected resume count to the order resume route', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({success: true, data: RESULT}), {
          headers: {'content-type': 'application/json'},
        }),
    )
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })

    await expect(
      client.v2.resumeProduction('ord 1', {expectedResumeCount: 0}),
    ).resolves.toEqual(RESULT)
    await client.v2.resumeProduction('ord-1')

    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe('https://api.test/api/v2/production/ord%201/resume')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({expectedResumeCount: 0})
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).toEqual({})
  })
})
