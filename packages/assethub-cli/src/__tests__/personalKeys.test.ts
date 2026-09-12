import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, expect, it} from 'vitest'
import {createAssetHubClient} from '../../../assethub-api-client/src/index.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
const personalKey = 'ah_pat_personal-test-secret'
const workspace = (id: string) => ({id, name: id, type: 'team', role: 'admin', active: true})

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-personal-'))
  cleanup.push(() => rm(dir, {recursive: true, force: true}))
  const configPath = join(dir, 'config.json')
  const requests: {path: string; auth?: string; workspace?: string | string[]}[] = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    requests.push({path: req.url!, auth: req.headers.authorization, workspace: req.headers['x-assethub-workspace']})
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== `Bearer ${personalKey}`)
      return json({error: {code: 'UNAUTHORIZED', message: 'Wrong key'}}, 401)
    if (url.pathname === '/api/workspaces' && req.method === 'GET')
      return json({userId: 'user-1', authentication: 'personal', workspaces: [workspace('workspace-a')], nextCursor: 'next/page'})
    if (url.pathname === '/api/workspaces/select')
      return json({workspaceId: body.workspaceId, selected: true, workspace: workspace(body.workspaceId), mfa: {status: 'not_required'}})
    if (url.pathname.startsWith('/api/workspaces'))
      return json({error: {code: 'SESSION_REQUIRED', message: 'User session required'}}, 403)
    const selected = req.headers['x-assethub-workspace']
    if (!selected) return json({success: false, error: {code: 'WORKSPACE_REQUIRED', message: 'Select a workspace'}}, 400)
    if (url.pathname === '/api/mcp') {
      if (req.method === 'GET') { res.writeHead(405); res.end(); return }
      if (body.id == null) { res.writeHead(202); res.end(); return }
      return json({jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
        ? {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'test', version: '1'}}
        : {tools: [{name: 'model_list', inputSchema: {type: 'object'}}]}})
    }
    if (url.pathname === '/api/v2/test-stream') {
      res.writeHead(200, {'content-type': 'application/x-ndjson'})
      res.end('{"status":"completed"}\n')
      return
    }
    let data: unknown = {items: [], nextCursor: null}
    if (url.pathname === '/api/v2/capabilities') data = {ownerId: selected, executionContext: {status: 'available', operations: ['image.generate']}, evaluators: []}
    if (url.pathname === '/api/v2/models') data = {models: []}
    if (url.pathname === '/api/v2/runs/run-1') data = {
      schemaVersion: 'assethub.execution.v1', runId: 'run-1', operation: 'image.generate', status: 'completed',
      canvas: {id: 42, ownerId: selected, name: 'Canvas', url: 'https://app.assethub.io/workflow/42'},
      history: {status: 'recorded'}, jobIds: [], orderIds: [], graphRefs: [], outputs: [],
      usage: {reservedCredits: null, chargedCredits: null}, createdAt: '2026-09-11T00:00:00Z', input: {},
    }
    if (url.pathname === '/api/v2/canvases/42') data = {id: 42, ownerId: selected, name: 'Canvas', url: 'https://app.assethub.io/workflow/42'}
    json({success: true, data})
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const run = (args: string[], input = '', extraEnv: Record<string, string> = {}) => new Promise<{code: number | null; data: any; stderr: string}>((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/assethub-cli/dist/index.js'), ...args], {env: {
      ...process.env, ASSETHUB_CLI_CONFIG: configPath, ASSETHUB_CLI_STATE_DIR: dir,
      ASSETHUB_API_BASE_URL: baseUrl, ASSETHUB_API_KEY: '', ASSETHUB_ACCESS_TOKEN: '', ASSETHUB_WORKSPACE_MFA: '', ...extraEnv,
    }})
    let output = '', stderr = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => { try { done({code, data: output ? JSON.parse(output) : undefined, stderr}) } catch (error) { reject(error) } })
    child.stdin.end(input)
  })
  return {dir, configPath, baseUrl, requests, run}
}

