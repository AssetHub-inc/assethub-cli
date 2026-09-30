import {spawn} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it, vi} from 'vitest'
import {
  claudeAddArgs,
  findOnPath,
  mergeCodexSection,
  redactKey,
  runSetup,
  type SetupDeps,
  type SetupOptions,
} from '../setupCommand.js'
import {launchAgentPlist} from '../appEnv.js'
import {defaultInstallHooks} from '../setupHooksBridge.js'
import {SESSION_SAVE_DISCLOSURE} from '../hooks/install.js'

const KEY = 'test-fake-key-aaaa-bbbb'
const section = '[mcp_servers.assethub]\nurl = "https://x.test/api/mcp"\nbearer_token_env_var = "ASSETHUB_API_KEY"\n'

const options = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  client: 'both',
  apiKeyStdin: false,
  noHook: false,
  saveSessions: true,
  dryRun: false,
  yes: true,
  printEnv: false,
  ...over,
})

const makeDeps = (over: Partial<SetupDeps> = {}) => {
  const files = new Map<string, string>()
  const logs: string[] = []
  const runs: {file: string; args: string[]}[] = []
  const deps: SetupDeps = {
    interactive: false,
    installHooks: async () => ({installed: true, detail: 'installed'}),
    codexHome: '/home/u/.codex',
    now: () => new Date('2026-09-29T10:00:00.000Z'),
    hasWorkingKey: async () => true,
    login: async () => {},
    promptApiKey: async () => KEY,
    resolveAuth: async () => ({apiKey: KEY, baseUrl: 'https://x.test', profile: 'default', workspaceId: 'ws-1'}),
    discoverWorkspace: async () => undefined,
    useWorkspace: async () => {},
    listWorkspaces: async () => [{id: 'ws-1', name: 'One'}, {id: 'ws-2', name: 'Two'}],
    pickWorkspace: async items => items[1].id,
    confirm: async () => true,
    confirmOptIn: async () => false,
    diagnose: async () => ({ok: true, checks: [{name: 'api', status: 'pass'}, {name: 'mcp', status: 'pass'}]}),
    findBinary: async () => '/bin/claude',
    run: async (file, args) => {
      runs.push({file, args})
      return {code: 0, output: ''}
    },
    readFileIfExists: async path => files.get(path),
    writeFileEnsuringDir: async (path, content) => void files.set(path, content),
    backupFile: async (from, to) => void files.set(to, files.get(from) ?? ''),
    log: line => void logs.push(line),
    platform: 'linux',
    home: '/Users/u',
    launchAgentProgram: ['/opt/node', '/opt/cli.js', 'env', 'load', '--profile', 'default'],
    ...over,
  }
  return {deps, files, logs, runs}
}

