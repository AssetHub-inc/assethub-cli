import {execFile} from 'node:child_process'
import {cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {describe, expect, it} from 'vitest'
import {cliVersion} from '../setup.js'
import {
  CHECK_INTERVAL_MS,
  decideUpdateNotice,
  isInstalledPackage,
  readUpdateCheck,
  updateCheckDisabled,
  updateCheckPath,
  writeUpdateCheck,
} from '../updateNotice.js'

const now = new Date('2026-10-01T10:00:00.000Z')
const checkedAgo = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('update notice', () => {
  it('announces a newer version from the cache and refreshes a stale cache', () => {
    expect(decideUpdateNotice('0.1.35', {checkedAt: checkedAgo(1000), latest: '0.1.36'}, now)).toEqual({
      refresh: false,
      notice: '@assethub/cli 0.1.36 is available (you have 0.1.35). Run `assethub update` to upgrade; your login is kept.',
    })
    expect(decideUpdateNotice('0.1.35', {checkedAt: checkedAgo(CHECK_INTERVAL_MS), latest: '0.1.35'}, now)).toEqual({refresh: true})
    expect(decideUpdateNotice('0.1.35', undefined, now)).toEqual({refresh: true})
    // A clock that went backwards or a broken date is treated as stale.
    expect(decideUpdateNotice('0.1.35', {checkedAt: '2027-01-01T00:00:00Z', latest: '0.1.35'}, now).refresh).toBe(true)
    expect(decideUpdateNotice('0.1.35', {checkedAt: 'nope', latest: '0.1.35'}, now).refresh).toBe(true)
  })

  it('stays quiet when the installed version is current or newer', () => {
    expect(decideUpdateNotice('0.1.35', {checkedAt: checkedAgo(0), latest: '0.1.35'}, now).notice).toBeUndefined()
    expect(decideUpdateNotice('0.2.0', {checkedAt: checkedAgo(0), latest: '0.1.40'}, now).notice).toBeUndefined()
  })

  it('applies only to an installed package, and can be turned off', () => {
    expect(isInstalledPackage('/usr/local/lib/node_modules/@assethub/cli/dist/index.js')).toBe(true)
    expect(isInstalledPackage('C:\\Users\\u\\AppData\\npm\\node_modules\\@assethub\\cli\\dist\\index.js')).toBe(true)
    expect(isInstalledPackage('/Users/u/.npm/_npx/abc/node_modules/@assethub/cli/dist/index.js')).toBe(false)
    expect(isInstalledPackage('/Users/u/Code/assethub-cli/packages/assethub-cli/dist/index.js')).toBe(false)
    expect(updateCheckDisabled({ASSETHUB_NO_UPDATE_CHECK: '1'})).toBe(true)
    expect(updateCheckDisabled({CI: 'true'})).toBe(true)
    expect(updateCheckDisabled({})).toBe(false)
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
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})

// A copy of the built package under node_modules/@assethub/cli is what a global
// install looks like; the repo's own dist never announces anything.
describe('installed package (spawned)', () => {
  it('prints the notice on stderr only, keeps stdout JSON clean, and honours the opt-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assethub-installed-'))
    try {
      const pkg = fileURLToPath(new URL('../../', import.meta.url))
      const repoModules = fileURLToPath(new URL('../../../../node_modules/', import.meta.url))
      const modules = join(root, 'node_modules')
      const installed = join(modules, '@assethub', 'cli')
      await mkdir(join(modules, '@assethub'), {recursive: true})
      for (const part of ['dist', 'skills', 'package.json']) await cp(join(pkg, part), join(installed, part), {recursive: true})
      for (const entry of await readdir(repoModules))
        if (entry !== '@assethub' && !entry.startsWith('.')) await symlink(join(repoModules, entry), join(modules, entry))
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

      const quiet = await run({ASSETHUB_NO_UPDATE_CHECK: '1'})
      expect(quiet.stderr).not.toContain('is available')
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })
})
