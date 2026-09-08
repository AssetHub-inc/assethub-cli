import {readFile} from 'node:fs/promises'
import {AssetHubApiError, createAssetHubClient} from '@assethub/api-client'

export const cliVersion = async (): Promise<string> =>
  (
    JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {version: string}
  ).version

const validatedBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Use an API URL without credentials, query, or fragment.')
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error(
      'Use HTTPS for remote servers; HTTP is supported only on localhost.',
    )
  return url.href.replace(/\/+$/, '')
}

export const mcpConfig = (client: string, baseUrl: string): string => {
  const url = `${validatedBaseUrl(baseUrl)}/api/mcp`
  if (client === 'cursor')
    return (
      JSON.stringify(
        {
          mcpServers: {
            assethub: {
              url,
              headers: {Authorization: 'Bearer ${env:ASSETHUB_API_KEY}'},
            },
          },
        },
        null,
        2,
      ) + '\n'
    )
  if (client === 'codex')
    return `[mcp_servers.assethub]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "ASSETHUB_API_KEY"\n`
  throw new Error('Use mcp config --client cursor|codex')
}

type Check = {
  name: 'api' | 'mcp' | 'configuration'
  status: 'pass' | 'fail'
  code?: string
  message?: string
  hint?: string
  workspaceId?: string
  executionStatus?: string
  toolCount?: number
}

type Auth = {apiKey: string; baseUrl: string; profile: string; source: string}

const failedCheck = (
  name: 'api' | 'mcp',
  status: number | undefined,
  timedOut: boolean,
): Check => {
  if (timedOut)
    return {
      name,
      status: 'fail',
      code: 'TIMEOUT',
      message: 'Connection timed out.',
      hint: 'Check your network or retry with --timeout-ms 30000.',
    }
  if (status === 401)
    return {
      name,
      status: 'fail',
      code: 'UNAUTHORIZED',
      message: 'The API key was rejected.',
      hint: 'Run assethub auth login --api-key-stdin with a current workspace key.',
    }
  if (status === 403)
    return {
      name,
      status: 'fail',
      code: 'FORBIDDEN',
      message: 'This account or workspace does not have access.',
      hint: 'Check the API key workspace and account access.',
    }
  if (name === 'mcp' && status === 404)
    return {
      name,
      status: 'fail',
      code: 'MCP_UNAVAILABLE',
      message: 'Hosted MCP is unavailable for this account or API origin.',
      hint: 'Hosted MCP is in Internal preview. Check access for the account that created the API key.',
    }
  if (status === 429)
    return {
      name,
      status: 'fail',
      code: 'RATE_LIMITED',
      message: 'Too many requests.',
      hint: 'Wait before retrying the check.',
    }
  // Server response text may contain credentials or private data. Report only
  // fixed diagnostics; do not include arbitrary error messages in shareable output.
  return {
    name,
    status: 'fail',
    code: status && status >= 500 ? 'SERVER_ERROR' : 'CONNECTION_FAILED',
    message: 'The connection check failed.',
    hint: 'Check the API origin, network, and service status; then retry.',
  }
}

export const diagnose = async ({
  resolveAuth,
  includeMcp,
  timeoutMs,
}: {
  resolveAuth: () => Promise<Auth>
  includeMcp: boolean
  timeoutMs: number
}) => {
  const version = await cliVersion()
  let auth: Auth
  try {
    auth = await resolveAuth()
    auth.baseUrl = validatedBaseUrl(auth.baseUrl)
  } catch {
    return {
      ok: false,
      version,
      nodeVersion: process.version,
      checks: [
        {
          name: 'configuration',
          status: 'fail',
          code: 'AUTH_CONFIGURATION',
          message:
            'No usable credentials or API origin for the selected profile.',
          hint: 'Check --profile and --base-url. Select a workspace with assethub workspace use <id> after user login, or run assethub auth login --api-key-stdin.',
        } satisfies Check,
      ],
    }
  }
  const signal = AbortSignal.timeout(timeoutMs)
  // Bound the entire transport, including initialize and SSE, and do not follow
  // redirects while carrying the workspace key.
  const boundedFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      redirect: 'error',
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    })
  const apiCheck = async (): Promise<Check> => {
    try {
      const capabilities = await createAssetHubClient({
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        fetch: boundedFetch,
      }).v2.getCapabilities()
      if (typeof capabilities.ownerId !== 'string' || !capabilities.ownerId)
        throw new Error('Invalid capabilities')
      return {
        name: 'api',
        status: 'pass',
        workspaceId: capabilities.ownerId,
        executionStatus: capabilities.executionContext?.status,
      }
    } catch (error) {
      return failedCheck(
        'api',
        error instanceof AssetHubApiError ? error.status : undefined,
        signal.aborted,
      )
    }
  }
  const mcpCheck = async (): Promise<Check> => {
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js')
    const {StreamableHTTPClientTransport, StreamableHTTPError} =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client = new Client({name: 'assethub-cli-doctor', version})
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${auth.baseUrl}/api/mcp`), {
          fetch: boundedFetch,
          requestInit: {headers: {Authorization: `Bearer ${auth.apiKey}`}},
        }),
        {signal, timeout: timeoutMs},
      )
      let toolCount = 0
      let cursor: string | undefined
      const cursors = new Set<string>()
      do {
        const page = await client.listTools(cursor ? {cursor} : {}, {
          signal,
          timeout: timeoutMs,
        })
        toolCount += page.tools.length
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor))
          throw new Error('Repeated tool cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (!toolCount) throw new Error('No MCP tools')
      return {name: 'mcp', status: 'pass', toolCount}
    } catch (error) {
      return failedCheck(
        'mcp',
        error instanceof StreamableHTTPError ? error.code : undefined,
        signal.aborted,
      )
    } finally {
      await client.close()
    }
  }
  const checks = await Promise.all([
    apiCheck(),
    ...(includeMcp ? [mcpCheck()] : []),
  ])
  return {
    ok: checks.every(check => check.status === 'pass'),
    version,
    nodeVersion: process.version,
    auth: {profile: auth.profile, source: auth.source, baseUrl: auth.baseUrl},
    checks,
  }
}
