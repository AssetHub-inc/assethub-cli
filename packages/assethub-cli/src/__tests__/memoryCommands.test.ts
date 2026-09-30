/**
 * `assethub memory memorize` and `assethub memory replay`.
 *
 * No network: every test stubs `global.fetch` and asserts on the request
 * bodies actually sent, which is the contract with a server being built in
 * parallel (see the brief this file implements). Polling loops run under
 * fake timers so the suite stays fast.
 */
import process, {stdout} from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {commandMemory} from '../index.js'

// `main`'s CLI keeps its command handlers and helper types inside `index.ts`
// rather than in `command/*.ts` + `shared.ts`, so these are declared locally to
// the shape the handler needs instead of imported. Structural typing makes that
// equivalent at the call site, and it keeps this file from depending on which
// module a type happens to live in today.
type Flags = Record<string, string | boolean | string[]>
type CommandContext = Parameters<typeof commandMemory>[2]

const auth: CommandContext['auth'] = {
  apiKey: 'test-key',
  baseUrl: 'https://api.test',
  profile: 'default',
  source: 'flag',
}

// `client` is unused by the memory commands (they talk to fetch directly),
// but `CommandContext` requires it, so a minimal stand-in keeps the type
// honest without pulling in a real `createAssetHubClient`.
const client = {} as CommandContext['client']

const makeCtx = (flags: Flags): CommandContext => ({client, flags, auth})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })

const printedValues = (): unknown[] => {
  const writeMock = stdout.write as unknown as {mock: {calls: unknown[][]}}
  return writeMock.mock.calls.map(call => JSON.parse(String(call[0])))
}

const lastPrinted = (): unknown => {
  const values = printedValues()
  return values[values.length - 1]
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/**
 * Runs `commandMemory` and drains every microtask/timer tick until it
 * settles, so a poll loop under fake timers resolves without a real delay.
 */
const runMemory = async (
  subcommand: string,
  positionals: string[],
  flags: Flags,
): Promise<void> => {
  const done = commandMemory(subcommand, positionals, makeCtx(flags))
  let settled = false
  done.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  while (!settled) {
    await vi.advanceTimersByTimeAsync(3000)
  }
  await done
}

describe('memory memorize', () => {
  it('sends a whole-canvas selection body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          memorizeJobId: 'mjob_1',
          graphId: 'graph_1',
          canvasId: 42,
          nodeIds: null,
        },
      }),
    )

    await runMemory('memorize', [], {canvas: '42'})

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/api/v2/memory/memorize')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      canvasId: 42,
      selection: {kind: 'whole'},
    })
    expect(lastPrinted()).toEqual({
      memorizeJobId: 'mjob_1',
      graphId: 'graph_1',
      canvasId: 42,
      nodeIds: null,
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('sends a nodes selection body for --nodes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          memorizeJobId: 'mjob_2',
          graphId: 'graph_1',
          canvasId: 42,
          nodeIds: ['a', 'b', 'c'],
        },
      }),
    )

    await runMemory('memorize', [], {canvas: '42', nodes: 'a, b ,c'})

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      canvasId: 42,
      selection: {kind: 'nodes', nodeIds: ['a', 'b', 'c']},
    })
  })

  it('rejects a --nodes selection over 256 ids without calling the API', async () => {
    const tooMany = Array.from(
      {length: 257},
      (_, index) => `node-${index}`,
    ).join(',')

    await expect(
      runMemory('memorize', [], {canvas: '42', nodes: tooMany}),
    ).rejects.toThrow(/at most 256/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with --wait, polls the memorize job to a terminal status', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            memorizeJobId: 'mjob_3',
            graphId: 'graph_1',
            canvasId: 42,
            nodeIds: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {memorizeJobId: 'mjob_3', status: 'running'},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {memorizeJobId: 'mjob_3', status: 'completed'},
        }),
      )

    await runMemory('memorize', [], {canvas: '42', wait: true})

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.test/api/v2/memory/memorize/mjob_3',
    )
    expect(lastPrinted()).toMatchObject({job: {status: 'completed'}})
    expect(process.exitCode).toBeUndefined()
  })
})

