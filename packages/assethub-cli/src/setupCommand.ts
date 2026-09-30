import {execFile} from 'node:child_process'
import {access, copyFile, mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {delimiter, dirname, join} from 'node:path'
import {API_KEY_ENV, launchAgentPath, launchAgentPlist, loadKeyIntoLaunchd, readLaunchdKey} from './appEnv.js'
import {SESSION_SAVE_DISCLOSURE} from './hooks/install.js'
import {mcpConfig} from './setup.js'
import type {InstallHooks} from './setupHooksBridge.js'

export type StepStatus = 'ok' | 'fail' | 'skip'
export type SetupStep = {name: string; status: StepStatus; detail: string}
export type SetupResult = {
  ok: boolean
  dryRun: boolean
  profile: string
  baseUrl: string
  workspaceId?: string
  steps: SetupStep[]
  nextStep: string
  exportLine?: string
}

export type SetupOptions = {
  client: 'claude' | 'codex' | 'both'
  workspace?: string
  apiKeyStdin: boolean
  /** An API key given as --api-key (always wins) or found in ASSETHUB_API_KEY (used when no saved key works). */
  apiKey?: string
  apiKeySource?: 'flag' | 'env'
  noHook: boolean
  /** `--no-app-env`: leave launchd alone even on macOS. */
  noAppEnv?: boolean
  /** Explicit consent to record and upload agent sessions (`--save-sessions`). */
  saveSessions: boolean
  dryRun: boolean
  yes: boolean
  printEnv: boolean
}

export type SetupAuth = {
  apiKey: string
  baseUrl: string
  profile: string
  workspaceId?: string
}

export type SetupWorkspace = {id: string; name?: string}

type DoctorReport = {ok: boolean; checks: {name: string; status: string; message?: string}[]}

// Everything that touches credentials, the network or the process environment is
// injected so the flow is testable without a child process.
export type SetupDeps = {
  interactive: boolean
  installHooks: InstallHooks
  codexHome: string
  now: () => Date
  hasWorkingKey: () => Promise<boolean>
  login: (input: {apiKey?: string}) => Promise<void>
  promptApiKey: () => Promise<string>
  resolveAuth: () => Promise<SetupAuth>
  discoverWorkspace: (auth: SetupAuth) => Promise<string | undefined>
  useWorkspace: (id: string) => Promise<void>
  listWorkspaces: () => Promise<SetupWorkspace[]>
  pickWorkspace: (items: SetupWorkspace[]) => Promise<string>
  confirm: (question: string) => Promise<boolean>
  /** Opt-in question that defaults to no. */
  confirmOptIn: (question: string) => Promise<boolean>
  diagnose: () => Promise<DoctorReport>
  findBinary: (name: string) => Promise<string | undefined>
  run: (file: string, args: string[]) => Promise<{code: number; output: string}>
  readFileIfExists: (path: string) => Promise<string | undefined>
  writeFileEnsuringDir: (path: string, content: string) => Promise<void>
  backupFile: (from: string, to: string) => Promise<void>
  log: (line: string) => void
  platform: NodeJS.Platform
  home: string
  /** argv the macOS LaunchAgent runs at login: node, this CLI, `env load --profile <name>`. */
  launchAgentProgram: string[]
}

export const redactKey = (key: string): string => `ah_…${key.slice(-4)}`

const scrub = (text: string, key: string): string =>
  key ? text.split(key).join(redactKey(key)) : text

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/
// `[mcp_servers."assethub"]` and `[mcp_servers.'assethub']` name the same table
// as `[mcp_servers.assethub]`, so quotes around a key segment are dropped.
const tableName = (line: string): string | undefined => {
  const match = TOML_HEADER.exec(line)
  return match
    ? match[1].replace(/\s+/g, '').replace(/"([^"]*)"|'([^']*)'/g, (_m, dq?: string, sq?: string) => dq ?? sq ?? '')
    : undefined
}
const isAssetHubTable = (name: string): boolean =>
  name === 'mcp_servers.assethub' || name.startsWith('mcp_servers.assethub.')

