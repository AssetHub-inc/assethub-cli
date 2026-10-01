// Keeping the CLI current. Once a day a detached `assethub update --refresh-check`
// process reads the latest version and, with auto-update on (the default),
// installs it the way `assethub update` would. No command ever waits on the
// network or the install: each one only reads the small cache file the
// background process leaves behind, announces what happened once, and moves on.

import {spawn} from 'node:child_process'
import {mkdir, open, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {compareVersions, PACKAGE_NAME, runUpdate, type UpdateDeps} from './update.js'

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const REFRESH_CHILD_ENV = 'ASSETHUB_UPDATE_REFRESH_CHILD'

/** What the last background install did; announced once, then marked. */
export type AutoUpdateResult =
  | {from: string; to: string; at: string; announced?: boolean}
  | {from: string; error: string; at: string; announced?: boolean}

export type UpdateCheckCache = {
  checkedAt: string
  latest: string
  autoUpdate?: AutoUpdateResult
  /** When the `is available` line was last shown: at most once a day. */
  noticedAt?: string
}

export const updateCheckPath = (configPath: string): string => join(dirname(configPath), 'update-check.json')

export const readUpdateCheck = async (path: string): Promise<UpdateCheckCache | undefined> => {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCheckCache>
    return typeof cache.checkedAt === 'string' && typeof cache.latest === 'string'
      ? {
          checkedAt: cache.checkedAt,
          latest: cache.latest,
          ...(cache.autoUpdate && typeof cache.autoUpdate === 'object' ? {autoUpdate: cache.autoUpdate} : {}),
          ...(typeof cache.noticedAt === 'string' ? {noticedAt: cache.noticedAt} : {}),
        }
      : undefined
  } catch {
    return undefined
  }
}

export const writeUpdateCheck = async (
  path: string,
  latest: string,
  now = new Date(),
  autoUpdate?: AutoUpdateResult,
): Promise<void> => {
  await mkdir(dirname(path), {recursive: true})
  const cache: UpdateCheckCache = {checkedAt: now.toISOString(), latest, ...(autoUpdate ? {autoUpdate} : {})}
  await writeFile(path, `${JSON.stringify(cache)}\n`)
}

/** Rewrites the cache with some fields changed (announcement bookkeeping by the foreground command). */
export const patchUpdateCheck = async (path: string, cache: UpdateCheckCache, patch: Partial<UpdateCheckCache>): Promise<void> => {
  await writeFile(path, `${JSON.stringify({...cache, ...patch})}\n`)
}

// A failed or slow refresh leaves the cache stale; this marker keeps every
// command from starting another one. Retried at most once an hour.
export const ATTEMPT_INTERVAL_MS = 60 * 60 * 1000
export const attemptPath = (cachePath: string): string => `${cachePath}.attempt`

/** Whether a refresh was started recently enough not to start another; records this attempt when not. */
export const claimRefreshAttempt = async (cachePath: string, now = new Date()): Promise<boolean> => {
  const path = attemptPath(cachePath)
  const last = await readFile(path, 'utf8').then(text => Date.parse(text.trim()), () => Number.NaN)
  if (Number.isFinite(last) && now.getTime() - last < ATTEMPT_INTERVAL_MS && last <= now.getTime()) return false
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, `${now.toISOString()}\n`)
  return true
}

// ---- the auto-update setting (on unless turned off) ----

export const settingsPath = (configPath: string): string => join(dirname(configPath), 'settings.json')

/** The saved choice: true or false, or undefined when never set (which means on). */
export const readAutoUpdateSetting = async (path: string): Promise<boolean | undefined> => {
  try {
    const value = (JSON.parse(await readFile(path, 'utf8')) as {autoUpdate?: unknown}).autoUpdate
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

export const writeAutoUpdateSetting = async (path: string, autoUpdate: boolean): Promise<void> => {
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>
  } catch {
    // missing or unreadable: start fresh
  }
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, `${JSON.stringify({...settings, autoUpdate}, null, 2)}\n`)
}

const truthy = (value: string | undefined): boolean => ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())

/** Auto-update is on by default; the saved setting or ASSETHUB_NO_AUTO_UPDATE turns it off. */
export const autoUpdateEnabled = (setting: boolean | undefined, env: NodeJS.ProcessEnv): boolean =>
  setting !== false && !truthy(env.ASSETHUB_NO_AUTO_UPDATE) && !updateCheckDisabled(env)

/**
 * Only a global install can be upgraded by `assethub update`: a project
 * dependency, an npx run or a source checkout has nothing to announce. Same
 * layouts as update.ts's detectInstall, without running `npm root --global`
 * on every command.
 */
