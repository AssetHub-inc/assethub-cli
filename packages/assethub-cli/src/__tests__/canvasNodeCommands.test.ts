import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, expect, it} from 'vitest'
import type {CanvasExecution} from '@assethub/api-client'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const parentId = '11111111-1111-4111-8111-111111111111'
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-node-commands-'))
  cleanup.push(() => rm(dir, {recursive: true, force: true}))
  const nodes = [
    {
      nodeId: 'shape:production',
      type: 'production-3d',
      actions: ['mesh.generate', 'mesh.compose'],
    },
    {
      nodeId: 'shape:part-a',
      type: 'preview-asset',
      sourceNodeId: 'shape:production',
      meshStatus: 'idle',
      actions: ['mesh.generate'],
    },
    {
      nodeId: 'shape:part-b',
      type: 'part-group',
      sourceNodeId: 'shape:production',
      meshStatus: 'failed',
      actions: ['mesh.generate'],
    },
    {
      nodeId: 'shape:done',
      type: 'preview-asset',
      sourceNodeId: 'shape:production',
      meshStatus: 'complete',
      actions: ['mesh.generate'],
    },
    {
      nodeId: 'shape:busy',
      type: 'preview-asset',
      sourceNodeId: 'shape:production',
      meshStatus: 'generating',
      actions: ['mesh.generate'],
    },
    {
      nodeId: 'shape:other',
      type: 'mesh-gen',
      sourceNodeId: 'shape:other-parent',
      meshStatus: 'idle',
      actions: ['mesh.generate'],
    },
    {
      nodeId: 'shape:composer',
      type: 'part-composer',
      actions: ['mesh.compose'],
    },
  ]
  const posted: {
    path: string
    body: Record<string, unknown>
    operationId: string
  }[] = []
  const requests: string[] = []
  const runs = new Map<string, CanvasExecution>()
  const fail = {nodeId: ''}
  const server = createServer(async (req, res) => {
    const path = req.url!
    requests.push(path)
    const canvas = {
      id: 42,
      name: 'Existing canvas',
      ownerId: 'org-1',
      url: 'https://app.assethub.io/workflow/42',
    }
    let data: unknown
    if (path === '/api/v2/capabilities')
      data = {
        ownerId: 'org-1',
        executionContext: {
          status: 'available',
          operations: ['mesh.generate', 'mesh.compose'],
        },
        evaluators: [],
      }
    else if (path === '/api/v2/canvases/42') data = canvas
    else if (path === '/api/v2/canvases/42/nodes') data = {items: nodes}
    else if (path.startsWith('/api/v2/runs/'))
      data = runs.get(path.split('/').at(-1)!)
    else if (['/api/v2/generate/mesh', '/api/v2/mesh/compose'].includes(path)) {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw) as Record<string, unknown>
      const context = body.executionContext as CanvasExecution['context'] & {
        canvasNode: {nodeId: string}
      }
      if (!context?.canvasNode) {
        res.writeHead(400, {'content-type': 'application/json'})
        res.end(
          JSON.stringify({
            success: false,
            error: {code: 'NODE_REQUIRED', message: 'Missing --node context'},
          }),
        )
        return
      }
      const operationId = String(req.headers['idempotency-key'])
      posted.push({path, body, operationId})
      if (fail.nodeId === context.canvasNode.nodeId) {
        res.writeHead(503, {'content-type': 'application/json'})
        res.end(
          JSON.stringify({
            success: false,
            error: {code: 'UNAVAILABLE', message: 'Try again'},
          }),
        )
        return
      }
      const runId = `run-${operationId}`
      const execution: CanvasExecution = runs.get(runId) ?? {
        schemaVersion: 'assethub.execution.v1',
        runId,
        operation: path.endsWith('/compose') ? 'mesh.compose' : 'mesh.generate',
        status: 'completed',
        canvas,
        context,
        input: body,
        outputs: [],
        jobIds: [],
        orderIds: [],
        graphRefs: [],
        ...(path.endsWith('/mesh')
          ? {meshGeneration: {id: `mesh-${operationId}`, progress: 100}}
          : {}),
        history: {status: 'recorded'},
        usage: {reservedCredits: 0, chargedCredits: 0},
        createdAt: new Date().toISOString(),
      }
      runs.set(runId, execution)
      data = {execution}
    } else {
      res.writeHead(400, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: false,
          error: {code: 'UNEXPECTED', message: path},
        }),
      )
      return
    }
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({success: true, data}))
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(
    () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  )
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No test address')
  const run = (args: string[]) =>
    new Promise<{code: number | null; output: string; stderr: string}>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [resolve('packages/assethub-cli/dist/index.js'), ...args],
          {
            env: {
              ...process.env,
              ASSETHUB_API_KEY: 'test-key',
              ASSETHUB_ACCESS_TOKEN: '',
              ASSETHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
              ASSETHUB_CLI_CONFIG: join(dir, 'config.json'),
              ASSETHUB_CLI_STATE_DIR: dir,
            },
          },
        )
        let output = '',
          stderr = ''
        child.stdout.on('data', chunk => {
          output += chunk
        })
        child.stderr.on('data', chunk => {
          stderr += chunk
        })
        child.on('error', reject)
        child.on('close', code => done({code, output, stderr}))
        child.stdin.end()
      },
    )
  return {dir, nodes, posted, requests, runs, fail, run}
}

