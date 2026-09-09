import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'
import type {CanvasExecution} from '@assethub/api-client'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
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
        resolveResult({code, json: JSON.parse(stdout) as Record<string, unknown>, stderr})
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
  modes: [
    {id: 'standard', available: true, maxRounds: 2, budgetMs: 30_000},
    {id: 'thorough', available: true, maxRounds: 4, budgetMs: 120_000},
    {id: 'placement', available: true, maxRounds: 3, budgetMs: 90_000},
    {id: 'workshop', available: false, reason: 'internal rollout', maxRounds: 1, budgetMs: 30_000},
    {id: 'blender', available: false, reason: 'worker unavailable', maxRounds: 1, budgetMs: 30_000},
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
      response.end(JSON.stringify({success: false, error: {message: String(error)}}))
    }
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
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
    const result = await runCli(baseUrl, stateDir, ['composer', 'refine', '--list-modes'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.json).toEqual(modes)
    expect(requests).toEqual(['GET /api/v2/mesh/refine'])
  })

  it('derives actual final parts and transforms from a prior compose run', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-refine-from-run-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: Record<string, unknown>[] = []
    const sourceInput = {
      parts: [{assetId: 'requested-mesh'}],
      fullBodyImageAssetId: 'reference',
      transforms: {'requested-mesh': [1, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
    }
    const previous: CanvasExecution = {
      ...execution('compose-run', sourceInput, 'completed'),
      operation: 'mesh.compose',
      requestedInput: sourceInput,
      input: sourceInput,
      composition: {
        parts: [{assetId: 'mesh-new', canonicalKey: 'body', volumeCentroid: [0.1, 0.2, 0.3]}],
        transforms: {'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      },
    }
    const final = execution('refine-run', sourceInput, 'needs_review')
    const baseUrl = await listen(async request => {
      if (request.url === '/api/v2/mesh/refine' && request.method === 'GET') return modes
      if (request.url === '/api/v2/capabilities')
        return {ownerId: 'org-a', executionContext: {status: 'available', operations: ['mesh.refine']}, evaluators: []}
      if (request.url === '/api/v2/canvases/42') return canvas
      if (request.url === '/api/v2/runs/compose-run') return previous
      if (request.url === '/api/v2/runs/refine-run') return final
      if (request.url === '/api/v2/mesh/refine' && request.method === 'POST') {
        const body = await bodyOf(request)
        posted.push(body)
        return {execution: {...final, requestedInput: body, input: body, context: body.executionContext}}
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`)
    })
    const result = await runCli(baseUrl, stateDir, [
      'composer',
      'refine',
      '--from-run',
      'compose-run',
      '--instruction',
      'align the feet to the ground',
      '--mode',
      'placement',
      '--max-rounds',
      '1',
      '--agent',
      'codex',
      '--wait',
    ])
    expect(result.code, result.stderr).toBe(3)
    expect((result.json.execution as CanvasExecution).outputs[0]?.assetId).toBe('refined-geometry')
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      parts: [{assetId: 'mesh-new', canonicalKey: 'body', volumeCentroid: [0.1, 0.2, 0.3]}],
      fullBodyImageAssetId: 'reference',
      transforms: {'mesh-new': [2, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      mode: 'placement',
      instruction: 'align the feet to the ground',
      maxRounds: 1,
      executionContext: {canvasId: 42, parentRunId: 'compose-run', agent: {name: 'codex'}},
    })
  })

  it.each(['queued', 'running'] as const)(
    'rejects an active %s checkpoint instead of racing refinement',
    async status => {
      const stateDir = await mkdtemp(join(tmpdir(), `assethub-refine-${status}-`))
      cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
      const baseUrl = await listen(request => {
        if (request.url === '/api/v2/mesh/refine') return modes
        if (request.url === `/api/v2/runs/${status}-run`)
          return {...execution(`${status}-run`, {}, status), operation: 'mesh.compose'}
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
        message: '--from-run must identify a finished mesh.compose or mesh.refine checkpoint',
      })
    },
  )

  it('accepts JSON input, replays the exact saved operation, and rejects unavailable modes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assethub-refine-json-'))
    cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
    const posted: Record<string, unknown>[] = []
    const operationId = 'a4e8530b-b362-45c7-9064-2b03b6f95b24'
    let savedRun: CanvasExecution | undefined
    const input = {
      parts: [{assetId: 'mesh-a', name: 'body'}],
      fullBodyImageAssetId: 'reference',
      transforms: {'mesh-a': [1, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      referenceTransform: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      mode: 'standard',
      instruction: 'center the character',
      maxRounds: 1,
    }
    const baseUrl = await listen(async request => {
      if (request.url === '/api/v2/mesh/refine' && request.method === 'GET') return modes
      if (request.url === '/api/v2/capabilities')
        return {ownerId: 'org-a', executionContext: {status: 'available', operations: ['mesh.refine']}, evaluators: []}
      if (request.url === '/api/v2/canvases/42') return canvas
      if (request.url === `/api/v2/runs/${operationId}`) return savedRun
      if (request.url === '/api/v2/mesh/refine' && request.method === 'POST') {
        const body = await bodyOf(request)
        posted.push(body)
        savedRun = execution(operationId, body, posted.length === 1 ? 'queued' : 'needs_review')
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
    const resumed = await runCli(baseUrl, stateDir, ['runs', 'resume', operationId, '--wait'])
    expect(resumed.code, resumed.stderr).toBe(3)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toEqual(posted[0])
    expect(resumed.json.execution).toMatchObject({status: 'needs_review', operation: 'mesh.refine'})
    const invalid = await runCli(baseUrl, stateDir, [
      'composer',
      'refine',
      '--input-json',
      json,
      '--mode',
      'blender',
    ])
    expect(invalid.code).toBe(2)
    expect(invalid.json.error).toMatchObject({message: 'Refinement mode blender is unavailable: worker unavailable'})
    expect(posted).toHaveLength(2)
  })
})
