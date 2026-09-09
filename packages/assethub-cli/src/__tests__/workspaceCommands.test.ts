import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {expect, it} from 'vitest'

it('uses the authenticated active workspace after environment auth overrides a saved profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-member-scope-'))
  const savedId = '184e8530-b362-45c7-9064-2b03b6f95b24'
  const activeId = '284e8530-b362-45c7-9064-2b03b6f95b24'
  const targets: string[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const workspaceId = req.url?.split('/')[3]
    let data: unknown
    if (req.url === '/api/workspaces') data = {userId: activeId, workspaces: [
      {id: savedId, name: 'Saved', type: 'team', role: 'admin', active: false},
      {id: activeId, name: 'Active', type: 'team', role: 'admin', active: true},
    ]}
    else {
      targets.push(workspaceId ?? '')
      if (req.method === 'GET') data = {workspaceId, members: []}
      if (req.method === 'POST') data = {workspaceId, userId: activeId, email: body.email, role: body.role, status: 'invited'}
      if (req.method === 'PATCH') data = {workspaceId, userId: body.userId, role: body.role, updated: true}
      if (req.method === 'DELETE') data = {workspaceId, userId: body.userId, removed: true}
    }
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify(data))
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const configPath = join(dir, 'config.json')
  const run = (args: string[], overrideToken = 'environment-user-token') => new Promise<Record<string, unknown>>((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/assethub-cli/dist/index.js'), 'workspace', ...args], {env: {
      ...process.env, ASSETHUB_CLI_CONFIG: configPath, ASSETHUB_ACCESS_TOKEN: overrideToken,
      ASSETHUB_API_BASE_URL: baseUrl, ASSETHUB_WORKSPACE_MFA: '', ASSETHUB_API_KEY: '',
    }})
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    child.once('error', reject)
    child.once('close', code => {
      try { expect(code, errors).toBe(0); done(JSON.parse(output)) } catch (error) { reject(error) }
    })
    child.stdin.end()
  })
  try {
    for (const storedOrigin of [baseUrl, 'https://other.assethub.io']) {
      await writeFile(configPath, JSON.stringify({defaultProfile: 'saved', profiles: {saved: {baseUrl: storedOrigin, accessToken: 'saved-user-token', workspaceId: savedId}}}))
      await run(['members'])
      await run(['invite', '--email', 'new@example.com'])
      await run(['set-role', activeId, '--role', 'user'])
      await run(['remove-member', activeId])
      expect(await run(['get'])).toMatchObject({id: activeId})
      expect(targets.splice(0)).toEqual([activeId, activeId, activeId, activeId])
      await run(['members', '--workspace', savedId])
      expect(targets.splice(0)).toEqual([savedId])
    }
    await writeFile(configPath, JSON.stringify({defaultProfile: 'saved', profiles: {saved: {baseUrl, accessToken: 'saved-user-token', workspaceId: savedId}}}))
    await run(['members'], '')
    await run(['members', '--profile', 'saved'])
    expect(targets).toEqual([savedId, savedId])
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    await rm(dir, {recursive: true, force: true})
  }
})

