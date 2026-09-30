import {execFile} from 'node:child_process'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {describe, expect, it} from 'vitest'
import {
  LAUNCH_AGENT_LABEL,
  launchAgentPath,
  launchAgentPlist,
  launchAgentProgram,
  loadKeyIntoLaunchd,
  readLaunchdKey,
} from '../appEnv.js'

const KEY = 'test-fake-key-aaaa-bbbb'

describe('launchAgentProgram', () => {
  // Each fake executable appends "<name> <args…>" to calls.log.
  const withFakes = async (test: (dir: string, log: () => Promise<string[]>) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-launch-agent-'))
    const fake = async (name: string, body = '') => {
      const path = join(dir, name)
      await writeFile(path, `#!/bin/sh\necho "${name} $*" >> "${dir}/calls.log"\n${body}`)
      await chmod(path, 0o755)
    }
    await fake('node')
    await writeFile(join(dir, 'cli.js'), '')
    await fake('assethub')
    // Stands in for the user's login shell: drops `-lic`, then runs the command
    // with a PATH on which only the login shell can find `assethub`.
    await fake('login-shell', `shift\nPATH="${dir}:$PATH" exec /bin/sh -c "$@"\n`)
    try {
      await test(dir, async () =>
        (await readFile(join(dir, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
      )
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  }
  const runProgram = (program: string[], shell: string) =>
    promisify(execFile)(program[0]!, program.slice(1), {env: {PATH: '/usr/bin:/bin', SHELL: shell}})

  it('runs the recorded node and CLI while both still exist', async () => {
    await withFakes(async (dir, log) => {
      const program = launchAgentProgram(join(dir, 'node'), join(dir, 'cli.js'), ['env', 'load', '--profile', 'work'])
      await runProgram(program, join(dir, 'login-shell'))
      expect(await log()).toEqual([`node ${join(dir, 'cli.js')} env load --profile work`])
    })
  })

  it('falls back to `assethub` from the login shell once that node version is gone', async () => {
    await withFakes(async (dir, log) => {
      const program = launchAgentProgram(join(dir, 'removed-node'), join(dir, 'cli.js'), ['env', 'load', '--profile', 'my work'])
      await runProgram(program, join(dir, 'login-shell'))
      expect(await log()).toEqual([
        `login-shell -lic exec assethub "$@" assethub env load --profile my work`,
        'assethub env load --profile my work',
      ])
    })
  })

  it('falls back when the recorded CLI file is gone', async () => {
    await withFakes(async (dir, log) => {
      const program = launchAgentProgram(join(dir, 'node'), join(dir, 'removed-cli.js'), ['env', 'load'])
      await runProgram(program, join(dir, 'login-shell'))
      expect((await log()).at(-1)).toBe('assethub env load')
    })
  })
})

describe('launchAgentPlist', () => {
  it('runs `assethub env load` at login and holds no key', () => {
    const plist = launchAgentPlist(['/opt/node/bin/node', '/opt/cli/dist/index.js', 'env', 'load', '--profile', 'work'])
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).toContain(
      '<array>\n    <string>/opt/node/bin/node</string>\n    <string>/opt/cli/dist/index.js</string>\n    <string>env</string>\n    <string>load</string>\n    <string>--profile</string>\n    <string>work</string>\n  </array>',
    )
    expect(plist).not.toContain(KEY)
  })

  it('escapes XML in program arguments', () => {
    expect(launchAgentPlist(['/a&b/<node>'])).toContain('<string>/a&amp;b/&lt;node&gt;</string>')
  })

  it('lives in the user LaunchAgents folder', () => {
    expect(launchAgentPath('/Users/u')).toBe(`/Users/u/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`)
  })
})

describe('launchd key helpers', () => {
  it('reads the value apps would see', async () => {
    const run = async (file: string, args: string[]) => {
      expect([file, ...args]).toEqual(['/bin/launchctl', 'getenv', 'ASSETHUB_API_KEY'])
      return {code: 0, output: `${KEY}\n`}
    }
    expect(await readLaunchdKey(run)).toBe(KEY)
  })

  it('reads an unset variable as undefined', async () => {
    expect(await readLaunchdKey(async () => ({code: 0, output: '\n'}))).toBeUndefined()
    expect(await readLaunchdKey(async () => ({code: 1, output: 'boom'}))).toBeUndefined()
  })

  it('sets the variable and reports failure without the key', async () => {
    const calls: string[][] = []
    const ok = await loadKeyIntoLaunchd(KEY, async (file, args) => {
      calls.push([file, ...args])
      return {code: 0, output: ''}
    })
    expect(ok).toEqual({ok: true})
    expect(calls).toEqual([['/bin/launchctl', 'setenv', 'ASSETHUB_API_KEY', KEY]])
    const failed = await loadKeyIntoLaunchd(KEY, async () => ({code: 5, output: `denied ${KEY}`}))
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain(KEY)
  })
})