describe('mergeCodexSection', () => {
  it('appends to an empty or missing file', () => {
    expect(mergeCodexSection('', section)).toBe(section)
  })

  it('replaces only the assethub table and its sub-tables', () => {
    const existing = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'url = "https://o.test"',
      '',
      '[mcp_servers.assethub]',
      'url = "https://old.test/api/mcp"',
      '',
      '[mcp_servers.assethub.env]',
      'A = "1"',
      '',
      '[mcp_servers.assethub-workspaces]',
      'url = "https://w.test"',
      '',
    ].join('\n')
    const merged = mergeCodexSection(existing, section)
    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain('[mcp_servers.other]\nurl = "https://o.test"')
    expect(merged).toContain('[mcp_servers.assethub-workspaces]\nurl = "https://w.test"')
    expect(merged).toContain('url = "https://x.test/api/mcp"')
    expect(merged).not.toContain('old.test')
    expect(merged).not.toContain('assethub.env')
    expect(merged.match(/\[mcp_servers\.assethub\]/g)).toHaveLength(1)
    expect(mergeCodexSection(merged, section)).toBe(merged)
  })

  it('replaces a quoted assethub table name instead of adding a second one', () => {
    const existing = [
      '[mcp_servers."assethub"]',
      'url = "https://old.test"',
      '',
      "[mcp_servers.'assethub'.env]",
      'A = "1"',
      '',
    ].join('\n')
    const merged = mergeCodexSection(existing, section)
    expect(merged).not.toContain('old.test')
    expect(merged).not.toContain('A = "1"')
    expect(merged.match(/^\[mcp_servers/gm)).toHaveLength(1)
  })

  it('refuses to append when assethub is defined with dotted or inline keys', () => {
    expect(() => mergeCodexSection('[mcp_servers]\nassethub.url = "https://o.test"\n', section)).toThrow(/assethub/)
    expect(() => mergeCodexSection('[mcp_servers]\nassethub = { url = "https://o.test" }\n', section)).toThrow(/assethub/)
    expect(() => mergeCodexSection('mcp_servers.assethub.url = "https://o.test"\n', section)).toThrow(/assethub/)
    // Another server under [mcp_servers] is not a conflict.
    expect(mergeCodexSection('[mcp_servers]\nother.url = "https://o.test"\n', section)).toContain('[mcp_servers.assethub]')
  })

  it('keeps blank lines outside the assethub table untouched', () => {
    const existing = 'a = """\nx\n\n\n\ny\n"""\n\n[mcp_servers.assethub]\nurl = "https://old.test"\n'
    const merged = mergeCodexSection(existing, section)
    expect(merged).toContain('x\n\n\n\ny')
    expect(mergeCodexSection(merged, section)).toBe(merged)
  })
})

