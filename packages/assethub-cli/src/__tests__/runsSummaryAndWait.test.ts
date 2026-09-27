import type {CanvasExecution} from '@assethub/api-client'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

const cli = (baseUrl: string, stateDir: string, args: string[]) =>
  new Promise<{code: number | null; stdout: string; stderr: string}>(
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
      child.once('exit', code => resolveResult({code, stdout, stderr}))
    },
  )

const execution: CanvasExecution = {
  schemaVersion: 'assethub.execution.v1',
  runId: 'run_1',
  operation: 'mesh.compose',
  status: 'completed',
  canvas: {id: 7, name: 'c', ownerId: 'o', url: ''},
  jobIds: [],
  orderIds: ['ord_1'],
  graphRefs: [],
  outputs: [{assetId: 'asset_out', mediaType: 'mesh'}],
  history: {status: 'recorded'},
  usage: {reservedCredits: 10, chargedCredits: 8},
  createdAt: '2026-09-08T00:00:00Z',
  input: {},
  context: {canvasId: 7, clientOperationId: 'op', source: 'cli'},
}

const startServer = () => {
  let getRunCalls = 0
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/v2/runs/run_1')) {
      getRunCalls += 1
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({success: true, data: execution}))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return {server, getCalls: () => getRunCalls}
}

const listen = async (server: ReturnType<typeof startServer>['server']) => {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

describe('runs get --summary', () => {
  it('prints a condensed, human-readable summary instead of the full JSON dump', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-runs-summary-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server} = startServer()
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, ['runs', 'get', 'run_1', '--summary'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('runId: run_1')
    expect(result.stdout).toContain('operation: mesh.compose')
    expect(result.stdout).toContain('status: completed')
    expect(result.stdout).toContain('credits: reserved=10 charged=8')
    expect(result.stdout).toContain('output: asset_out')
    // The full JSON dump (an {"execution": ...} object) is not what --summary prints.
    expect(() => JSON.parse(result.stdout)).toThrow()
  })

  it('still prints the full JSON execution when --summary is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-runs-nosummary-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server} = startServer()
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, ['runs', 'get', 'run_1'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({execution: {runId: 'run_1'}})
  })
})

describe('runs wait', () => {
  it('is an alias for runs watch: polls the run and returns once it is terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-runs-wait-'))
    cleanup.push(() => rm(dir, {recursive: true, force: true}))
    const {server, getCalls} = startServer()
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    const baseUrl = await listen(server)

    const result = await cli(baseUrl, dir, ['runs', 'wait', 'run_1', '--interval-ms', '1'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({execution: {runId: 'run_1', status: 'completed'}})
    expect(getCalls()).toBeGreaterThanOrEqual(1)
  })
})
