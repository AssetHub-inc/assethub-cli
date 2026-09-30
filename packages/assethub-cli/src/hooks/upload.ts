// Upload saved sessions to AssetHub's coding-agent session store
// (`/api/v2/coding-agent-sessions`). It speaks the same `ag.registry.v1`
// contract as `runs upload`, so the plan and transport are shared; only the
// URL prefix and the extra `session` registration fields differ. Sessions are
// owned by, and readable only by, the key's user.

import {readFile} from 'node:fs/promises'
import {basename, join} from 'node:path'

import {buildRunUploadPlan} from '../runsUpload/buildRunUpload.js'
import {controlRunUploadUrls} from '../runsUpload/controlEndpoints.js'
import {readGraphFolder} from '../runsUpload/graphFolder.js'
import {uploadRun} from '../runsUpload/uploadRun.js'
import {RunUploadError} from '../runsUpload/runUploadError.js'
import {MAX_COMPACT_LEVEL, buildSessionGraphFolder, sessionGraphId} from './graph.js'
import {acquireLock, listSessionDirs, readMeta, resolveHome, updateMeta} from './paths.js'
import {redactText} from './redact.js'
import {materializeSession} from './save.js'
import {TRANSCRIPT_FORMAT} from './trim.js'
import type {SessionMeta, UploadOutcome} from './types.js'

const DEFAULT_BASE_URL = 'https://app.assethub.io'
export const CODING_AGENT_SESSION_API_PREFIX = '/api/v2/coding-agent-sessions'

/** `.assethub/canvas` holds a Workflow canvas id; only a positive integer is sent. */
const canvasIdOf = (value: string | undefined): number | null => {
  const id = Number(value?.trim())
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
const DAY_MS = 24 * 60 * 60 * 1000
export const UPLOAD_TIMEOUT_MS = 20_000

export type UploadAuth = {apiKey: string; baseUrl: string; workspaceId?: string}

export type UploadOptions = {
  profile?: string
  home?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  auth?: UploadAuth
  now?: () => Date
  /** Ignore the once-a-day throttle after a `no-upload-access` answer. */
  force?: boolean
  timeoutMs?: number
}

/**
 * Resolve the CLI profile's key + base URL from ~/.assethub/config.json.
 * src/index.ts's resolveAuth is module-private, so this mirrors its precedence
 * for the non-interactive case (stored profile, then ASSETHUB_API_KEY).
 */
export const resolveUploadAuth = async (
  options: Pick<UploadOptions, 'profile' | 'home' | 'env'>,
): Promise<UploadAuth | null> => {
  const env = options.env ?? process.env
  const configPath = env.ASSETHUB_CLI_CONFIG ?? join(resolveHome(options.home), '.assethub', 'config.json')
  let config: {
    defaultProfile?: string
    profiles?: Record<string, {apiKey?: string; baseUrl?: string; workspaceId?: string; authentication?: string}>
  } = {}
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    // no config: fall back to env only
  }
  const name = options.profile ?? config.defaultProfile ?? 'default'
  const stored = config.profiles?.[name]
  const envKey = env.ASSETHUB_API_KEY?.trim()
  // Same precedence as the CLI's own auth: an explicit profile, a selected
  // workspace or a personal profile wins over ASSETHUB_API_KEY.
  const personal = stored?.authentication === 'personal' || Boolean(stored?.apiKey?.startsWith('ah_pat_'))
  const useStored = Boolean(options.profile || stored?.workspaceId || personal)
  const apiKey = useStored ? stored?.apiKey : envKey || stored?.apiKey
  if (!apiKey) return null
  const baseUrl =
    (options.profile ? stored?.baseUrl : env.ASSETHUB_API_BASE_URL ?? stored?.baseUrl) ??
    DEFAULT_BASE_URL
  // The selected workspace belongs to the saved key, not to an ASSETHUB_API_KEY override.
  const workspaceId = apiKey === stored?.apiKey ? stored?.workspaceId : undefined
  return {apiKey, baseUrl, ...(workspaceId ? {workspaceId} : {})}
}

