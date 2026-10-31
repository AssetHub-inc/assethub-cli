import {spawn} from 'node:child_process'
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import {createServer} from 'node:http'
import {hostname, platform} from 'node:os'

/**
 * `assethub auth login` browser flow (RFC 8252 loopback redirect + RFC 7636
 * PKCE S256). The browser only ever carries `state`, the PKCE challenge and a
 * one-time code; the workspace API key arrives in the token POST response.
 */

/**
 * How long the loopback listener waits for the browser. Long enough for an
 * MFA detour (one authenticator code per MFA-required workspace); the server
 * still expires the one-time code 5 minutes after approval.
 */
export const BROWSER_LOGIN_TIMEOUT_MS = 15 * 60_000
const DEFAULT_TIMEOUT_MS = BROWSER_LOGIN_TIMEOUT_MS
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

export type BrowserLoginWorkspace = {
  id: string
  name: string
  apiKey: {secret: string; id: string; name: string; lastFour: string}
}

export type BrowserLoginPersonal = {
  key: {id: string; name: string; secret: string; lastFour: string; expiresAt: string}
  userId: string
  startWorkspace: {id: string; name: string} | null
}

export type BrowserLoginResult = {
  workspaces: BrowserLoginWorkspace[]
  failed: {id: string; reason: string}[]
  /** Set in personal mode: one personal key for all workspaces. */
  personal?: BrowserLoginPersonal
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const parseFailed = (value: unknown): {id: string; reason: string}[] =>
  Array.isArray(value)
    ? value.flatMap(item =>
        isObject(item)
          ? [{id: String(item.id ?? ''), reason: String(item.reason ?? '')}]
          : [],
      )
    : []

const invalid = () => new Error('Browser login returned an invalid response')

const parseWorkspace = (value: unknown): BrowserLoginWorkspace => {
  if (!isObject(value) || !isObject(value.apiKey)) throw invalid()
  const id = text(value.id)
  const name = text(value.name)
  const secret = text(value.apiKey.secret)
  if (!id || !name || !secret) throw invalid()
  return {
    id,
    name,
    apiKey: {
      secret,
      id: String(value.apiKey.id ?? ''),
      name: String(value.apiKey.name ?? ''),
      lastFour: String(value.apiKey.lastFour ?? ''),
    },
  }
}

const parseTokenData = (data: unknown): BrowserLoginResult => {
  if (!isObject(data)) throw invalid()
  if (data.mode === 'personal') {
    const key = data.personalKey
    if (!isObject(key)) throw invalid()
    const secret = text(key.secret)
    const userId = text(data.userId)
    if (!secret?.startsWith('ah_pat_') || !userId) throw invalid()
    let startWorkspace: {id: string; name: string} | null = null
    if (data.startWorkspace != null) {
      const start = data.startWorkspace
      if (!isObject(start) || !text(start.id) || !text(start.name))
        throw invalid()
      startWorkspace = {id: String(start.id), name: String(start.name)}
    }
    return {
      workspaces: [],
      failed: parseFailed(data.failed),
      personal: {
        key: {
          id: String(key.id ?? ''),
          name: String(key.name ?? ''),
          secret,
          lastFour: String(key.lastFour ?? ''),
          expiresAt: String(key.expiresAt ?? ''),
        },
        userId,
        startWorkspace,
      },
    }
  }
  if (Array.isArray(data.workspaces)) {
    const workspaces = data.workspaces.map(parseWorkspace)
    if (workspaces.length === 0) throw invalid()
    if (new Set(workspaces.map(w => w.id)).size !== workspaces.length)
      throw invalid()
    return {workspaces, failed: parseFailed(data.failed)}
  }
  // Legacy v1: one workspace.
  const apiKey = data.apiKey
  const workspace = data.workspace
  if (!isObject(apiKey) || !isObject(workspace)) throw invalid()
  const id = text(workspace.id)
  const name = text(workspace.name)
  const secret = text(apiKey.key)
  if (!id || !name || !secret || apiKey.workspaceId !== id) throw invalid()
  return {
    workspaces: [
      {
        id,
        name,
        apiKey: {
          secret,
          id: String(apiKey.id ?? ''),
          name: String(apiKey.name ?? ''),
          lastFour: String(apiKey.lastFour ?? ''),
        },
      },
    ],
    failed: [],
  }
}

type TokenResponse = {
  success?: boolean
  data?: unknown
  error?: {code?: unknown; message?: unknown; details?: unknown}
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
  if (!response.ok) {
    const message =
      typeof body.error?.message === 'string'
        ? body.error.message
        : 'unknown error'
    const failed = isObject(body.error?.details)
      ? parseFailed(body.error.details.failed)
      : []
    const reasons = failed.length
      ? ` (${failed.map(f => `${f.id}: ${f.reason}`).join(', ')})`
      : ''
    throw new Error(
      `Browser login failed (HTTP ${response.status}): ${message}${reasons}`,
    )
  }
  return parseTokenData(body.data)
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
  write(
    `Waiting for approval in the browser (up to ${Math.round(timeoutMs / 60_000)} minutes). If AssetHub asks for MFA, finish MFA in the browser; this command keeps waiting.\n`,
  )
  const code = await listener.code
  return exchangeAuthorizationCode({
    baseUrl,
    code,
    verifier,
    port: listener.port,
    fetchImpl,
  })
}
