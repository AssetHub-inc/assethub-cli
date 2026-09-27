import type {CanvasExecution} from '@assethub/api-client'
import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
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
  new Promise<{code: number | null; json: any; stderr: string}>(
    (resolveResult, reject) => {
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
    },
  )

const canvas = {id: 42, name: 'One-shot', ownerId: 'org-a', url: 'http://example/workflow/42'}

const meshModel = {
  id: 'meshGen.hunyuan31',
  domain: 'meshGen',
  name: 'Hunyuan 3.1',
  tags: [],
  credits: null,
  creditCost: 12,
  creditPlanId: 'plan',
  defaultCreditCost: 12,
  defaultCreditPlanId: 'plan',
  duration: null,
  type: 'mesh',
  productVersion: null,
  providerFamily: null,
  provider: null,
  providerModel: null,
  apiAvailable: true,
  availability: {
    status: 'available',
    reason: null,
    contractStatus: 'guaranteed',
    guaranteed: true,
    source: 'live-model-catalog',
  },
  apiCapabilities: [],
  options: null,
  deprecated: false,
}

const meshComposerCapabilities = {
  models: [{id: 'v6', label: 'V6', modes: ['quick', 'quality']}],
  defaultModel: 'v6',
  modes: ['quick', 'quality'],
  quotes: [{agentVersion: 'v6', mode: 'quality', creditPlanId: 'plan', credits: 40}],
}

/** Builds a JSON test server that understands the endpoints the one-shot
 * command talks to: capabilities, canvas read, the model/compose catalogs
 * (both dry GETs), production automation submit + batch status, canvas
 * runs listing (for the V6 fallback's mesh<->image pairing), and
 * mesh.compose submit. `onRequest` lets a test observe/override behavior
 * per path. */
const startServer = (options: {
  onRequest?: (path: string, method: string, body: unknown) => unknown | undefined
  /** Merged into the `production automation` POST response's data, e.g. to
   * simulate a server new enough to return `estimatedCostBreakdown` (#8179). */
  automationResultExtra?: Record<string, unknown>
} = {}) => {
  const posted: Array<{path: string; body: Record<string, unknown>}> = []
  const meshExecutions = new Map<string, CanvasExecution>()
  const server = createServer(async (req, res) => {
    const path = req.url!.split('?')[0]
    const method = req.method ?? 'GET'
    const body = ['POST', 'PUT'].includes(method) ? await bodyOf(req) : undefined
    if (options.onRequest) {
      const overridden = options.onRequest(path, method, body)
      if (overridden !== undefined) {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({success: true, data: overridden}))
        return
      }
    }
    let data: unknown
    if (path === '/api/v2/capabilities') {
      data = {
        ownerId: 'org-a',
        executionContext: {
          status: 'available',
          operations: ['production.automation', 'mesh.compose'],
        },
        evaluators: [],
      }
    } else if (path === '/api/v2/canvases/42') {
      data = canvas
    } else if (path === '/api/v2/models') {
      data = {models: [meshModel], creditPlans: []}
    } else if (path === '/api/v2/mesh/compose' && method === 'GET') {
      data = meshComposerCapabilities
    } else if (path === '/api/v2/mesh/compose' && method === 'POST') {
      posted.push({path, body})
      const runId = (body as any).executionContext.clientOperationId
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
        usage: {reservedCredits: 40, chargedCredits: 40},
        createdAt: '2026-09-08T00:00:00Z',
        input: body as Record<string, unknown>,
        resolvedInput: body as Record<string, unknown>,
        context: (body as any).executionContext,
      }
      meshExecutions.set(runId, execution)
      data = {execution}
    } else if (path === '/api/v1/production/automation' && method === 'POST') {
      posted.push({path, body})
      const runId = (body as any).executionContext.clientOperationId
      const execution: CanvasExecution = {
        schemaVersion: 'assethub.execution.v1',
        runId,
        operation: 'production.automation',
        status: 'completed',
        canvas,
        jobIds: [],
        orderIds: ['order-1'],
        graphRefs: [],
        outputs: [],
        history: {status: 'recorded'},
        usage: {reservedCredits: null, chargedCredits: null},
        createdAt: '2026-09-08T00:00:00Z',
        input: body as Record<string, unknown>,
        context: (body as any).executionContext,
      }
      meshExecutions.set(runId, execution)
      data = {
        execution,
        batchId: 'batch-1',
        agentVersion: (body as any).agentVersion,
        estimatedCostCredits: 5,
        images: [
          {
            imageIndex: 0,
            orderId: 'order-1',
            projectId: 1,
            url: 'http://example/order-1',
            runId,
            publicAccessToken: 'tok',
          },
        ],
        ...options.automationResultExtra,
      }
    } else if (path.startsWith('/api/v2/runs/')) {
      data = meshExecutions.get(path.split('/').at(-1)!)
    } else {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({success: true, data}))
  })
  return {server, posted, meshExecutions}
}

