// A once-a-day "newer CLI available" line. The registry is read by a detached
// `assethub update --refresh-check` process, so no command waits on the
// network; each command only reads the small cache file it leaves behind.
// Nothing is installed automatically: `assethub update` stays an explicit step.

import {spawn} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {compareVersions, PACKAGE_NAME} from './update.js'

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type UpdateCheckCache = {checkedAt: string; latest: string}

export const updateCheckPath = (configPath: string): string => join(dirname(configPath), 'update-check.json')

export const readUpdateCheck = async (path: string): Promise<UpdateCheckCache | undefined> => {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCheckCache>
    return typeof cache.checkedAt === 'string' && typeof cache.latest === 'string'
      ? {checkedAt: cache.checkedAt, latest: cache.latest}
      : undefined
  } catch {
    return undefined
  }
}

export const writeUpdateCheck = async (path: string, latest: string, now = new Date()): Promise<void> => {
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, `${JSON.stringify({checkedAt: now.toISOString(), latest} satisfies UpdateCheckCache)}\n`)
}

/**
 * Only an installed package can be upgraded by `assethub update`; a source
 * checkout or an npx run has nothing to announce.
 */
export const isInstalledPackage = (cliPath: string): boolean => {
  const path = cliPath.replaceAll('\\', '/')
  return path.includes(`/node_modules/${PACKAGE_NAME}/`) && !path.includes('/_npx/')
}

/** Opted out, or running somewhere nobody reads a hint (CI). */
export const updateCheckDisabled = (env: NodeJS.ProcessEnv): boolean =>
  ['1', 'true'].includes((env.ASSETHUB_NO_UPDATE_CHECK ?? '').toLowerCase()) || Boolean(env.CI)

export type NoticeDecision = {notice?: string; refresh: boolean}

/** What to print now, and whether the cache is old enough to refresh in the background. */
export const decideUpdateNotice = (
  current: string,
  cache: UpdateCheckCache | undefined,
  now: Date,
): NoticeDecision => {
  const checked = cache ? Date.parse(cache.checkedAt) : Number.NaN
  const refresh = !Number.isFinite(checked) || now.getTime() - checked >= CHECK_INTERVAL_MS || checked > now.getTime()
  const newer = cache !== undefined && compareVersions(cache.latest, current) > 0
  return {
    refresh,
    ...(newer
      ? {notice: `${PACKAGE_NAME} ${cache.latest} is available (you have ${current}). Run \`assethub update\` to upgrade; your login is kept.`}
      : {}),
  }
}

/** Starts the background refresh and returns at once; the child outlives this process. */
export const refreshInBackground = (node: string, cli: string, configPath: string): void => {
  try {
    const child = spawn(node, [cli, 'update', '--refresh-check', '--config', configPath], {
      detached: true,
      stdio: 'ignore',
      env: {...process.env, ASSETHUB_NO_UPDATE_CHECK: '1'},
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // best effort: a missing hint must never fail the user's command
  }
}
