import {describe, expect, test} from 'vitest'
import {
  compareVersions,
  detectInstall,
  installCommand,
  resolveLatestVersion,
  runUpdate,
  type UpdateDeps,
} from '../update.js'

const NPM_ROOT = '/usr/local/lib/node_modules'
const NPM_BIN = `${NPM_ROOT}/@assethub/cli/dist/index.js`

describe('compareVersions', () => {
  test('orders numeric components numerically, not lexically', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('0.1.30', '0.1.30')).toBe(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  test('ranks a prerelease below its release', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBeGreaterThan(0)
  })
})

describe('detectInstall', () => {
  test('recognises a global npm install from the npm global root', () => {
    expect(detectInstall(NPM_BIN, NPM_ROOT)).toEqual({kind: 'global', installer: 'npm'})
  })

  test.each([
    ['/Users/a/.bun/install/global/node_modules/@assethub/cli/dist/index.js', 'bun'],
    ['/Users/a/Library/pnpm/global/5/.pnpm/@assethub+cli@0.1.30/node_modules/@assethub/cli/dist/index.js', 'pnpm'],
    ['/Users/a/.config/yarn/global/node_modules/@assethub/cli/dist/index.js', 'yarn'],
    ['/Users/a/.volta/tools/image/packages/@assethub/cli/lib/node_modules/@assethub/cli/dist/index.js', 'volta'],
  ])('recognises %s as a %s global install', (path, installer) => {
    expect(detectInstall(path, NPM_ROOT)).toEqual({kind: 'global', installer})
  })

  test('refuses an npx cache, a project dependency, and a source checkout', () => {
    expect(detectInstall('/Users/a/.npm/_npx/abc/node_modules/@assethub/cli/dist/index.js', NPM_ROOT).kind).toBe('npx')
    expect(detectInstall('/Users/a/game/node_modules/@assethub/cli/dist/index.js', NPM_ROOT).kind).toBe('project')
    expect(detectInstall('/Users/a/assethub-web/packages/assethub-cli/dist/index.js', NPM_ROOT).kind).toBe('source')
  })
})

test('installCommand pins the exact version for every installer', () => {
  expect(installCommand('npm', '0.1.31')).toEqual(['npm', ['install', '--global', '@assethub/cli@0.1.31']])
  expect(installCommand('pnpm', '0.1.31')).toEqual(['pnpm', ['add', '--global', '@assethub/cli@0.1.31']])
  expect(installCommand('yarn', '0.1.31')).toEqual(['yarn', ['global', 'add', '@assethub/cli@0.1.31']])
  expect(installCommand('bun', '0.1.31')).toEqual(['bun', ['add', '--global', '@assethub/cli@0.1.31']])
  expect(installCommand('volta', '0.1.31')).toEqual(['volta', ['install', '@assethub/cli@0.1.31']])
})

describe('resolveLatestVersion', () => {
  test('asks the package manager first, so .npmrc auth, registry and proxy apply', async () => {
    let fetched = false
    const version = await resolveLatestVersion(
      async () => '0.1.31',
      async () => {
        fetched = true
        return '9.9.9'
      },
    )
    expect(version).toBe('0.1.31')
    expect(fetched).toBe(false)
  })

  test('falls back to the registry when npm is unavailable', async () => {
    expect(
      await resolveLatestVersion(
        async () => {
          throw new Error('spawn npm ENOENT')
        },
        async () => '0.1.31',
      ),
    ).toBe('0.1.31')
  })

  test('reports both failures when neither source answers', async () => {
    await expect(
      resolveLatestVersion(
        async () => {
          throw new Error('npm view: E401')
        },
        async () => {
          throw new Error('HTTP 401')
        },
      ),
    ).rejects.toThrow(/npm view: E401.*HTTP 401/s)
  })
})

type Calls = {runs: [string, string[]][]; said: string[]; verified: number; refreshed: number}

