import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {afterEach, expect, test} from 'vitest'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

const cli = (baseUrl: string, stateDir: string, args: string[]) =>
  promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), ...args],
    {
      env: {
        ...process.env,
        ASSETHUB_API_KEY: 'test-key',
        ASSETHUB_API_BASE_URL: baseUrl,
        ASSETHUB_CLI_STATE_DIR: stateDir,
        ASSETHUB_CLI_CONFIG: join(stateDir, 'auth.json'),
      },
    },
  )

const run = (status: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 'assethub.execution.v1',
  runId: 'run-1',
  operation: 'production.analyze',
  status,
  canvas: {
    id: 7,
    name: 'c',
    ownerId: 'o',
    createdAt: '',
    url: 'https://app.assethub.io/workflow/7',
  },
  jobIds: [],
  orderIds: ['order-1'],
  graphRefs: [],
  outputs: [],
  history: {status: status === 'running' ? 'pending' : 'recorded'},
  usage: {reservedCredits: null, chargedCredits: null},
  createdAt: '',
  input: {},
  context: {canvasId: 7, clientOperationId: 'op', source: 'cli'},
  evaluations: [],
  ...extra,
})

const progress = (partsReady: number) => ({
  kind: 'character_assembly',
  phase: 'parts',
  step: 3,
  steps: 4,
  summary: `Step 3 of 4 · Making the parts · ${partsReady} of 2 meshes ready`,
  headline: `${partsReady} of 2 meshes ready`,
  partsReady,
  partsTotal: 2,
  parts: [
    {
      label: 'Body',
      state: 'ready',
      stateText: 'Ready',
      drawingAttempts: 1,
      meshAttempts: 1,
    },
    {
      label: 'Coat',
      state: partsReady === 2 ? 'ready' : 'meshing',
      stateText: partsReady === 2 ? 'Ready' : 'Meshing',
      drawingAttempts: 1,
      meshAttempts: 1,
    },
  ],
  rounds: [],
})

const resumes: string[] = []
const serve = async (responses: unknown[]) => {
  resumes.length = 0
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-runs-progress-cli-'))
  let reads = 0
  const server = createServer((req, res) => {
    if (req.url === '/files/character.glb') {
      res.writeHead(200, {'content-type': 'model/gltf-binary'})
      res.end('glb-bytes')
      return
    }
    if (req.url === '/api/v2/runs/order-no-run-access') {
      res.writeHead(403, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Canvas execution is not enabled',
          },
        }),
      )
      return
    }
    if (
      req.method === 'POST' &&
      req.url === '/api/v2/production/order-no-run-access/resume'
    ) {
      resumes.push('order-no-run-access')
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: true,
          data: {orderId: 'order-no-run-access', resumeCount: 1},
        }),
      )
      return
    }
    if (
      req.method === 'POST' &&
      req.url === '/api/v2/production/order-1/resume'
    ) {
      resumes.push('order-1')
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: true,
          data: {
            orderId: 'order-1',
            graphId: 'order-1',
            resumeCount: 1,
            epoch: 1,
            resetRuns: 0,
            alreadyResumed: false,
          },
        }),
      )
      return
    }
    if (req.url !== '/api/v2/runs/run-1') {
      res.writeHead(404)
      res.end()
      return
    }
    const data = responses[Math.min(reads, responses.length - 1)]
    reads += 1
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({success: true, data}))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  return {baseUrl: `http://127.0.0.1:${address.port}`, stateDir}
}

test('runs watch prints the V4 summary only when it changes, then the receipt with progress', async () => {
  const {baseUrl, stateDir} = await serve([
    run('running', {progress: progress(1)}),
    run('running', {progress: progress(1)}),
    run('running', {progress: progress(2)}),
    run('completed', {
      outputs: [{assetId: 'mesh-1', mediaType: 'mesh'}],
      progress: {...progress(2), phase: 'done', step: 4},
    }),
  ])

  const result = await cli(baseUrl, stateDir, [
    'runs',
    'watch',
    'run-1',
    '--interval-ms',
    '1',
  ])

  // Each line starts with the local time; part states (meshing) do not print.
  expect(
    result.stderr.trim().split('\n').map(line => line.replace(/^\d\d:\d\d {2}/, '')),
  ).toEqual([
    'run run-1  3/4 Making the parts · 1 of 2 meshes ready',
    'run run-1  3/4 Making the parts · 2 of 2 meshes ready',
    'run run-1  ✓ done · 3/4 Making the parts · 2 of 2 meshes ready',
  ])
  expect(JSON.parse(result.stdout).execution).toMatchObject({
    status: 'completed',
    progress: {kind: 'character_assembly', phase: 'done', partsReady: 2},
  })
})

test('runs get --download --out-dir saves the run outputs, like jobs get', async () => {
  const {baseUrl: fileServer} = await serve([])
  const {baseUrl, stateDir} = await serve([
    run('completed', {
      outputs: [
        {
          assetId: 'mesh-1',
          mediaType: 'mesh',
          url: `${fileServer}/files/character.glb`,
        },
      ],
    }),
  ])
  const outDir = join(stateDir, 'out')

  const result = await cli(baseUrl, stateDir, [
    'runs',
    'get',
    'run-1',
    '--download',
    '--out-dir',
    outDir,
  ])

  expect(JSON.parse(result.stdout).downloads.files).toEqual([
    expect.objectContaining({path: join(outDir, '001-character.glb')}),
  ])
  expect(await readFile(join(outDir, '001-character.glb'), 'utf8')).toBe(
    'glb-bytes',
  )
})

test('production resume takes a run ID and --wait follows the resumed run', async () => {
  const {baseUrl, stateDir} = await serve([
    run('failed'),
    run('running', {
      progress: {
        ...progress(2),
        phase: 'assembly',
        step: 4,
        summary:
          'Step 4 of 4 · Assembling in Blender · round 1: building and checking…',
      },
    }),
    run('completed', {outputs: [{assetId: 'mesh-1', mediaType: 'mesh'}]}),
  ])

  const result = await cli(baseUrl, stateDir, [
    'production',
    'resume',
    'run-1',
    '--wait',
    '--interval-ms',
    '1',
  ])

  expect(resumes).toEqual(['order-1'])
  expect(result.stderr).toContain(
    'run run-1  4/4 Assembling in Blender · round 1: building and checking…',
  )
  expect(JSON.parse(result.stdout)).toMatchObject({
    resume: {orderId: 'order-1', resumeCount: 1},
    execution: {runId: 'run-1', status: 'completed'},
  })
})

test('production resume still takes an order ID, and --wait asks for the run ID', async () => {
  const {baseUrl, stateDir} = await serve([])

  const result = await cli(baseUrl, stateDir, [
    'production',
    'resume',
    'order-1',
  ])
  expect(resumes).toEqual(['order-1'])
  expect(JSON.parse(result.stdout)).toMatchObject({
    orderId: 'order-1',
    resumeCount: 1,
  })

  await expect(
    cli(baseUrl, stateDir, ['production', 'resume', 'order-1', '--wait']),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('--wait follows a run: pass the run ID'),
  })
})

test('production resume <order-id> still resumes when the run lookup is refused', async () => {
  const {baseUrl, stateDir} = await serve([])

  const result = await cli(baseUrl, stateDir, [
    'production',
    'resume',
    'order-no-run-access',
  ])

  expect(resumes).toEqual(['order-no-run-access'])
  expect(JSON.parse(result.stdout)).toMatchObject({
    orderId: 'order-no-run-access',
  })
})