const listen = async (server: ReturnType<typeof startServer>['server']) => {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

describe('production run --image (one-shot)', () => {
  it('estimates cost without calling automation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-estimate-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server, posted} = startServer()
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, [
      'production',
      'run',
      '--image',
      'existing-asset-id',
      '--canvas',
      '42',
      '--estimate',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(result.json.estimate.breakdown.meshGeneration).toMatchObject({
      perPart: 12,
      maxParts: 24,
      total: 12 * 24,
    })
    expect(posted.filter(entry => entry.path.includes('/production/automation'))).toEqual([])
  })

  it('refuses when the estimate exceeds --max-cost, before calling automation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-maxcost-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server, posted} = startServer()
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, [
      'production',
      'run',
      '--image',
      'existing-asset-id',
      '--canvas',
      '42',
      '--max-cost',
      '10',
    ])
    expect(result.code).not.toBe(0)
    expect(result.json.error.message).toContain('--max-cost')
    expect(posted.filter(entry => entry.path.includes('/production/automation'))).toEqual([])
  })

  it('runs automation end to end and waits for the batch to finish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-wait-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    let statusCalls = 0
    const {server, posted} = startServer({
      onRequest: path => {
        if (path === '/api/v1/production/automation/batch-1') {
          statusCalls += 1
          const done = statusCalls >= 2
          return {
            batchId: 'batch-1',
            images: [
              {
                orderId: 'order-1',
                projectId: 1,
                imageIndex: 0,
                status: done ? 'completed' : 'in_progress',
                name: null,
                url: null,
                createdAt: '',
                updatedAt: '',
              },
            ],
            summary: {total: 1, completed: done ? 1 : 0, failed: 0, inProgress: done ? 0 : 1},
          }
        }
        return undefined
      },
    })
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, [
      'production',
      'run',
      '--image',
      'existing-asset-id',
      '--canvas',
      '42',
      '--wait',
      '--interval-ms',
      '1',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(result.json.batchId).toBe('batch-1')
    expect(statusCalls).toBeGreaterThanOrEqual(2)
    expect(posted.some(entry => entry.path === '/api/v1/production/automation')).toBe(true)
  })

  it('old server (no estimatedCostBreakdown): falls back to the explicit V6 compose using the mesh<->image pairing from the batch\'s own executions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-v6-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server, posted} = startServer({
      onRequest: path => {
        if (path === '/api/v1/production/automation/batch-1') {
          return {
            batchId: 'batch-1',
            images: [
              {
                orderId: 'order-1',
                projectId: 1,
                imageIndex: 0,
                status: 'completed',
                name: null,
                url: null,
                createdAt: '',
                updatedAt: '',
              },
            ],
            summary: {total: 1, completed: 1, failed: 0, inProgress: 0},
          }
        }
        if (path === '/api/v2/canvases/42/runs') {
          const meshExecution: CanvasExecution = {
            schemaVersion: 'assethub.execution.v1',
            runId: 'mesh-run-1',
            operation: 'mesh.generate',
            status: 'completed',
            canvas,
            jobIds: [],
            orderIds: ['order-1'],
            graphRefs: [],
            outputs: [{assetId: 'mesh-part-1', mediaType: 'mesh'}],
            inputAssets: [
              {assetId: 'part-image-1', mediaType: 'image', sourceAssetId: 'existing-asset-id'},
            ],
            history: {status: 'recorded'},
            usage: {reservedCredits: null, chargedCredits: null},
            createdAt: '2026-09-08T00:00:00Z',
            input: {},
            context: {canvasId: 42, clientOperationId: 'mesh-run-1', source: 'cli'},
          }
          return {items: [meshExecution], nextCursor: null}
        }
        return undefined
      },
    })
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, [
      'production',
      'run',
      '--image',
      'existing-asset-id',
      '--canvas',
      '42',
      '--compose',
      'v6',
      '--wait',
      '--interval-ms',
      '1',
    ])
    expect(result.code, result.stderr).toBe(0)
    const automationPost = posted.find(entry => entry.path === '/api/v1/production/automation')
    expect(automationPost!.body).toMatchObject({
      partComposerAgentVersion: 'part_composer_v6_auto_assemble',
    })
    expect((automationPost!.body as any).config).toBeUndefined()
    const composePost = posted.find(entry => entry.path === '/api/v2/mesh/compose')
    expect(composePost!.body).toMatchObject({
      agentVersion: 'v6',
      parts: [{assetId: 'mesh-part-1', partImageAssetId: 'part-image-1'}],
      fullBodyImageAssetId: 'existing-asset-id',
    })
    expect(result.json.compose).toMatchObject({status: 'completed'})
  })

  it('new server (estimatedCostBreakdown present): trusts the server\'s own V6 compose and never runs the fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-v6-new-server-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server, posted} = startServer({
      automationResultExtra: {
        estimatedTotalCredits: 55,
        estimatedCostBreakdown: {
          split: {perImage: 5, total: 5},
          meshGeneration: {perPart: 10, maxParts: 5, total: 50},
          compose: {perLane: null, lanesPerImage: 1, total: 0},
        },
      },
      onRequest: path => {
        if (path === '/api/v1/production/automation/batch-1') {
          return {
            batchId: 'batch-1',
            images: [
              {
                orderId: 'order-1',
                projectId: 1,
                imageIndex: 0,
                status: 'completed',
                name: null,
                url: null,
                createdAt: '',
                updatedAt: '',
              },
            ],
            summary: {total: 1, completed: 1, failed: 0, inProgress: 0},
          }
        }
        if (path === '/api/v2/canvases/42/runs') {
          throw new Error(
            'the CLI should never list canvas runs when the server already handled V6 compose itself',
          )
        }
        return undefined
      },
    })
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, [
      'production',
      'run',
      '--image',
      'existing-asset-id',
      '--canvas',
      '42',
      '--compose',
      'v6',
      '--wait',
      '--interval-ms',
      '1',
    ])
    expect(result.code, result.stderr).toBe(0)
    const automationPost = posted.find(entry => entry.path === '/api/v1/production/automation')
    expect(automationPost!.body).toMatchObject({
      partComposerAgentVersion: 'part_composer_v6_auto_assemble',
    })
    expect((automationPost!.body as any).config).toBeUndefined()
    // No client-side compose call and no canvas-runs listing: the server did it all in one call.
    expect(posted.find(entry => entry.path === '/api/v2/mesh/compose')).toBeUndefined()
    expect(result.json.compose).toBeUndefined()
    expect(result.json.estimatedTotalCredits).toBe(55)
    expect(result.json.estimatedCostBreakdown).toMatchObject({split: {total: 5}})
  })
})

