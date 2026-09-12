// Sending a planned run to Production Control.
//
// Order is the registry's: register -> blobs -> snapshot. The snapshot is
// rejected while any blob it references is absent from the pool, so the bytes
// have to land first.
//
// Resumability is the reason blobs go one at a time behind a HEAD. Content
// addressing makes an upload idempotent — the same key always holds the same
// bytes — so a run that dies at blob 150 of 300 is finished by re-running the
// exact same command: the first 150 HEAD as present and are skipped. Nothing
// records progress locally, because the server already knows it.
//
// Memory: exactly one blob is resident at a time, and `buildRunUploadPlan` has
// already refused any blob over the per-request ceiling by stat'ing it, so an
// oversized file is never read at all.

import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

import {
  CONTROL_ERROR_CODES,
  CONTROL_NOT_ENTITLED_STATUS,
  controlRunUploadUrls,
} from './controlEndpoints.js'
import {formatBytes, type PlannedBlob, type RunUploadPlan} from './buildRunUpload.js'
import {RunUploadError} from './runUploadError.js'

export type RunUploadProgressEvent =
  | {kind: 'register'; graphId: string}
  | {kind: 'blob'; index: number; total: number; blob: PlannedBlob; status: 'uploaded' | 'skipped'}
  | {kind: 'push'; graphId: string; rev: number}

export type RunUploadResult = {
  graphId: string
  streamId: string
  rev: number
  graphHash: string
  registered: boolean
  blobsUploaded: number
  blobsSkipped: number
  bytesUploaded: number
  /**
   * `published` — the snapshot became the graph's current revision.
   * `unchanged` — an exact re-push of what the server already holds.
   * `stale`     — the server already holds a NEWER revision, so this upload is
   *               a no-op rather than a failure.
   */
  status: 'published' | 'unchanged' | 'stale'
  data: unknown
}

export type UploadRunInput = {
  plan: RunUploadPlan
  baseUrl: string
  apiKey: string
  workspaceId?: string
  fetchImpl?: typeof fetch
  skipRegister?: boolean
  onProgress?: (event: RunUploadProgressEvent) => void
}

export const uploadRun = async ({
  plan,
  baseUrl,
  apiKey,
  workspaceId,
  fetchImpl = globalThis.fetch.bind(globalThis),
  skipRegister = false,
  onProgress = () => {},
}: UploadRunInput): Promise<RunUploadResult> => {
  const urls = controlRunUploadUrls(baseUrl)
  // Built once, never logged, never placed in a URL or a query string.
  const authHeaders = {authorization: `Bearer ${apiKey}`, ...(workspaceId ? {'X-AssetHub-Workspace': workspaceId} : {})}

  let registered = false
  if (!skipRegister) {
    onProgress({kind: 'register', graphId: plan.graphId})
    await request(fetchImpl, urls.graphs, {
      method: 'POST',
      headers: {...authHeaders, 'content-type': 'application/json'},
      body: JSON.stringify(plan.registration),
    })
    registered = true
  }

  let blobsUploaded = 0
  let blobsSkipped = 0
  let bytesUploaded = 0
  for (let index = 0; index < plan.blobs.length; index += 1) {
    const blob = plan.blobs[index]
    const url = urls.blob(plan.graphId, blob.blobKey)
    if (await blobExists(fetchImpl, url, authHeaders)) {
      blobsSkipped += 1
      onProgress({kind: 'blob', index, total: plan.blobs.length, blob, status: 'skipped'})
      continue
    }
    const bytes = await readVerifiedBlob(blob)
    await request(fetchImpl, url, {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'content-type': blob.mime,
        'x-artifact-blob-name': encodeURIComponent(blob.name),
        'x-artifact-blob-sha256': blob.sha256,
        'x-artifact-blob-size': String(blob.size),
      },
      body: bytes as unknown as BodyInit,
    })
    blobsUploaded += 1
    bytesUploaded += blob.size
    onProgress({kind: 'blob', index, total: plan.blobs.length, blob, status: 'uploaded'})
  }

  onProgress({kind: 'push', graphId: plan.graphId, rev: plan.rev})
  let payload: {data?: unknown}
  try {
    payload = await request(fetchImpl, urls.snapshot(plan.graphId), {
      method: 'PUT',
      headers: {...authHeaders, 'content-type': 'application/json'},
      body: plan.pushBody,
    })
  } catch (error) {
    // The server already holds a newer revision. That is the end state the
    // caller wanted, so it is reported, not thrown.
    if (error instanceof RunUploadError && error.code === CONTROL_ERROR_CODES.staleSnapshot) {
      return {
        graphId: plan.graphId,
        streamId: plan.streamId,
        rev: plan.rev,
        graphHash: plan.graphHash,
        registered,
        blobsUploaded,
        blobsSkipped,
        bytesUploaded,
        status: 'stale',
        data: error.details ?? null,
      }
    }
    throw error
  }

  const data = payload.data ?? null
  const serverStatus =
    data != null && typeof data === 'object' && 'status' in data
      ? String((data as {status: unknown}).status)
      : ''

  return {
    graphId: plan.graphId,
    streamId: plan.streamId,
    rev: plan.rev,
    graphHash: plan.graphHash,
    registered,
    blobsUploaded,
    blobsSkipped,
    bytesUploaded,
    status: serverStatus === 'unchanged' ? 'unchanged' : 'published',
    data,
  }
}