const deps = (overrides: Partial<UpdateDeps> = {}): {deps: UpdateDeps; calls: Calls} => {
  const calls: Calls = {runs: [], said: [], verified: 0, refreshed: 0}
  return {
    calls,
    deps: {
      currentVersion: async () => '0.1.30',
      latestVersion: async () => '0.1.31',
      binPath: async () => NPM_BIN,
      npmGlobalRoot: async () => NPM_ROOT,
      run: async (command, args) => {
        calls.runs.push([command, args])
        return {code: 0}
      },
      verify: async () => {
        calls.verified += 1
        return {version: '0.1.31', auth: 'pass'}
      },
      prepareSkillRefresh: async () => async () => {
        calls.refreshed += 1
        return [{path: '/Users/a/.agents/skills/assethub', change: 'updated', version: '0.1.31'}]
      },
      interactive: false,
      confirm: async () => true,
      say: message => {
        calls.said.push(message)
      },
      ...overrides,
    },
  }
}

describe('runUpdate', () => {
  test('installs the latest version with the detected installer and keeps the saved login', async () => {
    const {deps: d, calls} = deps()
    const report = await runUpdate({}, d)
    expect(calls.runs).toEqual([['npm', ['install', '--global', '@assethub/cli@0.1.31']]])
    expect(report).toMatchObject({
      status: 'updated',
      from: '0.1.30',
      to: '0.1.31',
      installer: 'npm',
      auth: 'pass',
    })
  })

  test('does nothing when already on the latest version', async () => {
    const {deps: d, calls} = deps({latestVersion: async () => '0.1.30'})
    expect(await runUpdate({}, d)).toMatchObject({status: 'up_to_date', from: '0.1.30', latest: '0.1.30'})
    expect(calls.runs).toEqual([])
  })

  test('never downgrades a newer local build', async () => {
    const {deps: d, calls} = deps({currentVersion: async () => '0.2.0'})
    expect(await runUpdate({}, d)).toMatchObject({status: 'up_to_date'})
    expect(calls.runs).toEqual([])
  })

  test('--check reports an available update without installing', async () => {
    const {deps: d, calls} = deps()
    expect(await runUpdate({check: true}, d)).toMatchObject({status: 'update_available', from: '0.1.30', latest: '0.1.31'})
    expect(calls.runs).toEqual([])
  })

  test('--dry-run prints the install command without running it', async () => {
    const {deps: d, calls} = deps()
    expect(await runUpdate({dryRun: true}, d)).toMatchObject({
      status: 'dry_run',
      command: 'npm install --global @assethub/cli@0.1.31',
    })
    expect(calls.runs).toEqual([])
  })

  test('asks before installing when interactive, and stops if declined', async () => {
    const {deps: d, calls} = deps({interactive: true, confirm: async () => false})
    await expect(runUpdate({}, d)).rejects.toThrow(/cancelled/i)
    expect(calls.runs).toEqual([])
  })

  test('--yes skips the confirmation', async () => {
    let asked = false
    const {deps: d, calls} = deps({
      interactive: true,
      confirm: async () => {
        asked = true
        return false
      },
    })
    await runUpdate({yes: true}, d)
    expect(asked).toBe(false)
    expect(calls.runs).toHaveLength(1)
  })

  test('fails loudly when the installer exits non-zero', async () => {
    const {deps: d, calls} = deps({run: async () => ({code: 243})})
    await expect(runUpdate({}, d)).rejects.toThrow(/npm install --global @assethub\/cli@0\.1\.31.*243/)
    expect(calls.verified).toBe(0)
  })

  test('fails when the installed binary still reports the old version', async () => {
    const {deps: d} = deps({verify: async () => ({version: '0.1.30', auth: 'pass'})})
    await expect(runUpdate({}, d)).rejects.toThrow(/still reports 0\.1\.30/)
  })

  test('reports a saved login that no longer works instead of claiming success silently', async () => {
    const {deps: d, calls} = deps({verify: async () => ({version: '0.1.31', auth: 'fail'})})
    expect(await runUpdate({}, d)).toMatchObject({status: 'updated', auth: 'fail'})
    expect(calls.said.join('\n')).toMatch(/assethub doctor/)
  })

  test('overwrites the installed agent skill with the new version and says so', async () => {
    const {deps: d, calls} = deps()
    const report = await runUpdate({}, d)
    expect(calls.refreshed).toBe(1)
    expect(report).toMatchObject({
      status: 'updated',
      skills: [{path: '/Users/a/.agents/skills/assethub', change: 'updated', version: '0.1.31'}],
    })
    expect(calls.said.join('\n')).toMatch(/Agent skill updated: \/Users\/a\/\.agents\/skills\/assethub \(0\.1\.31\)/)
  })

  test('a skill refresh that fails does not fail the update and says how to retry', async () => {
    const {deps: d, calls} = deps({
      prepareSkillRefresh: async () => {
        throw new Error('EACCES')
      },
    })
    expect(await runUpdate({}, d)).toMatchObject({status: 'updated', skills: []})
    expect(calls.said.join('\n')).toMatch(/EACCES.*assethub setup --only skills/)
  })

  test('rewrites the skill only after the installed binary is verified as the new version', async () => {
    const {deps: d, calls} = deps({verify: async () => ({version: '0.1.30', auth: 'pass'})})
    await expect(runUpdate({}, d)).rejects.toThrow(/still reports/)
    expect(calls.refreshed).toBe(0)
  })

  test('never touches the skill when nothing was installed', async () => {
    for (const options of [{check: true}, {dryRun: true}]) {
      const {deps: d, calls} = deps()
      await runUpdate(options, d)
      expect(calls.refreshed).toBe(0)
    }
    const failed = deps({run: async () => ({code: 1})})
    await expect(runUpdate({}, failed.deps)).rejects.toThrow()
    expect(failed.calls.refreshed).toBe(0)
  })

  test.each([
    ['/Users/a/.npm/_npx/abc/node_modules/@assethub/cli/dist/index.js', /npx @assethub\/cli@latest/],
    ['/Users/a/game/node_modules/@assethub/cli/dist/index.js', /project dependency/],
    ['/Users/a/assethub-web/packages/assethub-cli/dist/index.js', /source checkout/],
  ])('refuses to self-update from %s', async (path, message) => {
    const {deps: d, calls} = deps({binPath: async () => path})
    await expect(runUpdate({}, d)).rejects.toThrow(message)
    expect(calls.runs).toEqual([])
  })

  test('--check still works where self-update is refused', async () => {
    const {deps: d} = deps({binPath: async () => '/Users/a/game/node_modules/@assethub/cli/dist/index.js'})
    expect(await runUpdate({check: true}, d)).toMatchObject({status: 'update_available'})
  })
})

describe('createNodeUpdateDeps().prepareSkillRefresh', () => {
  test('reports an unreadable skill marker instead of treating the skill as not installed', async () => {
    const {mkdtemp, mkdir, rm} = await import('node:fs/promises')
    const {tmpdir} = await import('node:os')
    const {join} = await import('node:path')
    const {createNodeUpdateDeps} = await import('../update.js')
    const home = await mkdtemp(join(tmpdir(), 'assethub-skill-marker-'))
    const previous = process.env.ASSETHUB_CLI_HOME
    process.env.ASSETHUB_CLI_HOME = home
    try {
      // A directory where the marker file belongs: reading it fails with EISDIR, not ENOENT.
      await mkdir(join(home, '.agents', 'skills', 'assethub', '.assethub-cli-version'), {recursive: true})
      await expect(createNodeUpdateDeps([]).prepareSkillRefresh()).rejects.toThrow(/cannot read .*\.assethub-cli-version/)
    } finally {
      if (previous === undefined) delete process.env.ASSETHUB_CLI_HOME
      else process.env.ASSETHUB_CLI_HOME = previous
      await rm(home, {recursive: true, force: true})
    }
  })
})
