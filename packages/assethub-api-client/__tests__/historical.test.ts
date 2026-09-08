import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    headers: {'content-type': 'application/json'},
  })

describe('historical graph and mesh API', () => {
  it('encodes mesh search and graph read options', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ok({items: [{assetId: 'mesh-1', name: 'Chair'}], nextCursor: 'next'}),
      )
      .mockResolvedValueOnce(
        ok({items: [{graphId: 'graph-1', source: 'upload'}], nextCursor: null}),
      )
      .mockResolvedValueOnce(
        ok({
          graphId: 'graph/id',
          source: 'upload',
          revision: 'rev-4',
          lastRev: 4,
          nodes: [],
          edges: [],
          nextCursor: null,
          truncated: false,
        }),
      )
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })

    await client.v2.listMeshes({
      query: 'chair & shell',
      cursor: 'cursor/+==',
      limit: 10,
    })
    await client.v2.listGraphs({cursor: 'graph cursor', limit: 20})
    await client.v2.getGraph('graph/id', {
      source: 'upload',
      artifactId: 'node/1',
      direction: 'ancestors',
      depth: 2,
    })

    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/v2/meshes?q=chair+%26+shell&cursor=cursor%2F%2B%3D%3D&limit=10',
    )
    expect(String(request.mock.calls[1]?.[0])).toBe(
      'https://api.test/api/v2/graphs?cursor=graph+cursor&limit=20',
    )
    expect(String(request.mock.calls[2]?.[0])).toBe(
      'https://api.test/api/v2/graphs/graph%2Fid?source=upload&artifactId=node%2F1&direction=ancestors&depth=2',
    )
  })
})