// `assethub.url = …` or `assethub = { … }` under [mcp_servers], or a top-level
// `mcp_servers.assethub.… = …`: the same server, written as keys rather than a
// table. Appending a table next to it would be a duplicate key.
const ASSETHUB_KEY_IN_SERVERS = /^\s*["']?assethub["']?\s*[.=]/
const ASSETHUB_KEY_AT_ROOT = /^\s*mcp_servers\s*\.\s*["']?assethub["']?\s*[.=]/

// Replaces only the assethub table (and its sub-tables); every other line,
// including comments, blank lines and unrelated servers, is preserved.
export const mergeCodexSection = (existing: string, section: string): string => {
  const kept: string[] = []
  let current = ''
  let inside = false
  let replacedAt = -1
  for (const line of existing.split('\n')) {
    const name = tableName(line)
    if (name !== undefined) {
      current = name
      inside = isAssetHubTable(name)
      if (inside && replacedAt < 0) replacedAt = kept.length
    } else if (
      (current === 'mcp_servers' && ASSETHUB_KEY_IN_SERVERS.test(line)) ||
      (current === '' && ASSETHUB_KEY_AT_ROOT.test(line))
    ) {
      throw new Error(
        'the assethub MCP server is already defined with dotted or inline keys; ' +
          'replace it with an [mcp_servers.assethub] table (or remove it) and run setup again',
      )
    }
    if (!inside) kept.push(line)
  }
  const block = section.replace(/\n+$/, '').split('\n')
  if (replacedAt >= 0) {
    // Tidy blank lines only where the table is spliced in.
    const before = kept.slice(0, replacedAt)
    const after = kept.slice(replacedAt)
    while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
    while (after.length > 0 && after[0].trim() === '') after.shift()
    const lines = [...before, ...(before.length > 0 ? [''] : []), ...block, ...(after.length > 0 ? ['', ...after] : [])]
    return lines.join('\n').replace(/\n*$/, '\n')
  }
  const base = existing.replace(/\n+$/, '')
  return `${base}${base ? '\n\n' : ''}${block.join('\n')}\n`
}

export const extractCodexSection = (content: string): string => {
  const out: string[] = []
  let inside = false
  for (const line of content.split('\n')) {
    const name = tableName(line)
    if (name !== undefined) inside = isAssetHubTable(name)
    if (inside) out.push(line)
  }
  return out.join('\n').replace(/\n+$/, '')
}

const sectionDiff = (before: string, after: string): string[] => [
  ...(before ? before.split('\n') : []).map(line => `- ${line}`),
  ...after.split('\n').map(line => `+ ${line}`),
]

const timestamp = (date: Date): string => date.toISOString().replace(/[-:.]/g, '')

// MCP first: the Claude Code entry works without the CLI installed. The key is
// referenced as ${ASSETHUB_API_KEY}, which Claude Code expands from its
// environment on every connection (verified with Claude Code 2.1.81), so it is
// never written to ~/.claude.json or passed on a command line. Same contract as
// the Codex section's bearer_token_env_var.
export {API_KEY_ENV}

export const claudeServerConfig = (baseUrl: string, workspaceId?: string) => ({
  type: 'http',
  url: `${baseUrl.replace(/\/+$/, '')}/api/mcp`,
  headers: {
    Authorization: `Bearer \${${API_KEY_ENV}}`,
    ...(workspaceId ? {'X-AssetHub-Workspace': workspaceId} : {}),
  },
})

export const claudeAddArgs = (baseUrl: string, workspaceId?: string): string[] => [
  'mcp', 'add-json', 'assethub', JSON.stringify(claudeServerConfig(baseUrl, workspaceId)), '--scope', 'user',
]

const shellQuoteSingle = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export const runSetup = async (options: SetupOptions, deps: SetupDeps): Promise<SetupResult> => {
  const steps: SetupStep[] = []
  const say = (line: string) => deps.log(line)
  const wantClaude = options.client !== 'codex'
  const wantCodex = options.client !== 'claude'

  // 1. Login (reuses the existing `auth login` path through deps.login)
  const explicitKey = options.apiKeySource === 'flag' ? options.apiKey : undefined
  const hadKey = explicitKey ? false : await deps.hasWorkingKey()
  const givenKey = explicitKey ?? (options.apiKeySource === 'env' ? options.apiKey : undefined)
  const givenFrom = explicitKey ? '--api-key' : 'ASSETHUB_API_KEY'
  if (hadKey) {
    steps.push({name: 'login', status: 'ok', detail: 'reusing the saved API key'})
  } else if (options.dryRun) {
    steps.push({
      name: 'login',
      status: 'skip',
      detail: givenKey
        ? `would verify and save the API key from ${givenFrom}`
        : options.apiKeyStdin
          ? 'would read the API key from stdin'
          : 'would prompt for an API key',
    })
  } else {
    let apiKey = givenKey
    if (!apiKey && !options.apiKeyStdin) {
      if (!deps.interactive)
        throw new Error(
          'No saved API key. Re-run with --api-key-stdin, set ASSETHUB_API_KEY, or run interactively to be prompted.',
        )
      apiKey = await deps.promptApiKey()
    }
    await deps.login({apiKey})
    steps.push({
      name: 'login',
      status: 'ok',
      detail: givenKey ? `API key from ${givenFrom} verified and saved` : 'API key verified and saved',
    })
  }

  let auth: SetupAuth | undefined
  if (!options.dryRun || hadKey) auth = await deps.resolveAuth()
  const key = auth?.apiKey ?? ''
  const baseUrl = (auth?.baseUrl ?? '').replace(/\/+$/, '')

  // 2. Workspace
  let workspaceId = auth?.workspaceId
  if (options.workspace) {
    workspaceId = options.workspace
    if (options.dryRun) {
      steps.push({name: 'workspace', status: 'skip', detail: `would select workspace ${workspaceId}`})
    } else {
      await deps.useWorkspace(options.workspace)
      auth = await deps.resolveAuth()
      steps.push({name: 'workspace', status: 'ok', detail: `selected ${workspaceId}`})
    }
  } else if (workspaceId) {
    steps.push({name: 'workspace', status: 'ok', detail: `using ${workspaceId}`})
  } else if (auth && (workspaceId = await deps.discoverWorkspace(auth))) {
    steps.push({name: 'workspace', status: 'ok', detail: `using ${workspaceId} (from the API key)`})
  } else if (options.dryRun) {
    steps.push({name: 'workspace', status: 'skip', detail: 'would list workspaces and ask you to pick one'})
  } else {
    if (!deps.interactive)
      throw new Error('No workspace selected. Re-run with --workspace <id> (see: assethub workspace list).')
    const items = await deps.listWorkspaces()
    if (items.length === 0) throw new Error('No workspaces are available to this account.')
    workspaceId = items.length === 1 ? items[0].id : await deps.pickWorkspace(items)
    await deps.useWorkspace(workspaceId)
    auth = await deps.resolveAuth()
    steps.push({name: 'workspace', status: 'ok', detail: `selected ${workspaceId}`})
  }

  const workspaceForConfig = workspaceId ?? '<workspace-id>'
  const shownKey = key ? redactKey(key) : 'ah_…<key>'

  if (
    !options.dryRun &&
    deps.interactive &&
    !options.yes &&
    !(await deps.confirm('Write MCP configuration for the selected client(s)?'))
  )
    throw new Error('Cancelled before changing any client configuration.')

  // 3. Claude Code
  if (wantClaude) {
    const claude = await deps.findBinary('claude')
    const args = claudeAddArgs(baseUrl || '<base-url>', workspaceForConfig)
    const shown = `claude ${args.slice(0, 3).join(' ')} ${shellQuoteSingle(args[3])} ${args.slice(4).join(' ')}`
    if (!claude) {
      say(`claude not found on PATH. Run this later:\n  ${shown}`)
      // Claude was the only client asked for, so nothing got configured: say so
      // in the exit code rather than reporting success.
      steps.push({
        name: 'claude-mcp',
        status: wantCodex ? 'skip' : 'fail',
        detail: 'claude CLI not found; run the printed command later',
      })
    } else if (options.dryRun) {
      say(`[dry-run] ${shown}`)
      say('[dry-run] if an assethub entry already exists: claude mcp remove assethub --scope user, then add again')
      steps.push({name: 'claude-mcp', status: 'skip', detail: 'would register the assethub MCP server (dry run)'})
    } else {
      // Add first, and replace only an entry that already exists, so a failing
      // add never costs the user a working one.
      const addArgs = claudeAddArgs(baseUrl, workspaceForConfig)
      let added = await deps.run(claude, addArgs)
      let replaced = false
      if (added.code !== 0 && /already exists/i.test(added.output)) {
        await deps.run(claude, ['mcp', 'remove', 'assethub', '--scope', 'user'])
        replaced = true
        added = await deps.run(claude, addArgs)
      }
      const failure = scrub(added.output, key).trim().slice(0, 300)
      steps.push(
        added.code === 0
          ? {
              name: 'claude-mcp',
              status: 'ok',
              detail: `registered assethub in Claude Code (user scope; it reads the key from \$${API_KEY_ENV}, the key is not stored in Claude Code)`,
            }
          : {
              name: 'claude-mcp',
              status: 'fail',
              detail: replaced
                ? `claude mcp add failed after the old assethub entry was removed; run \`${shown}\` to restore it: ${failure}`
                : `claude mcp add failed: ${failure}`,
            },
      )
    }
  }

  // 4. Codex
  let exportLine: string | undefined
  if (wantCodex) {
    const path = join(deps.codexHome, 'config.toml')
    const section = mcpConfig('codex', baseUrl || 'https://app.assethub.io', false, workspaceId)
    const existing = await deps.readFileIfExists(path)
    let merged: string | undefined
    let mergeError: string | undefined
    try {
      merged = mergeCodexSection(existing ?? '', section)
    } catch (error) {
      mergeError = error instanceof Error ? error.message : String(error)
    }
    if (merged === undefined) {
      steps.push({name: 'codex-mcp', status: 'fail', detail: `${path} left unchanged: ${mergeError}`})
    } else if (options.dryRun) {
      say(`[dry-run] would ${existing === undefined ? 'create' : 'update'} ${path}`)
      if (existing !== undefined) say(`[dry-run] would back up to ${path}.bak-<timestamp>`)
      for (const line of sectionDiff(extractCodexSection(existing ?? ''), extractCodexSection(merged))) say(`  ${line}`)
      steps.push({name: 'codex-mcp', status: 'skip', detail: `would write [mcp_servers.assethub] to ${path} (dry run)`})
    } else if (merged === existing) {
      steps.push({name: 'codex-mcp', status: 'ok', detail: `${path} already up to date`})
    } else {
      let backup = ''
      if (existing !== undefined) {
        backup = `${path}.bak-${timestamp(deps.now())}`
        await deps.backupFile(path, backup)
      }
      await deps.writeFileEnsuringDir(path, merged)
      steps.push({name: 'codex-mcp', status: 'ok', detail: `wrote [mcp_servers.assethub] to ${path}${backup ? ` (backup: ${backup})` : ''}`})
    }
  }

  // Both clients read the key from the environment; the MCP server needs nothing else.
  say(`${wantClaude && wantCodex ? 'Claude Code and Codex read' : wantClaude ? 'Claude Code reads' : 'Codex reads'} the key from the ${API_KEY_ENV} environment variable: export it in your shell (run \`assethub setup --print-env\` to print the line). Setup never writes it to a shell profile.`)
  if (options.printEnv) exportLine = `export ${API_KEY_ENV}=${options.dryRun || !key ? shownKey : key}`

  // 5. Make the key visible to apps started outside a shell (macOS).
  const appEnv = await ensureAppEnv(options, deps, key)
  steps.push(appEnv)

  // 6. Session saving: recording every Claude Code session is opt-in.
  if (options.noHook) {
    steps.push({name: 'hook', status: 'skip', detail: 'skipped (--no-hook)'})
  } else if (!wantClaude) {
    steps.push({name: 'hook', status: 'skip', detail: 'Codex session saving is not supported yet'})
  } else if (options.dryRun) {
    steps.push({
      name: 'hook',
      status: 'skip',
      detail: options.saveSessions
        ? 'would install the session-saving hooks (dry run)'
        : 'would leave session saving off (enable with --save-sessions)',
    })
  } else {
    let consent = options.saveSessions
    if (!consent && deps.interactive && !options.yes) {
      say(SESSION_SAVE_DISCLOSURE)
      consent = await deps.confirmOptIn('Save and upload your Claude Code sessions?')
    }
    if (!consent) {
      steps.push({
        name: 'hook',
        status: 'skip',
        detail: 'session saving is off; enable it with `assethub setup --save-sessions` or `assethub hooks install --client claude`',
      })
    } else {
      if (options.saveSessions) say(SESSION_SAVE_DISCLOSURE)
      const pathNote = (await deps.findBinary('assethub'))
        ? ''
        : ' Note: the hooks run `assethub`, which is not on PATH; install the CLI globally.'
      try {
        const result = await deps.installHooks({client: 'claude'})
        steps.push({
          name: 'hook',
          status: result.installed ? 'ok' : 'fail',
          detail: `claude: ${result.detail}${result.installed ? pathNote : ''}`,
        })
      } catch (error) {
        steps.push({
          name: 'hook',
          status: 'fail',
          detail: `claude: ${scrub(error instanceof Error ? error.message : String(error), key)}`,
        })
      }
    }
  }

  // 7. Doctor
  if (options.dryRun) {
    steps.push({name: 'doctor', status: 'skip', detail: 'skipped (dry run)'})
  } else {
    try {
      const report = await deps.diagnose()
      const failing = report.checks.filter(check => check.status !== 'pass')
      steps.push({
        name: 'doctor',
        status: report.ok ? 'ok' : 'fail',
        detail: report.ok
          ? 'API and MCP checks passed'
          : failing.map(check => `${check.name}: ${check.message ?? 'failed'}`).join('; '),
      })
    } catch (error) {
      steps.push({name: 'doctor', status: 'fail', detail: scrub(error instanceof Error ? error.message : String(error), key)})
    }
  }

  const ok = steps.every(step => step.status !== 'fail')
  const nextStep = options.dryRun
    ? 'Re-run without --dry-run to apply these changes.'
    : !ok
      ? 'Fix the failed steps above, then re-run `assethub setup` (it is safe to repeat).'
      : appEnv.status === 'ok'
        ? `Quit and reopen ${wantClaude && wantCodex ? 'Claude (Cmd+Q) and Codex' : wantClaude ? 'Claude (Cmd+Q)' : 'Codex'} so it reads ${API_KEY_ENV}, then ask it to use the AssetHub tools. Terminal tabs opened before setup still need \`export ${API_KEY_ENV}=…\`.`
        : `Export ${API_KEY_ENV} in the shell that starts ${wantClaude && wantCodex ? 'Claude Code / Codex' : wantClaude ? 'Claude Code' : 'Codex'}, restart it, then ask it to use the AssetHub tools.`
  return {
    ok,
    dryRun: options.dryRun,
    profile: auth?.profile ?? '',
    baseUrl,
    workspaceId,
    steps,
    nextStep,
    ...(exportLine ? {exportLine} : {}),
  }
}

const APP_ENV_MISSING = `Claude and Codex apps cannot see ${API_KEY_ENV} yet, so their MCP calls get HTTP 401`

const ensureAppEnv = async (options: SetupOptions, deps: SetupDeps, key: string): Promise<SetupStep> => {
  const name = 'app-env'
  if (options.noAppEnv) return {name, status: 'skip', detail: 'skipped (--no-app-env)'}
  if (deps.platform !== 'darwin')
    return {
      name,
      status: 'skip',
      detail: `set ${API_KEY_ENV} in the environment your apps start with (\`assethub setup --print-env\` prints the line)`,
    }
  const plistPath = launchAgentPath(deps.home)
  if (options.dryRun) {
    deps.log(`[dry-run] would run: launchctl setenv ${API_KEY_ENV} ${key ? redactKey(key) : 'ah_…<key>'}`)
    deps.log(`[dry-run] would install ${plistPath} (runs \`assethub env load\` at login; holds no key)`)
    return {name, status: 'skip', detail: 'would make the key visible to apps (dry run)'}
  }
  if (!key) return {name, status: 'skip', detail: 'no API key to publish'}
  const plist = launchAgentPlist(deps.launchAgentProgram)
  if ((await readLaunchdKey(deps.run)) === key) {
    // A login agent from an older CLI may pin a node that is later removed;
    // rewrite ours in place. With no agent, the key came from elsewhere: leave it.
    const installed = await deps.readFileIfExists(plistPath)
    if (installed === undefined || installed === plist)
      return {name, status: 'ok', detail: `${API_KEY_ENV} is already visible to apps`}
    await deps.writeFileEnsuringDir(plistPath, plist)
    return {name, status: 'ok', detail: `${API_KEY_ENV} is already visible to apps; refreshed ${plistPath}`}
  }
  const consent =
    options.yes ||
    (deps.interactive &&
      (await deps.confirm(`Make ${API_KEY_ENV} visible to Claude and Codex apps (launchctl setenv, re-applied at login)?`)))
  if (!consent)
    return {name, status: 'skip', detail: `${APP_ENV_MISSING}; re-run \`assethub setup --yes\` or export it before starting them`}
  await deps.writeFileEnsuringDir(plistPath, plist)
  const loaded = await loadKeyIntoLaunchd(key, deps.run)
  if (!loaded.ok) return {name, status: 'fail', detail: `${APP_ENV_MISSING}: ${loaded.detail}`}
  if ((await readLaunchdKey(deps.run)) !== key)
    return {name, status: 'fail', detail: `${APP_ENV_MISSING}: launchctl did not keep the value`}
  return {name, status: 'ok', detail: `${API_KEY_ENV} is visible to apps started from now on; ${plistPath} re-applies it at login`}
}

export const formatSetupSummary = (result: SetupResult): string => {
  const mark = {ok: '✓', fail: '✗', skip: '-'} as const
  const lines = result.steps.map(step => `${mark[step.status]} ${step.name}: ${step.detail}`)
  return `${lines.join('\n')}\n\nNext: ${result.nextStep}\n`
}

// ---- default (real) implementations of the environment-facing dependencies ----

export const findOnPath = async (name: string, pathValue = process.env.PATH ?? ''): Promise<string | undefined> => {
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    try {
      await access(candidate)
      return candidate
    } catch {
      /* try the next directory */
    }
  }
  return undefined
}

export const runProcess = (file: string, args: string[]): Promise<{code: number; output: string}> =>
  new Promise(done => {
    execFile(file, args, {timeout: 60_000}, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      done({code, output: `${stdout}${stderr}`})
    })
  })