it('discovers native nodes, generates in place, and composes from persisted production inputs without image imports', async () => {
  const f = await fixture()
  const listing = await f.run(['canvas', 'nodes', '--canvas', '42'])
  expect(listing.code, listing.stderr).toBe(0)
  expect(JSON.parse(listing.output).items[0].nodeId).toBe('shape:production')
  const mesh = await f.run([
    'mesh',
    'generate',
    '--node',
    'shape:part-a',
    '--canvas',
    '42',
    '--operation-id',
    parentId,
    '--wait',
  ])
  expect(mesh.code, mesh.stderr).toBe(0)
  expect(JSON.parse(mesh.output).execution.context.canvasNode).toEqual({
    nodeId: 'shape:part-a',
  })
  expect(JSON.parse(mesh.output).execution.meshGeneration).toEqual({
    id: `mesh-${parentId}`,
    progress: 100,
  })
  expect(f.posted[0].body).toEqual({
    executionContext: {
      canvasId: 42,
      clientOperationId: parentId,
      source: 'cli',
      canvasNode: {nodeId: 'shape:part-a'},
    },
  })
  const journal = JSON.parse(
    await readFile(join(f.dir, 'operations', `${parentId}.json`), 'utf8'),
  )
  expect(journal.body.executionContext.canvasNode.nodeId).toBe('shape:part-a')
  for (const node of ['shape:production', 'shape:composer']) {
    const composed = await f.run([
      'composer',
      'run',
      '--node',
      node,
      '--canvas',
      '42',
      '--mode',
      'quality',
      '--model',
      'v4',
      '--wait',
    ])
    expect(composed.code, composed.stderr).toBe(0)
    const body = f.posted.at(-1)!.body
    expect(body).toMatchObject({
      mode: 'quality',
      agentVersion: 'v4',
      executionContext: {canvasNode: {nodeId: node}},
    })
    expect(body).not.toHaveProperty('parts')
    expect(body).not.toHaveProperty('fullBodyImageAssetId')
  }
  expect(
    f.requests.some(path => /files|import|upload|\/graph/.test(path)),
  ).toBe(false)
  const before = f.posted.length
  f.nodes.splice(0)
  const resumed = await f.run(['runs', 'resume', parentId])
  expect(resumed.code, resumed.stderr).toBe(0)
  expect(f.posted.length).toBe(before)
})

