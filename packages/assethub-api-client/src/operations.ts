import type {AssetHubApiVersion, AssetHubClient} from './index.js'

export type ApiOperation = {
  id: string
  method: string
  path: string
  contract: Record<string, unknown>
}
export type ApiOperationSpec = {
  paths: Record<string, Record<string, unknown>>
  components?: {schemas?: Record<string, unknown>}
}
export type ApiOperationInput = {
  operation: string
  path?: Record<string, string>
  query?: Record<string, string | number | boolean>
  body?: Record<string, unknown>
  operationId?: string
}
export type ApiOperationDiscovery = {
  catalog: Map<string, ApiOperation>
  specs: Record<AssetHubApiVersion, ApiOperationSpec>
}
export type ApiImageInputSource =
  | {kind: 'resourceId'; resourceId: string}
  | {kind: 'uploadId'; uploadId: string}
export type ApiImageInput = {
  source: ApiImageInputSource
  mediaType: 'image/jpeg'
  data: string
  width: number
  height: number
}
export type ApiImageOperationMetadata = {
  success: true
  data: {
    schemaVersion: 'assethub.image-inputs.v1'
    images: Array<Omit<ApiImageInput, 'data'>>
  }
}
export type ParsedApiImageOperationResult = {
  images: ApiImageInput[]
  metadata: ApiImageOperationMetadata
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const base64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const methods = ['get', 'post', 'put', 'patch', 'delete']

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value)
  return (
    actual.length === keys.length && actual.every(key => keys.includes(key))
  )
}

function assertImageOperationResult(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid AssetHub image operation result')
}

const parseApiImageInputSource = (value: unknown): ApiImageInputSource => {
  assertImageOperationResult(isRecord(value))
  if (
    value.kind === 'resourceId' &&
    hasOnlyKeys(value, ['kind', 'resourceId']) &&
    typeof value.resourceId === 'string' &&
    value.resourceId === value.resourceId.trim() &&
    value.resourceId.length >= 1 &&
    value.resourceId.length <= 500
  )
    return {kind: 'resourceId', resourceId: value.resourceId}
  if (
    value.kind === 'uploadId' &&
    hasOnlyKeys(value, ['kind', 'uploadId']) &&
    typeof value.uploadId === 'string' &&
    uuid.test(value.uploadId)
  )
    return {kind: 'uploadId', uploadId: value.uploadId}
  throw new Error('Invalid AssetHub image operation result')
}

/** Parse the exact image-read API envelope and separate native bytes from safe metadata. */
export const parseApiImageOperationResult = (
  value: unknown,
): ParsedApiImageOperationResult => {
  assertImageOperationResult(isRecord(value))
  assertImageOperationResult(
    hasOnlyKeys(value, ['success', 'data']) &&
      value.success === true &&
      isRecord(value.data),
  )
  const data = value.data
  assertImageOperationResult(
    hasOnlyKeys(data, ['schemaVersion', 'images']) &&
      data.schemaVersion === 'assethub.image-inputs.v1' &&
      Array.isArray(data.images) &&
      data.images.length >= 1 &&
      data.images.length <= 4,
  )

  let totalBase64Length = 0
  const images: ApiImageInput[] = data.images.map((raw: unknown) => {
    assertImageOperationResult(isRecord(raw))
    assertImageOperationResult(
      hasOnlyKeys(raw, ['source', 'mediaType', 'data', 'width', 'height']) &&
        raw.mediaType === 'image/jpeg' &&
        typeof raw.data === 'string' &&
        raw.data.length > 0 &&
        raw.data.length <= 1_000_000 &&
        base64.test(raw.data) &&
        Number.isSafeInteger(raw.width) &&
        (raw.width as number) >= 1 &&
        (raw.width as number) <= 1024 &&
        Number.isSafeInteger(raw.height) &&
        (raw.height as number) >= 1 &&
        (raw.height as number) <= 1024,
    )

    totalBase64Length += raw.data.length
    assertImageOperationResult(totalBase64Length <= 4_000_000)
    return {
      source: parseApiImageInputSource(raw.source),
      mediaType: 'image/jpeg' as const,
      data: raw.data,
      width: raw.width as number,
      height: raw.height as number,
    }
  })
  return {
    images,
    metadata: {
      success: true,
      data: {
        schemaVersion: 'assethub.image-inputs.v1',
        images: images.map(({data: _data, ...metadata}) => metadata),
      },
    },
  }
}

const assertApiPath = (path: string) => {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\%?#\u0000-\u0020]/.test(path) ||
    path.split('/').some(segment => segment === '.' || segment === '..')
  )
    throw new Error('Invalid advertised API path')
}

/** Shared with chat: IDs are METHOD /path, with an explicit V1 prefix when combined. */
export const buildApiCatalog = (
  spec: ApiOperationSpec,
  apiVersion: AssetHubApiVersion = 'v2',
  operationPrefix = '',
): Map<string, ApiOperation> => {
  const operations = new Map<string, ApiOperation>()
  if (!isRecord(spec) || !isRecord(spec.paths))
    throw new Error('Invalid OpenAPI document')
  for (const [path, entries] of Object.entries(spec.paths)) {
    assertApiPath(path)
    if (!isRecord(entries)) throw new Error('Invalid OpenAPI path definition')
    for (const [method, contract] of Object.entries(entries)) {
      if (!methods.includes(method)) continue
      if (!isRecord(contract)) continue
      const id = `${operationPrefix}${method.toUpperCase()} ${path}`
      operations.set(id, {
        id,
        method: method.toUpperCase(),
        path: `/api/${apiVersion}${path}`,
        contract,
      })
    }
  }
  return operations
}

