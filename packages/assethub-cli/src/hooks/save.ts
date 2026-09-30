// The hook body: copy + redact the transcript, collect images, prune old
// sessions, and on SessionEnd start the upload in a detached process. Never throws.

import {spawn} from 'node:child_process'
import {chmod, copyFile, readFile, readdir, realpath, rm, stat} from 'node:fs/promises'
import {basename, dirname, extname, join, resolve, sep} from 'node:path'

import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  listSessionDirs,
  logError,
  readMeta,
  sessionsRoot,
  updateMeta,
  writePrivateFileAtomic,
} from './paths.js'
import {redactJsonl} from './redact.js'
import {extractImagePaths} from './transcript.js'
import type {HookInput, SessionImage, SessionMeta} from './types.js'
import type {UploadOptions} from './upload.js'

export const MAX_IMAGES = 50
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export type SaveSessionOptions = {
  /** Raw hook JSON as read from stdin. */
  stdin?: string
  /** Or the already-parsed fields. */
  input?: HookInput
  home?: string
  now?: () => Date
  env?: NodeJS.ProcessEnv
  upload?: Pick<UploadOptions, 'profile'>
  /**
   * Starts `assethub hooks upload --session <dir> --auto` outside the hook.
   * SessionEnd runs while Claude Code exits under a short budget, so the
   * network upload must not run inside it.
   */
  startUpload?: (sessionDir: string, profile?: string) => void
  /** Starts the background retry of pending sessions on SessionStart. */
  startSweep?: (profile?: string) => void
}

export type SaveSessionResult = {
  sessionDir: string
  uploadStarted?: boolean
  pruned?: number
  abandoned?: number
  event?: string
  skipped?: 'opt-out' | 'no-input'
}

const spawnCli = (args: string[], profile?: string): void => {
  const script = process.argv[1]
  if (!script) return
  const argv = [script, ...args]
  if (profile) argv.push('--profile', profile)
  const child = spawn(process.execPath, argv, {detached: true, stdio: 'ignore'})
  child.on('error', () => {})
  child.unref()
}

/** SessionEnd: upload this session, then retry up to SWEEP_LIMIT older pending ones. */
export const spawnDetachedUpload = (sessionDir: string, profile?: string): void =>
  spawnCli(['hooks', 'upload', '--session', sessionDir, '--auto', '--sweep', String(SWEEP_LIMIT)], profile)

/** SessionStart: retry up to SWEEP_LIMIT pending sessions. */
export const spawnDetachedSweep = (profile?: string): void =>
  spawnCli(['hooks', 'upload', '--pending', '--limit', String(SWEEP_LIMIT)], profile)

export const retentionDays = (env: NodeJS.ProcessEnv): number | null => {
  const raw = env.ASSETHUB_SESSION_RETENTION_DAYS?.trim()
  if (!raw) return DEFAULT_RETENTION_DAYS
  if (raw === 'off' || raw === '0') return null
  const days = Number(raw)
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
}

/** Delete saved sessions last written more than `days` ago, whatever their upload state. */
export const pruneSessions = async (
  root: string,
  now: Date,
  days: number,
  keep: string,
): Promise<number> => {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return 0
  }
  for (const name of names) {
    const dir = join(root, name)
    if (dir === keep) continue
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) continue
      const meta = await readMeta(dir)
      const savedAt = meta?.savedAt ? new Date(meta.savedAt).getTime() : info.mtimeMs
      if (now.getTime() - savedAt <= days * DAY_MS) continue
      await rm(dir, {recursive: true, force: true})
      removed += 1
    } catch {
      // leave anything we cannot read
    }
  }
  return removed
}

