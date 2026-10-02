import {execFile} from 'node:child_process'
import {constants} from 'node:fs'
import {access, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {delimiter, dirname, join} from 'node:path'
import {API_KEY_ENV, launchAgentPath, launchAgentPlist, loadKeyIntoLaunchd, readLaunchdKey} from './appEnv.js'
import {hookScopeError, sessionSaveDisclosure} from './hooks/install.js'
import {
  agentSpec,
  cliHome,
  detectAgents,
  installAgentSkills,
  mcpServerEntry,
  mergeJsonServer,
  readJsonServer,
  type AgentId,
  type SkillsReport,
} from './agentSetup.js'
import {cliVersion, mcpConfig, validatedBaseUrl} from './setup.js'
import type {HookClient} from './hooks/types.js'
import type {InstallHooks} from './setupHooksBridge.js'

export type StepStatus = 'ok' | 'fail' | 'skip'
/** What a step did to local state: nothing, a write, or (dry run) a write it would make. */
export type StepChange = 'unchanged' | 'updated' | 'would-update'
export type SetupStep = {
  name: string
  status: StepStatus
  detail: string
  change?: StepChange
  /** The config file or folder the step reads and writes. */
  path?: string
}

// The steps `--only` and `--skip` name, in the order setup runs them. `agents`
// is not one: the mcp and skills steps need it.
export const SETUP_STEPS = ['login', 'workspace', 'mcp', 'skills', 'auto-update', 'app-env', 'hook', 'doctor'] as const
export type SetupStepName = (typeof SETUP_STEPS)[number]

export type SetupResult = {
  ok: boolean
  dryRun: boolean
  profile: string
  baseUrl: string
  workspaceId?: string
  /** CLI version, which is also the version of the installed skill. */
  version: string
  scope: 'global' | 'project'
  agents: AgentId[]
  /** Agents found on this machine, whether or not they were selected. */
  detected: AgentId[]
  /** The skill copy and each agent's link to it, when the skills step ran. */
  skill?: SkillsReport
  steps: SetupStep[]
  nextStep: string
  exportLine?: string
}

export type SetupOptions = {
  /** Agents to configure; undefined means every agent detected on this machine. */
  agents?: AgentId[]
  /** Write MCP config and the skill into the current folder instead of the home folder. */
  project?: boolean
  /** Steps to leave out (`--skip`, `--only`, `--no-skills`). */
  skip?: SetupStepName[]
  workspace?: string
  apiKeyStdin: boolean
  /** An API key given as --api-key (always wins) or found in ASSETHUB_API_KEY (used when no saved key works). */
  apiKey?: string
  apiKeySource?: 'flag' | 'env'
  noHook: boolean
  /** `--no-app-env`: leave launchd alone even on macOS. */
  noAppEnv?: boolean
  /** `--auto-update` / `--no-auto-update`: save that choice; undefined keeps the saved one (default on). */
  autoUpdate?: boolean
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
  /** Session saving is installed for this folder only. */
  cwd: string
  codexHome: string
  now: () => Date
  hasWorkingKey: () => Promise<boolean>
  login: (input: {apiKey?: string}) => Promise<void>
  promptApiKey: () => Promise<string>
  resolveAuth: () => Promise<SetupAuth>
  /** Base URL and workspace from flags and the saved profile, without a key or the network (login skipped). */
  resolveTarget: () => Promise<{baseUrl: string; workspaceId?: string}>
  /** Agents installed on this machine. */
  detectAgents: () => Promise<AgentId[]>
  version: () => Promise<string>
  /** Installs the skill under root and links it into each agent; reports without writing on a dry run. */
  installSkills: (input: {root: string; agents: AgentId[]; dryRun: boolean}) => Promise<SkillsReport>
  discoverWorkspace: (auth: SetupAuth) => Promise<string | undefined>
  useWorkspace: (id: string) => Promise<void>
  listWorkspaces: () => Promise<SetupWorkspace[]>
  pickWorkspace: (items: SetupWorkspace[]) => Promise<string>
  confirm: (question: string) => Promise<boolean>
  /** Opt-in question that defaults to no. */
  confirmOptIn: (question: string) => Promise<boolean>
  /** Whether this login may save and upload coding-agent sessions (internal accounts for now). */
  canSaveSessions: (auth: SetupAuth) => Promise<boolean>
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
  /** The saved auto-update choice (undefined: never set, which means on). */
  readAutoUpdate: () => Promise<boolean | undefined>
  writeAutoUpdate: (on: boolean) => Promise<void>
  /** Whether this CLI is an installed package `assethub update` can upgrade (not npx or a source checkout). */
  canSelfUpdate: () => Promise<boolean>
  /** ASSETHUB_NO_AUTO_UPDATE, ASSETHUB_NO_UPDATE_CHECK or CI turn it off for this environment. */
  autoUpdateBlockedByEnv: boolean
}

export const redactKey = (key: string): string => `ah_…${key.slice(-4)}`

const scrub = (text: string, key: string): string =>
  key ? text.split(key).join(redactKey(key)) : text

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/
// `[mcp_servers."assethub"]` and `[mcp_servers.'assethub']` name the same table
// as `[mcp_servers.assethub]`, so quotes around a key segment are dropped.
// Whitespace is dropped only outside quotes: `"asset hub"` is another server.
const tableName = (line: string): string | undefined => {
  const match = TOML_HEADER.exec(line)
  if (!match) return undefined
  let name = ''
  let quote: string | undefined
  for (const char of match[1]) {
    if (quote) {
      if (char === quote) quote = undefined
      else name += char
    } else if (char === '"' || char === "'") quote = char
    else if (!/\s/.test(char)) name += char
  }
  return name
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

export const claudeAddArgs = (
  baseUrl: string,
  workspaceId?: string,
  scope: 'user' | 'project' = 'user',
): string[] => [
  'mcp', 'add-json', 'assethub', JSON.stringify(claudeServerConfig(baseUrl, workspaceId)), '--scope', scope,
]

const shellQuoteSingle = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** "A", "A and B", "A, B and C". */
const listJoin = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

// How each agent's desktop app is named in restart instructions.
const APP_NAMES: Record<AgentId, string> = {'claude-code': 'Claude (Cmd+Q)', codex: 'Codex', cursor: 'Cursor'}

export const runSetup = async (options: SetupOptions, deps: SetupDeps): Promise<SetupResult> => {
  const steps: SetupStep[] = []
  const say = (line: string) => deps.log(line)
  const skipped = (step: SetupStepName) => options.skip?.includes(step) ?? false
  const scope = options.project ? 'project' : 'global'
  const root = options.project ? deps.cwd : deps.home
  const needsAgents = !skipped('mcp') || !skipped('skills') || !skipped('hook')

  // 0. Agents: the ones asked for, or every one found on this machine. Nothing
  // else is changed when there is none to configure.
  const version = await deps.version()
  const detected = needsAgents ? await deps.detectAgents() : []
  const agents = options.agents ?? detected
  const agentNames = agents.map(agent => agentSpec(agent).name)
  const failEarly = (step: SetupStep, nextStep: string): SetupResult => ({
    ok: false,
    dryRun: options.dryRun,
    profile: '',
    baseUrl: '',
    version,
    scope,
    agents,
    detected,
    steps: [step],
    nextStep,
  })
  // MCP needs an agent to configure; the skill copy alone does not.
  if (!skipped('mcp') && agents.length === 0)
    return failEarly(
      {name: 'agents', status: 'fail', detail: `no Claude Code, Codex or Cursor found under ${deps.home} or on PATH`},
      'Install a coding agent, or pass --agent claude-code|codex|cursor to configure one anyway.',
    )
  if (needsAgents && agents.length === 0)
    steps.push({name: 'agents', status: 'skip', detail: 'no coding agent found; the skill is installed without agent links'})
  else if (needsAgents)
    steps.push({name: 'agents', status: 'ok', detail: `${listJoin(agentNames)}${options.agents ? '' : ' (detected)'}`})

  const wantClaude = agents.includes('claude-code')
  const wantCodex = agents.includes('codex')
  const hookClients: HookClient[] = [...(wantClaude ? (['claude'] as const) : []), ...(wantCodex ? (['codex'] as const) : [])]
  const hookNames = hookClients.map(client => (client === 'claude' ? 'Claude Code' : 'Codex')).join(' and ')
  let hookRefusal: string | undefined
  for (const client of hookClients) {
    const refused = await hookScopeError(deps.home, {projectDir: deps.cwd}, client, deps.codexHome)
    if (refused) {
      hookRefusal = `${client}: ${refused}`
      break
    }
  }

  // --save-sessions asks for something the home folder cannot have, so stop
  // before login, MCP or app-env changes rather than half-applying setup.
  if (hookRefusal && options.saveSessions && !options.noHook && !skipped('hook'))
    return failEarly(
      {name: 'hook', status: 'fail', detail: hookRefusal},
      'Run `assethub setup --save-sessions` inside the project folder whose sessions should be saved, or run it without --save-sessions.',
    )

  // 1. Login (reuses the existing `auth login` path through deps.login). With
  // login skipped, a saved key is still used for app-env and doctor if there is one.
  let auth: SetupAuth | undefined
  let hadKey = false
  if (skipped('login')) {
    auth = await deps.resolveAuth().catch(() => undefined)
  } else {
    const explicitKey = options.apiKeySource === 'flag' ? options.apiKey : undefined
    hadKey = explicitKey ? false : await deps.hasWorkingKey()
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
    if (!options.dryRun || hadKey) auth = await deps.resolveAuth()
  }
  // Without a login, the saved profile still names the server and workspace.
  const target = auth ?? (skipped('login') ? await deps.resolveTarget() : undefined)
  const key = auth?.apiKey ?? ''
  const baseUrl = (target?.baseUrl ?? '').replace(/\/+$/, '')
  // Every agent entry is built from this URL: refuse a bad one before writing any of them.
  if (baseUrl) {
    try {
      validatedBaseUrl(baseUrl)
    } catch (error) {
      return failEarly(
        {name: 'mcp', status: 'fail', detail: `${baseUrl}: ${error instanceof Error ? error.message : String(error)}`},
        'Pass --base-url with an HTTPS origin (HTTP only for localhost), then re-run setup.',
      )
    }
  }

  // 2. Workspace
  let workspaceId = target?.workspaceId
  if (skipped('workspace')) {
    workspaceId = options.workspace ?? workspaceId
  } else if (options.workspace) {
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
    const items = await deps.listWorkspaces()
    if (items.length === 0) throw new Error('No workspaces are available to this account.')
    if (items.length > 1 && !deps.interactive)
      throw new Error('No workspace selected. Re-run with --workspace <id> (see: assethub workspace list).')
    workspaceId = items.length === 1 ? items[0].id : await deps.pickWorkspace(items)
    await deps.useWorkspace(workspaceId)
    auth = await deps.resolveAuth()
    steps.push({name: 'workspace', status: 'ok', detail: `selected ${workspaceId}`})
  }

  // A placeholder is shown only in a dry run that would still ask for the workspace.
  const workspaceForConfig = workspaceId ?? (options.dryRun && !skipped('workspace') ? '<workspace-id>' : undefined)
  const shownKey = key ? redactKey(key) : 'ah_…<key>'

  const writesConfig = !skipped('mcp') || !skipped('skills')
  if (
    writesConfig &&
    !options.dryRun &&
    deps.interactive &&
    !options.yes &&
    !(await deps.confirm(`Write AssetHub configuration for ${listJoin(agentNames)}${options.project ? ` in ${deps.cwd}` : ''}?`))
  )
    throw new Error('Cancelled before changing any agent configuration.')

  // Writes a merged config file, backing up the previous one; reports "unchanged" when nothing differs.
  const writeConfig = async (
    name: string,
    path: string,
    existing: string | undefined,
    merged: string,
    what: string,
    diff: string[],
  ): Promise<void> => {
    if (merged === existing) {
      steps.push({name, status: 'ok', detail: `${path} already up to date`, change: 'unchanged', path})
    } else if (options.dryRun) {
      say(`[dry-run] would ${existing === undefined ? 'create' : 'update'} ${path}`)
      if (existing !== undefined) say(`[dry-run] would back up to ${path}.bak-<timestamp>`)
      for (const line of diff) say(`  ${line}`)
      steps.push({name, status: 'skip', detail: `would write ${what} to ${path} (dry run)`, change: 'would-update', path})
    } else {
      let backup = ''
      if (existing !== undefined) {
        // Never overwrite an earlier backup made in the same instant, even by
        // another setup running at the same time: the copy refuses an existing name.
        const base = `${path}.bak-${timestamp(deps.now())}`
        for (let n = 0; ; n++) {
          backup = n === 0 ? base : `${base}-${n}`
          if ((await deps.readFileIfExists(backup)) !== undefined) continue
          try {
            await deps.backupFile(path, backup)
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
        }
      }
      await deps.writeFileEnsuringDir(path, merged)
      steps.push({name, status: 'ok', detail: `wrote ${what} to ${path}${backup ? ` (backup: ${backup})` : ''}`, change: 'updated', path})
    }
  }

  // 3. MCP: one writer per agent. Claude Code owns ~/.claude.json, so it is
  // changed through `claude mcp` and read only to skip an identical entry. When
  // `claude` is not on PATH (an IDE extension bundles its own), the same entry is
  // written into the same file directly, as `claude mcp add-json` would.
  if (!skipped('mcp') && wantClaude) {
    const claudeScope = options.project ? 'project' : 'user'
    const configPath = options.project ? join(deps.cwd, '.mcp.json') : join(deps.home, '.claude.json')
    const desired = claudeServerConfig(baseUrl || '<base-url>', workspaceForConfig)
    const configText = await deps.readFileIfExists(configPath)
    const current = readJsonServer(configText)
    const claude = await deps.findBinary('claude')
    const args = claudeAddArgs(baseUrl || '<base-url>', workspaceForConfig, claudeScope)
    const shown = `claude ${args.slice(0, 3).join(' ')} ${shellQuoteSingle(args[3])} ${args.slice(4).join(' ')}`
    if (JSON.stringify(current) === JSON.stringify(desired)) {
      steps.push({name: 'claude-mcp', status: 'ok', detail: `assethub is already registered in Claude Code (${claudeScope} scope)`, change: 'unchanged', path: configPath})
    } else if (!claude && !baseUrl) {
      // Nothing real to write yet (a dry run before login): show the command instead.
      say(`claude not found on PATH. Setup will write ${configPath} directly, or run:\n  ${shown}`)
      steps.push({name: 'claude-mcp', status: 'skip', detail: `would write mcpServers.assethub to ${configPath} (dry run)`, change: 'would-update', path: configPath})
    } else if (!claude) {
      let merged: string | undefined
      try {
        merged = mergeJsonServer(configPath, configText, desired)
      } catch (error) {
        say(`Run this once ${configPath} is fixed:\n  ${shown}`)
        steps.push({name: 'claude-mcp', status: 'fail', detail: `${configPath} left unchanged: ${error instanceof Error ? error.message : String(error)}`, path: configPath})
      }
      if (merged !== undefined)
        await writeConfig(
          'claude-mcp',
          configPath,
          configText,
          merged,
          'mcpServers.assethub directly (claude CLI not on PATH)',
          sectionDiff(current === undefined ? '' : JSON.stringify(current, null, 2), JSON.stringify(desired, null, 2)),
        )
    } else if (options.dryRun) {
      say(`[dry-run] ${shown}`)
      if (current !== undefined)
        say(`[dry-run] the existing assethub entry would be replaced: claude mcp remove assethub --scope ${claudeScope}, then add again`)
      steps.push({name: 'claude-mcp', status: 'skip', detail: 'would register the assethub MCP server (dry run)', change: 'would-update', path: configPath})
    } else {
      // Add first, and replace only an entry that already exists, so a failing
      // add never costs the user a working one.
      let added = await deps.run(claude, args)
      let replaced = false
      let restored: boolean | undefined
      let removeFailure: string | undefined
      if (added.code !== 0 && /already exists/i.test(added.output)) {
        const removed = await deps.run(claude, ['mcp', 'remove', 'assethub', '--scope', claudeScope])
        if (removed.code !== 0) {
          removeFailure = scrub(removed.output, key).trim().slice(0, 300)
        } else {
          replaced = true
          added = await deps.run(claude, args)
          // Put the previous entry back rather than leave Claude Code without one.
          if (added.code !== 0 && current !== undefined)
            restored =
              (await deps.run(claude, ['mcp', 'add-json', 'assethub', JSON.stringify(current), '--scope', claudeScope]))
                .code === 0
        }
      }
      const failure = scrub(added.output, key).trim().slice(0, 300)
      steps.push(
        removeFailure !== undefined
          ? {
              name: 'claude-mcp',
              status: 'fail',
              detail: `the existing assethub entry was left as it is: claude mcp remove failed: ${removeFailure}`,
              path: configPath,
            }
          : added.code === 0
          ? {
              name: 'claude-mcp',
              status: 'ok',
              detail: `registered assethub in Claude Code (${claudeScope} scope; it reads the key from \$${API_KEY_ENV}, the key is not stored in Claude Code)`,
              change: 'updated',
              path: configPath,
            }
          : {
              name: 'claude-mcp',
              status: 'fail',
              detail: !replaced
                ? `claude mcp add failed: ${failure}`
                : restored
                  ? `claude mcp add failed, so the previous assethub entry was put back: ${failure}`
                  : `claude mcp add failed after the old assethub entry was removed; run \`${shown}\` to add it again: ${failure}`,
              path: configPath,
            },
      )
    }
  }

  if (!skipped('mcp') && wantCodex) {
    const path = options.project ? join(deps.cwd, '.codex', 'config.toml') : join(deps.codexHome, 'config.toml')
    const section = mcpConfig('codex', baseUrl || 'https://app.assethub.io', false, workspaceId)
    const existing = await deps.readFileIfExists(path)
    let merged: string | undefined
    try {
      merged = mergeCodexSection(existing ?? '', section)
    } catch (error) {
      steps.push({name: 'codex-mcp', status: 'fail', detail: `${path} left unchanged: ${error instanceof Error ? error.message : String(error)}`, path})
    }
    if (merged !== undefined)
      await writeConfig(
        'codex-mcp',
        path,
        existing,
        merged,
        '[mcp_servers.assethub]',
        sectionDiff(extractCodexSection(existing ?? ''), extractCodexSection(merged)),
      )
  }

  if (!skipped('mcp') && agents.includes('cursor')) {
    const path = join(root, '.cursor', 'mcp.json')
    const existing = await deps.readFileIfExists(path)
    const entry = mcpServerEntry('cursor', baseUrl || 'https://app.assethub.io', workspaceId)
    let merged: string | undefined
    try {
      merged = mergeJsonServer(path, existing, entry)
    } catch (error) {
      steps.push({name: 'cursor-mcp', status: 'fail', detail: `${path} left unchanged: ${error instanceof Error ? error.message : String(error)}`, path})
    }
    if (merged !== undefined) {
      const before = readJsonServer(existing)
      await writeConfig(
        'cursor-mcp',
        path,
        existing,
        merged,
        'mcpServers.assethub',
        sectionDiff(before === undefined ? '' : JSON.stringify(before, null, 2), JSON.stringify(entry, null, 2)),
      )
    }
  }

  // Every agent reads the key from the environment; the MCP server needs nothing else.
  if (!skipped('mcp'))
    say(`${listJoin(agentNames)} ${agents.length > 1 ? 'read' : 'reads'} the key from the ${API_KEY_ENV} environment variable: export it in your shell (run \`assethub setup --print-env\` to print the line). Setup never writes it to a shell profile.`)
  let exportLine: string | undefined
  if (options.printEnv) exportLine = `export ${API_KEY_ENV}=${options.dryRun || !key ? shownKey : key}`

  // 4. Skill: one copy under <root>/.agents/skills, linked into each agent.
  let skill: SkillsReport | undefined
  if (!skipped('skills')) {
    try {
      skill = await deps.installSkills({root, agents, dryRun: options.dryRun})
      steps.push(skillsStep(skill, options.dryRun))
    } catch (error) {
      steps.push({name: 'skills', status: 'fail', detail: error instanceof Error ? error.message : String(error)})
    }
  }

  // 4b. Auto-update: on by default; shown so nobody is surprised by it.
  if (!skipped('auto-update')) {
    try {
      steps.push(await autoUpdateStep(options, deps))
    } catch (error) {
      steps.push({name: 'auto-update', status: 'fail', detail: error instanceof Error ? error.message : String(error)})
    }
  }

  // 5. Make the key visible to apps started outside a shell (macOS).
  const appEnv = skipped('app-env') ? undefined : await ensureAppEnv(options, deps, key)
  if (appEnv) steps.push(appEnv)

  // 6. Session saving: opt-in, and offered only to accounts that may upload
  // sessions (internal for now). Anyone else gets no question and no step.
  const sessionsAvailable = !skipped('hook') && hookClients.length > 0 && auth != null && (await deps.canSaveSessions(auth))
  if (!sessionsAvailable) {
    if (options.saveSessions && !skipped('hook'))
      steps.push({name: 'hook', status: 'skip', detail: 'session saving is not available for this account'})
  } else if (options.noHook) {
    steps.push({name: 'hook', status: 'skip', detail: 'skipped (--no-hook)'})
  } else if (hookRefusal) {
    // Not offered: the dry run and the question would promise an install the guard refuses.
    steps.push({name: 'hook', status: 'skip', detail: hookRefusal})
  } else if (options.dryRun) {
    steps.push({
      name: 'hook',
      status: 'skip',
      detail: options.saveSessions
        ? `would install the ${hookNames} session-saving hooks for ${deps.cwd} only (dry run)`
        : 'would leave session saving off (enable with --save-sessions)',
    })
  } else {
    const hookScope = {projectDir: deps.cwd}
    let consent = options.saveSessions
    const disclose = () => {
      for (const client of hookClients) say(sessionSaveDisclosure(hookScope, client))
    }
    if (!consent && deps.interactive && !options.yes) {
      disclose()
      consent = await deps.confirmOptIn(`Save and upload your ${hookNames} sessions?`)
    }
    if (!consent) {
      steps.push({
        name: 'hook',
        status: 'skip',
        detail: `session saving is off; enable it with \`assethub setup --save-sessions\`, or ${hookClients.map(client => `\`assethub hooks install --client ${client}\``).join(' and ')} inside the project folder`,
      })
    } else {
      if (options.saveSessions) disclose()
      const pathNote = (await deps.findBinary('assethub'))
        ? ''
        : ' Note: the hooks run `assethub`, which is not on PATH; install the CLI globally.'
      for (const client of hookClients) {
        try {
          const result = await deps.installHooks({
            client,
            ...hookScope,
            ...(client === 'codex' ? {codexHome: deps.codexHome} : {}),
          })
          steps.push({
            name: 'hook',
            status: result.installed ? 'ok' : 'fail',
            detail: `${client}: ${result.detail}${result.installed ? pathNote : ''}`,
          })
        } catch (error) {
          steps.push({
            name: 'hook',
            status: 'fail',
            detail: `${client}: ${scrub(error instanceof Error ? error.message : String(error), key)}`,
          })
        }
      }
    }
  }

  // 7. Doctor
  if (skipped('doctor')) {
    // left out on request
  } else if (options.dryRun) {
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
  const apps = listJoin(agents.map(agent => APP_NAMES[agent]))
  const nextStep = options.dryRun
    ? 'Re-run without --dry-run to apply these changes.'
    : !ok
      ? 'Fix the failed steps above, then re-run `assethub setup` (it is safe to repeat).'
      : skipped('mcp')
        ? agents.length > 0
          ? `Restart ${listJoin(agentNames)} so ${agents.length > 1 ? 'they reload their' : 'it reloads its'} skills.`
          : 'Done.'
        : appEnv?.status === 'ok'
          ? `Quit and reopen ${apps} so it reads ${API_KEY_ENV}, then ask it to use the AssetHub tools. Terminal tabs opened before setup still need \`export ${API_KEY_ENV}=…\`.`
          : `Export ${API_KEY_ENV} in the shell that starts ${agentNames.join(' / ')}, restart it, then ask it to use the AssetHub tools.`
  return {
    ok,
    dryRun: options.dryRun,
    profile: auth?.profile ?? '',
    baseUrl,
    workspaceId,
    version,
    scope,
    agents,
    detected,
    ...(skill ? {skill} : {}),
    steps,
    nextStep,
    ...(exportLine ? {exportLine} : {}),
  }
}

const autoUpdateStep = async (options: SetupOptions, deps: SetupDeps): Promise<SetupStep> => {
  const name = 'auto-update'
  const saved = await deps.readAutoUpdate()
  const wanted = options.autoUpdate ?? saved ?? true
  const changes = options.autoUpdate !== undefined && options.autoUpdate !== (saved ?? true)
  const onText = 'on: once a day a newer CLI installs itself in the background, keeping your login (turn off: `assethub setup --no-auto-update`)'
  const offText = 'off: run `assethub update` yourself (turn on: `assethub setup --auto-update`)'
  if (changes && options.dryRun)
    return {name, status: 'skip', detail: `would turn auto-update ${wanted ? 'on' : 'off'} (dry run)`, change: 'would-update'}
  if (options.autoUpdate !== undefined && options.autoUpdate !== saved) await deps.writeAutoUpdate(options.autoUpdate)
  const change = changes ? ('updated' as const) : ('unchanged' as const)
  if (!wanted) return {name, status: 'ok', detail: offText, change}
  if (!(await deps.canSelfUpdate()))
    return {name, status: 'skip', detail: 'this CLI is not a global install (npx or a source checkout), so it cannot update itself', change}
  if (deps.autoUpdateBlockedByEnv)
    return {name, status: 'skip', detail: 'on, but ASSETHUB_NO_AUTO_UPDATE, ASSETHUB_NO_UPDATE_CHECK or CI turns it off in this environment', change}
  return {name, status: 'ok', detail: onText, change}
}

const skillsStep = (report: SkillsReport, dryRun: boolean): SetupStep => {
  const changedLinks = report.links.filter(link => link.status === 'linked' || link.status === 'relinked')
  const keptLinks = report.links.filter(link => link.status === 'kept-existing')
  const copyChanged = report.status === 'installed' || report.status === 'updated'
  const changed = copyChanged || changedLinks.length > 0
  const parts = [
    report.status === 'kept-existing'
      ? `kept ${report.path} (not created by AssetHub)`
      : report.status === 'kept-newer'
        ? `kept ${report.path} (${report.version}, newer than this CLI)`
      : `${dryRun && copyChanged ? `would ${report.status === 'installed' ? 'install' : 'update'}` : report.status} ${report.path}${report.version ? ` (${report.version})` : ''}`,
    ...(changedLinks.length > 0
      ? [`${dryRun ? 'would link' : 'linked'} into ${listJoin(changedLinks.map(link => agentSpec(link.agent).name))}`]
      : []),
    ...keptLinks.map(link => `kept ${link.path} (not created by AssetHub)`),
  ]
  return {
    name: 'skills',
    path: report.path,
    status: dryRun && changed ? 'skip' : 'ok',
    detail: changed || report.links.length === 0 ? parts.join('; ') : `${parts.join('; ')}; links already in place`,
    change: !changed ? 'unchanged' : dryRun ? 'would-update' : 'updated',
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
      // Only an executable file: a directory or a plain file of that name is not a usable command.
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
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
  home: cliHome(),
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME?.trim() || join(cliHome(), '.codex'),
  now: () => new Date(),
  findBinary: (name: string) => findOnPath(name),
  detectAgents: () =>
    detectAgents(cliHome(), name => findOnPath(name), process.env.CODEX_HOME?.trim() || undefined),
  version: cliVersion,
  installSkills: installAgentSkills,
  run: runProcess,
  readFileIfExists: async (path: string) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  // Written beside the target and renamed over it, so an interrupted setup never
  // leaves a truncated config. A symlinked config (dotfiles) is replaced at its target.
  writeFileEnsuringDir: async (path: string, content: string) => {
    const target = await realpath(path).catch(() => path)
    await mkdir(dirname(target), {recursive: true})
    const temporary = `${target}.assethub-${process.pid}-${Date.now()}.tmp`
    try {
      await writeFile(temporary, content, {mode: await stat(target).then(info => info.mode & 0o777, () => 0o644)})
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, {force: true})
      throw error
    }
  },
  backupFile: (from: string, to: string) => copyFile(from, to, constants.COPYFILE_EXCL),
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

// Pasting into a raw-mode prompt can deliver terminal bytes with the text: Windows
// terminals wrap it in bracketed-paste markers, and a console may pass Ctrl+V through.
// Any of them in an Authorization header makes fetch fail before the request is sent.
export const sanitizeSecretInput = (raw: string): string =>
  raw
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()

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
        if (char === '\r' || char === '\n') return finish(() => resolve(sanitizeSecretInput(value)))
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