/** Include only referenced definitions; never send the entire spec every turn. */
export const describeApiOperation = (
  operation: ApiOperation,
  spec: ApiOperationSpec,
) => {
  const schemas: Record<string, unknown> = {}
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const ref = '$ref' in value ? value.$ref : undefined
    if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
      const name = ref.slice('#/components/schemas/'.length)
      if (Object.hasOwn(schemas, name)) return
      if (!Object.hasOwn(spec.components?.schemas ?? {}, name))
        throw new Error(`Missing schema: ${name}`)
      Object.defineProperty(schemas, name, {
        value: spec.components?.schemas?.[name],
        enumerable: true,
      })
      collect(schemas[name])
    }
    for (const item of Object.values(value)) collect(item)
  }
  collect(operation.contract)
  return {...operation, components: {schemas}}
}

export const searchApiOperations = (
  catalog: Map<string, ApiOperation>,
  query = '',
) =>
  [...catalog.values()]
    .filter(
      operation =>
        !query ||
        `${operation.id} ${operation.contract.summary ?? ''} ${operation.contract.description ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .map(operation => ({
      operation: operation.id,
      summary: operation.contract.summary ?? '',
      cost: operation.contract['x-assethub-credit-cost'],
    }))

export const buildApiRequest = (
  catalog: Map<string, ApiOperation>,
  input: ApiOperationInput,
  origin: string,
  fallbackOperationId: string,
) => {
  const operation = catalog.get(input.operation)
  if (!operation || !methods.includes(operation.method.toLowerCase()))
    throw new Error('Unknown operation. Search the API catalog first.')
  assertApiPath(operation.path)
  const parameters = input.path ?? {}
  if (!isRecord(parameters)) throw new Error('Invalid path parameters')
  const used = new Set<string>()
  const pathname = operation.path.replace(
    /\{([^}]+)\}/g,
    (_match, name: string) => {
      const value = Object.hasOwn(parameters, name)
        ? parameters[name]
        : undefined
      if (
        typeof value !== 'string' ||
        !value ||
        value === '.' ||
        value === '..' ||
        /[/\\%?#\u0000-\u001f]/.test(value)
      )
        throw new Error(`Invalid path parameter: ${name}`)
      used.add(name)
      return encodeURIComponent(value)
    },
  )
  if (Object.keys(parameters).some(name => !used.has(name)))
    throw new Error('Unknown path parameter')
  if (/[{}]/.test(pathname)) throw new Error('Invalid advertised API path')
  const url = new URL(pathname, origin)
  if (url.origin !== new URL(origin).origin)
    throw new Error('API request escaped the application origin')
  const query = input.query ?? {}
  if (!isRecord(query)) throw new Error('Invalid query parameters')
  for (const [key, value] of Object.entries(query)) {
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error(`Invalid query parameter: ${key}`)
    url.searchParams.set(key, String(value))
  }
  if (input.body !== undefined && !isRecord(input.body))
    throw new Error('API body must be an object')
  const context = input.body?.executionContext
  const bodyOperationId =
    isRecord(context) && 'clientOperationId' in context
      ? context.clientOperationId
      : input.body?.clientOperationId
  const operationId =
    input.operationId ?? bodyOperationId ?? fallbackOperationId
  if (typeof operationId !== 'string' || !uuid.test(operationId))
    throw new Error('operationId must be a UUID')
  if (bodyOperationId != null && bodyOperationId !== operationId)
    throw new Error('operationId must equal the body clientOperationId')
  if (operation.method === 'GET' && input.body !== undefined)
    throw new Error('GET does not accept a body')
  return {url, method: operation.method, body: input.body, operationId}
}

/** Documents are fetched through this client's authenticated, workspace-scoped transport. */
export const discoverApiOperations = async (
  client: AssetHubClient,
  options: {signal?: AbortSignal} = {},
): Promise<ApiOperationDiscovery> => {
  const [v2, v1] = await Promise.all([
    client.getOpenApiSpec('v2', options),
    client.getOpenApiSpec('v1', options),
  ])
  const specs = {v1: v1 as ApiOperationSpec, v2: v2 as ApiOperationSpec}
  const catalog = buildApiCatalog(specs.v2)
  for (const [id, operation] of buildApiCatalog(specs.v1, 'v1', 'V1 '))
    catalog.set(id, operation)
  return {catalog, specs}
}

/** Execute one advertised JSON operation. Never replay a write or infer a new operation ID. */
export const callApiOperation = async (
  client: AssetHubClient,
  discovery: ApiOperationDiscovery,
  input: ApiOperationInput,
  options: {signal?: AbortSignal} = {},
) => {
  const operation = discovery.catalog.get(input.operation)
  if (!operation)
    throw new Error('Unknown operation. Search the API catalog first.')
  if (
    operation.method !== 'GET' &&
    (!input.operationId || !uuid.test(input.operationId))
  )
    throw new Error('Mutations require an explicit operationId UUID')
  const request = buildApiRequest(
    discovery.catalog,
    input,
    client.baseUrl,
    input.operationId ?? crypto.randomUUID(),
  )
  const match = request.url.pathname.match(/^\/api\/(v1|v2)(\/.*)$/)
  if (!match) throw new Error('Invalid advertised API path')
  return client.request<unknown>(
    match[1] as AssetHubApiVersion,
    `${match[2]}${request.url.search}`,
    {
      method: request.method,
      redirect: 'error',
      signal: options.signal,
      ...(request.method !== 'GET'
        ? {headers: {'Idempotency-Key': request.operationId}}
        : {}),
      ...(request.body === undefined
        ? {}
        : {body: JSON.stringify(request.body)}),
    },
  )
}
