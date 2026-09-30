import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'
import type {CanvasExecution, MeshRefineRequest} from '@assethub/api-client'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

const bodyOf = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  let text = ''
  for await (const chunk of request) text += chunk
  return JSON.parse(text) as Record<string, unknown>
}

const runCli = (baseUrl: string, stateDir: string, args: string[]) =>
  new Promise<{
    code: number | null
    json: Record<string, unknown>
    stderr: string
  }>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), ...args],
      {
        env: {
          ...process.env,
          ASSETHUB_API_KEY: 'test-key-not-secret',
          ASSETHUB_API_BASE_URL: baseUrl,
          ASSETHUB_CLI_STATE_DIR: stateDir,
          ASSETHUB_CLI_CONFIG: join(stateDir, 'auth.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      try {
        resolveResult({
          code,
          json: JSON.parse(stdout) as Record<string, unknown>,
          stderr,
        })
      } catch {
        reject(new Error(`Invalid stdout: ${stdout}; stderr: ${stderr}`))
      }
    })
  })

const canvas = {
  id: 42,
  name: 'Composer',
  ownerId: 'org-a',
  url: 'https://api.test/workflow/42',
}

const modes = {
  defaultMode: 'standard',
  agentModels: [
    {id: 'gpt-6-astra', label: 'Astra', provider: 'responses-api'},
    {id: 'gpt-5.6-terra', label: 'Terra', provider: 'agents-api'},
    {id: 'gpt-6-astra', label: 'Astra legacy', provider: 'agents-api'},
  ],
  modes: [
    {id: 'standard', available: true, maxRounds: 2, budgetMs: 30_000},
    {id: 'codex', available: true, maxRounds: 16, budgetMs: 3_600_000},
    {id: 'thorough', available: true, maxRounds: 4, budgetMs: 120_000},
    {id: 'placement', available: true, maxRounds: 3, budgetMs: 90_000},
    {id: 'codex', available: true, maxRounds: 16, budgetMs: 3_600_000},
    {
      id: 'workshop',
      available: false,
      reason: 'internal rollout',
      maxRounds: 1,
      budgetMs: 30_000,
    },
    {
      id: 'blender',
      available: false,
      reason: 'worker unavailable',
      maxRounds: 1,
      budgetMs: 30_000,
    },
  ],
}

