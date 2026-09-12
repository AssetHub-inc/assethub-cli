import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, expect, it} from 'vitest'

const key = `sk_${'a'.repeat(64)}`
const userToken = 'synthetic-user-token'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })

const fixture = async (failure?: {status: number; code: string}, verifiesPersonal = true) => {
  const directory = await mkdtemp(join(tmpdir(), 'assethub-migrated-personal-'))
  cleanup.push(() => rm(directory, {recursive: true, force: true}))
  const configPath = join(directory, 'config.json')
  const requests: {path: string; auth?: string; workspace?: string | string[]}[] = []
  const workspace = (id: string) => ({id, name: id, type: 'team', role: 'owner', active: true})
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    requests.push({path: req.url!, auth: req.headers.authorization, workspace: req.headers['x-assethub-workspace']})
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) as {workspaceId: string} : undefined
    const json = (value: unknown, status = 200) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value)) }
    const personal = req.headers.authorization === `Bearer ${key}`
    if (path.startsWith('/api/workspaces')) {
      if (personal && failure) return json({error: {...failure, message: failure.code}}, failure.status)
      if (path === '/api/workspaces') return json({userId: personal ? 'key-owner' : 'other-user', ...(personal && verifiesPersonal ? {authentication: 'personal'} : {}), workspaces: [workspace('workspace-a')]})
      if (path === '/api/workspaces/select') return json({workspaceId: body!.workspaceId, selected: true, workspace: workspace(body!.workspaceId), mfa: {status: 'not_required'}})
      if (path.endsWith('/api-keys')) return json({apiKey: {id: 'issued', key: 'new-workspace-key', name: 'CLI', lastFour: '-key', workspaceId: 'workspace-a'}})
    }
    if (path === '/api/v2/models') return json({success: true, data: {models: []}})
    if (path === '/api/v2/capabilities') return json({success: true, data: {ownerId: req.headers['x-assethub-workspace'], executionContext: {status: 'available', operations: []}, evaluators: []}})
    return json({error: {code: 'NOT_FOUND', message: 'Unknown route'}}, 404)
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const save = async (authentication?: 'personal') => writeFile(configPath, JSON.stringify({defaultProfile: 'saved', profiles: {saved: {apiKey: key, accessToken: userToken, userId: 'old-user', baseUrl, updatedAt: '2026-09-12T00:00:00Z', ...(authentication ? {authentication} : {})}}}))
  const config = async () => JSON.parse(await readFile(configPath, 'utf8')) as {defaultProfile: string; profiles: Record<string, {apiKey: string; authentication?: string; userId?: string; workspaceId?: string}>}
  const run = (args: string[], input = '', environment: Record<string, string> = {}) => new Promise<{code: number | null; output: string; stderr: string}>((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/assethub-cli/dist/index.js'), ...args], {env: {...process.env, ASSETHUB_CLI_CONFIG: configPath, ASSETHUB_CLI_STATE_DIR: directory, ASSETHUB_API_BASE_URL: baseUrl, ASSETHUB_API_KEY: '', ASSETHUB_ACCESS_TOKEN: '', ASSETHUB_WORKSPACE_MFA: '', ...environment}})
    let output = '', stderr = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => done({code, output, stderr}))
    child.stdin.end(input)
  })
  return {requests, run, save, config, baseUrl}
}

it('discovers a registered legacy key at login and selects two workspaces with its original profile and bearer', async () => {
  const f = await fixture()
  const login = await f.run(['auth', 'login', '--api-key-stdin', '--profile', 'saved', '--skip-verify'], key)
  expect(login.code, login.stderr).toBe(0)
  expect(JSON.parse(login.output)).toMatchObject({authentication: 'personal', userId: 'key-owner', verified: true})
  expect((await f.config()).profiles.saved).toMatchObject({apiKey: key, authentication: 'personal', userId: 'key-owner'})
  for (const id of ['workspace-a', 'workspace-b']) {
    const selected = await f.run(['workspace', 'use', id], '', {ASSETHUB_ACCESS_TOKEN: userToken, ASSETHUB_API_KEY: 'stale-key'})
    expect(selected.code, selected.stderr).toBe(0)
    expect(JSON.parse(selected.output)).toMatchObject({profile: 'saved', workspaceId: id})
    expect(JSON.parse((await f.run(['capabilities'])).output)).toMatchObject({ownerId: id})
  }
  expect(Object.keys((await f.config()).profiles)).toEqual(['saved'])
  expect((await f.config()).profiles.saved.apiKey).toBe(key)
  const status = await f.run(['auth', 'status', '--workspace', 'workspace-c'])
  expect(status.code, status.stderr).toBe(0)
  expect(JSON.parse(status.output)).toMatchObject({authentication: 'personal', workspaceId: 'workspace-c'})
  expect((await f.config()).profiles.saved.workspaceId).toBe('workspace-b')
  expect(f.requests.every(request => request.auth === `Bearer ${key}`)).toBe(true)
  expect(f.requests.some(request => request.path.includes('api-keys') || request.path.includes('/models'))).toBe(false)
})

