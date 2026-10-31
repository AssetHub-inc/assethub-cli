import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, expect, it} from 'vitest'

// Exercises the built CLI end to end: `auth login --no-browser` prints the
// authorize URL, this test plays the browser, and a fake AssetHub answers the
// code exchange.
const cli = resolve(fileURLToPath(import.meta.url), '../../../dist/index.js')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

type Variant = 'v2' | 'legacy' | 'personal' | 'personal-nostart' | 'personal-mfa'

const fixture = async (tokenStatus = 200, variant: Variant = 'v2') => {
  const legacy = variant === 'legacy'
  const directory = await mkdtemp(join(tmpdir(), 'assethub-browser-login-'))
  cleanup.push(() => rm(directory, {recursive: true, force: true}))
  const configPath = join(directory, 'config.json')
  const exchanges: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(JSON.stringify(value))
    }
    if (req.url === '/api/v2/cli/auth/token' && req.method === 'POST') {
      exchanges.push(JSON.parse(raw))
      if (tokenStatus !== 200)
        return json(
          {success: false, error: {code: 'NOT_FOUND', message: 'Not found'}},
          tokenStatus,
        )
      if (variant.startsWith('personal'))
        return json({
          success: true,
          data: {
            version: 2,
            mode: 'personal',
            personalKey: {
              id: 'pat-1',
              name: 'AssetHub CLI',
              secret: 'ah_pat_personal-secret',
              lastFour: 'cret',
              expiresAt: '2027-01-01T00:00:00.000Z',
            },
            userId: 'user-1',
            startWorkspace:
              variant === 'personal-nostart'
                ? null
                : {id: 'ws-1', name: 'Studio'},
            workspaces: [],
            failed: [],
          },
        })
      if (legacy)
        return json({
          success: true,
          data: {
            apiKey: {
              id: 'key-1',
              key: 'assethub-minted-secret',
              lastFour: 'cret',
              name: 'AssetHub CLI on host (2026-10-31)',
              workspaceId: 'ws-1',
            },
            workspace: {id: 'ws-1', name: 'Studio'},
          },
        })
      return json({
        success: true,
        data: {
          version: 2,
          workspaces: [
            {
              id: 'ws-1',
              name: 'Studio',
              apiKey: {
                id: 'key-1',
                name: 'AssetHub CLI on host (2026-10-31)',
                secret: 'assethub-minted-secret',
                lastFour: 'cret',
              },
            },
            {
              id: 'ws-2',
              name: 'CC2',
              apiKey: {
                id: 'key-2',
                name: 'AssetHub CLI on host (2026-10-31)',
                secret: 'assethub-second-secret',
                lastFour: 'cret',
              },
            },
          ],
          failed: [{id: 'ws-3', reason: 'NOT_ADMIN'}],
        },
      })
    }
    if (req.url === '/api/workspaces/select')
      return json({
        workspaceId: (JSON.parse(raw) as {workspaceId: string}).workspaceId,
        selected: true,
        mfa: {
          status:
            variant === 'personal-mfa' ? 'verify_required' : 'not_required',
        },
      })
    if (req.url === '/api/v2/models')
      return json({success: true, data: {models: []}})
    return json({error: {code: 'NOT_FOUND'}}, 404)
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
    throw new Error('Missing address')
  const baseUrl = `http://127.0.0.1:${address.port}`

  /** Run the CLI; when the authorize URL appears on stderr, "approve" it. */
  const run = (
    args: string[],
    input = '',
    approve = true,
    extraEnv: Record<string, string> = {},
  ) =>
    new Promise<{
      code: number | null
      output: string
      stderr: string
      authorizeUrl?: URL
    }>((done, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          ASSETHUB_CLI_CONFIG: configPath,
          ASSETHUB_CLI_STATE_DIR: directory,
          ASSETHUB_API_BASE_URL: baseUrl,
          ASSETHUB_API_KEY: '',
          ASSETHUB_ACCESS_TOKEN: '',
          ASSETHUB_NO_AUTO_UPDATE: '1',
          CI: '',
          ...extraEnv,
        },
      })
      let output = ''
      let stderr = ''
      let authorizeUrl: URL | undefined
      child.stdout.on('data', chunk => {
        output += chunk
      })
      child.stderr.on('data', chunk => {
        stderr += chunk
        const match = /(http:\/\/\S+\/cli\/authorize\?\S+)/.exec(stderr)
        if (match && !authorizeUrl) {
          authorizeUrl = new URL(match[1]!)
          if (approve)
            void fetch(
              `http://127.0.0.1:${authorizeUrl.searchParams.get('port')}/callback?code=one-time&state=${authorizeUrl.searchParams.get('state')}`,
            )
        }
      })
      child.once('error', reject)
      child.once('close', code => done({code, output, stderr, authorizeUrl}))
      child.stdin.end(input)
    })
  const config = async () =>
    JSON.parse(await readFile(configPath, 'utf8')) as {
      defaultProfile: string
      profiles: Record<string, Record<string, unknown>>
    }
  return {run, config, exchanges, baseUrl}
}