describe('runSetup', () => {
  it('registers Claude (add first) and writes Codex with a backup', async () => {
    const {deps, files, runs} = makeDeps()
    const path = '/home/u/.codex/config.toml'
    files.set(path, 'model = "gpt-5"\n')
    const result = await runSetup(options(), deps)
    expect(result.ok).toBe(true)
    expect(runs).toHaveLength(1)
    expect(runs[0].args).toEqual(claudeAddArgs('https://x.test', 'ws-1'))
    expect(runs[0].args.slice(0, 3)).toEqual(['mcp', 'add-json', 'assethub'])
    // MCP first: no CLI in the loop; Claude Code expands the env var itself.
    expect(JSON.parse(runs[0].args[3])).toEqual({
      type: 'http',
      url: 'https://x.test/api/mcp',
      headers: {Authorization: 'Bearer ${ASSETHUB_API_KEY}', 'X-AssetHub-Workspace': 'ws-1'},
    })
    expect(runs.flatMap(r => r.args).join(' ')).not.toContain(KEY)
    expect(files.get(`${path}.bak-20260929T100000000Z`)).toBe('model = "gpt-5"\n')
    expect(files.get(path)).toContain('model = "gpt-5"')
    expect(files.get(path)).toContain('[mcp_servers.assethub]')
    expect(files.get(path)).toContain('"X-AssetHub-Workspace" = "ws-1"')
    expect(result.steps.map(s => [s.name, s.status])).toEqual([
      ['login', 'ok'],
      ['workspace', 'ok'],
      ['claude-mcp', 'ok'],
      ['codex-mcp', 'ok'],
      ['app-env', 'skip'],
      ['hook', 'ok'],
      ['doctor', 'ok'],
    ])
  })

  it('replaces an existing Claude entry only when add says it already exists', async () => {
    let adds = 0
    const {deps, runs} = makeDeps({
      run: async (file, args) => {
        runs.push({file, args})
        if (args[1] !== 'add-json') return {code: 0, output: ''}
        adds += 1
        return adds === 1
          ? {code: 1, output: 'MCP server assethub already exists in user config'}
          : {code: 0, output: ''}
      },
    })
    const result = await runSetup(options({client: 'claude'}), deps)
    expect(runs.map(r => r.args[1])).toEqual(['add-json', 'remove', 'add-json'])
    expect(result.steps.find(s => s.name === 'claude-mcp')?.status).toBe('ok')
  })

  it('never removes the existing Claude entry when add fails for another reason', async () => {
    const {deps, runs} = makeDeps({
      run: async (file, args) => {
        runs.push({file, args})
        return args[1] === 'add-json' ? {code: 1, output: 'unknown command add-json'} : {code: 0, output: ''}
      },
    })
    const result = await runSetup(options({client: 'claude'}), deps)
    expect(runs.map(r => r.args[1])).toEqual(['add-json'])
    expect(result.steps.find(s => s.name === 'claude-mcp')?.status).toBe('fail')
  })

  it('says the old entry is gone when the replacement add fails', async () => {
    const {deps} = makeDeps({
      run: async (_file, args) =>
        args[1] === 'add-json'
          ? {code: 1, output: 'MCP server assethub already exists'}
          : {code: 0, output: ''},
    })
    const step = (await runSetup(options({client: 'claude'}), deps)).steps.find(s => s.name === 'claude-mcp')!
    expect(step.status).toBe('fail')
    expect(step.detail).toContain('removed')
  })

  it('fails the Claude step when claude is missing and it was the only client asked for', async () => {
    const {deps} = makeDeps({findBinary: async () => undefined})
    const result = await runSetup(options({client: 'claude'}), deps)
    expect(result.steps.find(s => s.name === 'claude-mcp')?.status).toBe('fail')
    expect(result.ok).toBe(false)
  })

  it('fails the Codex step instead of writing a broken config.toml', async () => {
    const {deps, files} = makeDeps()
    const path = '/home/u/.codex/config.toml'
    const broken = '[mcp_servers]\nassethub.url = "https://old.test"\n'
    files.set(path, broken)
    const result = await runSetup(options({client: 'codex'}), deps)
    expect(result.steps.find(s => s.name === 'codex-mcp')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('assethub'),
    })
    expect(files.get(path)).toBe(broken)
  })

  it('prints the command instead of failing when claude is missing, without the key', async () => {
    const {deps, logs, runs} = makeDeps({findBinary: async name => (name === 'claude' ? undefined : '/bin/x')})
    const result = await runSetup(options({client: 'both'}), deps)
    expect(runs).toHaveLength(0)
    expect(result.steps.find(s => s.name === 'claude-mcp')?.status).toBe('skip')
    expect(result.ok).toBe(true)
    const text = logs.join('\n')
    expect(text).toContain(`claude mcp add-json assethub '{"type":"http","url":"https://x.test/api/mcp","headers":{"Authorization":"Bearer \${ASSETHUB_API_KEY}","X-AssetHub-Workspace":"ws-1"}}' --scope user`)
    expect(text).not.toContain(KEY)
  })

  it('reports a failing claude add with the key redacted', async () => {
    const {deps} = makeDeps({run: async (_f, args) => (args[1] === 'add-json' ? {code: 1, output: `bad ${KEY}`} : {code: 0, output: ''})})
    const result = await runSetup(options({client: 'claude'}), deps)
    const step = result.steps.find(s => s.name === 'claude-mcp')!
    expect(step.status).toBe('fail')
    expect(step.detail).not.toContain(KEY)
    expect(step.detail).toContain(redactKey(KEY))
    expect(result.ok).toBe(false)
  })

  it('does not touch the Codex file when it is already up to date', async () => {
    const {deps, files} = makeDeps()
    await runSetup(options({client: 'codex'}), deps)
    const before = [...files.keys()]
    await runSetup(options({client: 'codex'}), deps)
    expect([...files.keys()]).toEqual(before)
  })

  it('installs the Claude hook with --save-sessions, and skips it with --no-hook', async () => {
    const installHooks = vi.fn(async () => ({installed: true, detail: 'ok'}))
    const {deps, logs} = makeDeps({installHooks})
    await runSetup(options(), deps)
    expect(installHooks.mock.calls.map(c => (c as unknown[])[0])).toEqual([{client: 'claude'}])
    expect(logs.join('\n')).toContain(SESSION_SAVE_DISCLOSURE)
    installHooks.mockClear()
    const result = await runSetup(options({noHook: true}), deps)
    expect(installHooks).not.toHaveBeenCalled()
    expect(result.steps.find(s => s.name === 'hook')?.status).toBe('skip')
  })

  it('never records sessions without explicit consent', async () => {
    const installHooks = vi.fn(async () => ({installed: true, detail: 'ok'}))
    const confirmOptIn = vi.fn(async () => false)
    const off = options({saveSessions: false})

    // Non-interactive, and interactive with --yes: not asked, not installed.
    for (const over of [{}, {interactive: true}]) {
      const {deps} = makeDeps({installHooks, confirmOptIn, ...over})
      const result = await runSetup(off, deps)
      expect(result.steps.find(s => s.name === 'hook')).toMatchObject({
        status: 'skip',
        detail: expect.stringContaining('--save-sessions'),
      })
    }
    expect(confirmOptIn).not.toHaveBeenCalled()
    expect(installHooks).not.toHaveBeenCalled()

    // Interactive without --yes: disclosed, asked, default no.
    const asked = makeDeps({installHooks, confirmOptIn, interactive: true})
    await runSetup({...off, yes: false}, asked.deps)
    expect(asked.logs.join('\n')).toContain(SESSION_SAVE_DISCLOSURE)
    expect(confirmOptIn).toHaveBeenCalledTimes(1)
    expect(installHooks).not.toHaveBeenCalled()

    confirmOptIn.mockResolvedValueOnce(true)
    await runSetup({...off, yes: false}, makeDeps({installHooks, confirmOptIn, interactive: true}).deps)
    expect(installHooks).toHaveBeenCalledWith({client: 'claude'})
  })

  it('does not install hooks for Codex alone', async () => {
    const installHooks = vi.fn(async () => ({installed: true, detail: 'ok'}))
    const result = await runSetup(options({client: 'codex'}), makeDeps({installHooks}).deps)
    expect(installHooks).not.toHaveBeenCalled()
    expect(result.steps.find(s => s.name === 'hook')?.status).toBe('skip')
  })

  it('needs the CLI on PATH only for the session hooks, never for MCP', async () => {
    const {deps} = makeDeps({findBinary: async name => (name === 'claude' ? '/bin/claude' : undefined)})
    const result = await runSetup(options({client: 'claude'}), deps)
    expect(result.steps.find(s => s.name === 'claude-mcp')).toMatchObject({status: 'ok'})
    expect(result.steps.find(s => s.name === 'claude-mcp')?.detail).not.toContain('PATH')
    expect(result.steps.find(s => s.name === 'hook')?.detail).toContain('not on PATH')
  })

  it('tells a Claude-only user to export the key too', async () => {
    const {deps, logs} = makeDeps()
    const result = await runSetup(options({client: 'claude'}), deps)
    expect(logs.join('\n')).toContain('Claude Code reads the key from the ASSETHUB_API_KEY')
    expect(result.nextStep).toContain('Export ASSETHUB_API_KEY')
  })

  it('ships a no-op default hook installer', async () => {
    await expect(defaultInstallHooks({client: 'claude'})).resolves.toEqual({
      installed: false,
      detail: 'hooks not available in this build',
    })
  })

  it('logs in from the prompt when there is no working key', async () => {
    const login = vi.fn(async () => {})
    const {deps} = makeDeps({hasWorkingKey: async () => false, interactive: true, login})
    await runSetup(options({yes: true}), deps)
    expect(login).toHaveBeenCalledWith({apiKey: KEY})
  })

  it('logs in from stdin without prompting', async () => {
    const login = vi.fn(async () => {})
    const promptApiKey = vi.fn(async () => KEY)
    const {deps} = makeDeps({hasWorkingKey: async () => false, login, promptApiKey})
    await runSetup(options({apiKeyStdin: true}), deps)
    expect(login).toHaveBeenCalledWith({apiKey: undefined})
    expect(promptApiKey).not.toHaveBeenCalled()
  })

  it('saves an explicit --api-key even when a saved key works', async () => {
    const login = vi.fn(async () => {})
    const hasWorkingKey = vi.fn(async () => true)
    const {deps} = makeDeps({hasWorkingKey, login})
    await runSetup(options({apiKey: 'explicit-key', apiKeySource: 'flag'}), deps)
    expect(login).toHaveBeenCalledWith({apiKey: 'explicit-key'})
    expect(hasWorkingKey).not.toHaveBeenCalled()
  })

  it('saves ASSETHUB_API_KEY non-interactively when there is no saved key', async () => {
    const login = vi.fn(async () => {})
    const {deps} = makeDeps({hasWorkingKey: async () => false, login})
    await runSetup(options({apiKey: 'env-key', apiKeySource: 'env'}), deps)
    expect(login).toHaveBeenCalledWith({apiKey: 'env-key'})
  })

  it('prefers a working saved key over ASSETHUB_API_KEY', async () => {
    const login = vi.fn(async () => {})
    const {deps} = makeDeps({hasWorkingKey: async () => true, login})
    await runSetup(options({apiKey: 'env-key', apiKeySource: 'env'}), deps)
    expect(login).not.toHaveBeenCalled()
  })

  it('fails clearly without a key in non-interactive mode', async () => {
    const {deps} = makeDeps({hasWorkingKey: async () => false})
    await expect(runSetup(options(), deps)).rejects.toThrow(/--api-key-stdin/)
  })

  it('selects --workspace through the existing workspace logic', async () => {
    const useWorkspace = vi.fn(async () => {})
    const {deps} = makeDeps({useWorkspace})
    await runSetup(options({workspace: 'ws-9'}), deps)
    expect(useWorkspace).toHaveBeenCalledWith('ws-9')
  })

  it('lets an interactive user pick a workspace, and fails non-interactively', async () => {
    const noWorkspace = {resolveAuth: async () => ({apiKey: KEY, baseUrl: 'https://x.test', profile: 'default'})}
    const useWorkspace = vi.fn(async () => {})
    const picked = makeDeps({...noWorkspace, interactive: true, useWorkspace})
    await runSetup(options(), picked.deps)
    expect(useWorkspace).toHaveBeenCalledWith('ws-2')
    await expect(runSetup(options(), makeDeps(noWorkspace).deps)).rejects.toThrow(/--workspace <id>/)
  })

  it('changes nothing in --dry-run and never shows the key', async () => {
    const {deps, files, logs, runs} = makeDeps()
    const login = vi.fn()
    const useWorkspace = vi.fn()
    const installHooks = vi.fn()
    files.set('/home/u/.codex/config.toml', '[mcp_servers.assethub]\nurl = "https://old.test"\n')
    const result = await runSetup(
      options({dryRun: true, printEnv: true}),
      {...deps, login, useWorkspace, installHooks},
    )
    expect(runs).toHaveLength(0)
    expect(login).not.toHaveBeenCalled()
    expect(useWorkspace).not.toHaveBeenCalled()
    expect(installHooks).not.toHaveBeenCalled()
    expect([...files.keys()]).toEqual(['/home/u/.codex/config.toml'])
    const text = `${logs.join('\n')}\n${JSON.stringify(result)}`
    expect(text).not.toContain(KEY)
    expect(text).toContain('- url = "https://old.test"')
    expect(text).toContain('+ url = "https://x.test/api/mcp"')
    expect(text).toContain('claude mcp add-json assethub')
    expect(result.exportLine).toBe(`export ASSETHUB_API_KEY=${redactKey(KEY)}`)
  })

  it('prints the export line only when asked, and never logs the key otherwise', async () => {
    const quiet = makeDeps()
    const a = await runSetup(options(), quiet.deps)
    expect(a.exportLine).toBeUndefined()
    expect(JSON.stringify(a) + quiet.logs.join('\n')).not.toContain(KEY)
    expect(quiet.logs.join('\n')).toContain('ASSETHUB_API_KEY')
    const asked = await runSetup(options({printEnv: true}), makeDeps().deps)
    expect(asked.exportLine).toBe(`export ASSETHUB_API_KEY=${KEY}`)
  })

  it('marks the run failed when doctor fails', async () => {
    const {deps} = makeDeps({diagnose: async () => ({ok: false, checks: [{name: 'mcp', status: 'fail', message: 'down'}]})})
    const result = await runSetup(options(), deps)
    expect(result.ok).toBe(false)
    expect(result.steps.at(-1)).toMatchObject({name: 'doctor', status: 'fail', detail: 'mcp: down'})
  })
})

