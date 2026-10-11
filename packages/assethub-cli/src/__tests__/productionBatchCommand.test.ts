import {childOperationId, productionBatchOperationId} from '@assethub/api-client'
import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const v4 = 'ah_agent_graph_harpy_assembly_v4_legacy'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

type Body = {
  executionContext: {canvasId: number; clientOperationId: string}
  imageAssetId?: string
  [key: string]: unknown
}
type Item = {key: string; status: string; runId?: string; attempt: number; operationId?: string}
type Output = {
  items: Item[]
  error: {message: string}
  downloads: Array<{files: Array<{path: string}>}>
  [key: string]: unknown
}
const bodyOf = async (request: IncomingMessage) => {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : undefined
}

const cli = (baseUrl: string, stateDir: string, args: string[]) =>
  new Promise<{code: number | null; json: Output; stderr: string}>(
    (resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, ...args, '--base-url', baseUrl, '--api-key', 'test-key-not-secret'],
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
      let stdout = '',
        stderr = ''
      child.stdout.on('data', chunk => (stdout += chunk))
      child.stderr.on('data', chunk => (stderr += chunk))
      child.once('error', reject)
      child.once('exit', code => {
        try {
          resolveResult({code, json: JSON.parse(stdout), stderr})
        } catch {
          reject(new Error(`Invalid stdout: ${stdout}; stderr: ${stderr}`))
        }
      })
    },
  )

/**
 * A fake API: analyze keyed by Idempotency-Key. Runs complete on first read, or
 * after reporting each `progress` summary in turn while running.
 */
const startServer = async (options: {limitedKeys?: Set<string>; progress?: string[]} = {}) => {
  const posted: Array<{key: string; body: Body; status: number}> = []
  const refused = new Set<string>()
  const reads = new Map<string, number>()
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    const path = req.url!
    requests.push(path)
    const host = `http://${req.headers.host}`
    const canvas = {id: 42, name: 'Batch', ownerId: 'org-a', url: `${host}/workflow/42`}
    const execution = (runId: string, status: string) => ({
      schemaVersion: 'assethub.execution.v1',
      runId,
      operation: 'production.analyze',
      status,
      canvas,
      jobIds: [],
      orderIds: [runId],
      graphRefs: [{graphId: runId}],
      outputs: status === 'completed' ? [{assetId: `mesh-${runId}`, mediaType: 'mesh', url: `${host}/out/${runId}.glb`}] : [],
      history: {status: 'recorded'},
      usage: {reservedCredits: 100, chargedCredits: 100},
      createdAt: '2026-09-30T00:00:00Z',
      input: {agentVersion: v4},
      resolvedInput: {agentVersion: v4},
      context: {canvasId: 42, clientOperationId: runId, source: 'cli'},
    })
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {'content-type': 'application/json', ...headers})
      res.end(JSON.stringify(payload))
    }
    if (path.endsWith('/capabilities'))
      return send(200, {success: true, data: {ownerId: 'org-a', executionContext: {status: 'available', operations: ['production.analyze']}, evaluators: []}})
    if (path.endsWith('/canvases/42')) return send(200, {success: true, data: canvas})
    if (path.endsWith('/production/analyze') && req.method === 'POST') {
      const key = String(req.headers['idempotency-key'])
      const body = await bodyOf(req)
      expect(body.executionContext.clientOperationId).toBe(key)
      if (options.limitedKeys?.has(key)) {
        const replayed = refused.has(key)
        refused.add(key)
        posted.push({key, body, status: 429})
        return send(
          429,
          {success: false, error: {code: 'AGENT_OWNER_LIMIT_EXCEEDED', message: 'Your plan allows up to 1 active agent run.'}},
          {'Idempotency-Replayed': String(replayed)},
        )
      }
      posted.push({key, body, status: 200})
      return send(200, {success: true, data: {engine: 'artifact-graph', graphId: key, orderId: key, runId: key, agentVersion: v4, status: 'analyzing', execution: execution(key, 'queued')}})
    }
    const run = /\/runs\/([^/?]+)/.exec(path)
    if (run) {
      const read = reads.get(run[1]!) ?? 0
      reads.set(run[1]!, read + 1)
      const summary = options.progress?.[read]
      if (summary === undefined) return send(200, {success: true, data: execution(run[1]!, 'completed')})
      const progress = {kind: 'character_assembly', phase: 'parts', step: 1, steps: 4, summary, headline: summary, partsReady: 0, partsTotal: 0, parts: []}
      return send(200, {success: true, data: {...execution(run[1]!, 'running'), progress}})
    }
    if (path.startsWith('/out/')) {
      res.writeHead(200, {'content-type': 'model/gltf-binary'})
      return res.end('glb-bytes')
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(closed => server.close(() => closed())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return {baseUrl: `http://127.0.0.1:${address.port}`, posted, requests}
}

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-batch-'))
  cleanup.push(() => rm(dir, {recursive: true, force: true}))
  return dir
}