describe('production run backward compatibility (no --image)', () => {
  it('still exercises the mission-based run flow, untouched, when --image is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-back-compat-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const posted: Array<{path: string; body: unknown}> = []
    const server = createServer(async (req, res) => {
      const path = req.url!.split('?')[0]
      if (path === '/api/v1/production/status/ord_x') {
        data(res, {
          order: {status: 'in_progress'},
          missions: [{tasks: []}],
        })
        return
      }
      if (path === '/api/v1/production/run' && req.method === 'POST') {
        const body = await bodyOf(req)
        posted.push({path, body})
        data(res, {
          orderId: 'ord_x',
          missionId: 'ms_x',
          runId: 'run_x',
          publicAccessToken: 'tok',
          tag: 'tag',
          status: 'executing',
          runMode: 'full_auto',
          maxIterations: 1,
          maxIterationsEnabled: false,
          abVariantCount: 1,
          estimatedCostCredits: 5,
          effectiveOptions: {
            partExtractionMode: null,
            partImageModelVariant: null,
            partImageModelScope: null,
            partImageModelResolvedVia: 'default',
            transformModelVariant: null,
            meshModelIds: [],
          },
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    function data(res: import('node:http').ServerResponse, value: unknown) {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({success: true, data: value}))
    }
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const result = await cli(baseUrl, dir, [
      'production',
      'run',
      '--order-id',
      'ord_x',
      '--mission-id',
      'ms_x',
      '--run-mode',
      'full_auto',
      '--part-extractor',
      'V1.5',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(posted).toHaveLength(1)
    expect(posted[0].body).toMatchObject({orderId: 'ord_x', missionId: 'ms_x', runMode: 'full_auto'})
    expect(result.json.started).toMatchObject({runId: 'run_x'})
  })

  it('rejects the mission flow\'s own required flags exactly as before (no --order-id, no --image)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-oneshot-back-compat-reject-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const result = await cli('http://127.0.0.1:1', dir, ['production', 'run'])
    expect(result.code).not.toBe(0)
    expect(result.json.error.message).toContain('--order-id')
  })
})