describe('memory replay', () => {
  const source = {source: {resourceId: 'asset_1'}}

  it('ready with a prepared memory starts, queues, and polls the run to completion', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_1',
            expiresAt: '2026-09-08T12:00:00.000Z',
            status: 'ready',
            preparedMemoryId: 'graph_a:node_a',
            candidates: [],
            steps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {status: 'queued', runId: 'run_1'},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            runId: 'run_1',
            status: 'running',
            createdAt: '2026-09-08T12:00:00.000Z',
            steps: [],
            outputs: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            runId: 'run_1',
            status: 'completed',
            createdAt: '2026-09-08T12:00:00.000Z',
            steps: [],
            outputs: [],
          },
        }),
      )

    await runMemory('replay', ['memory', 'replay', 'graph_a:node_a'], {
      source: 'asset_1',
      wait: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [matchUrl, matchInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(matchUrl).toBe('https://api.test/api/v2/memory/match')
    expect(JSON.parse(String(matchInit.body))).toEqual(source)

    const [startUrl, startInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ]
    expect(startUrl).toBe('https://api.test/api/v2/memory/start')
    expect(JSON.parse(String(startInit.body))).toEqual({
      matchId: 'match_1',
      memoryId: 'graph_a:node_a',
    })

    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://api.test/api/v2/memory/runs/run_1',
    )
    expect(lastPrinted()).toMatchObject({runId: 'run_1', status: 'completed'})
    expect(process.exitCode).toBeUndefined()
  })

  it('searching polls the match endpoint before proceeding', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_2',
            expiresAt: '2026-09-08T12:00:00.000Z',
            status: 'searching',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_2',
            expiresAt: '2026-09-08T12:00:00.000Z',
            status: 'ready',
            consumed: false,
            preparedMemoryId: 'graph_b:node_b',
            candidates: [],
            steps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {status: 'queued', runId: 'run_2'},
        }),
      )

    await runMemory('replay', ['memory', 'replay', 'graph_b:node_b'], {
      source: 'asset_1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.test/api/v2/memory/match/match_2',
    )
    expect(lastPrinted()).toEqual({status: 'queued', runId: 'run_2'})
    expect(process.exitCode).toBeUndefined()
  })

  it('ready with preparedMemoryId null reports an empty result, not an error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          matchId: 'match_3',
          expiresAt: '2026-09-08T12:00:00.000Z',
          status: 'ready',
          preparedMemoryId: null,
          candidates: [],
          steps: [],
        },
      }),
    )

    await runMemory('replay', ['memory', 'replay', 'graph_c:node_c'], {
      source: 'asset_1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastPrinted()).toMatchObject({matched: false, status: 'ready'})
    expect(process.exitCode).toBeUndefined()
  })

  it('start answering preparing with a new matchId polls it and starts again', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_4',
            expiresAt: '2026-09-08T12:00:00.000Z',
            status: 'ready',
            preparedMemoryId: 'graph_a:node_a',
            candidates: [],
            steps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            status: 'preparing',
            matchId: 'match_5',
            expiresAt: '2026-09-08T12:05:00.000Z',
            memoryId: 'graph_d:node_d',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_5',
            expiresAt: '2026-09-08T12:05:00.000Z',
            status: 'ready',
            consumed: false,
            preparedMemoryId: 'graph_d:node_d',
            candidates: [],
            steps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {status: 'queued', runId: 'run_5'},
        }),
      )

    await runMemory('replay', ['memory', 'replay', 'graph_d:node_d'], {
      source: 'asset_1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [secondStartUrl, secondStartInit] = fetchMock.mock.calls[3] as [
      string,
      RequestInit,
    ]
    expect(secondStartUrl).toBe('https://api.test/api/v2/memory/start')
    expect(JSON.parse(String(secondStartInit.body))).toEqual({
      matchId: 'match_5',
      memoryId: 'graph_d:node_d',
    })
    expect(lastPrinted()).toEqual({status: 'queued', runId: 'run_5'})
    expect(process.exitCode).toBeUndefined()
  })

  it('a match that fails reports the reason and exits 1', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          matchId: 'match_6',
          expiresAt: '2026-09-08T12:00:00.000Z',
          status: 'failed',
          reason: 'no candidate image could be indexed',
        },
      }),
    )

    await runMemory('replay', ['memory', 'replay', 'graph_e:node_e'], {
      source: 'asset_1',
    })

    expect(lastPrinted()).toEqual({
      matchId: 'match_6',
      status: 'failed',
      reason: 'no candidate image could be indexed',
    })
    expect(process.exitCode).toBe(1)
  })

  it('a run that reaches failed exits 1, distinct from a timeout which exits 3', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_7',
            expiresAt: '2026-09-08T12:00:00.000Z',
            status: 'ready',
            preparedMemoryId: 'graph_f:node_f',
            candidates: [],
            steps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {status: 'queued', runId: 'run_7'},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            runId: 'run_7',
            status: 'failed',
            createdAt: '2026-09-08T12:00:00.000Z',
            steps: [
              {
                id: 's1',
                level: 0,
                title: 'mesh',
                status: 'failed',
                outputAssetIds: [],
              },
            ],
            outputs: [],
          },
        }),
      )

    await runMemory('replay', ['memory', 'replay', 'graph_f:node_f'], {
      source: 'asset_1',
      wait: true,
    })

    expect(lastPrinted()).toMatchObject({runId: 'run_7', status: 'failed'})
    expect(process.exitCode).toBe(1)
  })

  it('a run that never terminates within --timeout exits 3, not 1', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            matchId: 'match_8',
            expiresAt: '2026-09-08T12:00:00.000Z',
            status: 'ready',
            preparedMemoryId: 'graph_g:node_g',
            candidates: [],
            steps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {status: 'queued', runId: 'run_8'},
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              runId: 'run_8',
              status: 'running',
              createdAt: '2026-09-08T12:00:00.000Z',
              steps: [],
              outputs: [],
            },
          }),
        ),
      )

    await runMemory('replay', ['memory', 'replay', 'graph_g:node_g'], {
      source: 'asset_1',
      wait: true,
      timeout: '2',
    })

    expect(lastPrinted()).toMatchObject({
      runId: 'run_8',
      status: 'running',
      timedOut: true,
    })
    expect(process.exitCode).toBe(3)
  })

  it('rejects a url source verbatim, surfacing UNSUPPORTED_SOURCE as exit 2', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        success: false,
        error: {
          code: 'UNSUPPORTED_SOURCE',
          message: 'url is not accepted here',
        },
      }),
    )

    await runMemory('replay', ['memory', 'replay', 'graph_h:node_h'], {
      source: 'https://example.com/image.png',
    })

    const [, matchInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(matchInit.body))).toEqual({
      source: {resourceId: 'https://example.com/image.png'},
    })
    expect(lastPrinted()).toMatchObject({
      error: {code: 'UNSUPPORTED_SOURCE', status: 400},
    })
    expect(process.exitCode).toBe(2)
  })
})