const optedOut = async (cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> => {
  if (env.ASSETHUB_SESSION_SAVE === 'off') return true
  let dir = resolve(cwd)
  for (;;) {
    try {
      await stat(join(dir, '.assethub', 'no-session-save'))
      return true
    } catch {
      // keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

const readCanvasId = async (cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  if (env.ASSETHUB_CANVAS?.trim()) return env.ASSETHUB_CANVAS.trim()
  try {
    return (await readFile(join(cwd, '.assethub', 'canvas'), 'utf8')).trim() || undefined
  } catch {
    return undefined
  }
}

const safeId = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100)

// `<yyyy-mm-dd>_<id>`: match the id exactly, so session `b` never adopts the
// directory of session `a_b`.
const SESSION_DIR_DATE = /^\d{4}-\d{2}-\d{2}_/
const findSessionDir = async (root: string, id: string, date: string): Promise<string> => {
  try {
    const existing = (await readdir(root)).find(
      name => SESSION_DIR_DATE.test(name) && name.slice(11) === id,
    )
    if (existing) return join(root, existing)
  } catch {
    // root does not exist yet
  }
  return join(root, `${date}_${id}`)
}

const collectImages = async (
  sessionDir: string,
  transcript: string,
  cwd: string,
): Promise<SessionImage[]> => {
  const images: SessionImage[] = []
  let realCwd: string
  try {
    realCwd = await realpath(cwd)
  } catch {
    return images
  }
  for (const original of extractImagePaths(transcript)) {
    if (images.length >= MAX_IMAGES) break
    try {
      const real = await realpath(original)
      if (real !== realCwd && !real.startsWith(realCwd + sep)) continue
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue
      const file = `${String(images.length).padStart(3, '0')}-${safeId(basename(real))}`
      await ensurePrivateDir(join(sessionDir, 'images'))
      await copyFile(real, join(sessionDir, 'images', file))
      await chmod(join(sessionDir, 'images', file), PRIVATE_FILE_MODE)
      images.push({
        original,
        file,
        size: info.size,
        mime: MIME_BY_EXT[extname(real).toLowerCase()] ?? 'application/octet-stream',
      })
    } catch {
      // missing or unreadable: skip
    }
  }
  return images
}

/** A session with no hook for this long, and never ended, was abandoned (crash, killed terminal). */
export const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000
/** Sessions retried in the background per SessionStart / SessionEnd. */
export const SWEEP_LIMIT = 3

/** Events that copy and redact the transcript now; the rest only mark it changed. */
const FULL_SAVE_EVENTS = new Set(['SessionEnd', 'Manual'])

/**
 * Copy + redact the transcript Claude Code keeps at `meta.transcriptPath`, and
 * collect its images. Runs once per SessionEnd and before an upload, never per
 * turn. A copy shorter than the saved one is an older read (a transcript only
 * grows) and never replaces it.
 */
export const materializeSession = async (
  sessionDir: string,
  options: {env?: NodeJS.ProcessEnv; transcriptPath?: string} = {},
): Promise<SessionMeta | null> => {
  const meta = await readMeta(sessionDir)
  if (!meta) return null
  const source = options.transcriptPath ?? meta.transcriptPath
  const target = join(sessionDir, 'transcript.jsonl')
  let raw: string
  try {
    raw = await readFile(source ?? target, 'utf8')
  } catch {
    // Claude Code already cleaned it up: keep whatever copy we have.
    return meta
  }
  const redacted = source ? redactJsonl(raw) : raw
  const savedLength = await stat(target).then(info => info.size, () => -1)
  if (Buffer.byteLength(redacted, 'utf8') < savedLength) return meta
  await writePrivateFileAtomic(target, redacted)
  const images = await collectImages(sessionDir, raw, meta.cwd)
  return updateMeta(sessionDir, meta, latest => ({...latest, images, dirty: false}))
}

/**
 * On SessionStart: a session that never reached SessionEnd and has been quiet
 * for ABANDONED_AFTER_MS is marked for upload, so a crash or a killed terminal
 * does not lose it.
 */
export const markAbandonedSessions = async (
  root: string,
  now: Date,
  currentSessionId?: string,
): Promise<number> => {
  let marked = 0
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return 0
  }
  for (const name of names) {
    const dir = join(root, name)
    const meta = await readMeta(dir)
    if (!meta || meta.status !== 'saved' || meta.sessionId === currentSessionId) continue
    if (now.getTime() - new Date(meta.savedAt).getTime() < ABANDONED_AFTER_MS) continue
    await updateMeta(dir, meta, latest =>
      latest.status === 'saved' ? {...latest, status: 'pending-upload', abandoned: true} : latest,
    )
    marked += 1
  }
  return marked
}

export const saveSession = async (options: SaveSessionOptions = {}): Promise<SaveSessionResult> => {
  const env = options.env ?? process.env
  try {
    let input: HookInput | undefined = options.input
    if (!input && options.stdin?.trim()) input = JSON.parse(options.stdin) as HookInput
    const event = input?.hook_event_name ?? 'unknown'
    const now = (options.now ?? (() => new Date()))()
    const root = sessionsRoot(options.home)
    const uploadOn = env.ASSETHUB_SESSION_UPLOAD !== 'off'

    // SessionStart: pick up what earlier sessions left behind, record nothing.
    if (event === 'SessionStart') {
      const cwd = input?.cwd ?? process.cwd()
      if (await optedOut(cwd, env)) return {sessionDir: '', skipped: 'opt-out', event}
      const result: SaveSessionResult = {sessionDir: '', event}
      result.abandoned = await markAbandonedSessions(root, now, input?.session_id)
      const days = retentionDays(env)
      if (days != null) result.pruned = await pruneSessions(root, now, days, '')
      if (uploadOn && (await listSessionDirs(options.home)).length > 0) {
        ;(options.startSweep ?? spawnDetachedSweep)(options.upload?.profile)
        result.uploadStarted = true
      }
      return result
    }

    if (!input?.session_id || !input.transcript_path) return {sessionDir: '', skipped: 'no-input', event}
    const cwd = input.cwd ?? process.cwd()
    if (await optedOut(cwd, env)) return {sessionDir: '', skipped: 'opt-out', event}

    const id = safeId(input.session_id)
    const sessionDir = await findSessionDir(root, id, now.toISOString().slice(0, 10))
    await ensurePrivateDir(root)
    await ensurePrivateDir(sessionDir)

    const canvasId = await readCanvasId(cwd, env)
    const sessionId = input.session_id
    const transcriptPath = input.transcript_path
    const full = FULL_SAVE_EVENTS.has(event)
    const fresh: SessionMeta = {
      sessionId,
      cwd,
      client: 'claude',
      lastEvent: event,
      savedAt: now.toISOString(),
      status: 'saved',
      images: [],
    }
    // Stop and PreCompact only record that the session moved on: cheap, and
    // nothing to race. Decide from the meta as it is now.
    await updateMeta(sessionDir, fresh, latest => ({
      ...latest,
      sessionId,
      cwd,
      client: 'claude',
      transcriptPath,
      lastEvent: event,
      savedAt: now.toISOString(),
      canvasId: canvasId ?? latest.canvasId,
      dirty: true,
      // An already-uploaded session that grew needs a new revision.
      status:
        event === 'SessionEnd' || latest.status === 'uploaded'
          ? 'pending-upload'
          : (latest.status ?? 'saved'),
    }))
    if (full) await materializeSession(sessionDir, {env, transcriptPath})

    const result: SaveSessionResult = {sessionDir, event}
    if (event === 'SessionEnd') {
      const days = retentionDays(env)
      if (days != null) result.pruned = await pruneSessions(root, now, days, sessionDir)
      if (uploadOn) {
        ;(options.startUpload ?? spawnDetachedUpload)(sessionDir, options.upload?.profile)
        result.uploadStarted = true
      }
    }
    return result
  } catch (error) {
    await logError(options.home, error)
    return {sessionDir: ''}
  }
}
