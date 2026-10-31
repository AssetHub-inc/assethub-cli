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

const fixture = async (tokenStatus = 200) => {
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
    }
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
  expect(result.output + result.stderr).not.toContain('assethub-minted-secret')
  expect(JSON.parse(result.output)).toMatchObject({
    success: true,
    authentication: 'browser',
    workspace: {id: 'ws-1', name: 'Studio'},
    apiKey: {lastFour: 'cret'},
  })
  const saved = await f.config()
  expect(saved.defaultProfile).toBe('default')
  expect(saved.profiles.default).toMatchObject({
    apiKey: 'assethub-minted-secret',
    baseUrl: f.baseUrl,
  })

  // The stdin path is unchanged and overwrites the same profile.
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
  expect((await f.config()).profiles.default).toMatchObject({
    apiKey: 'assethub-minted-secret',
  })
}, 30_000)
