import {spawn} from 'node:child_process'
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import {createServer} from 'node:http'
import {hostname, platform} from 'node:os'

/**
 * `assethub auth login` browser flow (RFC 8252 loopback redirect + RFC 7636
 * PKCE S256). The browser only ever carries `state`, the PKCE challenge and a
 * one-time code; the workspace API key arrives in the token POST response.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const FALLBACK_HINT =
  'Create a workspace API key in AssetHub (Settings > API keys) and run: assethub auth login --api-key-stdin'

export class BrowserLoginUnavailableError extends Error {
  constructor() {
    super(
      `Browser login is not available for this account yet. ${FALLBACK_HINT}`,
    )
    this.name = 'BrowserLoginUnavailableError'
  }
}

export const createPkcePair = (): {verifier: string; challenge: string} => {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

export const sanitizeClientName = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'cli'

export const buildAuthorizeUrl = (
  baseUrl: string,
  input: {port: number; state: string; challenge: string; clientName: string},
): string => {
  const url = new URL('/cli/authorize', new URL(baseUrl).origin)
  url.search = new URLSearchParams({
    port: String(input.port),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    client: 'assethub-cli',
    name: input.clientName,
  }).toString()
  return url.toString()
}

const sameString = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>AssetHub CLI</title><p>${message}</p>`

/** Listen on 127.0.0.1:<random>; resolve with the code for the matching state. */
export const waitForLoopbackCallback = async ({
  state,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}: {
  state: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{port: number; code: Promise<string>}> => {
  let settle: {resolve: (code: string) => void; reject: (error: Error) => void}
  const code = new Promise<string>((resolve, reject) => {
    settle = {resolve, reject}
  })
  // Callers may attach handlers later; avoid an unhandled rejection meanwhile.
  code.catch(() => {})
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, message: string) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(page(message))
    }
    if (request.method !== 'GET' || url.pathname !== '/callback')
      return send(404, 'Not found.')
    const received = url.searchParams.get('state') ?? ''
    if (!sameString(received, state))
      return send(400, 'This login link does not match the running CLI.')
    if (url.searchParams.get('error')) {
      send(200, 'Login cancelled. You can close this tab.')
      return finish(new Error('Login was cancelled in the browser.'))
    }
    const value = url.searchParams.get('code')
    if (!value) return send(400, 'Missing login code.')
    send(200, 'AssetHub CLI is logged in. You can close this tab.')
    finish(undefined, value)
  })
  let done = false
  const timer = setTimeout(
    () =>
      finish(
        new Error(
          `Timed out waiting for browser approval. Run assethub auth login again, or ${FALLBACK_HINT.charAt(0).toLowerCase()}${FALLBACK_HINT.slice(1)}`,
        ),
      ),
    timeoutMs,
  )
  const onAbort = () => finish(new Error('Login cancelled.'))
  function finish(error?: Error, value?: string) {
    if (done) return
    done = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections()
    if (error) settle.reject(error)
    else settle.resolve(value!)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, {once: true})
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Loopback listener has no port')
  return {port: address.port, code}
}

export type BrowserLoginResult = {
  apiKey: string
  keyId: string
  keyName: string
  lastFour: string
  workspace: {id: string; name: string}
}

type TokenResponse = {
  success?: boolean
  data?: {
    apiKey?: {
      id?: unknown
      key?: unknown
      lastFour?: unknown
      name?: unknown
      workspaceId?: unknown
    }
    workspace?: {id?: unknown; name?: unknown}
  }
  error?: {code?: unknown; message?: unknown}
}

export const exchangeAuthorizationCode = async ({
  baseUrl,
  code,
  verifier,
  port,
  fetchImpl = fetch,
}: {
  baseUrl: string
  code: string
  verifier: string
  port: number
  fetchImpl?: typeof fetch
}): Promise<BrowserLoginResult> => {
  const response = await fetchImpl(
    new URL('/api/v2/cli/auth/token', new URL(baseUrl).origin).toString(),
    {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_port: port,
      }),
    },
  )
  const body = (await response.json().catch(() => ({}))) as TokenResponse
  if (response.status === 404) throw new BrowserLoginUnavailableError()
  if (response.status === 400 && body.error?.code === 'INVALID_GRANT')
    throw new Error(
      'The login code was rejected or expired. Run assethub auth login again.',
    )
  if (response.status === 429)
    throw new Error('Too many login attempts. Wait a minute and try again.')
  if (!response.ok)
    throw new Error(
      `Browser login failed (HTTP ${response.status}): ${typeof body.error?.message === 'string' ? body.error.message : 'unknown error'}`,
    )
  const apiKey = body.data?.apiKey
  const workspace = body.data?.workspace
  if (
    typeof apiKey?.key !== 'string' ||
    apiKey.key.length === 0 ||
    typeof workspace?.id !== 'string' ||
    typeof workspace.name !== 'string' ||
    apiKey.workspaceId !== workspace.id
  )
    throw new Error('Browser login returned an invalid response')
  return {
    apiKey: apiKey.key,
    keyId: String(apiKey.id ?? ''),
    keyName: String(apiKey.name ?? ''),
    lastFour: String(apiKey.lastFour ?? ''),
    workspace: {id: workspace.id, name: workspace.name},
  }
}

export const openInBrowser = async (url: string): Promise<void> => {
  const [command, args] =
    platform() === 'darwin'
      ? ['open', [url]]
      : platform() === 'win32'
        ? // Not `cmd /c start`: cmd treats the URL's `&` as a command separator.
          ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  await new Promise<void>(resolve => {
    try {
      const child = spawn(command, args, {detached: true, stdio: 'ignore'})
      child.once('error', () => resolve())
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    } catch {
      resolve()
    }
  })
}

export const runBrowserLogin = async ({
  baseUrl,
  noBrowser = false,
  openBrowser = openInBrowser,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  write,
  clientName = sanitizeClientName(hostname()),
}: {
  baseUrl: string
  noBrowser?: boolean
  openBrowser?: (url: string) => Promise<void> | void
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  write: (text: string) => void
  clientName?: string
}): Promise<BrowserLoginResult> => {
  const state = randomBytes(32).toString('base64url')
  const {verifier, challenge} = createPkcePair()
  const listener = await waitForLoopbackCallback({state, timeoutMs, signal})
  const url = buildAuthorizeUrl(baseUrl, {
    port: listener.port,
    state,
    challenge,
    clientName,
  })
  if (noBrowser) {
    write(
      `Open this URL in a browser on this machine to approve the CLI:\n${url}\n`,
    )
  } else {
    write(
      `Opening AssetHub in your browser to approve this CLI...\nIf the browser does not open, visit:\n${url}\n`,
    )
    await Promise.resolve(openBrowser(url)).catch(() => {})
  }
  const code = await listener.code
  return exchangeAuthorizationCode({
    baseUrl,
    code,
    verifier,
    port: listener.port,
    fetchImpl,
  })
}