/** Automatic retries after an ordinary failure wait 1h, 2h, 4h … up to a day. */
export const retryDelayMs = (failedAttempts: number): number =>
  Math.min(DAY_MS, 60 * 60 * 1000 * 2 ** Math.max(0, failedAttempts - 1))

const causeName = (error: unknown): string | undefined => {
  const cause = (error as {cause?: {name?: unknown}} | undefined)?.cause
  return typeof cause?.name === 'string' ? cause.name : undefined
}

/** The upload was too big, or too slow to finish: a smaller graph may get through. */
const isSizeOrTimeFailure = (error: unknown): boolean => {
  if (!(error instanceof RunUploadError)) {
    const name = (error as {name?: unknown} | undefined)?.name
    return name === 'TimeoutError' || name === 'AbortError'
  }
  if (['push_too_large', 'PAYLOAD_TOO_LARGE'].includes(error.code)) return true
  if (error.status === 413 || error.status === 504) return true
  const cause = causeName(error)
  return error.code === 'network_unreachable' && (cause === 'TimeoutError' || cause === 'AbortError')
}

/**
 * One upload per session at a time: the SessionEnd upload and a background
 * retry would otherwise rebuild the same graph folder under each other.
 */
export const uploadSession = async (
  sessionDir: string,
  options: UploadOptions = {},
): Promise<UploadOutcome> => {
  if (!(await readMeta(sessionDir))) return {ok: false, reason: 'no-session'}
  const release = await acquireLock(join(sessionDir, '.upload.lock'), {waitMs: 0, staleMs: 15 * 60_000})
  if (!release) return {ok: false, reason: 'upload-in-progress', throttled: true}
  try {
    return await uploadSessionUnlocked(sessionDir, options)
  } finally {
    await release()
  }
}