it('logs in through the browser and saves the minted key like --api-key-stdin', async () => {
  const f = await fixture()
  const result = await f.run(['auth', 'login', '--no-browser'])
  expect(result.code).toBe(0)
  const url = result.authorizeUrl!
  expect(url.origin).toBe(f.baseUrl)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(f.exchanges).toHaveLength(1)
  const exchange = f.exchanges[0] as {
    code: string
    code_verifier: string
    redirect_port: number
  }
  expect(exchange.code).toBe('one-time')
  expect(
    createHash('sha256').update(exchange.code_verifier).digest('base64url'),
  ).toBe(url.searchParams.get('code_challenge'))
  expect(exchange.redirect_port).toBe(Number(url.searchParams.get('port')))
  // Never in argv/URL/stdout/stderr
  expect(url.toString()).not.toContain('assethub-minted-secret')
  const everything = result.output + result.stderr
  expect(everything).not.toContain('assethub-minted-secret')
  expect(everything).not.toContain('assethub-second-secret')
  expect(JSON.parse(result.output)).toMatchObject({
    success: true,
    authentication: 'browser',
    defaultProfile: 'ws-studio-ws1',
    profile: 'ws-studio-ws1',
    workspace: {id: 'ws-1', name: 'Studio'},
    apiKey: {lastFour: 'cret'},
    profiles: [
      {profile: 'ws-studio-ws1', workspace: {id: 'ws-1', name: 'Studio'}},
      {profile: 'ws-cc2-ws2', workspace: {id: 'ws-2', name: 'CC2'}},
    ],
    failed: [{id: 'ws-3', reason: 'NOT_ADMIN'}],
  })
  expect(result.stderr).toContain('Logged in to 2 workspaces:')
  expect(result.stderr).toContain('ws-cc2-ws2')
  expect(result.stderr).toContain('ws-3  NOT_ADMIN')
  expect(result.stderr).toContain('assethub <command> --profile <name>')
  const saved = await f.config()
  expect(saved.defaultProfile).toBe('ws-studio-ws1')
  expect(saved.profiles['ws-studio-ws1']).toMatchObject({
    apiKey: 'assethub-minted-secret',
    baseUrl: f.baseUrl,
  })
  expect(saved.profiles['ws-cc2-ws2']).toMatchObject({
    apiKey: 'assethub-second-secret',
  })

  // The stdin path is unchanged and writes the default profile.
  const stdinLogin = await f.run(
    ['auth', 'login', '--api-key-stdin'],
    'manual-key',
  )
  expect(stdinLogin.code).toBe(0)
  expect(stdinLogin.authorizeUrl).toBeUndefined()
  expect((await f.config()).profiles.default).toMatchObject({
    apiKey: 'manual-key',
  })
}, 30_000)

it('saves the first workspace under an explicit --profile and makes it default', async () => {
  const f = await fixture()
  const result = await f.run([
    'auth',
    'login',
    '--no-browser',
    '--profile',
    'mine',
  ])
  expect(result.code).toBe(0)
  const saved = await f.config()
  expect(saved.defaultProfile).toBe('mine')
  expect(saved.profiles.mine).toMatchObject({apiKey: 'assethub-minted-secret'})
  expect(saved.profiles['ws-cc2-ws2']).toMatchObject({
    apiKey: 'assethub-second-secret',
  })
  expect(saved.profiles['ws-studio-ws1']).toBeUndefined()
}, 30_000)

