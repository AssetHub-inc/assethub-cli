import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    headers: {'content-type': 'application/json'},
  })

const links = {
  skillId: 'clean/silhouette',
  revision: 4,
  contentSha256: 'a'.repeat(64),
  workflowRef: null,
  evidence: [
    {
      key: 'ev-1',
      kind: 'workspace_image',
      graphId: 'graph-1',
      artifactId: 'node-1',
      contentSha256: 'b'.repeat(64),
      sourceRevision: 3,
      decisionKind: 'artist_approved',
      status: 'resolved' as const,
      memoryId: 'graph-1:node-1',
      node: {
        id: 'node-1',
        artifactKind: 'image',
        tags: [],
        hasImage: true,
      },
    },
  ],
  references: [
    {
      kind: 'canvas_graph' as const,
      canvasId: 40516,
      graphId: 'graph-1',
      sourceRevision: 118,
      why: 'the silhouette pass',
      nodes: [
        {
          nodeId: 'node-2',
          status: 'resolved' as const,
          memoryId: 'graph-1:node-2',
        },
      ],
    },
  ],
  counts: {total: 2, resolved: 2, unresolved: 0},
  truncated: false,
}

describe('skill memory links API', () => {
  it('encodes the skill id and omits an absent revision', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(ok(links))
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })

    await client.v2.getSkillMemoryLinks('clean/silhouette')

    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/v2/workspace-skills/clean%2Fsilhouette/memory',
    )
  })

  it('passes a revision through as a query parameter', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(ok(links))
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })

    await client.v2.getSkillMemoryLinks('skill-1', {revision: 2})

    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/v2/workspace-skills/skill-1/memory?revision=2',
    )
  })

  it('returns the memoryId a replay takes, unchanged', async () => {
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(ok(links)),
    })

    const result = await client.v2.getSkillMemoryLinks('skill-1')

    expect(result.evidence[0]?.memoryId).toBe('graph-1:node-1')
    // A built skill's provenance comes back here, and both sides are counted.
    expect(result.references[0]?.nodes[0]?.memoryId).toBe('graph-1:node-2')
    expect(result.counts).toEqual({total: 2, resolved: 2, unresolved: 0})
  })
})