describe('runSetup app-env (macOS)', () => {
  const PLIST = '/Users/u/Library/LaunchAgents/io.assethub.env.plist'
  // A fake launchd: `getenv` answers what `setenv` last stored.
  const mac = (over: Partial<SetupDeps> = {}, initial?: string, setenvCode = 0) => {
    let value = initial
    const made = makeDeps({
      platform: 'darwin',
      run: async (file, args) => {
        made.runs.push({file, args})
        if (file === '/bin/launchctl' && args[0] === 'getenv') return {code: 0, output: value ? `${value}\n` : '\n'}
        if (file === '/bin/launchctl' && args[0] === 'setenv') {
          if (setenvCode === 0) value = args[2]
          return {code: setenvCode, output: setenvCode ? 'nope' : ''}
        }
        return {code: 0, output: ''}
      },
      ...over,
    })
    return made
  }
  const step = (result: {steps: {name: string}[]}) => result.steps.find(s => s.name === 'app-env')
  const launchctl = (runs: {file: string; args: string[]}[]) =>
    runs.filter(r => r.file === '/bin/launchctl').map(r => r.args[0])

  it('makes the key visible to apps, installs the login agent and says to restart Claude', async () => {
    const {deps, files, runs, logs} = mac()
    const result = await runSetup(options(), deps)
    expect(step(result)).toMatchObject({status: 'ok'})
    expect(launchctl(runs)).toEqual(['getenv', 'setenv', 'getenv'])
    expect(files.get(PLIST)).toContain('<string>env</string>')
    expect(files.get(PLIST)).not.toContain(KEY)
    expect(result.nextStep).toMatch(/Cmd\+Q/)
    expect(JSON.stringify(result) + logs.join('\n')).not.toContain(KEY)
  })

  it('does nothing when apps already see the same key', async () => {
    const {deps, files, runs} = mac({}, KEY)
    const result = await runSetup(options(), deps)
    expect(step(result)).toMatchObject({status: 'ok'})
    expect(launchctl(runs)).toEqual(['getenv'])
    expect(files.has(PLIST)).toBe(false)
  })

  it('refreshes an outdated login agent when apps already see the same key', async () => {
    const {deps, files, runs} = mac({}, KEY)
    files.set(PLIST, launchAgentPlist(['/removed/node', '/old/cli.js', 'env', 'load']))
    const result = await runSetup(options(), deps)
    expect(step(result)).toMatchObject({status: 'ok'})
    expect(step(result)?.detail).toMatch(/refreshed/)
    expect(launchctl(runs)).toEqual(['getenv'])
    expect(files.get(PLIST)).toBe(launchAgentPlist(deps.launchAgentProgram))
  })

  it('leaves an up-to-date login agent untouched', async () => {
    const {deps, files} = mac({}, KEY)
    const current = launchAgentPlist(deps.launchAgentProgram)
    files.set(PLIST, current)
    const write = vi.spyOn(deps, 'writeFileEnsuringDir')
    const result = await runSetup(options(), deps)
    expect(step(result)?.detail).not.toMatch(/refreshed/)
    expect(write.mock.calls.map(([path]) => path)).not.toContain(PLIST)
  })

  it('replaces a stale key that apps would send', async () => {
    const {deps, runs} = mac({}, 'old-key-zzzz')
    const result = await runSetup(options(), deps)
    expect(step(result)).toMatchObject({status: 'ok'})
    expect(launchctl(runs)).toEqual(['getenv', 'setenv', 'getenv'])
  })

  it('asks first when interactive, and leaves launchd alone on no', async () => {
    const confirm = vi.fn(async (question: string) => !/visible to/.test(question))
    const {deps, runs, files} = mac({interactive: true, confirm})
    const result = await runSetup(options({yes: false, saveSessions: false}), deps)
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/visible to/))
    expect(step(result)).toMatchObject({status: 'skip'})
    expect(step(result)?.detail).toMatch(/cannot see ASSETHUB_API_KEY/)
    expect(launchctl(runs)).toEqual(['getenv'])
    expect(files.has(PLIST)).toBe(false)
  })

  it('never changes launchd non-interactively without --yes', async () => {
    const {deps, runs} = mac()
    const result = await runSetup(options({yes: false}), deps)
    expect(step(result)).toMatchObject({status: 'skip'})
    expect(launchctl(runs)).toEqual(['getenv'])
  })

  it('fails honestly when setenv does not take', async () => {
    const {deps} = mac({}, undefined, 1)
    const result = await runSetup(options(), deps)
    expect(step(result)).toMatchObject({status: 'fail'})
    expect(result.ok).toBe(false)
  })

  it('is skipped with --no-app-env and in --dry-run', async () => {
    const skipped = mac()
    expect(step(await runSetup(options({noAppEnv: true}), skipped.deps))).toMatchObject({status: 'skip'})
    expect(launchctl(skipped.runs)).toEqual([])
    const dry = mac()
    const result = await runSetup(options({dryRun: true}), dry.deps)
    expect(step(result)).toMatchObject({status: 'skip'})
    expect(launchctl(dry.runs)).toEqual([])
    expect(dry.logs.join('\n')).toContain('[dry-run] would install')
  })

  it('points other platforms at the environment their apps start with', async () => {
    const {deps, runs} = makeDeps()
    const result = await runSetup(options(), deps)
    expect(step(result)).toMatchObject({status: 'skip'})
    expect(step(result)?.detail).toMatch(/ASSETHUB_API_KEY/)
    expect(launchctl(runs)).toEqual([])
  })
})

