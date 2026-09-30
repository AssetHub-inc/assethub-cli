import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    headers: {'content-type': 'application/json'},
  })

describe('memorized-graph read API', () => {
  it('encodes the snapshot, node, image, and canvas graph-id requests', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ok({
          graphId: 'graph/1',
          lastRev: 3,
          nodeCount: 1,
          edgeCount: 0,
          nodes: [],
          nextOffset: null,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          graphId: 'graph/1',
          id: 'node/1',
          artifactKind: 'text',
          tags: [],
          metadata: {title: 't'},
          payload: 'hello',
          edges: {incoming: [], outgoing: []},
        }),
      )
      .mockResolvedValueOnce(
        ok({
          mediaType: 'image/png',
          data: 'abc',
          bytes: 2,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          canvasId: 40516,
          memorizeGraphId: 'mem-1',
          memorizeSnapshotExists: true,
          exportGraphId: 'exp-1',
          exportSnapshotExists: false,
        }),
      )
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })

    await client.v2.getGraphSnapshot('graph/1', {offset: 10, limit: 20})
    await client.v2.getGraphNode('graph/1', 'node/1')
    await client.v2.getGraphNodeImage('graph/1', 'node/1')
    await client.v2.getCanvasGraphIds(40516)

    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/v2/graphs/graph%2F1/snapshot?offset=10&limit=20',
    )
    expect(String(request.mock.calls[1]?.[0])).toBe(
      'https://api.test/api/v2/graphs/graph%2F1/nodes/node%2F1',
    )
    expect(String(request.mock.calls[2]?.[0])).toBe(
      'https://api.test/api/v2/graphs/graph%2F1/nodes/node%2F1/image',
    )
    expect(String(request.mock.calls[3]?.[0])).toBe(
      'https://api.test/api/v2/canvases/40516/graph-id',
    )
  })
})
