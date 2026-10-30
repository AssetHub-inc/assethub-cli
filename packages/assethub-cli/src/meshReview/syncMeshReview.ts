// packages/assethub-cli/src/meshReview/syncMeshReview.ts
//
// Sending a finished mesh-review run (findings.json + renders) to Production Control.
// Order: create run (idempotent on the client run key) -> upload each render to its
// signed URL -> complete with the findings.
//
// RESUME. Standalone sync derives its key from project, asset and exact findings bytes;
// a registered run instead reuses its durable session key and immutable output hashes.
// Repeating the same command resumes the same server run instead of creating another. Nothing is recorded as "progress": the server already knows which renders landed
// (complete answers MISSING_RENDERS with the exact list).

import {createHash} from 'node:crypto'
import {readFile, realpath, stat, writeFile} from 'node:fs/promises'
import {dirname, join, sep} from 'node:path'
import {writePrivateFileAtomic} from '../hooks/paths.js'
import {acquireMeshReviewLock} from './sessionLock.js'
import {startAutomaticVisual} from './autoVisual.js'

export const MESH_REVIEW_API_PREFIX = '/api/v2/production/mesh-reviews'
export const MESH_REVIEW_MAX_FINDINGS_BYTES = 4 * 1024 * 1024
export const MESH_REVIEW_MAX_RENDER_BYTES = 20 * 1024 * 1024
export const MESH_REVIEW_SYNC_STATE_FILE = 'mesh-review-sync.json'

export class MeshReviewSyncError extends Error {
  readonly code: string
  readonly status?: number
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options: {status?: number
      details?: Record<string, unknown>
      cause?: unknown} = {},
  ) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause},
    )
    this.name = 'MeshReviewSyncError'
    this.code = code
    this.status = options.status
    this.details = options.details
  }
}

export type SyncSummary = {error: number; warn: number; info: number}
export type SyncProgress =
  | {kind: 'create'; runId: string; created: boolean}
  | {kind: 'render'; index: number; total: number; path: string}
  | {kind: 'complete'; runId: string}
  | {kind: 'visual-quote'; credits: number}
export type SyncResult = {
  runId: string
  status: string
  summary: SyncSummary
  baselineRunId: string | null
  unchanged: boolean
  rendersUploaded: number
  modelPreview?: 'uploaded' | 'unavailable'
  visualReview?: 'started' | 'no_source' | 'unavailable'
  videoPreview?: 'uploaded' | 'unavailable'
}
export type SyncInput = {
  findingsPath: string
  /** Explicit CLI input only; never read an arbitrary path from findings metadata. */
  previewMeshPath?: string
  previewVideoPath?: string
  visualSourceRoots?: string[]
  visualExplicitSources?: string[]
  clientRunKey?: string
  signal?: AbortSignal
  project: string
  assetKey: string
  baseUrl: string
  apiKey: string
  workspaceId?: string
  fetchImpl?: typeof fetch
  onProgress?: (event: SyncProgress) => void
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const FINALIZING_ATTEMPTS = 5
const FINALIZING_BASE_DELAY_MS = 2000

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

export const computeClientRunKey = ({
  project,
  assetKey,
  findingsBytes,
}: {
  project: string
  assetKey: string
  findingsBytes: Buffer
}): string => sha256(`${project}\0${assetKey}\0${sha256(findingsBytes)}`)

export type Envelope = {success?: boolean
  data?: unknown
  error?: {code?: string; message?: string; details?: Record<string, unknown>}}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return 'the server'
  }
}

const RESUME_HINT = 'Run the same command again; the run is resumed, not duplicated.'

const send = async (fetchImpl: typeof fetch, url: string, init: RequestInit,
): Promise<Response> => {
  try {
    return await fetchImpl(url, init)
  } catch (error) {
    // Nothing here echoes request headers, so the API key cannot leak into a transport error.
    throw new MeshReviewSyncError(
      'network_unreachable',
      `Could not reach ${originOf(url)}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Check your network and --base-url, then run the same command again; the run is resumed, not duplicated.`,
      {cause: error},
    )
  }
}