describe('assethub setup (spawned CLI)', () => {
  it('sets up Claude and Codex end to end from a stdin key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assethub-setup-cmd-'))
    const requests: string[] = []
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const rpc = raw ? JSON.parse(raw) : {}
      requests.push(`${req.method} ${req.url}`)
      if (req.method === 'GET' && req.url?.endsWith('/mcp')) {
        res.writeHead(405)
        res.end()
      } else if (req.url === '/api/v2/models') {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({success: true, data: {models: []}}))
      } else if (req.url?.endsWith('/mcp')) {
        if (rpc.id == null) {
          res.writeHead(202)
          res.end()
          return
        }
        const result =
          rpc.method === 'initialize'
            ? {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 't', version: '1'}}
            : {tools: [{name: 'model_list', description: 'x', inputSchema: {type: 'object'}}]}
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.end(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: rpc.id, result})}\n\n`)
      } else {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({success: true, data: {ownerId: 'ws-e2e', executionContext: {status: 'available', operations: []}, evaluators: []}}))
      }
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const origin = `http://127.0.0.1:${address.port}`
    const bin = join(dir, 'bin')
    await mkdir(bin)
    const argvLog = join(dir, 'claude-argv.log')
    await writeFile(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\n`)
    await chmod(join(bin, 'claude'), 0o755)
    const codexHome = join(dir, 'codex')
    await mkdir(codexHome)
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-5"\n')
    const executable = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
    const invoke = (args: string[], input = '') =>
      new Promise<{code: number | null; stdout: string; stderr: string}>((done, reject) => {
        const child = spawn(process.execPath, [executable, ...args], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: dir,
            CODEX_HOME: codexHome,
            ASSETHUB_CLI_CONFIG: join(dir, 'config.json'),
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => (stdout += chunk))
        child.stderr.on('data', chunk => (stderr += chunk))
        child.once('error', reject)
        child.once('close', code => done({code, stdout, stderr}))
        child.stdin.end(input)
      })
    try {
      const dry = await invoke(['setup', '--dry-run', '--no-app-env', '--base-url', origin, '--workspace', 'ws-e2e'])
      expect(dry.code, dry.stderr).toBe(0)
      expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n')
      expect(dry.stderr).toContain('[dry-run]')

      const first = await invoke(['setup', '--api-key-stdin', '--no-app-env', '--base-url', origin, '--json'], 'fake-e2e-key-cccc\n')
      expect(first.code, first.stderr).toBe(0)
      expect(first.stdout + first.stderr).not.toContain('fake-e2e-key-cccc')
      const report = JSON.parse(first.stdout)
      expect(report.ok).toBe(true)
      expect(report.workspaceId).toBe('ws-e2e')
      expect(report.steps.map((s: {name: string}) => s.name)).toEqual(['login', 'workspace', 'claude-mcp', 'codex-mcp', 'app-env', 'hook', 'doctor'])
      const argv = (await readFile(argvLog, 'utf8')).trim().split('\n')
      expect(argv).toHaveLength(1)
      expect(argv[0]).toBe(
        `mcp add-json assethub ${JSON.stringify({type: 'http', url: `${origin}/api/mcp`, headers: {Authorization: 'Bearer ${ASSETHUB_API_KEY}', 'X-AssetHub-Workspace': 'ws-e2e'}})} --scope user`,
      )
      expect(argv.join('\n')).not.toContain('fake-e2e-key-cccc')
      // Non-interactive and no --save-sessions: nothing records sessions.
      expect(report.steps.find((s: {name: string}) => s.name === 'hook').status).toBe('skip')
      await expect(readFile(join(dir, '.claude', 'settings.json'), 'utf8')).rejects.toThrow()

      const codex = await readFile(join(codexHome, 'config.toml'), 'utf8')
      expect(codex).toContain('model = "gpt-5"')
      expect(codex).toContain(`url = "${origin}/api/mcp"`)
      expect(codex).not.toContain('fake-e2e-key-cccc')
      expect((await readdir(codexHome)).some(name => name.startsWith('config.toml.bak-'))).toBe(true)

      // Re-running reuses the saved key (no stdin) and stays idempotent.
      const second = await invoke(['setup', '--print-env', '--no-app-env'])
      expect(second.code, second.stderr).toBe(0)
      expect(second.stdout).toContain('export ASSETHUB_API_KEY=fake-e2e-key-cccc')
      expect(second.stdout).toContain('✓ login')
      expect((await readFile(join(codexHome, 'config.toml'), 'utf8')).match(/\[mcp_servers\.assethub\]/g)).toHaveLength(1)
    } finally {
      server.close()
      await rm(dir, {recursive: true, force: true})
    }
  }, 60_000)
})

describe('setup review fixes', () => {
  const section = '[mcp_servers.assethub]\nurl = "https://app.assethub.io/api/mcp"\n'

  it('keeps another server whose quoted name only differs by a space', () => {
    const existing = '[mcp_servers."asset hub"]\nurl = "https://other.test"\n'
    const merged = mergeCodexSection(existing, section)
    expect(merged).toContain('[mcp_servers."asset hub"]\nurl = "https://other.test"')
    expect(merged).toContain('[mcp_servers.assethub]')
  })

  it('never overwrites an earlier Codex backup made in the same instant', async () => {
    const {deps, files} = makeDeps()
    const path = '/home/u/.codex/config.toml'
    files.set(path, 'model = "gpt-5"\n')
    files.set(`${path}.bak-20260929T100000000Z`, 'the first backup\n')
    await runSetup(options({client: 'codex', saveSessions: false}), deps)
    expect(files.get(`${path}.bak-20260929T100000000Z`)).toBe('the first backup\n')
    expect(files.get(`${path}.bak-20260929T100000000Z-1`)).toBe('model = "gpt-5"\n')
  })

  it('finds only an executable file on PATH, not a directory or a plain file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assethub-path-'))
    try {
      const [asDir, asPlain, asExec] = ['a', 'b', 'c'].map(name => join(root, name))
      await mkdir(join(asDir, 'claude'), {recursive: true})
      await mkdir(asPlain, {recursive: true})
      await writeFile(join(asPlain, 'claude'), 'not executable')
      await mkdir(asExec, {recursive: true})
      await writeFile(join(asExec, 'claude'), '#!/bin/sh\n')
      await chmod(join(asExec, 'claude'), 0o755)
      expect(await findOnPath('claude', [asDir, asPlain, asExec].join(':'))).toBe(join(asExec, 'claude'))
      expect(await findOnPath('claude', [asDir, asPlain].join(':'))).toBeUndefined()
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })
})
