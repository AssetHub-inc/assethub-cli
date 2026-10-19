import {createAssetHubClient} from '@assethub/api-client'
import {describe, expect, it, vi} from 'vitest'
import {
  runModelRoutingCommand,
  routingComparisonExitCode,
} from '../modelRouting.js'

const id = '42608b89-cc07-4a6b-a065-d1716b23bba0'
const input = {
  id,
  role: 'prompt',
  baselineModel: 'old',
  candidateModel: 'new',
  prompt: 'Same input',
}
const setup = (models: Record<string, string> = {prompt: 'new'}) => {
  const calls: {path: string; body?: unknown}[] = []
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(
        JSON.stringify({
          success: true,
          data:
            path.endsWith('/routing') && !init?.body
              ? {
                  state: {
                    revision: 'r2',
                    models,
                    previousModels: {prompt: 'old'},
                  },
                  presets: {
                    deepseek: {prompt: 'candidate', final_judge: 'judge'},
                  },
                  roles: {prompt: {}, final_judge: {}},
                  creditPlans: {text: 2, vision: 4},
                }
              : {
                  id,
                  arms: [
                    {id: 'baseline', status: 'failed'},
                    {id: 'candidate', status: 'uncertain'},
                  ],
                },
        }),
      )
    },
  )
  const client = createAssetHubClient({
    baseUrl: 'https://api.test',
    apiKey: 'test-key',
    fetch,
  })
  return {client, calls, fetch}
}

describe('Internal model routing CLI', () => {
  // @testdoc Rollback uses the fetched revision and previous profile so concurrent edits are rejected by server CAS.
  it('restores exactly the previous models with the fetched revision', async () => {
    const {client, calls} = setup()
    await runModelRoutingCommand({client, command: 'rollback'})
    expect(calls).toEqual([
      {path: '/api/v2/models/routing', body: undefined},
      {
        path: '/api/v2/models/routing',
        body: {expectedRevision: 'r2', models: {prompt: 'old'}},
      },
    ])
  })

  // @testdoc A caller-provided comparison UUID remains unchanged and failures stay visible without applying routing.
  it('displays two-arm native credits before one paid submission, without applying or retrying', async () => {
    const {client, calls} = setup()
    const beforeSubmit = vi.fn(() => expect(calls).toHaveLength(1))
    const result = await runModelRoutingCommand({
      client,
      command: 'compare',
      input,
      beforeSubmit,
    })
    expect(beforeSubmit).toHaveBeenCalledWith({id, credits: 2})
    expect(calls).toEqual([
      {path: '/api/v2/models/routing', body: undefined},
      {path: '/api/v2/models/comparisons', body: input},
    ])
    expect(result).toMatchObject({
      id,
      arms: [{status: 'failed'}, {status: 'uncertain'}],
    })
  })

  // @testdoc Missing comparison identity is rejected before any provider request so an uncertain command cannot mint a fresh paid run.
  it('requires the comparison ID to be persisted in the input JSON before submitting', async () => {
    const {client, calls} = setup()
    await expect(
      runModelRoutingCommand({
        client,
        command: 'compare',
        input: {...input, id: undefined},
      }),
    ).rejects.toThrow('UUID')
    expect(calls).toEqual([])
  })

  // @testdoc Retrieval is one owner-scoped read and never starts another paid comparison.
  it('retrieves a comparison without POST or polling', async () => {
    const {client, calls} = setup()
    await runModelRoutingCommand({client, command: 'comparison', id})
    expect(calls).toEqual([
      {path: `/api/v2/models/comparisons/${id}`, body: undefined},
    ])
  })

  // @testdoc A failed provider submission is surfaced once and reuses the input identity for an explicit resume.
  it('does not retry an uncertain POST', async () => {
    const {client, calls, fetch} = setup()
    fetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {creditPlans: {text: 2, vision: 4}},
          }),
        ),
    )
    fetch.mockImplementationOnce(async () => {
      throw new Error('network uncertain')
    })
    await expect(
      runModelRoutingCommand({client, command: 'compare', input}),
    ).rejects.toMatchObject({exitCode: 3, message: expect.stringContaining(id)})
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(0)
  })
})

// @testdoc A slow comparison may use the full 250-second server deadline; the CLI must wait longer without retrying paid work or lengthening config mutations.
it('waits beyond the comparison server deadline only for comparison submission', async () => {
  const {client, calls} = setup()
  const deadline = vi.spyOn(AbortSignal, 'timeout')
  try {
    await runModelRoutingCommand({client, command: 'compare', input})
    expect(deadline.mock.calls.at(-1)?.[0]).toBeGreaterThan(250_000)
    expect(
      calls.filter(call => call.path === '/api/v2/models/comparisons'),
    ).toHaveLength(1)
    await runModelRoutingCommand({
      client,
      command: 'apply',
      input: {expectedRevision: 'r2', models: {prompt: 'new'}},
    })
    expect(deadline).toHaveBeenLastCalledWith(120_000)
  } finally {
    deadline.mockRestore()
  }
})

// @testdoc Preset adoption uses the server-owned model map and a current revision, never a CLI model manifest.
it('applies the discovered preset with CAS', async () => {
  const {client, calls} = setup()
  await runModelRoutingCommand({client, command: 'apply', preset: 'deepseek'})
  expect(calls).toHaveLength(2)
  expect(calls[1]?.body).toEqual({
    expectedRevision: 'r2',
    models: {prompt: 'candidate', final_judge: 'judge'},
  })
})