it('still saves one ws- profile from a legacy v1 server', async () => {
  const f = await fixture(200, 'legacy')
  const result = await f.run(['auth', 'login', '--no-browser'])
  expect(result.code).toBe(0)
  const saved = await f.config()
  expect(saved.defaultProfile).toBe('ws-studio-ws1')
  expect(Object.keys(saved.profiles)).toEqual(['ws-studio-ws1'])
  expect(result.output + result.stderr).not.toContain('assethub-minted-secret')
}, 30_000)

it('prints the --api-key-stdin fallback when the server does not offer browser login', async () => {
  const f = await fixture(404)
  const result = await f.run(['auth', 'login', '--no-browser'])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('Browser login is not available')
  expect(result.stderr).toContain('assethub auth login --api-key-stdin')
}, 30_000)

it('keeps the bare login error in CI', async () => {
  const f = await fixture()
  const result = await f.run(['auth', 'login'], '', false, {CI: 'true'})
  expect(result.code).not.toBe(0)
  expect(result.authorizeUrl).toBeUndefined()
  expect(result.stderr).toContain('API key is empty')
}, 30_000)

// Agent shells and `!` prompts have no TTY; a bare login there used to fail
// with "API key is empty", so starting the browser flow changes no working path.
it('starts browser login for a bare login without a TTY outside CI', async () => {
  const f = await fixture()
  const result = await f.run(['auth', 'login'], '', true, {
    // keep the test from launching a real browser
    ASSETHUB_BROWSER_LOGIN_NO_OPEN: '1',
  })
  expect(result.code).toBe(0)
  expect(result.authorizeUrl).toBeDefined()
  expect(f.exchanges).toHaveLength(1)
  expect((await f.config()).profiles['ws-studio-ws1']).toMatchObject({
    apiKey: 'assethub-minted-secret',
  })
}, 30_000)

it('saves a personal key like a personal-key login and selects the start workspace', async () => {
  const f = await fixture(200, 'personal')
  const result = await f.run(['auth', 'login', '--no-browser'])
  expect(result.code).toBe(0)
  expect(result.output + result.stderr).not.toContain('ah_pat_personal-secret')
  expect(JSON.parse(result.output)).toMatchObject({
    success: true,
    authentication: 'personal',
    mode: 'personal',
    profile: 'default',
    userId: 'user-1',
    apiKey: {id: 'pat-1', lastFour: 'cret'},
    workspace: {id: 'ws-1', name: 'Studio'},
  })
  expect(result.stderr).toContain('Logged in with a personal API key (...cret)')
  expect(result.stderr).toContain('assethub workspace use <id>')
  const saved = await f.config()
  expect(saved.defaultProfile).toBe('default')
  expect(saved.profiles.default).toMatchObject({
    apiKey: 'ah_pat_personal-secret',
    authentication: 'personal',
    userId: 'user-1',
    workspaceId: 'ws-1',
    baseUrl: f.baseUrl,
  })
}, 30_000)

it('saves a personal key without a start workspace', async () => {
  const f = await fixture(200, 'personal-nostart')
  const result = await f.run(['auth', 'login', '--no-browser', '--profile', 'me'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.output).workspace).toBeNull()
  const saved = await f.config()
  expect(saved.defaultProfile).toBe('me')
  expect(saved.profiles.me?.workspaceId).toBeUndefined()
}, 30_000)

it('keeps the personal profile and warns when the start workspace needs MFA', async () => {
  const f = await fixture(200, 'personal-mfa')
  const result = await f.run(['auth', 'login', '--no-browser'])
  expect(result.code).toBe(0)
  expect(result.stderr).toContain('Warning:')
  expect(result.stderr).toContain('assethub workspace use ws-1')
  expect(JSON.parse(result.output).workspace).toBeNull()
  const saved = await f.config()
  expect(saved.profiles.default).toMatchObject({apiKey: 'ah_pat_personal-secret'})
  expect(saved.profiles.default?.workspaceId).toBeUndefined()
}, 30_000)
