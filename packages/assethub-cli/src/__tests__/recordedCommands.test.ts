import type {CanvasExecution, Source} from '@assethub/api-client'
import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})
const bodyOf = async (request: IncomingMessage) => {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : undefined
}
const cli = (baseUrl: string, stateDir: string, args: string[]) =>
  new Promise<{
    code: number | null
    json: {
      execution: CanvasExecution
      source?: Source
      preprocessed?: {
        ok: boolean
        error: {operationId?: string; message?: string}
      }
      error?: {message: string}
      downloads?: {files: Array<{path: string}>}
    }
    stderr: string
  }>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [resolve('packages/assethub-cli/dist/index.js'), ...args],
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
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      try {
        resolveResult({code, json: JSON.parse(stdout), stderr})
      } catch {
        reject(new Error(`Invalid stdout: ${stdout}; stderr: ${stderr}`))
      }
    })
  })

describe('built recorded CLI', () => {
  it.each([false, true])(
    'composes, resumes an unacknowledged receipt=%s, and derives transformed parts',
    async pending => {
      const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-compose-'))
      cleanup.push(() => rm(dir, {recursive: true, force: true}))
      const posted: Record<string, unknown>[] = []
      const executions = new Map<string, CanvasExecution>()
      const server = createServer(async (req, res) => {
        const canvas = {
          id: 42,
          name: 'Composition',
          ownerId: 'org-a',
          url: `http://${req.headers.host}/workflow/42`,
        }
        let data: unknown
        if (req.url === '/api/v2/capabilities')
          data = {
            ownerId: 'org-a',
            executionContext: {
              status: 'available',
              operations: ['mesh.compose'],
            },
            evaluators: [],
          }
        else if (req.url === '/api/v2/canvases/42') data = canvas
        else if (req.url === '/api/v2/mesh/compose' && req.method === 'POST') {
          const input = await bodyOf(req)
          expect(req.headers['idempotency-key']).toBe(
            input.executionContext.clientOperationId,
          )
          posted.push(input)
          const runId = input.executionContext.clientOperationId
          const execution: CanvasExecution = {
            schemaVersion: 'assethub.execution.v1',
            runId,
            operation: 'mesh.compose',
            status: 'completed',
            canvas,
            jobIds: [],
            orderIds: [],
            graphRefs: [],
            outputs: [{assetId: 'composed-mesh', mediaType: 'mesh'}],
            history: {status: 'recorded'},
            usage: {reservedCredits: null, chargedCredits: null},
            createdAt: '2026-09-08T00:00:00Z',
            input,
            resolvedInput: input,
            context: input.executionContext,
          }
          executions.set(runId, execution)
          data = {execution}
        } else if (req.url?.startsWith('/api/v2/runs/'))
          data = executions.get(req.url.split('/').at(-1)!)
        else {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({success: true, data}))
      })
      await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
      cleanup.push(() => new Promise<void>(done => server.close(() => done())))
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const op = 'a4e8530b-b362-45c7-9064-2b03b6f95b24'
      const first = await cli(baseUrl, dir, [
        'composer',
        'run',
        '--part',
        'mesh-a',
        '--part',
        'mesh-b',
        '--reference',
        'reference',
        '--canvas',
        '42',
        '--operation-id',
        op,
        '--wait',
      ])
      expect(first.code, first.stderr).toBe(0)
      expect(posted[0]).toMatchObject({
        parts: [{assetId: 'mesh-a'}, {assetId: 'mesh-b'}],
        fullBodyImageAssetId: 'reference',
      })
      if (pending)
        executions.set(op, {
          ...executions.get(op)!,
          status: 'queued',
          history: {status: 'pending'},
        })
      const resumed = await cli(baseUrl, dir, ['runs', 'resume', op, '--wait'])
      expect(resumed.code, resumed.stderr).toBe(0)
      expect(resumed.json.execution.runId).toBe(first.json.execution.runId)
      expect(posted).toHaveLength(pending ? 2 : 1)
      if (pending) expect(posted[1]).toEqual(posted[0])
      const transforms = {
        'mesh-a': [1, 0, 0, 0, 0, 0, 1, 1, 1, 1],
        'mesh-b': [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      }
      const recomposed = await cli(baseUrl, dir, [
        'composer',
        'run',
        '--from-run',
        op,
        '--transforms-json',
        JSON.stringify(transforms),
        '--wait',
      ])
      expect(recomposed.code, recomposed.stderr).toBe(0)
      expect(posted).toHaveLength(pending ? 3 : 2)
      expect(posted.at(-1)).toMatchObject({
        transforms,
        executionContext: {canvasId: 42, parentRunId: op},
      })
      expect(recomposed.json.execution.runId).not.toBe(
        first.json.execution.runId,
      )
    },
  )

  // @testdoc Graph extractor names and aliases preserve one analysis receipt on replay, reject classic continuation flags and raw internal IDs.
  it.each([
    ['V3.6.1', 'ah_agent_graph_v3_6_1', 'V3.6.1 Primary Images First', []],
    ['V3.6.3', 'ah_agent_graph_v3_6_3', 'V3.6.3 Fast Analysis', []],
    ['V3.6.4', 'ah_agent_graph_v3_6_4', 'V3.6.4 Fast Analysis', []],
    ['V3.6.5 Primary Images', 'ah_agent_graph_v3_6_5', 'V3.6.5 Primary Images', ['v3.6.5', '3.6.5']],
    ['Chibi Character (Pluffy) v3.1', 'ah_agent_graph_pluffy_v3_1', 'Chibi Character (Pluffy) v3.1', ['pluffy', 'pluffy v3.1', 'pluffy 3.1']],
    ['V3.7 Artist Skills', 'ah_agent_graph_v3_7', 'V3.7 Artist Skills', ['v3.7', '3.7']],
  ] as const)('splits and replays %s graphs', async (name, apiValue, label, aliases) => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-graph-process-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const posted: Array<{path: string; body: Record<string, unknown>}> = []
    const classicRequests: string[] = []
    let runReads = 0
    const server = createServer(async (req, res) => {
      const path = req.url!
      if (
        path.includes('/production/status/') ||
        path.endsWith('/production/execute')
      )
        classicRequests.push(path)
      const canvas = {
        id: 42,
        name: 'Graph test',
        ownerId: 'org-a',
        url: `http://${req.headers.host}/workflow/42`,
      }
      const execution = {
        schemaVersion: 'assethub.execution.v1',
        runId: 'graph-1',
        operation: 'production.analyze',
        status: path.includes('/runs/') ? 'completed' : 'queued',
        canvas,
        jobIds: [],
        orderIds: ['graph-1'],
        graphRefs: [{graphId: 'graph-1'}],
        outputs: [
          {
            assetId: 'part-1',
            mediaType: 'image',
            url: `http://${req.headers.host}/part.png`,
          },
        ],
        history: {status: 'recorded'},
        usage: {reservedCredits: 25, chargedCredits: 25},
        createdAt: '2026-09-08T00:00:00Z',
        resolvedInput: {agentVersion: apiValue},
        context: {
          canvasId: 42,
          clientOperationId: '84e8530b-b362-45c7-9064-2b03b6f95b24',
          source: 'cli',
        },
        input: {agentVersion: apiValue},
      }

      let data: unknown
      if (path.endsWith('/capabilities'))
        data = {
          ownerId: 'org-a',
          executionContext: {
            status: 'available',
            operations: ['production.analyze', 'production.execute'],
          },
          evaluators: [],
        }
      else if (path.endsWith('/canvases/42')) data = canvas
      else if (path.endsWith('/production/agents'))
        data = {
          agents: [{value: apiValue, supportedOnGraphEndpoint: true}],
        }
      else if (path.endsWith('/production/analyze')) {
        const body = await bodyOf(req)
        posted.push({path, body})
        data = {
          engine: 'artifact-graph',
          graphId: 'graph-1',
          orderId: 'graph-1',
          runId: 'graph-1',
          agentVersion: label,
          status: 'analyzing',
          execution,
        }
      } else if (path.includes('/runs/')) {
        runReads++
        data = execution
      } else if (path === '/part.png') {
        res.writeHead(200, {'content-type': 'image/png'})
        res.end('part-image-bytes')
        return
      } else {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({success: true, data}))
    })
    await new Promise<void>(resolveReady =>
      server.listen(0, '127.0.0.1', resolveReady),
    )
    cleanup.push(
      () =>
        new Promise<void>(resolveClose => server.close(() => resolveClose())),
    )
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing server address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    const outDir = join(dir, 'parts-out')
    const args = [
      'parts',
      'split',
      '--source-id',
      'image-asset',
      '--canvas',
      '42',
      '--part-extractor',
      name,
      '--all-ready',
      '--wait',
      '--interval-ms',
      '1',
      '--operation-id',
      operationId,
      '--download',
      '--out-dir',
      outDir,
    ]

    const agents = await cli(baseUrl, dir, ['production', 'agents'])
    expect(agents.code, agents.stderr).toBe(0)
    expect(agents.json).toMatchObject({
      agents: [{supportedOnGraphEndpoint: true}],
    })
    const split = await cli(baseUrl, dir, args)
    expect(split.code, split.stderr).toBe(0)
    expect(split.json.execution).toMatchObject({
      runId: 'graph-1',
      graphRefs: [{graphId: 'graph-1'}],
      outputs: [{assetId: 'part-1'}],
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      path: '/api/v1/production/analyze',
      body: {agentVersion: apiValue},
    })
    expect(classicRequests).toEqual([])
    expect(await readFile(split.json.downloads!.files[0].path, 'utf8')).toBe(
      'part-image-bytes',
    )

    const replayed = await cli(baseUrl, dir, args)
    expect(replayed.code, replayed.stderr).toBe(0)
    expect(replayed.json.execution.runId).toBe('graph-1')
    expect(posted).toHaveLength(1)
    expect(classicRequests).toEqual([])
    expect(runReads).toBeGreaterThan(1)

    for (const unsupported of [
      ['--task-id', 'task-1'],
      ['--mission-id', 'mission-1'],
      ['--part-extraction-mode', 'fast'],
    ]) {
      const rejected = await cli(baseUrl, dir, [
        ...args.slice(0, 8),
        ...unsupported,
      ])
      expect(rejected.code).not.toBe(0)
      expect(rejected.json.error?.message).toContain(
        `${unsupported[0]} is not supported with ${name}`,
      )
    }
    const continued = await cli(baseUrl, dir, [
      'parts',
      'split',
      '--order-id',
      'classic-order',
      '--part-extractor',
      label,
    ])
    expect(continued.code).not.toBe(0)
    expect(continued.json.error?.message).toContain(
      `--order-id is not supported with ${name}`,
    )
    expect(posted).toHaveLength(1)

    for (const alias of [name, ...aliases]) {
      const analyzed = await cli(baseUrl, dir, [
        'production', 'analyze', '--source-id', 'image-asset',
        '--canvas', '42', '--part-extractor', alias,
      ])
      expect(analyzed.code, analyzed.stderr).toBe(0)
      expect(posted.at(-1)).toMatchObject({
        path: '/api/v1/production/analyze',
        body: {agentVersion: apiValue},
      })
    }
    let expectedPostCount = 2 + aliases.length
    if (apiValue === 'ah_agent_graph_v3_7') {
      const selected = await cli(baseUrl, dir, [
        'production', 'analyze', '--source-id', 'image-asset',
        '--canvas', '42', '--part-extractor', name,
        '--skill-mode', 'manual', '--skill-id', 'character-hands',
        '--skill-id', 'shared.proportions',
      ])
      expect(selected.code, selected.stderr).toBe(0)
      expect(posted.at(-1)?.body.skillSelection).toEqual({
        mode: 'manual',
        skillIds: ['character-hands', 'shared.proportions'],
      })
      expectedPostCount++
      for (const invalid of [
        ['--skill-id', 'character-hands'],
        ['--skill-mode', 'manual'],
        ['--skill-mode', 'manual', '--skill-id'],
        ['--skill-mode', 'off', '--skill-id', 'character-hands'],
      ]) {
        const rejected = await cli(baseUrl, dir, [
          'production', 'analyze', '--source-id', 'image-asset',
          '--canvas', '42', '--part-extractor', name, ...invalid,
        ])
        expect(rejected.code).not.toBe(0)
      }
      expect(posted).toHaveLength(expectedPostCount)
    }
    expect(posted).toHaveLength(expectedPostCount)
    const rawId = await cli(baseUrl, dir, [
      'production', 'analyze', '--source-id', 'image-asset',
      '--canvas', '42', '--part-extractor', apiValue,
    ])
    expect(rawId.code).not.toBe(0)
    expect(rawId.json.error?.message).toContain(
      'Internal part extractor IDs are not accepted by the public CLI',
    )
    expect(posted).toHaveLength(expectedPostCount)
    expect(classicRequests).toEqual([])
  })

  it('chains generation and selected parts execution on one canvas with durable operation keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-process-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    await writeFile(join(dir, 'input.png'), 'input-image-bytes')
    let creations = 0
    const executions = new Map<string, unknown>()
    let partsExecuted = false
    let stallStatuses = false
    let failPreprocess = false
    const downloads: string[] = []
    const posted: {
      path: string
      body: Record<string, unknown>
      key: string | string[] | undefined
    }[] = []
    const server = createServer(async (req, res) => {
      const path = req.url!
      const canvas = {
        id: 42,
        name: 'Test',
        ownerId: 'org-a',
        url: `http://${req.headers.host}/workflow/42`,
      }
      if (path === '/image.png') {
        downloads.push(path)
        res.writeHead(200, {'content-type': 'image/png'})
        res.end('image-bytes')
        return
      }
      if (path.startsWith('/workflow/')) {
        downloads.push(path)
        res.writeHead(403)
        res.end()
        return
      }
      let data: unknown
      if (path.endsWith('/capabilities'))
        data = {
          ownerId: 'org-a',
          executionContext: {
            status: 'available',
            operations: [
              'image.generate',
              'mesh.generate',
              'production.analyze',
              'production.execute',
              'production.automation',
            ],
          },
          evaluators: [],
        }
      else if (path.endsWith('/canvases/42')) data = canvas
      else if (path.endsWith('/canvases')) {
        const body = await bodyOf(req)
        if (
          !body.clientOperationId ||
          body.clientOperationId !== req.headers['idempotency-key']
        ) {
          res.writeHead(400)
          res.end()
          return
        }
        creations++
        data = canvas
      } else if (path.endsWith('/files/upload')) {
        for await (const _chunk of req) {
          /* Drain uploaded image bytes. */
        }
        data = {
          uploadId: 'upload-1',
          fileRef: {
            type: 'supabase',
            bucket: 'external_api_uploads',
            path: 'org-a/staging.png',
          },
        }
      } else if (path.includes('/runs/'))
        data = executions.get(path.split('/').at(-1)!)
      else if (path.includes('/production/status/') && stallStatuses) return
      else if (path.includes('/production/status/'))
        data = {
          order: {id: 'order-1', status: partsExecuted ? 'completed' : 'ready'},
          missions: [
            {id: 'mission-1', tasks: [{id: 'task-1', status: 'ready'}]},
          ],
        }
      else if (path.includes('/production/')) {
        const body = await bodyOf(req)
        posted.push({path, body, key: req.headers['idempotency-key']})
        if (path.endsWith('/execute')) partsExecuted = true
        const execution = {
          schemaVersion: 'assethub.execution.v1',
          runId: `production-${body.executionContext.clientOperationId}`,
          operation: `production.${path.split('/').at(-1)}`,
          status: 'completed',
          canvas,
          jobIds: [],
          orderIds: ['order-1'],
          graphRefs: [],
          outputs: [],
          history: {status: 'recorded'},
          usage: {reservedCredits: null, chargedCredits: null},
          context: body.executionContext,
          input: body,
        }
        executions.set(execution.runId, execution)
        data = {
          orderId: 'order-1',
          publicAccessToken: 'ephemeral-token',
          execution,
        }
      } else if (
        path.endsWith('/image/generate') ||
        path.endsWith('/generate/mesh')
      ) {
        const body = await bodyOf(req)
        posted.push({path, body, key: req.headers['idempotency-key']})
        if (failPreprocess && path.endsWith('/image/generate')) {
          res.writeHead(503, {'content-type': 'application/json'})
          res.end(
            JSON.stringify({
              success: false,
              error: {
                code: 'RUN_TOKEN_UNAVAILABLE',
                message: 'Trigger accepted; token unavailable',
              },
            }),
          )
          return
        }
        const mesh = path.endsWith('/mesh')
        data = {
          jobId: mesh ? 'mesh-job' : 'image-job',
          execution: {
            schemaVersion: 'assethub.execution.v1',
            runId: mesh ? 'mesh-run' : 'image-run',
            status: 'completed',
            operation: mesh ? 'mesh.generate' : 'image.generate',
            canvas,
            jobIds: [],
            orderIds: [],
            graphRefs: [],
            outputs: [
              {
                assetId: mesh ? 'mesh-asset' : 'image-asset',
                mediaType: mesh ? 'mesh' : 'image',
                url: `http://${req.headers.host}/image.png`,
              },
            ],
            history: {status: 'recorded'},
            usage: {reservedCredits: null, chargedCredits: null},
            context: body.executionContext,
            createdAt: '2026-09-07T00:00:00Z',
            input: body,
          },
        }
      } else {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({success: true, data}))
    })
    await new Promise<void>(resolveReady =>
      server.listen(0, '127.0.0.1', resolveReady),
    )
    cleanup.push(
      () =>
        new Promise<void>(resolveClose => server.close(() => resolveClose())),
    )
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing server address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const source = await cli(baseUrl, dir, [
      'source',
      'create',
      '--file',
      join(dir, 'input.png'),
      '--media-type',
      'image',
    ])
    expect(source.code, source.stderr).toBe(0)
    expect(source.json.source).toEqual({uploadId: 'upload-1'})
    const image = await cli(baseUrl, dir, [
      'image',
      'generate',
      '--prompt',
      'robot',
      '--source-json',
      JSON.stringify(source.json),
      '--agent',
      'test-agent',
      '--download',
      '--out-dir',
      join(dir, 'out'),
    ])
    expect(image.code, image.stderr).toBe(0)
    expect(image.json.execution.outputs[0].assetId).toBe('image-asset')
    const mesh = await cli(baseUrl, dir, [
      'mesh',
      'generate',
      '--source-id',
      image.json.execution.outputs[0].assetId,
      '--canvas',
      '42',
    ])
    expect(mesh.code, mesh.stderr).toBe(0)
    expect(mesh.json.execution.outputs[0].assetId).toBe('mesh-asset')
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    const split = await cli(baseUrl, dir, [
      'parts',
      'split',
      '--source-id',
      'image-asset',
      '--part-extractor',
      'V1.5',
      '--all-ready',
      '--operation-id',
      operationId,
      '--download',
      '--out-dir',
      join(dir, 'parts-out'),
    ])
    expect(split.code, split.stderr).toBe(0)
    expect(split.json.execution.orderIds).toEqual(['order-1'])
    expect(JSON.stringify(split.json)).not.toContain('ephemeral-token')
    const splitCalls = posted.filter(item => item.path.includes('/production/'))
    expect(splitCalls.map(item => item.path)).toEqual([
      '/api/v1/production/analyze',
      '/api/v1/production/execute',
    ])
    expect(splitCalls[1].body.confirmedTaskIds).toEqual(['task-1'])
    expect(splitCalls[0].key).toBe(operationId)
    expect(splitCalls[1].key).not.toBe(operationId)
    const repeated = await cli(baseUrl, dir, [
      'parts',
      'split',
      '--source-id',
      'image-asset',
      '--part-extractor',
      'V1.5',
      '--all-ready',
      '--operation-id',
      operationId,
      '--timeout-ms',
      '100',
    ])
    expect(repeated.code, repeated.stderr).toBe(0)
    expect(repeated.json.execution.runId).toBe(split.json.execution.runId)
    expect(
      posted.filter(item => item.path.includes('/production/')).length,
    ).toBe(2)
    for (const changed of [
      ['--source-id', 'different-image', '--all-ready'],
      ['--source-id', 'image-asset', '--task-id', 'different-task'],
    ]) {
      const rejected = await cli(baseUrl, dir, [
        'parts',
        'split',
        ...changed,
        '--part-extractor',
        'V1.5',
        '--operation-id',
        operationId,
      ])
      expect(rejected.code).not.toBe(0)
      expect(rejected.json.error?.message).toContain('different inputs')
    }
    const automation = await cli(baseUrl, dir, [
      'production',
      'automation',
      '--input-json',
      JSON.stringify({
        images: [{imageAssetId: 'image-asset'}, {uploadId: 'upload-1'}],
        agentVersion: 'V1.5',
        config: {autoCompose: false},
      }),
    ])
    expect(automation.code, automation.stderr).toBe(0)
    expect(posted.at(-1)?.body.images).toEqual([
      {imageAssetId: 'image-asset'},
      {uploadId: 'upload-1'},
    ])
    expect(posted.map(item => item.path)).toEqual([
      '/api/v2/image/generate',
      '/api/v2/generate/mesh',
      '/api/v1/production/analyze',
      '/api/v1/production/execute',
      '/api/v1/production/automation',
    ])
    expect(creations).toBe(1)
    expect(posted[0].body.source).toEqual({uploadId: 'upload-1'})
    expect(posted[1].body.source).toEqual({resourceId: 'image-asset'})
    for (const item of posted)
      expect(item.key).toBe(
        (item.body.executionContext as {clientOperationId: string})
          .clientOperationId,
      )
    failPreprocess = true
    const failedComparison = await cli(baseUrl, dir, [
      'parts',
      'compare',
      '--source-id',
      'image-asset',
      '--part-extractor',
      'V1.5',
      '--preprocess-prompt',
      'clean up',
    ])
    expect(failedComparison.code, failedComparison.stderr).toBe(1)
    expect(failedComparison.json.preprocessed?.ok).toBe(false)
    expect(failedComparison.json.preprocessed?.error.operationId).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    stallStatuses = true
    const timedOut = await cli(baseUrl, dir, [
      'parts',
      'split',
      '--source-id',
      'image-asset',
      '--part-extractor',
      'V1.5',
      '--all-ready',
      '--timeout-ms',
      '40',
    ])
    expect(timedOut.code, timedOut.stderr).toBe(3)
    expect(timedOut.json.execution.orderIds).toEqual(['order-1'])
    expect(downloads).toEqual(['/image.png'])
    expect(JSON.stringify(image.json)).not.toContain('test-key-not-secret')
  })
})