const uploadSessionUnlocked = async (
  sessionDir: string,
  options: UploadOptions,
): Promise<UploadOutcome> => {
  const now = options.now ?? (() => new Date())
  let meta = await readMeta(sessionDir)
  if (!meta) return {ok: false, reason: 'no-session'}

  if (!options.force && meta.lastUploadAttemptAt) {
    const since = now().getTime() - new Date(meta.lastUploadAttemptAt).getTime()
    if (meta.reason === 'no-upload-access' && since < DAY_MS) {
      return {ok: false, reason: 'no-upload-access', throttled: true}
    }
    if ((meta.failedAttempts ?? 0) > 0 && since < retryDelayMs(meta.failedAttempts ?? 0)) {
      return {ok: false, reason: 'retry-later', throttled: true}
    }
  }

  // Re-read on every write: a hook may have saved the session meanwhile.
  const record = async (patch: Partial<SessionMeta>): Promise<void> => {
    await updateMeta(sessionDir, meta as SessionMeta, latest => ({
      ...latest,
      ...patch,
      lastUploadAttemptAt: now().toISOString(),
    }))
  }
  const fail = async (reason: string, patch: Partial<SessionMeta> = {}): Promise<UploadOutcome> => {
    try {
      const latest = (await readMeta(sessionDir)) ?? meta
      await record({status: 'pending-upload', reason, failedAttempts: (latest?.failedAttempts ?? 0) + 1, ...patch})
    } catch {
      // keep the original failure as the answer
    }
    return {ok: false, reason}
  }

  const auth = options.auth ?? (await resolveUploadAuth(options))
  if (!auth) {
    await record({status: 'pending-upload', reason: 'no-credentials'})
    return {ok: false, reason: 'no-credentials'}
  }

  // Copy and redact now if the live transcript moved on since the last copy.
  // Also re-copy a session an older CLI saved whole, so it is trimmed before it leaves the machine.
  if (meta.dirty || meta.transcriptFormat !== TRANSCRIPT_FORMAT)
    meta = (await materializeSession(sessionDir, {env: options.env})) ?? meta

  let level = meta.compactLevel ?? 0
  try {
    const baseFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS
    // Per request, not one deadline for the whole upload: many blobs of up to
    // 4 MiB each cannot share 20 seconds.
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      baseFetch(input, {...init, signal: AbortSignal.timeout(timeoutMs)})) as typeof fetch

    for (;;) {
      // Past every rev ever sent: a snapshot whose response was lost may have
      // been published, and re-sending its rev with new content is a permanent
      // conflict. The server accepts gaps, so skipping an unsent rev is harmless.
      const latest = (await readMeta(sessionDir)) ?? meta
      const rev = Math.max(latest.uploadedRev ?? -1, latest.attemptedRev ?? -1) + 1
      let plan
      try {
        const folder = await readGraphFolder(await buildSessionGraphFolder(sessionDir, {compactLevel: level}))
        plan = await buildRunUploadPlan({
          folder,
          graphId: sessionGraphId(basename(sessionDir)),
          rev,
          description: `Agent session ${meta.sessionId}`,
          tags: ['session', 'agent:claude'],
          now: now(),
        })
      } catch (error) {
        // Too big to send at all: compact and try again right away.
        if (isSizeOrTimeFailure(error) && level < MAX_COMPACT_LEVEL) {
          level += 1
          continue
        }
        throw error
      }
      await record({attemptedRev: rev, compactLevel: level})
      const result = await uploadRun({
        plan,
        baseUrl: auth.baseUrl,
        apiKey: auth.apiKey,
        workspaceId: auth.workspaceId,
        fetchImpl,
        urls: controlRunUploadUrls(auth.baseUrl, CODING_AGENT_SESSION_API_PREFIX),
        registrationExtra: {
          session: {client: meta.client, sessionId: meta.sessionId, canvasId: canvasIdOf(meta.canvasId)},
        },
      })
      await record({
        status: 'uploaded',
        graphId: result.graphId,
        uploadedRev: rev,
        reason: undefined,
        failedAttempts: 0,
      })
      return {ok: true, graphId: result.graphId}
    }
  } catch (error) {
    if (error instanceof RunUploadError && error.status === 404) {
      await record({status: 'pending-upload', reason: 'no-upload-access'})
      return {ok: false, reason: 'no-upload-access'}
    }
    const reason = redactText(error instanceof Error ? error.message : String(error)).slice(0, 500)
    // Too big or too slow on the wire: the next try sends a smaller graph.
    const compacted = isSizeOrTimeFailure(error) ? {compactLevel: Math.min(level + 1, MAX_COMPACT_LEVEL)} : {}
    return fail(reason, compacted)
  }
}

/**
 * Upload pending sessions, newest first. `limit` caps how many are attempted
 * (sessions waiting out a retry delay do not count); `exclude` skips one that
 * the caller already handled.
 */
export const uploadPending = async (
  options: UploadOptions & {limit?: number; exclude?: string} = {},
): Promise<{session: string; outcome: UploadOutcome}[]> => {
  const pending: {dir: string; savedAt: number}[] = []
  for (const dir of await listSessionDirs(options.home)) {
    if (dir === options.exclude) continue
    const meta = await readMeta(dir)
    if (meta?.status !== 'pending-upload') continue
    pending.push({dir, savedAt: new Date(meta.savedAt).getTime() || 0})
  }
  pending.sort((a, b) => b.savedAt - a.savedAt)
  const results: {session: string; outcome: UploadOutcome}[] = []
  let attempted = 0
  for (const {dir} of pending) {
    if (options.limit !== undefined && attempted >= options.limit) break
    const outcome = await uploadSession(dir, options)
    results.push({session: dir, outcome})
    if (!outcome.throttled) attempted += 1
  }
  return results
}