export const isInstalledPackage = (cliPath: string): boolean => {
  const path = cliPath.replaceAll('\\', '/')
  if (!path.includes(`/node_modules/${PACKAGE_NAME}/`) || path.includes('/_npx/')) return false
  return [
    `/lib/node_modules/${PACKAGE_NAME}/`, // npm, nvm, Homebrew node, a custom npm prefix
    `/npm/node_modules/${PACKAGE_NAME}/`, // npm on Windows (%AppData%/npm)
    '/.volta/',
    '/.bun/install/global/',
    '/pnpm/global/',
    '/yarn/global/',
  ].some(segment => path.includes(segment))
}

/** Opted out, or running somewhere nobody reads a hint (CI). */
export const updateCheckDisabled = (env: NodeJS.ProcessEnv): boolean =>
  truthy(env.ASSETHUB_NO_UPDATE_CHECK) || Boolean(env.CI)

export type NoticeDecision = {notices: string[]; refresh: boolean; markAnnounced: boolean; markNoticed: boolean}

const TURN_OFF = 'turn off with `assethub setup --no-auto-update`'

/** What to print now, whether to mark a background install as announced, and whether to refresh. */
export const decideUpdateNotice = (
  current: string,
  cache: UpdateCheckCache | undefined,
  now: Date,
): NoticeDecision => {
  const checked = cache ? Date.parse(cache.checkedAt) : Number.NaN
  const refresh = !Number.isFinite(checked) || now.getTime() - checked >= CHECK_INTERVAL_MS || checked > now.getTime()
  const notices: string[] = []
  const result = cache?.autoUpdate
  const announce = result !== undefined && !result.announced
  if (announce && 'to' in result && result.to === current)
    notices.push(`${PACKAGE_NAME} updated itself from ${result.from} to ${result.to} (auto-update; ${TURN_OFF}).`)
  if (announce && 'error' in result)
    notices.push(`${PACKAGE_NAME} could not update itself to ${cache?.latest}: ${result.error}`)
  const noticed = cache?.noticedAt ? Date.parse(cache.noticedAt) : Number.NaN
  const noticeDue = !Number.isFinite(noticed) || now.getTime() - noticed >= CHECK_INTERVAL_MS || noticed > now.getTime()
  // A failed install is reported together with the release it could not install.
  const available = cache !== undefined && compareVersions(cache.latest, current) > 0 && (noticeDue || (announce && 'error' in result))
  if (available)
    notices.push(`${PACKAGE_NAME} ${cache.latest} is available (you have ${current}). Run \`assethub update\` to upgrade; your login is kept.`)
  return {notices, refresh, markAnnounced: announce, markNoticed: available}
}

// ---- the background refresh ----

const LOCK_STALE_MS = 15 * 60 * 1000

/** One install at a time, background or `assethub update`: a second one leaves it alone. */
export const takeLock = async (path: string): Promise<boolean> => {
  await mkdir(dirname(path), {recursive: true})
  try {
    await (await open(path, 'wx')).close()
    return true
  } catch {
    const age = await stat(path).then(info => Date.now() - info.mtimeMs, () => 0)
    if (age < LOCK_STALE_MS) return false
    await rm(path, {force: true})
    try {
      await (await open(path, 'wx')).close()
      return true
    } catch {
      return false
    }
  }
}

/**
 * Reads the latest version and, when auto-update is on and it is newer,
 * installs it through `runUpdate` (same installer, same login check as
 * `assethub update --yes`). Records the outcome for the next command to announce.
 */
export const refreshUpdateCheck = async (input: {
  cachePath: string
  lockPath: string
  autoUpdate: boolean
  deps: UpdateDeps
  now?: () => Date
}): Promise<UpdateCheckCache | undefined> => {
  const now = input.now ?? (() => new Date())
  if (!(await takeLock(input.lockPath))) return undefined
  try {
    const [current, latest] = await Promise.all([input.deps.currentVersion(), input.deps.latestVersion()])
    let autoUpdate: AutoUpdateResult | undefined
    if (input.autoUpdate && compareVersions(latest, current) > 0) {
      try {
        const report = await runUpdate({yes: true}, {...input.deps, latestVersion: async () => latest, interactive: false})
        if (report.status === 'updated') autoUpdate = {from: report.from, to: report.to, at: now().toISOString()}
      } catch (error) {
        autoUpdate = {from: current, error: error instanceof Error ? error.message : String(error), at: now().toISOString()}
      }
    }
    await writeUpdateCheck(input.cachePath, latest, now(), autoUpdate)
    return {checkedAt: now().toISOString(), latest, ...(autoUpdate ? {autoUpdate} : {})}
  } finally {
    await rm(input.lockPath, {force: true})
  }
}

/** Starts the background refresh and returns at once; the child outlives this process. */
export const refreshInBackground = (node: string, cli: string, configPath: string): void => {
  try {
    const child = spawn(node, [cli, 'update', '--refresh-check', '--config', configPath], {
      detached: true,
      stdio: 'ignore',
      // Marks the child (and the `assethub doctor` it runs to verify an install) so it
      // neither prints notices nor starts another refresh.
      env: {...process.env, [REFRESH_CHILD_ENV]: '1'},
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // best effort: a missing hint must never fail the user's command
  }
}