const blobExists = async (
  fetchImpl: typeof fetch,
  url: string,
  authHeaders: Record<string, string>,
): Promise<boolean> => {
  const response = await send(fetchImpl, url, {method: 'HEAD', headers: authHeaders})
  if (response.ok) return true
  if (response.status === 404) return false
  throw await errorFrom(response, url, 'HEAD')
}

const readVerifiedBlob = async (blob: PlannedBlob): Promise<Buffer> => {
  const bytes = await readFile(blob.file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  // The server recomputes this and rejects a mismatch; catching it here names
  // the local file instead of surfacing an opaque 400.
  if (digest !== blob.sha256) {
    throw new RunUploadError(
      'blob_digest_mismatch',
      `${blob.file} hashes to sha256:${digest} but the run folder declares ${blob.blobKey}. ` +
        'The file changed since the folder was exported. Nothing further was sent; re-export the run.',
      {details: {blobKey: blob.blobKey, file: blob.file}},
    )
  }
  if (bytes.byteLength !== blob.size) {
    throw new RunUploadError(
      'blob_size_mismatch',
      `${blob.file} is ${bytes.byteLength} bytes but the run folder declares ${blob.size}. ` +
        'The file changed since the folder was exported. Nothing further was sent; re-export the run.',
      {details: {blobKey: blob.blobKey, file: blob.file}},
    )
  }
  return bytes
}

const request = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{data?: unknown}> => {
  const method = String(init.method ?? 'GET')
  const response = await send(fetchImpl, url, init)
  const payload = await readJson(response)
  if (!response.ok || payload?.success !== true) {
    throw await errorFrom(response, url, method, payload)
  }
  return payload as {data?: unknown}
}

const send = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> => {
  try {
    return await fetchImpl(url, init)
  } catch (error) {
    // Nothing here echoes the request headers, so the API key cannot leak into
    // a transport error.
    throw new RunUploadError(
      'network_unreachable',
      `Could not reach Production Control at ${originOf(url)}: ${causeText(error)}. ` +
        'Check your network and --base-url (or ASSETHUB_API_BASE_URL), then run the same command again — ' +
        'blobs that already landed are detected and skipped, so the upload continues where it stopped.',
      {cause: error},
    )
  }
}

type ErrorEnvelope = {
  success?: boolean
  error?: {code?: string; message?: string; details?: Record<string, unknown>}
}

const readJson = async (response: Response): Promise<ErrorEnvelope | null> => {
  try {
    return (await response.json()) as ErrorEnvelope
  } catch {
    // HEAD, 204, or a proxy's HTML error page.
    return null
  }
}

const errorFrom = async (
  response: Response,
  url: string,
  method: string,
  parsed?: ErrorEnvelope | null,
): Promise<RunUploadError> => {
  const payload = parsed === undefined ? await readJson(response) : parsed
  const code = payload?.error?.code ?? `HTTP_${response.status}`
  const message = payload?.error?.message ?? `${method} ${originOf(url)} failed with ${response.status}`
  const details = payload?.error?.details
  return new RunUploadError(code, `${message}${hintFor(code, response.status, details)}`, {
    status: response.status,
    details,
  })
}

/** The "what do I do now" half of every server-side failure. */
const hintFor = (
  code: string,
  status: number,
  details: Record<string, unknown> | undefined,
): string => {
  if (code === CONTROL_ERROR_CODES.missingBlobs) {
    const keys = Array.isArray(details?.blobKeys) ? details.blobKeys.map(String) : []
    return (
      `\nProduction Control is missing ${keys.length || 'some'} of this run's blobs` +
      (keys.length > 0 ? `: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}` : '') +
      '.\nRun the same command again — it re-checks every blob and sends only the absent ones.'
    )
  }
  if (code === CONTROL_ERROR_CODES.snapshotConflict) {
    return (
      '\nProduction Control already holds a different snapshot at this revision.' +
      '\nUpload as a new revision with --rev <n> higher than the stored one, or --graph-id to publish it as a separate run.'
    )
  }
  if (code === CONTROL_ERROR_CODES.payloadTooLarge || status === 413) {
    return '\nThe request exceeded the size Production Control accepts. Re-export the run with smaller assets, or split it.'
  }
  // Both of these are 404, so the code is what separates them. Reading a
  // NOT_REGISTERED as "you have no access" would send someone chasing an
  // entitlement they already have.
  if (code === CONTROL_ERROR_CODES.notRegistered) {
    return (
      '\nThat graph is not registered for your org, so there is nothing to upload into.' +
      '\nDrop --skip-register (registration is part of the normal upload), or pass the --graph-id of a run you have already registered.'
    )
  }
  if (status === CONTROL_NOT_ENTITLED_STATUS) {
    return (
      '\nThis API key cannot upload runs to Production Control. That needs an internal account whose org has the Production Control entitlement.' +
      '\nCheck `assethub auth status` is using the key you meant, then ask for access.'
    )
  }
  if (status === 401 || status === 403) {
    return '\nThe API key was rejected. Re-run `assethub auth login --api-key-stdin`, or pass --api-key.'
  }
  if (status >= 500) {
    return '\nThat is a server-side failure. Run the same command again — already-uploaded blobs are skipped, so a retry is cheap.'
  }
  return ''
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

const causeText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  const causeMessage = cause instanceof Error ? cause.message : ''
  return causeMessage ? `${error.message} (${causeMessage})` : error.message
}