it('pins production child operations and resumes a partial batch without rerunning complete parts or changing node targets', async () => {
  const f = await fixture()
  f.fail.nodeId = 'shape:part-b'
  const args = [
    'mesh',
    'generate',
    '--node',
    'shape:production',
    '--canvas',
    '42',
    '--operation-id',
    parentId,
    '--model-id',
    'saved-model-override',
    '--params-json',
    '{"quality":"high"}',
  ]
  const first = await f.run(args)
  expect(first.code).not.toBe(0)
  expect(first.stderr).toContain(parentId)
  const targets = f.posted.map(
    item =>
      (item.body.executionContext as {canvasNode: {nodeId: string}}).canvasNode
        .nodeId,
  )
  expect(new Set(targets)).toEqual(new Set(['shape:part-a', 'shape:part-b']))
  expect(f.posted[0].body).toMatchObject({
    modelId: 'saved-model-override',
    params: {quality: 'high'},
  })
  const a = f.posted.find(
    item =>
      (item.body.executionContext as {canvasNode: {nodeId: string}}).canvasNode
        .nodeId === 'shape:part-a',
  )!
  const b = f.posted.find(
    item =>
      (item.body.executionContext as {canvasNode: {nodeId: string}}).canvasNode
        .nodeId === 'shape:part-b',
  )!
  expect(a.operationId).not.toBe(b.operationId)
  const before = f.posted.length
  const discoveryReads = f.requests.filter(path =>
    path.endsWith('/nodes'),
  ).length
  f.fail.nodeId = ''
  f.nodes.splice(0)
  const resumed = await f.run(['runs', 'resume', parentId])
  expect(resumed.code, resumed.stderr).toBe(0)
  expect(JSON.parse(resumed.output).executions).toHaveLength(2)
  expect(f.requests.filter(path => path.endsWith('/nodes')).length).toBe(
    discoveryReads,
  )
  expect(f.posted.slice(before).map(item => item.operationId)).toEqual([
    b.operationId,
  ])
  expect(f.posted.at(-1)!.body).toEqual(b.body)
  const repeat = await f.run(args)
  expect(repeat.code, repeat.stderr).toBe(0)
  expect(f.posted.length).toBe(before + 1)
  expect(
    (await readdir(join(f.dir, 'operations'))).filter(file =>
      file.endsWith('.json'),
    ),
  ).toHaveLength(2)
})

it('rejects reusing a node batch ID for composition or another node before dispatch', async () => {
  const f = await fixture()
  const result = await f.run([
    'mesh',
    'generate',
    '--node',
    'shape:production',
    '--canvas',
    '42',
    '--operation-id',
    parentId,
  ])
  expect(result.code, result.stderr).toBe(0)
  const before = f.requests.length
  for (const args of [
    ['composer', 'run', '--node', 'shape:production'],
    ['mesh', 'generate', '--node', 'shape:other'],
  ]) {
    const reuse = await f.run([
      ...args,
      '--canvas',
      '42',
      '--operation-id',
      parentId,
    ])
    expect(reuse.code).not.toBe(0)
    expect(reuse.stderr).toContain('different')
    expect(f.requests.length).toBe(before)
  }
})

it('skips completed and generating leaf nodes and rejects unsupported nodes', async () => {
  const f = await fixture()
  for (const nodeId of ['shape:done', 'shape:busy']) {
    const result = await f.run([
      'mesh',
      'generate',
      '--node',
      nodeId,
      '--canvas',
      '42',
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.output)).toMatchObject({nodeId, skipped: true})
  }
  const invalid = await f.run([
    'mesh',
    'generate',
    '--node',
    'shape:composer',
    '--canvas',
    '42',
  ])
  expect(invalid.code).not.toBe(0)
  expect(f.posted).toEqual([])
})

it('reports the parent batch ID on wait timeout so resume retains every child', async () => {
  const f = await fixture()
  const result = await f.run([
    'mesh',
    'generate',
    '--node',
    'shape:production',
    '--canvas',
    '42',
    '--operation-id',
    parentId,
  ])
  expect(result.code, result.stderr).toBe(0)
  for (const run of f.runs.values()) run.status = 'running'
  const resumed = await f.run([
    'runs',
    'resume',
    parentId,
    '--wait',
    '--timeout-ms',
    '10',
    '--interval-ms',
    '1',
  ])
  expect(resumed.code, resumed.stderr).toBe(3)
  expect(JSON.parse(resumed.output).operationId).toBe(parentId)
  expect(f.posted).toHaveLength(2)
})

it.each([
  ['mesh', 'generate', '--source-url', 'https://example.com/source.png'],
  ['mesh', 'generate', '--input-json', '{}'],
  ['mesh', 'generate', '--upload-id', 'upload_1'],
  ['mesh', 'generate', '--from-node', 'graph/node', '--graph-revision', '1'],
  ['composer', 'run', '--part', 'mesh_1', '--reference', 'image_1'],
  ['composer', 'run', '--input-json', '{}'],
  ['composer', 'run', '--from-run', 'old-run'],
])(
  'rejects conflicting node inputs before any request: %j',
  async (...args) => {
    const f = await fixture()
    const result = await f.run([
      ...args,
      '--node',
      'shape:production',
      '--canvas',
      '42',
    ])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--node')
    expect(f.requests).toEqual([])
  },
)