describe('production batch', () => {
  // @testdoc Both V4 and V5 aliases send every part-count choice; V5 JSON switches stay explicit and unchanged.
  it.each(['few', 'default', 'detailed'])('forwards %s for V4 and V5', async partCount => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    for (const extractor of ['v4', 'v5']) {
      const experiment = extractor === 'v5'
        ? {partCount, v5Assembler: true, v5Start: 'placement'}
        : {partCount}
      for (const command of [['production', 'analyze'], ['parts', 'split'], ['parts', 'compare']]) {
        const result = await cli(baseUrl, dir, [
          ...command, '--source-id', 'image-asset', '--canvas', '42', '--part-extractor', extractor,
          '--part-count', partCount, '--assembly-experiment', JSON.stringify(experiment),
        ])
        expect(result.code, result.stderr).toBe(0)
        expect(posted.at(-1)?.body).toMatchObject({
          agentVersion: extractor === 'v4' ? v4 : 'ah_agent_graph_harpy_assembly_v2',
          assemblyExperiment: experiment,
        })
      }
    }
    expect(posted).toHaveLength(6)
  })

  // @testdoc Invalid, repeated, conflicting and incompatible part-count flags fail without any paid dispatch.
  it.each([
    ['production', 'analyze', '--part-extractor', 'v4', '--part-count', 'lots'],
    ['production', 'analyze', '--part-extractor', 'v4', '--part-count'],
    ['production', 'analyze', '--part-extractor', 'v4', '--part-count', 'few', '--part-count', 'default'],
    ['production', 'analyze', '--part-extractor', 'v4', '--part-count', 'few', '--assembly-experiment', '{"partCount":"detailed"}'],
    ['production', 'analyze', '--part-extractor', 'V1.5', '--part-count', 'few'],
    ['parts', 'split', '--part-extractor', 'V1.5', '--part-count', 'few'],
    ['parts', 'split', '--order-id', 'existing-order', '--part-count', 'few'],
    ['production', 'automation', '--input-json', '{"images":[{"imageAssetId":"image-asset"}],"agentVersion":"V1.5"}', '--part-count', 'few'],
  ].map(args => ({args})))('rejects unsupported input $args', async ({args}) => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    const result = await cli(baseUrl, dir, [...args, '--canvas', '42', ...(args.includes('--order-id') ? [] : ['--source-id', 'image-asset'])])
    expect(result.code).not.toBe(0)
    expect(result.json.error.message).toMatch(/part-count/)
    expect(posted).toHaveLength(0)
  })

  // @testdoc Every assembly flag fails before any HTTP request when the command or an existing order cannot apply it.
  it.each([
    {flag: '--part-count', value: 'few'},
    {flag: '--assembly-experiment', value: '{"partCount":"few"}'},
    {flag: '--garment-fit', value: 'wearGraph'},
  ])('refuses ignored $flag on unsupported entry points', async ({flag, value}) => {
    const dir = await tempDir()
    const {baseUrl, posted, requests} = await startServer()
    for (const args of [
      ['parts', 'split', '--order-id', 'existing-order'],
      ['production', 'automation', '--input-json', '{"images":[{"imageAssetId":"image-asset"}],"agentVersion":"V1.5"}'],
      ['production', 'run', '--image', 'image-asset'],
    ]) {
      const result = await cli(baseUrl, dir, [...args, flag, value, '--canvas', '42'])
      expect(result.code).not.toBe(0)
      expect(result.json.error.message).toContain(flag)
      expect(requests).toEqual([])
      expect(posted).toEqual([])
    }
  })

  // @testdoc The widened refusal guard still sends explicit garment flags on supported graph entry points.
  it('preserves garment flags on supported commands', async () => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    for (const command of [['production', 'analyze'], ['parts', 'split'], ['parts', 'compare']]) {
      const result = await cli(baseUrl, dir, [...command, '--source-id', 'image-asset', '--canvas', '42', '--part-extractor', 'v4', '--garment-fit', 'wearGraph'])
      expect(result.code, result.stderr).toBe(0)
      expect(posted.at(-1)?.body.assemblyExperiment).toEqual({garmentFit: {wearGraph: true}})
    }
    expect(posted).toHaveLength(3)
  })

  // @testdoc Explicit JSON part-count input reaches the API unchanged when no shorthand flag is given.
  it('preserves a JSON-only experiment', async () => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    const json = {partCount: 'detailed', v5Assembler: true, v5Start: 'fit', garmentFit: {wearGraph: false}}
    const result = await cli(baseUrl, dir, ['production', 'analyze', '--source-id', 'image-asset', '--canvas', '42', '--part-extractor', 'v4', '--assembly-experiment', JSON.stringify(json)])
    expect(result.code, result.stderr).toBe(0)
    expect(posted[0]?.body.assemblyExperiment).toEqual(json)
  })

  // @testdoc Omitting part-count retains classic API requests without an assemblyExperiment field.
  it('does not stamp a part-count default', async () => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    const result = await cli(baseUrl, dir, ['production', 'analyze', '--source-id', 'image-asset', '--canvas', '42', '--part-extractor', 'V1.5'])
    expect(result.code, result.stderr).toBe(0)
    expect(posted[0]?.body).not.toHaveProperty('assemblyExperiment')
  })


  it('starts one run per image and repeat, resumes without starting any again, and pins its inputs', async () => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    const operationId = '6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f'
    const args = [
      'production', 'batch',
      '--source-id', 'harpy', '--source-id', 'satyr',
      '--repeat', '2', '--part-extractor', 'v4', '--name', 'Consistency',
      '--canvas', '42', '--operation-id', operationId, '--yes',
      '--part-count', 'few',
    ]

    const first = await cli(baseUrl, dir, args)
    expect(first.code, first.stderr).toBe(0)
    expect(posted).toHaveLength(4)
    const expected = [
      ['0#1', 'harpy', 'Consistency harpy #1'],
      ['1#1', 'satyr', 'Consistency satyr #1'],
      ['0#2', 'harpy', 'Consistency harpy #2'],
      ['1#2', 'satyr', 'Consistency satyr #2'],
    ] as const
    for (const [key, imageAssetId, name] of expected) {
      const id = await childOperationId(operationId, key)
      const request = posted.find(entry => entry.key === id)
      expect(request, key).toBeDefined()
      expect(request!.body).toMatchObject({
        imageAssetId,
        agentVersion: v4,
        assemblyExperiment: {partCount: 'few'},
        name,
        executionContext: {canvasId: 42, clientOperationId: id, source: 'cli'},
      })
    }
    expect(first.json).toMatchObject({
      batchOperationId: operationId,
      canvasId: 42,
      agentVersion: v4,
      counts: {dispatched: 4, deferred: 0, failed: 0},
    })
    expect(first.json.items.map((item: Item) => [item.key, item.status])).toEqual(
      expected.map(([key]) => [key, 'dispatched']),
    )
    expect(first.stderr).toContain(`--operation-id ${operationId}`)

    const again = await cli(baseUrl, dir, args)
    expect(again.code, again.stderr).toBe(0)
    expect(posted).toHaveLength(4)
    expect(again.json.items.map((item: Item) => item.runId)).toEqual(
      first.json.items.map((item: Item) => item.runId),
    )

    const changed = await cli(baseUrl, dir, [...args, '--source-id', 'knight'])
    expect(changed.code).not.toBe(0)
    expect(changed.json.error.message).toContain('different inputs')

    const single = await cli(baseUrl, dir, [
      'production', 'analyze', '--source-id', 'harpy', '--part-extractor', 'v4',
      '--canvas', '42', '--operation-id', operationId,
    ])
    expect(single.code).not.toBe(0)
    expect(single.json.error.message).toContain('production batch')
    expect(posted).toHaveLength(4)
  })

  it('asks for --yes before starting more than one paid run', async () => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    const result = await cli(baseUrl, dir, [
      'production', 'batch', '--source-id', 'harpy', '--repeat', '3',
      '--part-extractor', 'v4', '--canvas', '42',
    ])
    expect(result.code).not.toBe(0)
    expect(result.json.error.message).toContain('3 paid runs')
    expect(posted).toHaveLength(0)
  })

  it('rejects single-source flags it cannot batch', async () => {
    const dir = await tempDir()
    const {baseUrl, posted} = await startServer()
    const result = await cli(baseUrl, dir, [
      'production', 'batch', '--stdin', '--part-extractor', 'v4', '--canvas', '42',
    ])
    expect(result.code).not.toBe(0)
    expect(result.json.error.message).toContain('--stdin')
    expect(posted).toHaveLength(0)
  })

  it('with --wait, reports each new progress step of a running run once', async () => {
    const dir = await tempDir()
    const {baseUrl} = await startServer({
      progress: ['Step 1 of 4 · Planning the parts', 'Step 3 of 4 · Making the parts', 'Step 3 of 4 · Making the parts'],
    })
    const result = await cli(baseUrl, dir, [
      'production', 'batch', '--source-id', 'harpy', '--part-extractor', 'v4', '--canvas', '42',
      '--wait', '--interval-ms', '1',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain('Batch ')
    expect(result.stderr).toContain('  A  harpy\n')
    const lines = result.stderr.split('\n').filter(line => /^\d\d:\d\d {2}A {2}harpy {2}/.test(line))
    expect(lines[0]).toContain('started run ')
    expect(lines.filter(line => line.includes('1/4 Planning the parts'))).toHaveLength(1)
    expect(lines.filter(line => line.includes('Making the parts'))).toHaveLength(1)
    expect(lines.at(-1)).toContain('✓ done')
    expect(result.stderr).toMatch(/── \d\d:\d\d · done ──\n {2}A {2}harpy {2}✓ done/)
  })

  it('with --wait, holds an image the agent-run limit refused and starts it on a new key once a run finishes', async () => {
    const dir = await tempDir()
    const operationId = '7a2e3d4c-5b6a-4f9e-8d7c-2b3c4d5e6f70'
    const refusedKey = await childOperationId(operationId, '1#1')
    const {baseUrl, posted} = await startServer({limitedKeys: new Set([refusedKey])})
    const outDir = join(dir, 'out')
    const result = await cli(baseUrl, dir, [
      'production', 'batch', '--source-id', 'harpy', '--source-id', 'satyr',
      '--part-extractor', 'v4', '--canvas', '42', '--operation-id', operationId, '--yes',
      '--wait', '--concurrency', '1', '--interval-ms', '1',
      '--download', '--out-dir', outDir,
    ])
    expect(result.code, result.stderr).toBe(0)
    const retryKey = await productionBatchOperationId(operationId, '1#1', 1)
    expect(
      posted.filter(entry => entry.body.imageAssetId === 'satyr').map(entry => [entry.key, entry.status]),
    ).toEqual([
      [refusedKey, 429],
      [refusedKey, 429],
      [retryKey, 200],
    ])
    expect(result.json.items).toMatchObject([
      {key: '0#1', status: 'completed', attempt: 0},
      {key: '1#1', status: 'completed', attempt: 1, operationId: retryKey},
    ])
    expect(result.stderr).toContain('waiting for a free run slot · Your plan allows up to 1 active agent run.')
    const saved = JSON.parse(
      await readFile(join(dir, 'production-batches', `${operationId}.json`), 'utf8'),
    )
    expect(saved.items.map((item: Item) => item.attempt)).toEqual([0, 1])
    expect(result.json.downloads).toHaveLength(2)
    expect(
      await readFile(result.json.downloads[1].files[0].path, 'utf8'),
    ).toBe('glb-bytes')
    expect(result.json.downloads[1].files[0].path).toContain(join('satyr', 'run-1'))
  })
})