const readEnvelope = async (response: Response): Promise<Envelope | null> => {
  try {
    return (await response.json()) as Envelope
  } catch {
    return null
  }
}

export const meshReviewCall = async (fetchImpl: typeof fetch, url: string, init: RequestInit,
): Promise<Envelope> => {
  const response = await send(fetchImpl, url, init)
  const payload = await readEnvelope(response)
  if (!response.ok || payload?.success !== true) {
    const code = payload?.error?.code ?? `http_${response.status}`
    throw new MeshReviewSyncError(
      code,
      `${payload?.error?.message ?? `Request failed with HTTP ${response.status}`} (${code}). ${
        response.status >= 500 ? RESUME_HINT : ''
      }`.trim(),
      {status: response.status, details: payload?.error?.details},
    )
  }
  return payload
}

type ComparisonDoc = {inputs?: Array<{path?: string; role?: string; sha256?: string}>; config?: {conceptReview?: unknown; reviewExecution?: unknown; reviewMeshVideo?: unknown; reviewMeshChunks?: unknown}
  findings?: Array<{renders?: string[]}>}
const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value)
const comparisonPaths = (raw: unknown): string[] => {
  if (raw === undefined) return []
  if (!record(raw) || raw.schema !== 'concept-review/v1' || !Array.isArray(raw.views) || raw.views.length > 8)
    throw new MeshReviewSyncError('findings_invalid', 'Invalid concept comparison metadata.',
    )
  return raw.views.flatMap(view => {
    if (!record(view) || !record(view.models)) throw new MeshReviewSyncError('findings_invalid', 'Invalid comparison view.',
      )
    return [view.reference, ...Object.values(view.models)].map(frame => {
      if (!record(frame) || typeof frame.path !== 'string' || !/^renders\/(grey|textured)\/[A-Za-z0-9._-]+\.png$/.test(frame.path))
        throw new MeshReviewSyncError('findings_invalid', 'Invalid comparison render path.',
        )
      return frame.path
    })
  })
}

const RENDER_PATH = /^renders\/(grey|textured)\/[A-Za-z0-9._-]+\.png$/
const HASH = /^[a-f0-9]{64}$/
const executionEvidence = (raw: unknown): Map<string, string> => {
  const hashes = new Map<string, string>()
  if (raw === undefined) return hashes
  const invalid = () => {
    throw new MeshReviewSyncError(
      'findings_invalid',
      'Invalid review execution metadata or evidence hash.',
    )
  }
  const bounded = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max
  if (
    !record(raw) ||
    raw.schema !== 'review-execution/v1' ||
    !Array.isArray(raw.checks) ||
    raw.checks.length > 100
  )
    return invalid()
  if (
    raw.renderHashes !== undefined &&
    (!record(raw.renderHashes) ||
      Object.keys(raw.renderHashes).length > 200 ||
      Object.entries(raw.renderHashes).some(
        ([path, hash]) =>
          path.length > 240 ||
          !RENDER_PATH.test(path) ||
          typeof hash !== 'string' ||
          !HASH.test(hash),
      ))
  )
    return invalid()
  const ids = new Set<string>()
  for (const check of raw.checks) {
    if (
      !record(check) ||
      !bounded(check.id, 120) ||
      ids.has(check.id) ||
      !bounded(check.label, 160) ||
      typeof check.status !== 'string' ||
      !['pass', 'fail', 'needs_review', 'not_applicable'].includes(
        check.status,
      ) ||
      !bounded(check.detail, 4000) ||
      !Array.isArray(check.evidence) ||
      check.evidence.length > 32
    )
      return invalid()
    ids.add(check.id)
    for (const path of check.evidence) {
      if (
        !bounded(path, 240) ||
        !RENDER_PATH.test(path) ||
        !record(raw.renderHashes)
      )
        return invalid()
      const hash = raw.renderHashes[path]
      if (typeof hash !== 'string' || !HASH.test(hash)) return invalid()
      hashes.set(path, hash)
    }
  }
  if (hashes.size > 200) return invalid()
  if (
    raw.pendingConditions !== undefined &&
    (!Array.isArray(raw.pendingConditions) ||
      raw.pendingConditions.length > 40 ||
      raw.pendingConditions.some(value => !bounded(value, 2000)))
  )
    return invalid()
  if (
    raw.textureMaps !== undefined &&
    (!Array.isArray(raw.textureMaps) ||
      raw.textureMaps.length > 32 ||
      raw.textureMaps.some(
        map =>
          !record(map) ||
          !bounded(map.role, 80) ||
          !bounded(map.path, 1024) ||
          typeof map.sha256 !== 'string' ||
          !HASH.test(map.sha256) ||
          ![map.width, map.height].every(
            value =>
              typeof value === 'number' &&
              Number.isInteger(value) &&
              value > 0 &&
              value <= 65536,
          ) ||
          typeof map.channels !== 'number' ||
          !Number.isInteger(map.channels) ||
          map.channels < 1 ||
          map.channels > 4 ||
          !bounded(map.colorSpace, 80),
      ))
  )
    return invalid()
  return hashes
}