const execution = (
  runId: string,
  input: Record<string, unknown>,
  status: CanvasExecution['status'],
): CanvasExecution => ({
  schemaVersion: 'assethub.execution.v1',
  runId,
  operation: 'mesh.refine',
  status,
  canvas,
  jobIds: [],
  orderIds: [],
  graphRefs: [],
  outputs: [{assetId: 'refined-geometry', mediaType: 'mesh'}],
  history: {status: 'recorded'},
  composition: {
    parts: [{assetId: 'mesh-new', canonicalKey: 'body'}],
    transforms: {
      'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    },
  },
  refinement: {mode: 'placement', message: 'Review the feet placement'},
  usage: {reservedCredits: null, chargedCredits: null},
  createdAt: '2026-09-08T00:00:00Z',
  requestedInput: input,
  input,
  resolvedInput: input,
  context: input.executionContext as CanvasExecution['context'],
})

const listen = async (
  handler: (request: IncomingMessage) => Promise<unknown> | unknown,
) => {
  const server = createServer(async (request, response) => {
    try {
      const data = await handler(request)
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({success: true, data}))
    } catch (error) {
      response.writeHead(500, {'content-type': 'application/json'})
      response.end(
        JSON.stringify({success: false, error: {message: String(error)}}),
      )
    }
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

describe('composer refine CLI', () => {
  it('lists native refinement modes without dispatching', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-refine-modes-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const requests: string[] = []
    const baseUrl = await listen(request => {
      requests.push(`${request.method} ${request.url}`)
      if (request.url === '/api/v2/mesh/refine') return modes
      throw new Error(`Unexpected request ${request.method} ${request.url}`)
    })
    const result = await runCli(baseUrl, stateDir, [
      'composer',
      'refine',
      '--list-modes',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(result.json).toEqual(modes)
    expect(requests).toEqual(['GET /api/v2/mesh/refine'])
  })

  it.each([
    ['standard', 'agents-api', 'gpt-5.6-terra'],
    ['codex', 'agents-api', 'gpt-5.6-terra'],
    ['codex', 'responses-api', 'gpt-6-astra'],
    ['codex', 'agents-api', 'gpt-6-astra'],
  ] as const)(
    'derives actual final parts for %s through %s %s',
    async (mode, provider, model) => {
      const stateDir = await mkdtemp(
        join(tmpdir(), 'assethub-refine-from-run-'),
      )
      cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
      const posted: Record<string, unknown>[] = []
      const sourceInput = {
        parts: [{assetId: 'requested-mesh'}],
        fullBodyImageAssetId: 'reference',
        transforms: {'requested-mesh': [1, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
        mode: 'quick',
        referenceTransform: [9, 9, 9, 9, 9, 9, 1, 1, 1, 1],
      }
      const actualReferenceTransform = [3, 3, 3, 3, 3, 3, 1, 1, 1, 1]
      const previous: CanvasExecution = {
        ...execution('compose-run', sourceInput, 'completed'),
        operation: 'mesh.compose',
        requestedInput: undefined,
        input: sourceInput,
        composition: {
          parts: [
            {
              assetId: 'mesh-new',
              canonicalKey: 'body',
              volumeCentroid: [0.1, 0.2, 0.3],
            },
          ],
          transforms: {'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
          referenceTransform: actualReferenceTransform,
        },
      }
      const final = execution('refine-run', sourceInput, 'needs_review')
      const baseUrl = await listen(async request => {
        if (request.url === '/api/v2/mesh/refine' && request.method === 'GET')
          return modes
        if (request.url === '/api/v2/capabilities')
          return {
            ownerId: 'org-a',
            executionContext: {
              status: 'available',
              operations: ['mesh.refine'],
            },
            evaluators: [],
          }
        if (request.url === '/api/v2/canvases/42') return canvas
        if (request.url === '/api/v2/runs/compose-run') return previous
        if (request.url === '/api/v2/runs/refine-run') return final
        if (
          request.url === '/api/v2/mesh/refine' &&
          request.method === 'POST'
        ) {
          const body = await bodyOf(request)
          posted.push(body)
          return {
            execution: {
              ...final,
              requestedInput: body,
              input: body,
              context: body.executionContext,
            },
          }
        }
        throw new Error(`Unexpected request ${request.method} ${request.url}`)
      })
      const result = await runCli(baseUrl, stateDir, [
        'composer',
        'refine',
        '--from-run',
        'compose-run',
        ...(mode === 'codex' ? ['--mode', mode] : []),
        '--instruction',
        'align the feet to the ground',
        '--max-rounds',
        '1',
        '--agent-model',
        model === 'gpt-6-astra' ? `${provider}:${model}` : model,
        '--agent',
        'codex',
        '--wait',
      ])
      expect(result.code, result.stderr).toBe(3)
      expect(
        (result.json.execution as CanvasExecution).outputs[0]?.assetId,
      ).toBe('refined-geometry')
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({
        agentRuntime: {provider, model},
        parts: [
          {
            assetId: 'mesh-new',
            canonicalKey: 'body',
            volumeCentroid: [0.1, 0.2, 0.3],
          },
        ],
        fullBodyImageAssetId: 'reference',
        transforms: {'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
        mode,
        instruction: 'align the feet to the ground',
        maxRounds: 1,
        referenceTransform: actualReferenceTransform,
        executionContext: {
          canvasId: 42,
          parentRunId: 'compose-run',
          agent: {name: 'codex'},
        },
      })
    },
  )

  it.each(['queued', 'running'] as const)(
    'rejects an active %s checkpoint instead of racing refinement',
    async status => {
      const stateDir = await mkdtemp(
        join(tmpdir(), `assethub-refine-${status}-`),
      )
      cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
      const baseUrl = await listen(request => {
        if (request.url === '/api/v2/mesh/refine') return modes
        if (request.url === `/api/v2/runs/${status}-run`)
          return {
            ...execution(`${status}-run`, {}, status),
            operation: 'mesh.compose',
          }
        throw new Error(`Unexpected request ${request.method} ${request.url}`)
      })
      const result = await runCli(baseUrl, stateDir, [
        'composer',
        'refine',
        '--from-run',
        `${status}-run`,
        '--instruction',
        'do not dispatch',
      ])
      expect(result.code).toBe(2)
      expect(result.json.error).toMatchObject({
        message:
          '--from-run must identify a finished mesh.compose or mesh.refine checkpoint',
      })
    },
  )

  it('accepts JSON input, replays the exact saved operation, and rejects unavailable modes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-refine-json-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: Record<string, unknown>[] = []
    const operationId = 'a4e8530b-b362-45c7-9064-2b03b6f95b24'
    let savedRun: CanvasExecution | undefined
    let bodyFirstMaxRounds: number | undefined = 32
    const input: Omit<MeshRefineRequest, 'executionContext'> = {
      parts: [{assetId: 'mesh-a', name: 'body'}],
      fullBodyImageAssetId: 'reference',
      transforms: {'mesh-a': [1, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      referenceTransform: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      mode: 'codex',
      geometryBackend: 'blender',
      assemblyPolicy: 'body_first_v1',
      dressingGeneration: {
        maxCredits: 80,
        sourceImageAssetIds: {'mesh-a': 'image-part'},
      },
      skillSelection: {
        mode: 'manual',
        skillIds: ['assethub-mesh-part-assembly'],
      },
      instruction: 'center the character',
      agentRuntime: {provider: 'agents-api', model: 'gpt-6-astra'},
      maxRounds: 32,
    }
    const baseUrl = await listen(async request => {
      if (request.url === '/api/v2/mesh/refine' && request.method === 'GET')
        return {...modes, bodyFirst: true, bodyFirstMaxRounds}
      if (request.url === '/api/v2/capabilities')
        return {
          ownerId: 'org-a',
          executionContext: {status: 'available', operations: ['mesh.refine']},
          evaluators: [],
        }
      if (request.url === '/api/v2/canvases/42') return canvas
      if (request.url === `/api/v2/runs/${operationId}`) return savedRun
      if (request.url === '/api/v2/mesh/refine' && request.method === 'POST') {
        const body = await bodyOf(request)
        posted.push(body)
        savedRun = execution(
          operationId,
          body,
          posted.length === 1 ? 'queued' : 'needs_review',
        )
        if (posted.length === 1) savedRun.history = {status: 'pending'}
        return {execution: savedRun}
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`)
    })
    const json = JSON.stringify(input)
    const first = await runCli(baseUrl, stateDir, [
      'composer',
      'refine',
      '--input-json',
      json,
      '--canvas',
      '42',
      '--operation-id',
      operationId,
    ])
    expect(first.code, first.stderr).toBe(3)
    const resumed = await runCli(baseUrl, stateDir, [
      'runs',
      'resume',
      operationId,
      '--wait',
    ])
    expect(resumed.code, resumed.stderr).toBe(3)
    expect(posted).toHaveLength(2)
    expect(posted[0]?.agentRuntime).toEqual(input.agentRuntime)
    expect(posted[0]).toMatchObject(input)
    expect(posted[1]).toEqual(posted[0])
    expect(resumed.json.execution).toMatchObject({
      status: 'needs_review',
      operation: 'mesh.refine',
    })
    for (const policy of [undefined, 'body_first_v1']) {
      bodyFirstMaxRounds = undefined
      const overBudget = await runCli(baseUrl, stateDir, [
        'composer',
        'refine',
        '--input-json',
        JSON.stringify({...input, assemblyPolicy: policy}),
        '--canvas',
        '42',
      ])
      expect(overBudget.code).toBe(2)
      expect(overBudget.json.error).toMatchObject({
        message: '--max-rounds must be at most 16 for codex',
      })
    }
    bodyFirstMaxRounds = 32
    const continued = await runCli(baseUrl, stateDir, [
      'composer',
      'refine',
      '--from-run',
      operationId,
      '--instruction',
      'Continue repairing remaining defects',
      '--operation-id',
      '42608b89-cc07-4a6b-a065-d1716b23bba0',
    ])
    expect(continued.code, continued.stderr).toBe(3)
    expect(posted[2]).toMatchObject({
      assemblyPolicy: 'body_first_v1',
      maxRounds: 32,
    })
    const invalid = await runCli(baseUrl, stateDir, [
      'composer',
      'refine',
      '--input-json',
      JSON.stringify({...input, geometryBackend: undefined}),
      '--mode',
      'blender',
    ])
    expect(invalid.code).toBe(2)
    expect(invalid.json.error).toMatchObject({
      message: 'Refinement mode blender is unavailable: worker unavailable',
    })
    expect(posted).toHaveLength(3)
  })
})

// @testdoc Initial Composer uses the discovered model and preserves its separate version and geometry mode.
it.each([
  ['gpt-5.6-terra', 'agents-api'],
  ['gpt-6-astra', 'responses-api'],
  ['gpt-6-astra', 'agents-api'],
])('forwards %s through its discovered %s route', async (model, provider) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-compose-model-'))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  const posted: Record<string, unknown>[] = []
  const baseUrl = await listen(async request => {
    if (request.url === '/api/v2/mesh/refine' && request.method === 'GET')
      return modes
    if (request.url === '/api/v2/capabilities')
      return {
        ownerId: 'org-a',
        executionContext: {status: 'available', operations: ['mesh.compose']},
        evaluators: [],
      }
    if (request.url === '/api/v2/canvases/42') return canvas
    if (request.url === '/api/v2/mesh/compose' && request.method === 'POST') {
      const body = await bodyOf(request)
      posted.push(body)
      return {
        execution: {
          ...execution('compose-native', body, 'queued'),
          operation: 'mesh.compose',
        },
      }
    }
    throw new Error(`Unexpected request ${request.method} ${request.url}`)
  })
  const result = await runCli(baseUrl, stateDir, [
    'composer',
    'run',
    '--part',
    'mesh-one',
    '--reference',
    'image-ref',
    '--model',
    'part_composer_v3_assembler',
    '--agent-model',
    model === 'gpt-6-astra' ? `${provider}:${model}` : model,
    '--mode',
    'quality',
    '--canvas',
    '42',
  ])
  expect(result.code, result.stderr).toBe(0)
  expect(posted).toEqual([
    expect.objectContaining({
      agentVersion: 'part_composer_v3_assembler',
      mode: 'quality',
      agentRuntime: {provider, model},
    }),
  ])
})

// @testdoc A duplicate bare Astra ID never selects the first provider silently or starts a paid Composer operation.
it('rejects ambiguous bare Astra with concrete provider-qualified alternatives', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-compose-ambiguous-'))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  const posted: string[] = []
  const baseUrl = await listen(async request => {
    if (request.method === 'POST') posted.push(request.url ?? '')
    if (request.url === '/api/v2/mesh/refine' && request.method === 'GET')
      return modes
    throw new Error(`Unexpected request ${request.method} ${request.url}`)
  })
  const result = await runCli(baseUrl, stateDir, [
    'composer',
    'run',
    '--part',
    'mesh-one',
    '--reference',
    'image-ref',
    '--canvas',
    '42',
    '--agent-model',
    'gpt-6-astra',
  ])
  expect(result.code).toBe(2)
  expect(result.json.error).toMatchObject({
    message: expect.stringContaining(
      'responses-api:gpt-6-astra or agents-api:gpt-6-astra',
    ),
  })
  expect(posted).toEqual([])
})

describe('composer V6 and V5.1 from the CLI', () => {
  const capabilities = {
    ownerId: 'org-a',
    executionContext: {
      status: 'available',
      operations: ['mesh.compose', 'mesh.refine'],
    },
    evaluators: [],
  }
  const serve = (posted: {url: string; body: Record<string, unknown>}[]) =>
    listen(async request => {
      if (request.url === '/api/v2/mesh/refine' && request.method === 'GET')
        return modes
      if (request.url === '/api/v2/capabilities') return capabilities
      if (request.url === '/api/v2/canvases/42') return canvas
      if (request.method === 'POST' && request.url?.startsWith('/api/v2/mesh/')) {
        const body = await bodyOf(request)
        posted.push({url: request.url, body})
        const operation =
          request.url === '/api/v2/mesh/compose' ? 'mesh.compose' : 'mesh.refine'
        return {
          execution: {
            ...execution('queued-run', body, 'queued'),
            operation,
            context: body.executionContext,
          },
        }
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`)
    })

  it.each(['V6', 'v6', 'part_composer_v6_auto_assemble'])(
    'composes with Auto assemble (V6) for --model %s',
    async model => {
      const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-v6-'))
      cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
      const posted: {url: string; body: Record<string, unknown>}[] = []
      const result = await runCli(await serve(posted), stateDir, [
        'composer', 'run', '--canvas', '42',
        '--part', 'mesh-a=image-a', '--part', 'mesh-b=image-b',
        '--reference', 'ref-image',
        '--model', model,
      ])
      expect(result.code, result.stderr).toBe(0)
      expect(posted).toHaveLength(1)
      expect(posted[0]!.url).toBe('/api/v2/mesh/compose')
      expect(posted[0]!.body).toMatchObject({
        parts: [
          {assetId: 'mesh-a', partImageAssetId: 'image-a'},
          {assetId: 'mesh-b', partImageAssetId: 'image-b'},
        ],
        fullBodyImageAssetId: 'ref-image',
        agentVersion: 'part_composer_v6_auto_assemble',
        executionContext: {canvasId: 42},
      })
    },
  )

  it.each([
    ['light', 0.75],
    ['medium', 0.5],
    ['heavy', 0.25],
  ] as const)(
    'bakes the output with --optimize %s (the node\'s Optimize output preset)',
    async (preset, ratio) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-optimize-'))
      cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
      const posted: {url: string; body: Record<string, unknown>}[] = []
      const result = await runCli(await serve(posted), stateDir, [
        'composer', 'run', '--canvas', '42',
        '--part', 'mesh-a=image-a', '--part', 'mesh-b=image-b',
        '--reference', 'ref-image',
        '--model', 'V6', '--optimize', preset,
      ])
      expect(result.code, result.stderr).toBe(0)
      expect(posted[0]!.body).toMatchObject({
        agentVersion: 'part_composer_v6_auto_assemble',
        decimateRatio: ratio,
      })
    },
  )

  it('keeps full resolution with --optimize off, even over a saved ratio', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-optimize-off-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: {url: string; body: Record<string, unknown>}[] = []
    const input = {
      parts: [{assetId: 'mesh-a', partImageAssetId: 'image-a'}],
      fullBodyImageAssetId: 'ref-image',
      agentVersion: 'part_composer_v6_auto_assemble',
      decimateRatio: 0.5,
    }
    const result = await runCli(await serve(posted), stateDir, [
      'composer', 'run', '--canvas', '42',
      '--input-json', JSON.stringify(input), '--optimize', 'off',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(posted[0]!.body).not.toHaveProperty('decimateRatio')
  })

  it.each([
    [
      ['--input-json', JSON.stringify({
        parts: [{assetId: 'body', partImageAssetId: 'image-a'}],
        fullBodyImageAssetId: 'ref-image',
        baseBodyAssetId: 'body',
      }), '--optimize', 'light'],
      '--optimize cannot be combined with a base body (baseBodyAssetId)',
    ],
    [
      ['--node', 'shape:composer', '--optimize', 'medium'],
      '--optimize is not available with --node; set the node\'s Optimize output instead',
    ],
  ])('rejects --optimize for %j before dispatching', async (args, message) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-optimize-reject-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: {url: string; body: Record<string, unknown>}[] = []
    const result = await runCli(await serve(posted), stateDir, [
      'composer', 'run', '--canvas', '42', ...args,
    ])
    expect(result.code).toBe(2)
    expect(result.json.error).toMatchObject({message})
    expect(posted).toEqual([])
  })

  it('rejects --optimize on --from-run of a base-body composition', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-optimize-base-run-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: {url: string; body: Record<string, unknown>}[] = []
    const sourceInput = {
      parts: [{assetId: 'body'}, {assetId: 'coat'}],
      fullBodyImageAssetId: 'ref-image',
      baseBodyAssetId: 'body',
      agentVersion: 'part_composer_v4_turntable',
    }
    const previous: CanvasExecution = {
      ...execution('base-run', sourceInput, 'completed'),
      operation: 'mesh.compose',
    }
    const baseUrl = await listen(async request => {
      if (request.url === '/api/v2/runs/base-run') return previous
      if (request.url === '/api/v2/capabilities') return capabilities
      if (request.url === '/api/v2/canvases/42') return canvas
      if (request.method === 'POST') {
        posted.push({url: request.url ?? '', body: await bodyOf(request)})
        return {execution: execution('queued-run', {}, 'queued')}
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`)
    })
    const result = await runCli(baseUrl, stateDir, [
      'composer', 'run', '--from-run', 'base-run', '--optimize', 'light',
    ])
    expect(result.code).toBe(2)
    expect(result.json.error).toMatchObject({
      message: '--optimize cannot be combined with a base body (baseBodyAssetId)',
    })
    expect(posted).toEqual([])
  })

  it('never sends a bake ratio without --optimize', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-optimize-none-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: {url: string; body: Record<string, unknown>}[] = []
    const result = await runCli(await serve(posted), stateDir, [
      'composer', 'run', '--canvas', '42',
      '--part', 'mesh-a=image-a', '--reference', 'ref-image', '--model', 'V6',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(posted[0]!.body).not.toHaveProperty('decimateRatio')
  })

  it.each(['V5.1', 'skill-assembly', 'part_composer_v5_1_skill_assembly'])(
    'runs Skill assembly (V5.1) as a codex refinement for --model %s',
    async model => {
      const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-v51-'))
      cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
      const posted: {url: string; body: Record<string, unknown>}[] = []
      const result = await runCli(await serve(posted), stateDir, [
        'composer', 'run', '--canvas', '42',
        '--part', 'mesh-a=image-a', '--part', 'mesh-b', '--reference', 'ref-image',
        '--model', model,
        '--agent-model', 'gpt-6-astra',
        '--reasoning', 'high',
      ])
      expect(result.code, result.stderr).toBe(0)
      expect(posted).toHaveLength(1)
      expect(posted[0]!.url).toBe('/api/v2/mesh/refine')
      const identity = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]
      expect(posted[0]!.body).toMatchObject({
        skillAssembly: 'assemble-character',
        skillAssemblyReasoning: 'high',
        mode: 'codex',
        agentRuntime: {provider: 'agents-api', model: 'gpt-6-astra'},
        instruction:
          'Assemble these parts into one character with the Character Assembly skill.',
        parts: [{assetId: 'mesh-a'}, {assetId: 'mesh-b'}],
        fullBodyImageAssetId: 'ref-image',
        transforms: {'mesh-a': identity, 'mesh-b': identity},
        executionContext: {canvasId: 42},
      })
      expect(posted[0]!.body).not.toHaveProperty('agentVersion')
    },
  )

  it('runs Skill assembly from composer refine --skill-assembly on a finished compose run', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-refine-skill-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: {url: string; body: Record<string, unknown>}[] = []
    const sourceInput = {
      parts: [{assetId: 'mesh-new'}],
      fullBodyImageAssetId: 'reference',
      transforms: {'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      agentVersion: 'part_composer_v6_auto_assemble',
      mode: 'quick',
    }
    const previous: CanvasExecution = {
      ...execution('compose-run', sourceInput, 'completed'),
      operation: 'mesh.compose',
    }
    const baseUrl = await listen(async request => {
      if (request.url === '/api/v2/runs/compose-run') return previous
      if (request.url === '/api/v2/mesh/refine' && request.method === 'GET')
        return modes
      if (request.url === '/api/v2/capabilities') return capabilities
      if (request.url === '/api/v2/canvases/42') return canvas
      if (request.url === '/api/v2/mesh/refine' && request.method === 'POST') {
        const body = await bodyOf(request)
        posted.push({url: request.url, body})
        return {execution: {...execution('queued-run', body, 'queued'), context: body.executionContext}}
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`)
    })
    const result = await runCli(baseUrl, stateDir, [
      'composer', 'refine', '--from-run', 'compose-run', '--skill-assembly',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(posted[0]!.body).toMatchObject({
      skillAssembly: 'assemble-character',
      mode: 'codex',
      transforms: {'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      executionContext: {canvasId: 42, parentRunId: 'compose-run'},
    })
  })

  it.each([
    [['--model', 'V5.1', '--agent-model', 'responses-api:gpt-6-astra'], 'Skill assembly runs on an Agents API model'],
    [['--model', 'V5.1', '--mode', 'quality'], 'Skill assembly (V5.1) has no quick/quality mode'],
    [['--model', 'V6', '--reasoning', 'high'], '--reasoning applies only to Skill assembly (V5.1)'],
    [['--model', 'V6'], 'Auto assemble (V6) needs each part\'s drawing; pass --part <mesh-id>=<part-image-id> for: mesh-a'],
    [['--optimize', 'extreme'], '--optimize must be off, light, medium or heavy'],
    [['--model', 'V5.1', '--optimize', 'light'], '--optimize applies to composition, not Skill assembly (V5.1)'],
  ])('rejects %j before dispatching', async (args, message) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-composer-reject-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: {url: string; body: Record<string, unknown>}[] = []
    const result = await runCli(await serve(posted), stateDir, [
      'composer', 'run', '--canvas', '42',
      '--part', 'mesh-a', '--reference', 'ref-image', ...args,
    ])
    expect(result.code).toBe(2)
    expect(result.json.error).toMatchObject({message})
    expect(posted).toEqual([])
  })
})
