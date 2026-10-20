import {stdout} from 'node:process'
import {describe, expect, it} from 'vitest'

import {buildGraphTimeline} from '../graphTimeline.js'
import {commandGraph} from '../index.js'

const node = (tags: string[], timing?: Record<string, unknown>) => ({
  tags,
  metadata: timing ? {timing} : {},
})

describe('buildGraphTimeline', () => {
  it('groups by stage tag with first start, last completion, sum and max', () => {
    const out = buildGraphTimeline([
      node(['stage:mesh'], {
        createdAt: '2026-10-16T00:00:00.000Z',
        startedAt: '2026-10-16T00:00:02.000Z',
        completedAt: '2026-10-16T00:00:10.000Z',
        durationMs: 8000,
      }),
      node(['stage:mesh', 'x'], {
        createdAt: '2026-10-16T00:00:01.000Z',
        startedAt: null,
        completedAt: '2026-10-16T00:00:20.000Z',
        durationMs: 19000,
      }),
      node(['stage:plan'], {
        createdAt: '2026-10-15T23:59:00.000Z',
        startedAt: null,
        completedAt: null,
        durationMs: null,
      }),
      node(['stage:plan']),
      node(['other'], {createdAt: '2026-10-16T00:00:00.000Z'}),
    ])
    expect(out.unstagedNodes).toBe(1)
    expect(out.untimedNodes).toBe(1)
    expect(out.stages.map(s => s.stage)).toEqual(['stage:plan', 'stage:mesh'])
    expect(out.stages[1]).toEqual({
      stage: 'stage:mesh',
      nodes: 2,
      timedNodes: 2,
      firstStartedAt: '2026-10-16T00:00:01.000Z',
      lastCompletedAt: '2026-10-16T00:00:20.000Z',
      wallMs: 19000,
      sumDurationMs: 27000,
      maxDurationMs: 19000,
    })
    expect(out.stages[0]).toMatchObject({
      nodes: 2,
      timedNodes: 1,
      lastCompletedAt: null,
      wallMs: null,
      maxDurationMs: null,
    })
  })
})

describe('graph timeline command', () => {
  it('prints the timeline for --graph and export keeps metadata.timing', async () => {
    const graph = {
      graphId: 'g1',
      source: 'generated',
      revision: 'r',
      lastRev: 1,
      nodes: [
        {
          id: 'n1',
          tags: ['stage:mesh'],
          metadata: {
            timing: {
              createdAt: '2026-10-16T00:00:00.000Z',
              startedAt: '2026-10-16T00:00:01.000Z',
              completedAt: '2026-10-16T00:00:03.000Z',
              durationMs: 2000,
            },
          },
        },
      ],
      edges: [],
      nextCursor: null,
      truncated: false,
    }
    const ctx = {
      client: {v2: {getGraph: async () => graph}},
      flags: {graph: 'g1'},
      auth: {
        apiKey: 'k',
        baseUrl: 'https://api.test',
        profile: 'default',
        source: 'flag',
      },
      args: [],
    } as never
    const printed: string[] = []
    const original = stdout.write.bind(stdout)
    stdout.write = ((chunk: unknown) => {
      printed.push(String(chunk))
      return true
    }) as typeof stdout.write
    try {
      await commandGraph('timeline', ['graph', 'timeline'], ctx)
      await commandGraph('export', ['graph', 'export'], ctx)
    } finally {
      stdout.write = original
    }
    const timeline = JSON.parse(printed[0])
    expect(timeline.graphId).toBe('g1')
    expect(timeline.stages[0]).toMatchObject({
      stage: 'stage:mesh',
      sumDurationMs: 2000,
    })
    expect(JSON.parse(printed[1]).nodes[0].metadata.timing.durationMs).toBe(
      2000,
    )
  })
})