it.each([false, true])(
  'logs in, selects a workspace and scopes the next canvas command (supplied key: %s)',
  async suppliedKey => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-workspace-cli-'))
    const workspaceId = '184e8530-b362-45c7-9064-2b03b6f95b24'
    const token = 'private-user-token-for-test'
    const key = 'private-selected-org-key-for-test'
    const mfaProof = 'private-signed-workspace-proof'
    let requireMfa = false
    let keysCreated = 0
    const created = new Set<string>()
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      let data: unknown
      const expectedToken = req.url?.startsWith('/api/workspaces') ? token : key
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.writeHead(401, {'content-type': 'application/json'})
        res.end(
          JSON.stringify({
            success: false,
            error: {message: 'Wrong authentication scope'},
          }),
        )
        return
      }
      if (req.url?.startsWith('/api/workspaces')) {
        if (
          requireMfa &&
          req.headers.cookie !== `ah_workspace_mfa=${mfaProof}`
        ) {
          res.writeHead(403, {'content-type': 'application/json'})
          res.end(
            JSON.stringify({error: {message: 'Missing workspace MFA proof'}}),
          )
          return
        }
        if (req.url === '/api/workspaces' && req.method === 'GET')
          data = {
            userId: 'user-1',
            workspaces: [
              {
                id: workspaceId,
                name: 'Agent org',
                type: 'team',
                role: suppliedKey ? 'user' : 'admin',
                active: false,
              },
            ],
          }
        else if (req.url === '/api/workspaces' && req.method === 'POST') {
          const op = String(req.headers['idempotency-key'])
          data = {
            workspace: {id: workspaceId, name: body.name},
            created: !created.has(op),
          }
          created.add(op)
        } else if (req.url === '/api/workspaces/select')
          data = {
            workspaceId: body.workspaceId,
            selected: true,
            mfa: {status: requireMfa ? 'complete' : 'not_required'},
          }
        else if (req.url.endsWith('/members')) {
          if (req.method === 'GET') data = {workspaceId, members: [{userId: workspaceId, email: 'member@example.com', name: 'Member', role: 'user'}]}
          if (req.method === 'POST') data = {workspaceId, userId: workspaceId, email: body.email, role: body.role, status: 'invited'}
          if (req.method === 'PATCH') data = {workspaceId, userId: body.userId, role: body.role, updated: true}
          if (req.method === 'DELETE') data = {workspaceId, userId: body.userId, removed: true}
        }
        else if (req.url.endsWith('/api-keys')) {
          keysCreated++
          data = {
            apiKey: {
              id: 'key-1',
              key,
              name: body.name,
              workspaceId,
              lastFour: 'test',
            },
          }
        }
      } else {
        if (req.url === '/api/v2/capabilities')
          data = {
            ownerId: workspaceId,
            executionContext: {status: 'available', operations: []},
            evaluators: [],
          }
        else if (req.url === '/api/v2/canvases/42')
          data = {
            id: 42,
            name: 'Selected org canvas',
            ownerId: workspaceId,
            url: 'https://app.assethub.io/workflow/42',
          }
        data = {success: true, data}
      }
      res.writeHead(data ? 200 : 404, {'content-type': 'application/json'})
      res.end(JSON.stringify(data ?? {error: {message: 'Not found'}}))
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing server address')
    const configPath = join(dir, 'config.json')
    const cli = (args: string[], input = '', mfa = '') =>
      new Promise<Record<string, unknown>>((done, reject) => {
        const child = spawn(
          process.execPath,
          [resolve('packages/assethub-cli/dist/index.js'), ...args],
          {
            env: {
              ...process.env,
              ASSETHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
              ASSETHUB_API_KEY: suppliedKey ? key : 'old-environment-org-key',
              ASSETHUB_ACCESS_TOKEN: '',
              ASSETHUB_WORKSPACE_MFA: mfa,
              ASSETHUB_CLI_CONFIG: configPath,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
        let output = '',
          errors = ''
        child.stdout.on('data', chunk => {
          output += chunk
        })
        child.stderr.on('data', chunk => {
          errors += chunk
        })
        child.once('error', reject)
        child.once('close', code => {
          try {
            expect(code, errors).toBe(0)
            expect(output + errors).not.toContain(token)
            expect(output + errors).not.toContain(key)
            expect(output + errors).not.toContain(mfaProof)
            done(JSON.parse(output))
          } catch (error) {
            reject(error)
          }
        })
        child.stdin.end(input)
      })
    try {
      requireMfa = true
      await cli(['auth', 'login', '--access-token-stdin'], token, mfaProof)
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
      const operationId = '284e8530-b362-45c7-9064-2b03b6f95b24'
      expect(
        await cli([
          'workspace',
          'create',
          '--name',
          'Agent org',
          '--operation-id',
          operationId,
        ]),
      ).toMatchObject({created: true})
      expect(
        await cli([
          'workspace',
          'create',
          '--name',
          'Agent org',
          '--operation-id',
          operationId,
        ]),
      ).toMatchObject({created: false})
      expect(await cli(['workspace', 'use', workspaceId])).toMatchObject({
        workspaceId,
      })
      await cli(['workspace', 'use', workspaceId])
      expect(keysCreated).toBe(suppliedKey ? 0 : 1)
      expect(await cli(['workspace', 'members'])).toMatchObject({workspaceId, members: [{userId: workspaceId}]})
      expect(await cli(['workspace', 'invite', '--email', 'new@example.com'])).toMatchObject({workspaceId, role: 'user', status: 'invited'})
      expect(await cli(['workspace', 'set-role', workspaceId, '--role', 'admin'])).toMatchObject({workspaceId, role: 'admin', updated: true})
      expect(await cli(['workspace', 'remove-member', workspaceId])).toMatchObject({workspaceId, removed: true})

      expect(await cli(['canvas', 'use', '42'])).toMatchObject({
        ownerId: workspaceId,
      })
      expect(await cli(['canvas', 'get'])).toMatchObject({
        id: 42,
        ownerId: workspaceId,
      })
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.profiles[config.defaultProfile]).toMatchObject({
        workspaceId,
        userId: 'user-1',
        apiKey: key,
        workspaceMfaToken: mfaProof,
      })
    } finally {
      await new Promise<void>(done => server.close(() => done()))
      await rm(dir, {recursive: true, force: true})
    }
  },
)