it.each(['list', 'use', 'status'])('discovers an existing saved legacy key through %s before an old user token', async command => {
  const f = await fixture()
  await f.save()
  const args = command === 'status' ? ['auth', 'status'] : ['workspace', command, ...(command === 'use' ? ['workspace-b'] : [])]
  const result = await f.run(args, '', {ASSETHUB_ACCESS_TOKEN: userToken})
  expect(result.code, result.stderr).toBe(0)
  expect(f.requests.every(request => request.auth === `Bearer ${key}`)).toBe(true)
  expect((await f.config()).profiles.saved).toMatchObject({apiKey: key, authentication: 'personal', userId: 'key-owner'})
  expect(Object.keys((await f.config()).profiles)).toEqual(['saved'])
})

it.each([
  {status: 401, code: 'PERSONAL_KEY_REVOKED'},
  {status: 401, code: 'PERSONAL_KEY_EXPIRED'},
  {status: 403, code: 'FORBIDDEN'},
  {status: 503, code: 'AUTH_UNAVAILABLE'},
  {status: 403, code: 'PERSONAL_KEY_NOT_REGISTERED'},
])('propagates $status $code without trying a user token, models, or issuing a key', async failure => {
  const f = await fixture(failure)
  await f.save()
  for (const args of [['workspace', 'list'], ['workspace', 'use', 'workspace-b'], ['auth', 'status'], ['auth', 'login', '--api-key-stdin', '--skip-verify']]) {
    const result = await f.run(args, key, {ASSETHUB_ACCESS_TOKEN: userToken})
    expect(result.code, result.output).not.toBe(0)
    expect(result.stderr).toContain(failure.code)
  }
  expect(f.requests.every(request => request.auth === `Bearer ${key}` && request.path.startsWith('/api/workspaces'))).toBe(true)
  expect(f.requests.some(request => request.path.includes('api-keys'))).toBe(false)
  expect((await f.config()).profiles.saved.authentication).toBeUndefined()
})

it('never falls back from a previously verified personal profile even for an unregistered response', async () => {
  const f = await fixture({status: 401, code: 'PERSONAL_KEY_NOT_REGISTERED'})
  await f.save('personal')
  for (const args of [['workspace', 'list'], ['workspace', 'use', 'workspace-b'], ['auth', 'status'], ['auth', 'login', '--profile', 'saved', '--api-key-stdin']]) {
    const result = await f.run(args, key, {ASSETHUB_ACCESS_TOKEN: userToken})
    expect(result.code).not.toBe(0)
  }
  expect(f.requests.every(request => request.auth === `Bearer ${key}`)).toBe(true)
  expect(f.requests.every(request => request.path.startsWith('/api/workspaces'))).toBe(true)
})

it('rejects a successful workspace response that does not attest personal authentication', async () => {
  const f = await fixture(undefined, false)
  await f.save()
  const result = await f.run(['workspace', 'list'])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('did not verify personal authentication')
  expect((await f.config()).profiles.saved.authentication).toBeUndefined()
  expect(f.requests.every(request => request.auth === `Bearer ${key}`)).toBe(true)
})

it('uses an explicit profile origin and does not send undiscovered saved keys to an overridden origin', async () => {
  const f = await fixture()
  await f.save()
  const listed = await f.run(['workspace', 'list', '--profile', 'saved'], '', {ASSETHUB_API_KEY: 'other-key', ASSETHUB_ACCESS_TOKEN: userToken, ASSETHUB_API_BASE_URL: 'https://wrong.example'})
  expect(listed.code, listed.stderr).toBe(0)
  expect(f.requests.every(request => request.auth === `Bearer ${key}`)).toBe(true)
  await f.save()
  const other = await fixture()
  const rejected = await f.run(['workspace', 'list', '--base-url', other.baseUrl])
  expect(rejected.code).not.toBe(0)
  expect(other.requests).toEqual([])
})

it('retains legacy login and user-token workspace selection only after the exact unregistered response', async () => {
  const f = await fixture({status: 401, code: 'PERSONAL_KEY_NOT_REGISTERED'})
  const login = await f.run(['auth', 'login', '--api-key-stdin', '--profile', 'saved'], key)
  expect(login.code, login.stderr).toBe(0)
  expect(f.requests.map(request => request.path.split('?')[0])).toEqual(['/api/workspaces', '/api/v2/models'])
  expect((await f.config()).profiles.saved.authentication).toBeUndefined()
  await f.save()
  const selected = await f.run(['workspace', 'use', 'workspace-a'])
  expect(selected.code, selected.stderr).toBe(0)
  expect(f.requests.some(request => request.auth === `Bearer ${userToken}` && request.path.endsWith('/api-keys'))).toBe(true)
})

it('does not probe the unsupported assethub UUID key format', async () => {
  const f = await fixture()
  const result = await f.run(['auth', 'login', '--api-key-stdin'], 'assethub-11111111-1111-4111-8111-111111111111')
  expect(result.code, result.stderr).toBe(0)
  expect(f.requests.map(request => request.path)).toEqual(['/api/v2/models'])
})
