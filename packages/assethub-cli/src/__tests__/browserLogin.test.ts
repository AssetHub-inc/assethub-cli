import {createHash} from 'node:crypto'
import {describe, expect, it, vi} from 'vitest'

import {
  BrowserLoginUnavailableError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  runBrowserLogin,
  sanitizeClientName,
  waitForLoopbackCallback,
} from '../browserLogin.js'

const tokenBody = {
  success: true,
  data: {
    apiKey: {
      id: 'key-1',
      key: 'assethub-secret',
      lastFour: 'cret',
      name: 'AssetHub CLI on laptop (2026-10-31)',
      workspaceId: 'ws-1',
    },
    workspace: {id: 'ws-1', name: 'Studio'},
  },
}

describe('PKCE and URL helpers', () => {
  it('creates an S256 pair', () => {
    const {verifier, challenge} = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
    expect(createPkcePair().verifier).not.toBe(verifier)
  })

  it('builds the authorize URL on the base URL origin', () => {
    const url = new URL(
      buildAuthorizeUrl('https://app.assethub.io/api', {
        port: 53682,
        state: 's'.repeat(43),
        challenge: 'c'.repeat(43),
        clientName: 'laptop',
      }),
    )
    expect(url.origin + url.pathname).toBe(
      'https://app.assethub.io/cli/authorize',
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      port: '53682',
      state: 's'.repeat(43),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      client: 'assethub-cli',
      name: 'laptop',
    })
  })

  it('sanitises the host name', () => {
    expect(sanitizeClientName('My Mac (work)')).toBe('MyMacwork')
    expect(sanitizeClientName('a'.repeat(80))).toHaveLength(64)
    expect(sanitizeClientName('!!!')).toBe('cli')
  })
})

describe('loopback listener', () => {
  const state = 'S'.repeat(43)
  const visit = (port: number, query: string) =>
    fetch(`http://127.0.0.1:${port}/callback?${query}`)

  it('resolves with the code once the matching state arrives, ignoring a forged state', async () => {
    const listener = await waitForLoopbackCallback({state, timeoutMs: 5_000})
    const forged = await visit(listener.port, 'code=evil&state=wrong')
    expect(forged.status).toBe(400)
    const missing = await fetch(`http://127.0.0.1:${listener.port}/other`)
    expect(missing.status).toBe(404)
    const ok = await visit(listener.port, `code=good&state=${state}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    await expect(listener.code).resolves.toBe('good')
    await expect(
      fetch(`http://127.0.0.1:${listener.port}/callback`),
    ).rejects.toThrow()
  })

  it('rejects when the browser cancels', async () => {
    const listener = await waitForLoopbackCallback({state, timeoutMs: 5_000})
    const result = expect(listener.code).rejects.toThrow(
      'Login was cancelled in the browser.',
    )
    await visit(listener.port, `error=access_denied&state=${state}`)
    await result
  })

  it('times out', async () => {
    const listener = await waitForLoopbackCallback({state, timeoutMs: 20})
    await expect(listener.code).rejects.toThrow(/Timed out/)
  })

  it('stops on abort', async () => {
    const controller = new AbortController()
    const listener = await waitForLoopbackCallback({
      state,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(listener.code).rejects.toThrow('Login cancelled.')
  })
})

describe('code exchange', () => {
  const fetchReturning = (status: number, body: unknown) =>
    vi.fn(async () => Response.json(body, {status}))

  it('posts code, verifier and port to the token endpoint', async () => {
    const fetchImpl = fetchReturning(200, tokenBody)
    const result = await exchangeAuthorizationCode({
      baseUrl: 'https://app.assethub.io',
      code: 'the-code',
      verifier: 'the-verifier',
      port: 53682,
      fetchImpl,
    })
    expect(result.apiKey).toBe('assethub-secret')
    expect(result.workspace).toEqual({id: 'ws-1', name: 'Studio'})
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://app.assethub.io/api/v2/cli/auth/token')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_port: 53682,
    })
  })

  it.each([
    [404, {success: false, error: {code: 'NOT_FOUND'}}, /--api-key-stdin/],
    [
      400,
      {success: false, error: {code: 'INVALID_GRANT'}},
      /rejected or expired/,
    ],
    [429, {success: false, error: {code: 'RATE_LIMITED'}}, /Too many/],
    [200, {success: true, data: {apiKey: {key: ''}}}, /invalid response/],
  ])('maps HTTP %s', async (status, body, message) => {
    await expect(
      exchangeAuthorizationCode({
        baseUrl: 'https://app.assethub.io',
        code: 'c',
        verifier: 'v',
        port: 53682,
        fetchImpl: fetchReturning(status, body),
      }),
    ).rejects.toThrow(message)
  })

  it('uses a dedicated error for not-available', async () => {
    await expect(
      exchangeAuthorizationCode({
        baseUrl: 'https://app.assethub.io',
        code: 'c',
        verifier: 'v',
        port: 53682,
        fetchImpl: fetchReturning(404, {}),
      }),
    ).rejects.toBeInstanceOf(BrowserLoginUnavailableError)
  })
})

describe('runBrowserLogin', () => {
  it('opens the browser, receives the callback and exchanges the code', async () => {
    let written = ''
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(
        createHash('sha256').update(body.code_verifier).digest('base64url'),
      ).toBe(challenge)
      return Response.json(tokenBody)
    })
    let challenge = ''
    const openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      challenge = parsed.searchParams.get('code_challenge')!
      await fetch(
        `http://127.0.0.1:${parsed.searchParams.get('port')}/callback?code=c&state=${parsed.searchParams.get('state')}`,
      )
    })
    const result = await runBrowserLogin({
      baseUrl: 'https://app.assethub.io',
      openBrowser,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: text => {
        written += text
      },
    })
    expect(result.apiKey).toBe('assethub-secret')
    expect(openBrowser).toHaveBeenCalledTimes(1)
    expect(written).toContain('https://app.assethub.io/cli/authorize?')
    expect(written).not.toContain('assethub-secret')
  })

  it('prints the URL instead of opening it with noBrowser', async () => {
    let written = ''
    const openBrowser = vi.fn()
    const login = runBrowserLogin({
      baseUrl: 'https://app.assethub.io',
      noBrowser: true,
      openBrowser,
      timeoutMs: 50,
      write: text => {
        written += text
      },
    })
    await expect(login).rejects.toThrow(/Timed out.*--api-key-stdin/s)
    expect(openBrowser).not.toHaveBeenCalled()
    expect(written).toContain('Open this URL in a browser')
  })
})
