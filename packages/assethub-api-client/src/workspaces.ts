export type Workspace = {
  id: string
  name: string
  type: string | null
  role: 'admin' | 'owner' | 'user'
  active: boolean
}

export type WorkspaceListResult = {
  userId: string
  workspaces: Workspace[]
}

export type WorkspaceCreateResult = {
  workspace: {id: string; name: string}
  created: boolean
}

export type WorkspaceMfa = {
  status: 'not_required' | 'complete' | 'setup_required' | 'verify_required'
  factorId?: string
  factorType?: 'totp' | 'webauthn'
}

export type WorkspaceSelectResult = {
  workspaceId: string
  selected: true
  mfa: WorkspaceMfa
}

export type WorkspaceApiKey = {
  id: string
  name: string
  lastFour: string
  workspaceId: string
  /** Returned once at creation. Callers must store it securely. */
  key: string
}

export type WorkspaceApiKeyCreateResult = {apiKey: WorkspaceApiKey}

export type WorkspaceClientOptions = {
  accessToken: string
  /** Signed `ah_workspace_mfa` proof issued by the AssetHub browser flow. */
  workspaceMfaToken?: string
  baseUrl?: string
  fetch?: typeof fetch
}

export type WorkspaceCreateOptions = {idempotencyKey?: string}

export type WorkspaceClient = {
  list(): Promise<WorkspaceListResult>
  create(
    input: {name: string},
    options?: WorkspaceCreateOptions,
  ): Promise<WorkspaceCreateResult>
  select(workspaceId: string): Promise<WorkspaceSelectResult>
  createApiKey(
    workspaceId: string,
    input: {name: string},
  ): Promise<WorkspaceApiKey>
}

export class WorkspaceClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(options: {status: number; code: string; message: string}) {
    super(options.message)
    this.name = 'WorkspaceClientError'
    this.status = options.status
    this.code = options.code
  }
}

const DEFAULT_BASE_URL = 'https://app.assethub.io'

const isLoopback = (hostname: string): boolean => {
  const lower = hostname.toLowerCase()
  const normalized =
    lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  const ipv4 = normalized.split('.').map(Number)
  const isIpv4Loopback =
    ipv4.length === 4 &&
    ipv4[0] === 127 &&
    ipv4.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
  return normalized === 'localhost' || normalized === '::1' || isIpv4Loopback
}

const resolveBaseUrl = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Workspace API base URL is invalid')
  }
  if (url.username || url.password)
    throw new Error('Workspace API base URL cannot include credentials')
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopback(url.hostname))
  )
    throw new Error('Workspace API base URL must use HTTPS')
  let pathname = url.pathname
  while (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  const serialized = url.toString()
  return serialized.endsWith('/') ? serialized.slice(0, -1) : serialized
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const string = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const workspace = (value: unknown): value is Workspace => {
  const item = object(value)
  return (
    string(item.id) &&
    string(item.name) &&
    (item.type === null || typeof item.type === 'string') &&
    (item.role === 'admin' || item.role === 'owner' || item.role === 'user') &&
    typeof item.active === 'boolean'
  )
}

const workspaceList = (value: unknown): WorkspaceListResult | null => {
  const result = object(value)
  return string(result.userId) &&
    Array.isArray(result.workspaces) &&
    result.workspaces.every(workspace)
    ? {userId: result.userId, workspaces: result.workspaces}
    : null
}

const workspaceCreate = (value: unknown): WorkspaceCreateResult | null => {
  const result = object(value)
  const createdWorkspace = object(result.workspace)
  return string(createdWorkspace.id) &&
    string(createdWorkspace.name) &&
    typeof result.created === 'boolean'
    ? {
        workspace: {id: createdWorkspace.id, name: createdWorkspace.name},
        created: result.created,
      }
    : null
}

const MFA_STATUSES: WorkspaceMfa['status'][] = [
  'not_required',
  'complete',
  'setup_required',
  'verify_required',
]

const validFactorId = (value: unknown): boolean =>
  value === undefined || string(value)

const validFactorType = (value: unknown): boolean =>
  value === undefined || value === 'totp' || value === 'webauthn'

const workspaceSelection = (value: unknown): WorkspaceSelectResult | null => {
  const result = object(value)
  const mfa = object(result.mfa)
  if (
    !string(result.workspaceId) ||
    result.selected !== true ||
    !MFA_STATUSES.includes(mfa.status as WorkspaceMfa['status']) ||
    !validFactorId(mfa.factorId) ||
    !validFactorType(mfa.factorType)
  )
    return null
  return {
    workspaceId: result.workspaceId,
    selected: true,
    mfa: {
      status: mfa.status as WorkspaceMfa['status'],
      ...(string(mfa.factorId) ? {factorId: mfa.factorId} : {}),
      ...(mfa.factorType === 'totp' || mfa.factorType === 'webauthn'
        ? {factorType: mfa.factorType}
        : {}),
    },
  }
}

const workspaceApiKey = (value: unknown): WorkspaceApiKey | null => {
  const result = object(value)
  const apiKey = object(result.apiKey)
  return string(apiKey.id) &&
    string(apiKey.name) &&
    string(apiKey.lastFour) &&
    string(apiKey.workspaceId) &&
    string(apiKey.key)
    ? {
        id: apiKey.id,
        name: apiKey.name,
        lastFour: apiKey.lastFour,
        workspaceId: apiKey.workspaceId,
        key: apiKey.key,
      }
    : null
}

const redact = (message: string, secrets: Array<string | undefined>): string =>
  secrets
    .filter((secret): secret is string => Boolean(secret))
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      message,
    )