// @testdoc Text preset adoption retains the independent global image default in preview and mutation, using one current routing read.
it.each([false, true])(
  'preserves the image default when applying a text preset, dryRun=%s',
  async dryRun => {
    const imageDefault = 'google/gemini-3.1-flash-image'
    const {client, calls} = setup({prompt: 'new', image_default: imageDefault})
    const result = await runModelRoutingCommand({
      client, command: 'apply', preset: 'deepseek', dryRun,
    })
    const update = {
      expectedRevision: 'r2',
      models: {prompt: 'candidate', final_judge: 'judge', image_default: imageDefault},
    }
    if (dryRun) {
      expect(result).toEqual(update)
      expect(calls).toHaveLength(1)
    } else {
      expect(calls).toHaveLength(2)
      expect(calls[1]?.body).toEqual(update)
    }
  },
)

// @testdoc Editing one role retains every other selected role, including the independent judge.
it('sets or clears a role without replacing the rest of the profile', async () => {
  const {client, calls} = setup()
  await runModelRoutingCommand({
    client,
    command: 'set',
    role: 'final_judge',
    model: 'judge',
  })
  expect(calls[1]?.body).toEqual({
    expectedRevision: 'r2',
    models: {prompt: 'new', final_judge: 'judge'},
  })
  await runModelRoutingCommand({
    client,
    command: 'set',
    role: 'prompt',
    model: 'default',
  })
  expect(calls[3]?.body).toEqual({expectedRevision: 'r2', models: {}})
})

// @testdoc An unchanged selection is read-only so running a development command twice does not erase rollback history.
it('preserves rollback history when the selected role is already current', async () => {
  const {client, calls} = setup()
  await runModelRoutingCommand({
    client,
    command: 'set',
    role: 'prompt',
    model: 'new',
  })
  expect(calls).toHaveLength(1)
})

// @testdoc Preview emits the exact CAS payload without mutation, while bad selections fail before any write.
it('previews legacy restoration and rejects unknown or conflicting selections', async () => {
  const {client, calls} = setup()
  expect(
    await runModelRoutingCommand({
      client,
      command: 'apply',
      preset: 'legacy',
      dryRun: true,
    }),
  ).toEqual({expectedRevision: 'r2', models: {}})
  await expect(
    runModelRoutingCommand({client, command: 'apply', preset: 'typo'}),
  ).rejects.toThrow('Unknown preset')
  await expect(
    runModelRoutingCommand({
      client,
      command: 'set',
      role: 'typo',
      model: 'new',
    }),
  ).rejects.toThrow('roles:')
  await expect(
    runModelRoutingCommand({
      client,
      command: 'apply',
      preset: 'deepseek',
      input: {models: {}},
    }),
  ).rejects.toThrow('exactly one')
  await expect(
    runModelRoutingCommand({client, command: 'compare', input, dryRun: true}),
  ).rejects.toThrow('--dry-run')
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call.body === undefined)).toBe(true)
})

// @testdoc A stale-revision response is surfaced once; the CLI must not refetch and overwrite the other operator's selection.
it('does not retry a conflicting routing change', async () => {
  const {client, fetch} = setup()
  fetch.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            state: {revision: 'r2', models: {}, previousModels: null},
            presets: {deepseek: {prompt: 'candidate'}},
            roles: {prompt: {}},
          },
        }),
      ),
  )
  fetch.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'ROUTING_REVISION_CONFLICT',
            message: 'Reload before applying',
          },
        }),
        {status: 409},
      ),
  )
  await expect(
    runModelRoutingCommand({client, command: 'apply', preset: 'deepseek'}),
  ).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(2)
})

// @testdoc Development checks distinguish provider completion from failure or uncertainty, with uncertainty taking priority.
it('returns machine-readable comparison exit codes without inferring quality approval', () => {
  const receipt = (...statuses: string[]) => ({
    arms: statuses.map(status => ({status})),
  })
  expect(routingComparisonExitCode(receipt('succeeded', 'succeeded'))).toBe(0)
  expect(routingComparisonExitCode(receipt('failed', 'succeeded'))).toBe(1)
  expect(routingComparisonExitCode(receipt('failed', 'uncertain'))).toBe(3)
  expect(routingComparisonExitCode(receipt('running', 'succeeded'))).toBe(3)
  expect(routingComparisonExitCode(receipt('unknown', 'succeeded'))).toBe(3)
  expect(() => routingComparisonExitCode({arms: []})).toThrow('two arms')
})

// @testdoc Only ambiguous paid-submit outcomes become exit 3; definite auth/admission rejection remains a normal API error.
it.each([400, 401, 409, 429, 500, 408])(
  'classifies comparison HTTP %s without another provider submission',
  async status => {
    const {client, fetch} = setup()
    fetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {creditPlans: {text: 2, vision: 4}},
          }),
        ),
    )
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: {code: 'AGENT_OWNER_LIMIT_EXCEEDED', message: 'Rejected'},
          }),
          {status},
        ),
    )
    await expect(
      runModelRoutingCommand({client, command: 'compare', input}),
    ).rejects.toMatchObject(
      status >= 500 || status === 408 ? {exitCode: 3} : {status},
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  },
)
