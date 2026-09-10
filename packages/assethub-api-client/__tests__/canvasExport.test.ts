import {expect, test, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

test('exports an owned canvas with an optional actual mesh lineage filter', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            schemaVersion: 'assethub.canvas-export.v1',
            assets: [],
            steps: [],
          },
        }),
        {headers: {'content-type': 'application/json'}},
      ),
    )
  const client = createAssetHubClient({apiKey: 'test-key', fetch: fetcher})
  const result = await client.v2.exportCanvas(42, {mesh: 'mesh_18'})
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    'https://app.assethub.io/api/v2/canvases/42/export?mesh=mesh_18',
  )
  expect(fetcher.mock.calls[0]![1]?.method).toBe('GET')
  expect(result.schemaVersion).toBe('assethub.canvas-export.v1')
})
