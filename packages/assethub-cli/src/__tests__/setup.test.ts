import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import {expect, test} from 'vitest'

// A real child process and HTTP boundary catch entrypoint, credential selection,
// protocol, timeout, and output regressions in the artifact users install.
test('diagnoses API/MCP setup and keeps explicit profile credentials isolated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-setup-'))
  const executable = resolve('packages/assethub-cli/dist/index.js')
  const requests: {path: string; auth?: string; method?: string}[] = []
  let apiStatus = 200
  let mcpStatus = 200
  let hang = false
  const server = createServer(async (req, res) => {
    if (hang) return
    if (req.method === 'GET' && req.url?.endsWith('/api/mcp')) {
      res.writeHead(405)
      res.end()
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const rpc = raw ? JSON.parse(raw) : {}
    requests.push({
      path: req.url!,
      auth: req.headers.authorization,
      method: rpc.method,
    })
    const status = req.url?.endsWith('/api/mcp') ? mcpStatus : apiStatus
    if (status !== 200) {
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: false,
          error: {code: 'TEST_ERROR', message: 'sensitive-server-text'},
        }),
      )
    } else if (req.url?.endsWith('/api/mcp')) {
      if (rpc.id == null) {
        res.writeHead(202)
        res.end()
        return
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: {tools: {}},
              serverInfo: {name: 'assethub-test', version: '1'},
            }
          : {
              tools: [
                {
                  name: 'model_list',
                  description: 'List models',
                  inputSchema: {type: 'object'},
                },
              ],
            }
      res.writeHead(200, {'content-type': 'text/event-stream'})
      res.end(
        `event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: rpc.id, result})}\n\n`,
      )
    } else {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: true,
          data: {
            ownerId: 'test-workspace',
            executionContext: {status: 'available', operations: []},
            evaluators: [],
          },
        }),
      )
    }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing test address')
  const origin = `http://127.0.0.1:${address.port}`
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      defaultProfile: 'selected',
      profiles: {
        selected: {apiKey: 'selected-key', baseUrl: origin},
        default: {apiKey: 'default-key', baseUrl: origin},
      },
    }),
  )
  let envOrigin = origin
  let envKey = 'stale-environment-key'
  const invoke = async (...args: string[]) => {
    try {
      const output = await promisify(execFile)(
        process.execPath,
        [executable, ...args],
        {
          env: {
            ...process.env,
            ASSETHUB_CLI_CONFIG: config,
            ASSETHUB_API_KEY: envKey,
            ASSETHUB_API_BASE_URL: envOrigin,
          },
          timeout: 10_000,
        },
      )
      return {...output, code: 0}
    } catch (error) {
      const failed = error as Error & {
        stdout: string
        stderr: string
        code: number
      }
      return {stdout: failed.stdout, stderr: failed.stderr, code: failed.code}
    }
  }
  try {
    const version = await invoke('--version')
    const pkg = JSON.parse(
      await readFile(resolve('packages/assethub-cli/package.json'), 'utf8'),
    )
    expect(version.stdout.trim()).toBe(pkg.version)
    const cursor = await invoke('mcp', 'config', '--client', 'cursor')
    expect(JSON.parse(cursor.stdout).mcpServers.assethub).toEqual({
      url: origin + '/api/mcp',
      headers: {Authorization: 'Bearer ${env:ASSETHUB_API_KEY}'},
    })
    const codex = await invoke('mcp', 'config', '--client', 'codex')
    expect(codex.stdout).toContain('bearer_token_env_var = "ASSETHUB_API_KEY"')
    expect(requests).toHaveLength(0)
    const mountedConfig = await invoke(
      'mcp',
      'config',
      '--client',
      'cursor',
      '--base-url',
      origin + '/mounted/',
    )
    expect(mountedConfig.code).toBe(0)
    expect(JSON.parse(mountedConfig.stdout).mcpServers.assethub.url).toBe(
      origin + '/mounted/api/mcp',
    )
    const mounted = await invoke(
      'doctor',
      '--mcp',
      '--profile',
      'selected',
      '--base-url',
      origin + '/mounted',
    )
    expect(mounted.code).toBe(0)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(r => r.path.startsWith('/mounted/'))).toBe(true)
    requests.length = 0

    envOrigin = 'http://127.0.0.1:1'
    const healthy = await invoke('doctor', '--mcp', '--profile', 'selected')
    expect({
      code: healthy.code,
      stdout: healthy.stdout,
      stderr: healthy.stderr,
      methods: requests.map(r => r.method),
    }).toMatchObject({code: 0})
    const report = JSON.parse(healthy.stdout)
    expect(report.ok).toBe(true)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'api',
          status: 'pass',
          workspaceId: 'test-workspace',
        }),
        expect.objectContaining({name: 'mcp', status: 'pass', toolCount: 1}),
      ]),
    )
    expect(requests.every(r => r.auth === 'Bearer selected-key')).toBe(true)
    expect(requests.some(r => r.method === 'tools/call')).toBe(false)
    expect(healthy.stdout + healthy.stderr).not.toMatch(
      /selected-key|stale-environment-key/,
    )
    requests.length = 0
    const overridden = await invoke(
      'doctor',
      '--profile',
      'selected',
      '--api-key',
      'explicit-key',
    )
    expect(overridden.code).toBe(0)
    expect(requests.every(r => r.auth === 'Bearer explicit-key')).toBe(true)
    expect(requests.length).toBeGreaterThan(0)
    requests.length = 0
    const missingOverride = await invoke(
      'doctor',
      '--profile',
      'missing',
      '--api-key',
      'explicit-key',
    )
    expect(missingOverride.code).toBe(2)
    expect(requests).toHaveLength(0)
    envKey = ''
    envOrigin = origin
    const selected = await invoke('capabilities')
    expect(selected.code).toBe(0)
    expect(requests.every(r => r.auth === 'Bearer selected-key')).toBe(true)
    requests.length = 0
    envKey = 'stale-environment-key'
    for (const flag of ['--api-key', '--profile']) {
      const empty = await invoke('doctor', flag, '')
      expect(empty.code).toBe(2)
      expect(requests).toHaveLength(0)
    }
    const missing = await invoke('doctor', '--profile', 'missing')
    expect(missing.code).toBe(2)
    expect(JSON.parse(missing.stdout).ok).toBe(false)
    expect(requests).toHaveLength(0)

    mcpStatus = 404
    const gated = await invoke('doctor', '--mcp', '--profile', 'selected')
    expect(gated.code).toBe(2)
    expect(JSON.parse(gated.stdout).checks).toContainEqual(
      expect.objectContaining({
        name: 'mcp',
        status: 'fail',
        code: 'MCP_UNAVAILABLE',
      }),
    )
    expect(gated.stdout + gated.stderr).not.toContain('sensitive-server-text')
    apiStatus = 401
    const denied = await invoke('doctor', '--profile', 'selected')
    expect(denied.code).toBe(2)
    expect(JSON.parse(denied.stdout).checks).toContainEqual(
      expect.objectContaining({name: 'api', code: 'UNAUTHORIZED'}),
    )
    const logout = await invoke('auth', 'logout')
    expect(logout.code).toBe(0)
    expect(JSON.parse(logout.stdout).profile).toBe('selected')
    const afterLogout = JSON.parse(await readFile(config, 'utf8'))
    expect(afterLogout.profiles.selected).toBeUndefined()
    expect(afterLogout.profiles.default.apiKey).toBe('default-key')
    // Restore the test-only profile for the independent timeout check.
    await writeFile(
      config,
      JSON.stringify({
        profiles: {selected: {apiKey: 'selected-key', baseUrl: origin}},
      }),
    )
    hang = true
    const timeout = await invoke(
      'doctor',
      '--mcp',
      '--profile',
      'selected',
      '--timeout-ms',
      '100',
    )
    expect(timeout.code).toBe(2)
    expect(
      JSON.parse(timeout.stdout).checks.every(
        (c: {code: string}) => c.code === 'TIMEOUT',
      ),
    ).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(dir, {recursive: true, force: true})
  }
})
