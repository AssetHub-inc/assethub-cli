import {appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'

import {redactText} from './redact.js'
import type {SessionMeta} from './types.js'

export const resolveHome = (home?: string): string => home ?? homedir()
export const sessionsRoot = (home?: string): string =>
  join(resolveHome(home), '.assethub', 'sessions')
export const errorsLogPath = (home?: string): string => join(sessionsRoot(home), 'errors.log')

// Sessions hold the artist's conversation and images, and redaction is best
// effort, so everything under ~/.assethub/sessions is private to the user.
export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

/** mkdir -p with private modes; also tightens a directory an older version made. */
export const ensurePrivateDir = async (dir: string): Promise<void> => {
  await mkdir(dir, {recursive: true, mode: PRIVATE_DIR_MODE})
  await chmod(dir, PRIVATE_DIR_MODE)
}

/** Write via a temp file and rename, so a reader never sees a half-written file. */
export const writePrivateFileAtomic = async (target: string, content: string): Promise<void> => {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, content, {mode: PRIVATE_FILE_MODE})
  await rename(tmp, target)
}

export const readMeta = async (sessionDir: string): Promise<SessionMeta | null> => {
  try {
    return JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

export const writeMeta = async (sessionDir: string, meta: SessionMeta): Promise<void> => {
  await writePrivateFileAtomic(join(sessionDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

/**
 * A lock is a directory, because creating one is atomic. A lock older than
 * `staleMs` belongs to a process that died, and is taken over. Returns the
 * release function, or null when the lock is still held after `waitMs`.
 */
export const acquireLock = async (
  path: string,
  {waitMs, staleMs}: {waitMs: number; staleMs: number},
): Promise<(() => Promise<void>) | null> => {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(path, {mode: PRIVATE_DIR_MODE})
      return () => rm(path, {recursive: true, force: true})
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await stat(path).then(info => Date.now() - info.mtimeMs, () => 0)
      if (age > staleMs) {
        await rm(path, {recursive: true, force: true})
        continue
      }
      if (Date.now() >= deadline) return null
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

/**
 * Read, update and write meta under a per-session lock, so a hook and an
 * upload running at the same time cannot overwrite each other's fields.
 * If the lock cannot be had in time the write still happens: a hook must
 * never hang on a stuck lock.
 */
export const updateMeta = async (
  sessionDir: string,
  fallback: SessionMeta,
  update: (latest: SessionMeta) => SessionMeta,
): Promise<SessionMeta> => {
  const release = await acquireLock(join(sessionDir, '.meta.lock'), {waitMs: 5_000, staleMs: 30_000})
  try {
    const next = update((await readMeta(sessionDir)) ?? fallback)
    await writeMeta(sessionDir, next)
    return next
  } finally {
    await release?.()
  }
}

export const listSessionDirs = async (home?: string): Promise<string[]> => {
  const root = sessionsRoot(home)
  try {
    const entries = await readdir(root, {withFileTypes: true})
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))
      .sort()
  } catch {
    return []
  }
}

export const logError = async (home: string | undefined, error: unknown): Promise<void> => {
  try {
    await ensurePrivateDir(sessionsRoot(home))
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    await appendFile(errorsLogPath(home), `${new Date().toISOString()} ${redactText(message)}\n`, {
      mode: PRIVATE_FILE_MODE,
    })
  } catch {
    // The hook must never fail the agent, even when logging fails.
  }
}