export const defaultFileDeps = () => ({
  platform: process.platform,
  home: homedir(),
  codexHome: process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  now: () => new Date(),
  findBinary: (name: string) => findOnPath(name),
  run: runProcess,
  readFileIfExists: async (path: string) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  writeFileEnsuringDir: async (path: string, content: string) => {
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, content)
  },
  backupFile: (from: string, to: string) => copyFile(from, to),
})

// ---- interactive prompts (TTY only; prompts go to stderr so stdout stays clean) ----

export const promptLine = async (question: string): Promise<string> => {
  const {createInterface} = await import('node:readline/promises')
  const rl = createInterface({input: process.stdin, output: process.stderr})
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Reads a secret without echoing it.
export const promptHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY) return reject(new Error('A terminal is required to enter the API key interactively.'))
    process.stderr.write(question)
    let value = ''
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const finish = (done: () => void) => {
      input.setRawMode(false)
      input.pause()
      input.removeListener('data', onData)
      process.stderr.write('\n')
      done()
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value.trim()))
        if (char === '\u0003') return finish(() => reject(new Error('Cancelled.')))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    input.on('data', onData)
  })

export const pickFromList = async (items: SetupWorkspace[]): Promise<string> => {
  process.stderr.write('Workspaces:\n')
  items.forEach((item, index) => process.stderr.write(`  ${index + 1}) ${item.name ?? item.id} (${item.id})\n`))
  const answer = Number(await promptLine(`Pick a workspace [1-${items.length}]: `))
  const chosen = items[answer - 1]
  if (!Number.isInteger(answer) || !chosen) throw new Error('No valid workspace chosen.')
  return chosen.id
}

export const confirmYes = async (question: string): Promise<boolean> =>
  !/^n/i.test(await promptLine(`${question} [Y/n] `))

export const confirmNo = async (question: string): Promise<boolean> =>
  /^y/i.test(await promptLine(`${question} [y/N] `))