const requestHeaders = (
  init: RequestInit,
  accessToken: string,
  encodedMfaToken: string | undefined,
): HeadersInit => ({
  Authorization: `Bearer ${accessToken}`,
  ...(init.body === undefined ? {} : {'Content-Type': 'application/json'}),
  ...(init.headers ?? {}),
  ...(encodedMfaToken ? {Cookie: `ah_workspace_mfa=${encodedMfaToken}`} : {}),
})

export const createWorkspaceClient = (
  options: WorkspaceClientOptions,
): WorkspaceClient => {
  if (options.accessToken.trim().length === 0)
    throw new Error('Workspace access token is required')
  const baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
  const fetchImpl = options.fetch ?? fetch
  const encodedMfaToken = options.workspaceMfaToken
    ? encodeURIComponent(options.workspaceMfaToken)
    : undefined
  const secrets = [
    options.accessToken,
    options.workspaceMfaToken,
    encodedMfaToken,
  ]

  const request = async <T>(
    path: string,
    init: RequestInit,
    validate: (value: unknown) => T | null,
  ): Promise<T> => {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: requestHeaders(init, options.accessToken, encodedMfaToken),
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Workspace API request failed'
      throw new WorkspaceClientError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: redact(message, secrets),
      })
    }
    const payload = (await response.json().catch(() => ({}))) as unknown
    if (!response.ok) {
      const apiError = object(object(payload).error)
      let code = 'HTTP_ERROR'
      if (typeof apiError.code === 'string') code = apiError.code
      else if (typeof apiError.name === 'string') code = apiError.name
      const message =
        typeof apiError.message === 'string'
          ? apiError.message
          : `Workspace API request failed with status ${response.status}`
      throw new WorkspaceClientError({
        status: response.status,
        code,
        message: redact(message, secrets),
      })
    }
    const result = validate(payload)
    if (result === null) {
      throw new WorkspaceClientError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'Workspace API returned an invalid response',
      })
    }
    return result
  }

  return {
    list: () => request('/api/workspaces', {method: 'GET'}, workspaceList),
    create: (input, createOptions = {}) =>
      request(
        '/api/workspaces',
        {
          method: 'POST',
          headers: {
            'Idempotency-Key':
              createOptions.idempotencyKey ?? globalThis.crypto.randomUUID(),
          },
          body: JSON.stringify(input),
        },
        workspaceCreate,
      ),
    select: workspaceId =>
      request(
        '/api/workspaces/select',
        {method: 'POST', body: JSON.stringify({workspaceId})},
        workspaceSelection,
      ),
    createApiKey: (workspaceId, input) =>
      request(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/api-keys`,
        {method: 'POST', body: JSON.stringify(input)},
        workspaceApiKey,
      ),
  }
}