it('logs in once and selects paginated workspaces using the same personal key and profile', async () => {
  const f = await fixture()
  const login = await f.run(['auth', 'login', '--api-key-stdin', '--profile', 'personal'], personalKey)
  expect(login.code, login.stderr).toBe(0)
  expect(login.data).toMatchObject({authentication: 'personal', userId: 'user-1', verified: true})
  expect(f.requests.map(r => r.path)).toEqual(['/api/workspaces'])
  expect((await f.run(['auth', 'status'])).data).toMatchObject({authentication: 'personal', userId: 'user-1'})
  const listed = await f.run(['workspace', 'list', '--query', 'Studio / A', '--cursor', 'next/page', '--limit', '2'])
  expect(listed.code, listed.stderr).toBe(0)
  expect(listed.data.nextCursor).toBe('next/page')
  const query = new URL(f.requests.at(-1)!.path, f.baseUrl).searchParams
  expect(Object.fromEntries(query)).toEqual({query: 'Studio / A', cursor: 'next/page', limit: '2'})
  for (const id of ['workspace-a', 'workspace-b']) {
    const selected = await f.run(['workspace', 'use', id])
    expect(selected.code, selected.stderr).toBe(0)
    expect(selected.data).toMatchObject({workspaceId: id, profile: 'personal', workspace: {id}})
    expect((await f.run(['capabilities'])).data.ownerId).toBe(id)
    const config = JSON.parse(await readFile(f.configPath, 'utf8'))
    expect(Object.keys(config.profiles)).toEqual(['personal'])
    expect(config).toMatchObject({defaultProfile: 'personal', profiles: {personal: {apiKey: personalKey, userId: 'user-1', workspaceId: id}}})
  }
  expect((await f.run(['workspace', 'get'])).data.id).toBe('workspace-b')
  expect((await f.run(['auth', 'status'])).data.workspaceId).toBe('workspace-b')
  const doctor = await f.run(['doctor', '--mcp'])
  expect(doctor.code, doctor.stderr).toBe(0)
  expect(doctor.data.ok).toBe(true)
  const mcpConfig = await f.run(['mcp', 'config', '--client', 'cursor', '--profile', 'personal'], '', {ASSETHUB_API_BASE_URL: 'https://wrong.example'})
  expect(mcpConfig.data.mcpServers.assethub).toEqual({url: `${f.baseUrl}/api/mcp`, headers: {Authorization: 'Bearer ${env:ASSETHUB_API_KEY}', 'X-AssetHub-Workspace': 'workspace-b'}})
  const before = f.requests.length
  const overridden = await f.run(['capabilities', '--profile', 'personal', '--workspace', 'workspace-c'], '', {ASSETHUB_API_KEY: 'stale-key', ASSETHUB_ACCESS_TOKEN: 'stale-user', ASSETHUB_API_BASE_URL: 'https://wrong.example'})
  expect(overridden.code, overridden.stderr).toBe(0)
  expect(overridden.data.ownerId).toBe('workspace-c')
  expect(f.requests[before].workspace).toBe('workspace-c')
  expect((await f.run(['capabilities'])).data.ownerId).toBe('workspace-b')
  expect((await f.run(['mesh', 'list'])).code).toBe(0)
  expect((await f.run(['canvas', 'get', '42'])).code).toBe(0)
  expect(f.requests.filter(r => !r.path.startsWith('/api/workspaces')).every(r => r.workspace)).toBe(true)
  expect(f.requests.every(r => r.auth === `Bearer ${personalKey}`)).toBe(true)
  expect(f.requests.some(r => r.path.endsWith('/api-keys'))).toBe(false)
  const explicitKey = await f.run(['workspace', 'use', 'workspace-c', '--api-key', personalKey])
  expect(explicitKey.code, explicitKey.stderr).toBe(0)
  expect(explicitKey.data.profile).toBe('personal')
  expect(Object.keys(JSON.parse(await readFile(f.configPath, 'utf8')).profiles)).toEqual(['personal'])
  const requestCount = f.requests.length
  for (const limit of ['0', '101']) {
    expect((await f.run(['workspace', 'list', '--limit', limit])).code).not.toBe(0)
  }
  expect((await f.run(['workspace', 'members'])).code).not.toBe(0)
  expect((await f.run(['workspace', 'create', '--name', 'Denied'])).code).not.toBe(0)
  expect((await f.run(['capabilities', '--base-url', 'https://wrong.example'])).code).not.toBe(0)
  expect(f.requests.length).toBe(requestCount)
})

it('retains workspace scope on SDK JSON, canvas, history and NDJSON transports', async () => {
  const f = await fixture()
  const client = createAssetHubClient({apiKey: personalKey, baseUrl: f.baseUrl, workspaceId: 'workspace-b'})
  await client.v2.getCapabilities()
  await client.v2.getCanvas(42)
  await client.v2.listMeshes()
  // No public endpoint currently uses the retained streaming transport.
  const stream = (client as unknown as {requestNdJson: (version: string, path: string, init: RequestInit) => AsyncGenerator<unknown>}).requestNdJson('v2', '/test-stream', {method: 'GET'})
  const events = []
  for await (const event of stream) events.push(event)
  expect(events).toEqual([{status: 'completed'}])
  expect(f.requests.map(r => r.workspace)).toEqual(['workspace-b', 'workspace-b', 'workspace-b', 'workspace-b'])
})

it('resumes saved operations only in their selected workspace with the same personal key', async () => {
  const f = await fixture()
  await f.run(['auth', 'login', '--api-key-stdin'], personalKey)
  await f.run(['workspace', 'use', 'workspace-a'])
  const operationId = '11111111-1111-4111-8111-111111111111'
  await mkdir(join(f.dir, 'operations'))
  await writeFile(join(f.dir, 'operations', `${operationId}.json`), JSON.stringify({
    operation: 'image.generate', operationId, baseUrl: f.baseUrl, ownerId: 'workspace-b', runId: 'run-1',
    body: {prompt: 'test', executionContext: {canvasId: 42, clientOperationId: operationId, source: 'cli'}},
  }))
  const wrongWorkspace = await f.run(['runs', 'resume', operationId])
  expect(wrongWorkspace.code).not.toBe(0)
  expect(wrongWorkspace.stderr).toContain('different organization')
  expect(f.requests.some(r => r.path.includes('/runs/'))).toBe(false)
  const start = f.requests.length
  const resumed = await f.run(['runs', 'resume', operationId, '--workspace', 'workspace-b'])
  expect(resumed.code, resumed.stderr).toBe(0)
  expect(resumed.data.execution).toMatchObject({runId: 'run-1', canvas: {ownerId: 'workspace-b'}})
  expect(f.requests.slice(start).every(r => r.workspace === 'workspace-b' && r.auth === `Bearer ${personalKey}`)).toBe(true)
})