type PlannedRender = {path: string
  file: string
  size: number
  expectedHash?: string
}

const planRenders = async (findingsDir: string, doc: ComparisonDoc,
): Promise<PlannedRender[]> => {
  const evidence = executionEvidence(doc.config?.reviewExecution)
  const paths = [...new Set([...(doc.findings ?? []).flatMap(finding => finding.renders ?? []), ...comparisonPaths(doc.config?.conceptReview),
      ...evidence.keys(),
    ]),
  ]
  if (
    paths.length > 200 ||
    paths.some(
      path =>
        typeof path !== 'string' ||
        path.length > 240 ||
        !RENDER_PATH.test(path),
    )
  )
    throw new MeshReviewSyncError(
      'findings_invalid',
      'Invalid render paths or too many renders.',
    )
  const root = await realpath(findingsDir)
  const planned: PlannedRender[] = []
  for (const path of paths) {
    const file = join(findingsDir, path)
    const resolved = await realpath(file).catch(() => null)
    if (resolved && !resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
      throw new MeshReviewSyncError(
        'findings_invalid',
        `Render ${path} resolves outside the review directory.`,
      )
    const info = await stat(file).catch(() => null)
    if (info == null || !info.isFile()) {
      throw new MeshReviewSyncError('render_missing', `findings.json references ${path} but ${file} does not exist. Re-run the review (without --no-render) before syncing.`,
      )
    }
    if (info.size > MESH_REVIEW_MAX_RENDER_BYTES) {
      throw new MeshReviewSyncError('render_too_large', `${file} is ${info.size} bytes; the limit is ${MESH_REVIEW_MAX_RENDER_BYTES}. Re-run with a smaller --render-px.`,
      )
    }
    const expectedHash = evidence.get(path)
    if (expectedHash && sha256(await readFile(file)) !== expectedHash)
      throw new MeshReviewSyncError(
        'render_hash_mismatch',
        `Evidence ${path} does not match its recorded SHA-256.`,
      )
    planned.push({path, file, size: info.size, expectedHash})
  }
  return planned
}

const uploadRender = async (fetchImpl: typeof fetch, signedUrl: string, render: PlannedRender,
): Promise<void> => {
  // Mirrors storage-js `uploadToSignedUrl`: multipart with the file as the unnamed part, upsert on.
  const form = new FormData()
  form.append('cacheControl', '3600')
  const bytes = await readFile(render.file)
  if (render.expectedHash && sha256(bytes) !== render.expectedHash)
    throw new MeshReviewSyncError(
      'render_hash_mismatch',
      `Evidence ${render.path} changed before upload.`,
    )
  form.append('', new Blob([new Uint8Array(bytes)], {type: 'image/png'}))
  const response = await send(fetchImpl, signedUrl, {method: 'PUT', headers: {'x-upsert': 'true'}, body: form,
  })
  if (!response.ok) {
    throw new MeshReviewSyncError('render_upload_failed', `Uploading ${render.path} failed with HTTP ${response.status}. ${RESUME_HINT}`, {status: response.status},
    )
  }
}

const syncOwnedMeshReview = async (input: SyncInput): Promise<SyncResult> => {
  const fetchBase = input.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const fetchImpl: typeof fetch = (url, init) => fetchBase(url, {...init, ...(input.signal ? {signal: input.signal} : {})})
  const onProgress = input.onProgress ?? (() => {})
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const base = `${input.baseUrl.replace(/\/+$/, '')}${MESH_REVIEW_API_PREFIX}`
  // Built once, never logged, never placed in a URL or a query string.
  const authHeaders = {
    authorization: `Bearer ${input.apiKey}`,
    ...(input.workspaceId ? {'x-assethub-workspace': input.workspaceId} : {}),
  }
  const jsonHeaders = {...authHeaders, 'content-type': 'application/json'}

  const findingsBytes = await readFile(input.findingsPath)
  if (findingsBytes.byteLength > MESH_REVIEW_MAX_FINDINGS_BYTES) {
    throw new MeshReviewSyncError('findings_too_large', `${input.findingsPath} is ${findingsBytes.byteLength} bytes; the limit is ${MESH_REVIEW_MAX_FINDINGS_BYTES}. Re-run the review with a lower per-rule element cap.`,
    )
  }
  let doc: ComparisonDoc & {schema?: string}
  try {
    doc = JSON.parse(findingsBytes.toString('utf8'))
  } catch (error) {
    throw new MeshReviewSyncError('findings_invalid', `${input.findingsPath} is not valid JSON.`, {cause: error},
    )
  }
  if (!record(doc) || doc.schema !== 'mesh-review/v1') {
    throw new MeshReviewSyncError('findings_invalid', `${input.findingsPath} is not a mesh-review/v1 findings file.`,
    )
  }
  const dir = dirname(input.findingsPath)
  const renders = await planRenders(dir, doc)
  const sessionPath = join(dir, 'mesh-review-session.json')
  const session: unknown = await readFile(sessionPath, 'utf8').then(JSON.parse, error => { if (error?.code === 'ENOENT') return null; throw error })
  let clientRunKey = input.clientRunKey
  if (session !== null) {
    const credentialScope = `key:${sha256(input.apiKey)}`
    if (!record(session) || session.project !== input.project || session.assetKey !== input.assetKey || session.baseUrl !== input.baseUrl.replace(/\/+$/, '') || session.workspaceId !== (input.workspaceId ?? null) || session.credentialScope !== credentialScope || typeof session.clientRunKey !== 'string' || !HASH.test(session.clientRunKey) || (clientRunKey && clientRunKey !== session.clientRunKey)) throw new MeshReviewSyncError('session_mismatch', 'Review session belongs to different inputs or workspace.')
    if (session.engineCompletedSha256 !== sha256(findingsBytes)) throw new MeshReviewSyncError('session_output_changed', 'Findings have no matching engine completion receipt. Use a new review output directory.')
    const hashes: Array<[string, string]> = []
    for (const render of renders) hashes.push([render.path, sha256(await readFile(render.file))])
    const outputSha256 = sha256(JSON.stringify({findings: sha256(findingsBytes), renders: hashes}))
    if (session.outputSha256 && session.outputSha256 !== outputSha256) throw new MeshReviewSyncError('session_output_changed', 'Findings or rendered evidence changed after this review started uploading. Use a new review output directory.')
    await writePrivateFileAtomic(sessionPath, JSON.stringify({...session, outputSha256}, null, 2))
    clientRunKey = session.clientRunKey
  }
  clientRunKey ??= computeClientRunKey({project: input.project, assetKey: input.assetKey, findingsBytes})

  const created = await meshReviewCall(fetchImpl, `${base}/runs`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      project: input.project,
      assetKey: input.assetKey,
      source: 'local',
      clientRunKey,
      renders: renders.map(({path, size}) => ({path, size})),
    }),
  })
  const run = created.data as {runId: string
    created: boolean
    modelPreviewEnabled?: boolean
    autoVisualEnabled?: boolean
    uploads: Array<{path: string; signedUrl: string}>}
  onProgress({kind: 'create', runId: run.runId, created: run.created})
  await writeFile(
    join(dir, MESH_REVIEW_SYNC_STATE_FILE),
    JSON.stringify({runId: run.runId, clientRunKey, baseUrl: input.baseUrl}, null, 2,
    ),
  )

  const byPath = new Map(renders.map(render => [render.path, render]))
  const uploadPaths = async (targets: Array<{path: string; signedUrl: string}>,
  ) => {
    for (const [index, target] of targets.entries()) {
      const render = byPath.get(target.path)
      if (render == null) continue
      await uploadRender(fetchImpl, target.signedUrl, render)
      onProgress({kind: 'render', index, total: targets.length, path: target.path,
      })
    }
  }
  await uploadPaths(run.uploads)
  let rendersUploaded = run.uploads.length

  const completeOnce = () =>
    meshReviewCall(fetchImpl, `${base}/runs/${encodeURIComponent(run.runId)}/complete`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({findings: doc}),
    },
    )
  // 409 RUN_FINALIZING: another completion holds the run (or crashed mid-write and the server
  // reclaims it after its stale window). Retry with exponential backoff, a few attempts only.
  const complete = async (): Promise<Envelope> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await completeOnce()
      } catch (error) {
        const finalizing = error instanceof MeshReviewSyncError && error.code === 'RUN_FINALIZING'
        if (!finalizing || attempt >= FINALIZING_ATTEMPTS) throw error
        await sleep(FINALIZING_BASE_DELAY_MS * 2 ** (attempt - 1))
      }
    }
  }
  let completed: Envelope
  try {
    completed = await complete()
  } catch (error) {
    if (!(error instanceof MeshReviewSyncError) || error.code !== 'MISSING_RENDERS') throw error
    // One retry: re-send exactly the renders the server says are absent, using fresh signed URLs.
    const missing = (error.details?.missing as string[] | undefined) ?? []
    const again = await meshReviewCall(fetchImpl, `${base}/runs`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        project: input.project,
        assetKey: input.assetKey,
        source: 'local',
        clientRunKey,
        renders: renders.filter(r => missing.includes(r.path)).map(({path, size}) => ({path, size})),
      }),
    })
    // Only re-send what the server listed, even if it signs more URLs than asked for.
    const retryTargets = (again.data as {uploads: Array<{path: string; signedUrl: string}>}).uploads.filter(u => missing.includes(u.path))
    await uploadPaths(retryTargets)
    rendersUploaded += retryTargets.length
    completed = await complete()
  }
  const result = completed.data as Omit<SyncResult, 'rendersUploaded'>
  let modelPreview: SyncResult['modelPreview']
  if (run.modelPreviewEnabled && input.previewMeshPath) {
    modelPreview = 'unavailable'
    try {
      const choices = (doc.inputs ?? []).filter(item => ['final', 'lp', 'hp'].includes(String(item.role)))
      const role = ['final', 'lp', 'hp'].find(value => choices.some(item => item.role === value))
      const selected = choices.filter(item => item.role === role)
      const file = input.previewMeshPath
      const size = (await stat(file)).size
      const chunks = doc.config?.reviewMeshChunks
      const chunked = record(chunks) && chunks.schema === 'mesh-chunks/v1' && chunks.meshSha256 === selected[0]?.sha256 && chunks.size === size && size > MESH_REVIEW_MAX_RENDER_BYTES && size <= 2 * MESH_REVIEW_MAX_RENDER_BYTES
      if (selected.length === 1 && /\.(fbx|glb)$/i.test(file) && size > 0 && (size <= MESH_REVIEW_MAX_RENDER_BYTES || chunked)) {
        const bytes = await readFile(file)
        if (bytes.byteLength === size && sha256(bytes) === selected[0]?.sha256) {
          const prepared = await meshReviewCall(fetchImpl, `${base}/runs/${encodeURIComponent(run.runId)}/model`, {method: 'POST', headers: authHeaders})
          const data = prepared.data as {signedUrl?: string; signedUrls?: string[]}
          const targets = chunked ? data.signedUrls : data.signedUrl ? [data.signedUrl] : undefined
          if (targets?.length === (chunked ? 2 : 1)) {
            let uploaded = true
            for (const [index, signedUrl] of targets.entries()) {
              const part = chunked ? bytes.subarray(index * MESH_REVIEW_MAX_RENDER_BYTES, (index + 1) * MESH_REVIEW_MAX_RENDER_BYTES) : bytes
              const form = new FormData(); form.append('cacheControl', '3600'); form.append('', new Blob([new Uint8Array(part)], {type: 'application/octet-stream'}))
              const response = await send(fetchImpl, signedUrl, {method: 'PUT', headers: {'x-upsert': 'true'}, body: form})
              if (!response.ok) {uploaded = false; break}
            }
            if (uploaded) modelPreview = 'uploaded'
          }
        }
      }
    } catch { /* The completed review is retained even when the optional model upload fails. */ }
  }
  let videoPreview: SyncResult['videoPreview']
  if (run.modelPreviewEnabled && input.previewVideoPath) {
    videoPreview = 'unavailable'
    try {
      const video = doc.config?.reviewMeshVideo
      const choices = (doc.inputs ?? []).filter(item => ['final', 'lp', 'hp'].includes(String(item.role)))
      const role = ['final', 'lp', 'hp'].find(value => choices.some(item => item.role === value))
      const selected = choices.filter(item => item.role === role)
      const size = (await stat(input.previewVideoPath)).size
      if (record(video) && video.schema === 'mesh-turntable/v1' && typeof video.videoSha256 === 'string' && HASH.test(video.videoSha256) && selected.length === 1 && selected[0]?.sha256 === video.meshSha256 && /\.mp4$/i.test(input.previewVideoPath) && size > 0 && size <= MESH_REVIEW_MAX_RENDER_BYTES) {
        const bytes = await readFile(input.previewVideoPath)
        if (bytes.byteLength <= MESH_REVIEW_MAX_RENDER_BYTES && sha256(bytes) === video.videoSha256) {
          const prepared = await meshReviewCall(fetchImpl, `${base}/runs/${encodeURIComponent(run.runId)}/video`, {method: 'POST', headers: authHeaders})
          const signedUrl = (prepared.data as {signedUrl: string}).signedUrl
          const form = new FormData(); form.append('cacheControl', '3600'); form.append('', new Blob([new Uint8Array(bytes)], {type: 'video/mp4'}))
          const response = await send(fetchImpl, signedUrl, {method: 'PUT', headers: {'x-upsert': 'true'}, body: form})
          if (response.ok) videoPreview = 'uploaded'
        }
      }
    } catch { /* The completed review is retained even when the optional video upload fails. */ }
  }
  const visualReview = run.autoVisualEnabled ? await startAutomaticVisual({
    base, runId: run.runId, headers: jsonHeaders, fetchImpl, findingsPath: input.findingsPath,
    doc, roots: input.visualSourceRoots ?? [], explicit: input.visualExplicitSources ?? [],
    credentialScope: `key:${sha256(input.apiKey)}`, call: meshReviewCall,
    onQuote: credits => onProgress({kind: 'visual-quote', credits}),
  }) : undefined
  onProgress({kind: 'complete', runId: run.runId})
  return {...result, rendersUploaded, ...(modelPreview ? {modelPreview} : {}), ...(videoPreview ? {videoPreview} : {}), ...(visualReview ? {visualReview} : {})}
}


/** The run command already owns its session lock; standalone sync must not race a local engine. */
export const syncMeshReview = async (input: SyncInput): Promise<SyncResult> => {
  const dir = dirname(input.findingsPath)
  const release = !input.clientRunKey ? await acquireMeshReviewLock(dir) : undefined
  try { return await syncOwnedMeshReview(input) } finally { await release?.() }
}
