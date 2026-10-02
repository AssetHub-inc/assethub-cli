import {execFile} from 'node:child_process'
import {cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {describe, expect, it, vi} from 'vitest'
import {cliVersion} from '../setup.js'
import type {UpdateDeps} from '../update.js'
import {
  ATTEMPT_INTERVAL_MS,
  attemptPath,
  autoUpdateEnabled,
  CHECK_INTERVAL_MS,
  claimRefreshAttempt,
  decideUpdateNotice,
  isInstalledPackage,
  readAutoUpdateSetting,
  readUpdateCheck,
  refreshUpdateCheck,
  settingsPath,
  updateCheckDisabled,
  updateCheckPath,
  writeAutoUpdateSetting,
  writeUpdateCheck,
} from '../updateNotice.js'

const now = new Date('2026-10-01T10:00:00.000Z')
const checkedAgo = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('update notice', () => {
  it('announces a newer version from the cache and refreshes a stale cache', () => {
    expect(decideUpdateNotice('0.1.35', {checkedAt: checkedAgo(1000), latest: '0.1.36'}, now)).toEqual({
      refresh: false,
      markAnnounced: false,
      markNoticed: true,
      notices: ['@assethub/cli 0.1.36 is available (you have 0.1.35). Run `assethub update` to upgrade; your login is kept.'],
    })
    expect(decideUpdateNotice('0.1.35', {checkedAt: checkedAgo(CHECK_INTERVAL_MS), latest: '0.1.35'}, now)).toEqual({refresh: true, notices: [], markAnnounced: false, markNoticed: false})
    expect(decideUpdateNotice('0.1.35', undefined, now)).toEqual({refresh: true, notices: [], markAnnounced: false, markNoticed: false})
    // A clock that went backwards or a broken date is treated as stale.
    expect(decideUpdateNotice('0.1.35', {checkedAt: '2027-01-01T00:00:00Z', latest: '0.1.35'}, now).refresh).toBe(true)
    expect(decideUpdateNotice('0.1.35', {checkedAt: 'nope', latest: '0.1.35'}, now).refresh).toBe(true)
  })

  it('shows the "is available" line at most once a day', () => {
    const cache = {checkedAt: checkedAgo(1000), latest: '0.1.36'}
    expect(decideUpdateNotice('0.1.35', {...cache, noticedAt: checkedAgo(60_000)}, now)).toMatchObject({notices: [], markNoticed: false})
    expect(decideUpdateNotice('0.1.35', {...cache, noticedAt: checkedAgo(CHECK_INTERVAL_MS)}, now)).toMatchObject({markNoticed: true})
  })

  it('stays quiet when the installed version is current or newer', () => {
    expect(decideUpdateNotice('0.1.35', {checkedAt: checkedAgo(0), latest: '0.1.35'}, now).notices).toEqual([])
    expect(decideUpdateNotice('0.2.0', {checkedAt: checkedAgo(0), latest: '0.1.40'}, now).notices).toEqual([])
  })

  it('announces a background install once, and a failed one with the reason', () => {
    const at = checkedAgo(0)
    const done = decideUpdateNotice('0.1.36', {checkedAt: at, latest: '0.1.36', autoUpdate: {from: '0.1.35', to: '0.1.36', at}}, now)
    expect(done).toMatchObject({markAnnounced: true, notices: [expect.stringContaining('updated itself from 0.1.35 to 0.1.36')]})
    expect(done.notices[0]).toContain('assethub setup --no-auto-update')
    const again = decideUpdateNotice('0.1.36', {checkedAt: at, latest: '0.1.36', autoUpdate: {from: '0.1.35', to: '0.1.36', at, announced: true}}, now)
    expect(again).toMatchObject({markAnnounced: false, notices: []})
    const failed = decideUpdateNotice('0.1.35', {checkedAt: at, latest: '0.1.36', autoUpdate: {from: '0.1.35', error: 'EACCES', at}}, now)
    expect(failed.notices).toEqual([
      '@assethub/cli could not update itself to 0.1.36: EACCES',
      expect.stringContaining('0.1.36 is available'),
    ])
  })

  it('applies only to an installed package, and can be turned off', () => {
    expect(isInstalledPackage('/usr/local/lib/node_modules/@assethub/cli/dist/index.js')).toBe(true)
    expect(isInstalledPackage('/Users/u/.nvm/versions/node/v22.20.0/lib/node_modules/@assethub/cli/dist/index.js')).toBe(true)
    expect(isInstalledPackage('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@assethub\\cli\\dist\\index.js')).toBe(true)
    expect(isInstalledPackage('/Users/u/.volta/tools/image/packages/@assethub/cli/lib/node_modules/@assethub/cli/dist/index.js')).toBe(true)
    // A project dependency cannot be upgraded by `assethub update`.
    expect(isInstalledPackage('/Users/u/work/game/node_modules/@assethub/cli/dist/index.js')).toBe(false)
    expect(isInstalledPackage('/Users/u/.npm/_npx/abc/node_modules/@assethub/cli/dist/index.js')).toBe(false)
    expect(isInstalledPackage('/Users/u/Code/assethub-cli/packages/assethub-cli/dist/index.js')).toBe(false)
    expect(updateCheckDisabled({ASSETHUB_NO_UPDATE_CHECK: '1'})).toBe(true)
    expect(updateCheckDisabled({CI: 'true'})).toBe(true)
    expect(updateCheckDisabled({})).toBe(false)
    // Auto-update: on by default, off by setting, by its own variable, or with the check off.
    expect(autoUpdateEnabled(undefined, {})).toBe(true)
    expect(autoUpdateEnabled(true, {})).toBe(true)
    expect(autoUpdateEnabled(false, {})).toBe(false)
    expect(autoUpdateEnabled(undefined, {ASSETHUB_NO_AUTO_UPDATE: '1'})).toBe(false)
    expect(autoUpdateEnabled(undefined, {CI: 'true'})).toBe(false)
  })

  it('round-trips the cache next to the config and ignores a broken one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-update-cache-'))
    try {
      const path = updateCheckPath(join(dir, 'config.json'))
      expect(path).toBe(join(dir, 'update-check.json'))
      expect(await readUpdateCheck(path)).toBeUndefined()
      await writeUpdateCheck(path, '0.1.36', now)
      expect(await readUpdateCheck(path)).toEqual({checkedAt: now.toISOString(), latest: '0.1.36'})
      await writeFile(path, '{broken')
      expect(await readUpdateCheck(path)).toBeUndefined()

      // A refresh attempt is claimed once an hour, so a failing registry is not asked on every command.
      expect(await claimRefreshAttempt(path, now)).toBe(true)
      expect(await claimRefreshAttempt(path, new Date(now.getTime() + 60_000))).toBe(false)
      expect(await readFile(attemptPath(path), 'utf8')).toContain(now.toISOString())
      expect(await claimRefreshAttempt(path, new Date(now.getTime() + ATTEMPT_INTERVAL_MS))).toBe(true)

      const settings = settingsPath(join(dir, 'config.json'))
      expect(await readAutoUpdateSetting(settings)).toBeUndefined()
      await writeFile(settings, JSON.stringify({other: 1}))
      await writeAutoUpdateSetting(settings, false)
      expect(await readAutoUpdateSetting(settings)).toBe(false)
      expect(JSON.parse(await readFile(settings, 'utf8')).other).toBe(1)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})

describe('background refresh', () => {
  const fakeDeps = (over: Partial<UpdateDeps> = {}) => {
    const runs: string[][] = []
    let version = '0.1.35'
    const deps: UpdateDeps = {
      currentVersion: async () => version,
      latestVersion: async () => '0.1.36',
      binPath: async () => '/usr/local/lib/node_modules/@assethub/cli/dist/index.js',
      npmGlobalRoot: async () => '/usr/local/lib/node_modules',
      run: async (command, args) => {
        runs.push([command, ...args])
        version = '0.1.36'
        return {code: 0}
      },
      verify: async () => ({version, auth: 'pass'}),
      prepareSkillRefresh: async () => async () => [],
      interactive: false,
      confirm: async () => false,
      say: () => {},
      ...over,
    }
    return {deps, runs}
  }
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-refresh-'))
    try {
      await fn(dir)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  }

  it('installs a newer release when auto-update is on and records it for the next command', () =>
    withDir(async dir => {
      const {deps, runs} = fakeDeps()
      const cachePath = join(dir, 'update-check.json')
      await refreshUpdateCheck({cachePath, lockPath: `${cachePath}.lock`, autoUpdate: true, deps, now: () => now})
      expect(runs).toEqual([['npm', 'install', '--global', '@assethub/cli@0.1.36']])
      expect(await readUpdateCheck(cachePath)).toEqual({
        checkedAt: now.toISOString(),
        latest: '0.1.36',
        autoUpdate: {from: '0.1.35', to: '0.1.36', at: now.toISOString()},
      })
      // The lock is released.
      await expect(readFile(`${cachePath}.lock`)).rejects.toThrow()
    }))

  it('only records the latest version when auto-update is off', () =>
    withDir(async dir => {
      const {deps, runs} = fakeDeps()
      const cachePath = join(dir, 'update-check.json')
      await refreshUpdateCheck({cachePath, lockPath: `${cachePath}.lock`, autoUpdate: false, deps, now: () => now})
      expect(runs).toEqual([])
      expect(await readUpdateCheck(cachePath)).toEqual({checkedAt: now.toISOString(), latest: '0.1.36'})
    }))

  it('records a failed install and keeps the current version', () =>
    withDir(async dir => {
      const {deps} = fakeDeps({run: async () => ({code: 243})})
      const cachePath = join(dir, 'update-check.json')
      await refreshUpdateCheck({cachePath, lockPath: `${cachePath}.lock`, autoUpdate: true, deps, now: () => now})
      expect((await readUpdateCheck(cachePath))?.autoUpdate).toEqual({
        from: '0.1.35',
        error: expect.stringContaining('exited with code 243'),
        at: now.toISOString(),
      })
    }))

  it('does not install from a project dependency or npx', () =>
    withDir(async dir => {
      const {deps, runs} = fakeDeps({binPath: async () => '/repo/node_modules/@assethub/cli/dist/index.js'})
      const cachePath = join(dir, 'update-check.json')
      await refreshUpdateCheck({cachePath, lockPath: `${cachePath}.lock`, autoUpdate: true, deps, now: () => now})
      expect(runs).toEqual([])
      expect((await readUpdateCheck(cachePath))?.autoUpdate).toMatchObject({error: expect.stringContaining('project dependency')})
    }))

  it('leaves the work to a refresh that is already running', () =>
    withDir(async dir => {
      const latestVersion = vi.fn(async () => '0.1.36')
      const {deps, runs} = fakeDeps({latestVersion})
      const cachePath = join(dir, 'update-check.json')
      await writeFile(`${cachePath}.lock`, '')
      expect(await refreshUpdateCheck({cachePath, lockPath: `${cachePath}.lock`, autoUpdate: true, deps})).toBeUndefined()
      expect(latestVersion).not.toHaveBeenCalled()
      expect(runs).toEqual([])
    }))
})

// A copy of the built package under node_modules/@assethub/cli is what a global
// install looks like; the repo's own dist never announces anything.
describe('installed package (spawned)', () => {
  it('prints the notice on stderr only, keeps stdout JSON clean, and honours the opt-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assethub-installed-'))
    try {
      const pkg = fileURLToPath(new URL('../../', import.meta.url))
      // <prefix>/lib/node_modules is where npm puts a global install.
      const modules = join(root, 'lib', 'node_modules')
      const installed = join(modules, '@assethub', 'cli')
      await mkdir(join(modules, '@assethub'), {recursive: true})
      for (const part of ['dist', 'skills', 'package.json']) await cp(join(pkg, part), join(installed, part), {recursive: true})
      // Link the dependencies from wherever this checkout keeps them: the package's
      // own node_modules (pnpm) first, then the hoisted root (npm workspaces).
      const linked = new Set(['@assethub/cli'])
      for (const source of [join(pkg, 'node_modules'), fileURLToPath(new URL('../../../../node_modules/', import.meta.url))]) {
        const entries = await readdir(source).catch(() => [] as string[])
        for (const entry of entries.filter(name => !name.startsWith('.'))) {
          const names = entry.startsWith('@')
            ? (await readdir(join(source, entry))).map(name => `${entry}/${name}`)
            : [entry]
          for (const name of names) {
            if (linked.has(name)) continue
            linked.add(name)
            await mkdir(join(modules, name, '..'), {recursive: true})
            await symlink(join(source, name), join(modules, name))
          }
        }
      }
      if (!linked.has('@assethub/api-client'))
        await symlink(fileURLToPath(new URL('../../../assethub-api-client/', import.meta.url)), join(modules, '@assethub', 'api-client'))

      const config = join(root, 'home', 'config.json')
      await writeUpdateCheck(updateCheckPath(config), '99.0.0')
      const run = (extraEnv: Record<string, string>) =>
        promisify(execFile)(process.execPath, [join(installed, 'dist', 'index.js'), 'auth', 'status'], {
          env: {PATH: process.env.PATH ?? '', HOME: join(root, 'home'), ASSETHUB_CLI_HOME: join(root, 'home'), ASSETHUB_CLI_CONFIG: config, ...extraEnv},
        }).catch((error: {stdout: string; stderr: string}) => error)

      const shown = await run({})
      expect(shown.stderr).toContain(`@assethub/cli 99.0.0 is available (you have ${await cliVersion()})`)
      expect(shown.stdout).not.toContain('is available')
      // The cache is fresh, so no background refresh rewrote it.
      expect(JSON.parse(await readFile(updateCheckPath(config), 'utf8')).latest).toBe('99.0.0')

      // Once a day: the next command does not repeat it.
      expect((await run({})).stderr).not.toContain('is available')

      const quiet = await run({ASSETHUB_NO_UPDATE_CHECK: '1'})
      expect(quiet.stderr).not.toContain('is available')

      // A background install that already happened is announced exactly once.
      const version = await cliVersion()
      await writeUpdateCheck(updateCheckPath(config), version, new Date(), {from: '0.0.1', to: version, at: new Date().toISOString()})
      expect((await run({})).stderr).toContain(`updated itself from 0.0.1 to ${version}`)
      expect((await run({})).stderr).not.toContain('updated itself')
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })
})
