/**
 * `assethub init` and the skill sync that keeps its output current.
 *
 * Coding agents learn a tool from two local files: an MCP server entry in their
 * own config, and a skill directory they read on demand. `init` writes both for
 * every supported agent found on this machine, merging into existing config
 * rather than replacing it, and never touching credentials — the MCP entries
 * reference `ASSETHUB_API_KEY` from the agent's environment.
 *
 * The skill is copied once to `~/.agents/skills/assethub` and symlinked into
 * each agent's skill directory. A version marker lets every later command
 * refresh the copy when the CLI has been upgraded, so agents never read rules
 * written for a version they are no longer running.
 */
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname, join, relative, resolve} from 'node:path'
import {cwd as processCwd, env, pid} from 'node:process'
import {fileURLToPath} from 'node:url'
import {cliVersion, mcpConfig, validatedBaseUrl} from './setup.js'

export const AGENT_IDS = ['claude-code', 'codex', 'cursor'] as const
export type AgentId = (typeof AGENT_IDS)[number]

type AgentSpec = {
  id: AgentId
  name: string
  /** Presence of this directory under home means the agent is installed. */
  detectDir: string
  globalMcpPath: string
  projectMcpPath: string
  skillDir: string
  format: 'claude' | 'cursor' | 'codex'
}

const AGENTS: readonly AgentSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detectDir: '.claude',
    globalMcpPath: '.claude.json',
    projectMcpPath: '.mcp.json',
    skillDir: '.claude/skills',
    format: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    detectDir: '.codex',
    globalMcpPath: '.codex/config.toml',
    projectMcpPath: '.codex/config.toml',
    skillDir: '.codex/skills',
    format: 'codex',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detectDir: '.cursor',
    globalMcpPath: '.cursor/mcp.json',
    projectMcpPath: '.cursor/mcp.json',
    skillDir: '.cursor/skills',
    format: 'cursor',
  },
]

const SERVER_NAME = 'assethub'
const SKILL_NAME = 'assethub'
const VERSION_MARKER = '.assethub-cli-version'

/** `ASSETHUB_CLI_HOME` keeps tests and sandboxes from writing into the real home directory. */
export const cliHome = (): string => env.ASSETHUB_CLI_HOME || homedir()

export const packagedSkillDir = (): string =>
  fileURLToPath(new URL(`../skills/${SKILL_NAME}/`, import.meta.url))

export const canonicalSkillDir = (home: string): string =>
  join(home, '.agents', 'skills', SKILL_NAME)

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as {code?: string}).code === 'ENOENT'

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

// ── MCP configuration ────────────────────────────────────────────────

export const mcpServerEntry = (
  format: AgentSpec['format'],
  baseUrl: string,
  workspaceId?: string,
): Record<string, unknown> => {
  const url = `${validatedBaseUrl(baseUrl)}/api/mcp`
  // Cursor expands `${env:NAME}`; Claude Code expands `${NAME}`. Neither file ever holds the key.
  const key = format === 'cursor' ? '${env:ASSETHUB_API_KEY}' : '${ASSETHUB_API_KEY}'
  return {
    ...(format === 'claude' ? {type: 'http'} : {}),
    url,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(workspaceId ? {'X-AssetHub-Workspace': workspaceId} : {}),
    },
  }
}

type WriteStatus = 'created' | 'updated' | 'unchanged'

const writeJsonServer = async (
  path: string,
  entry: Record<string, unknown>,
  dryRun: boolean,
): Promise<WriteStatus> => {
  const text = await readText(path)
  let document: Record<string, unknown> = {}
  if (text !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${path} is not valid JSON. Fix or move it, then rerun init.`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error(`${path} must contain a JSON object.`)
    document = parsed as Record<string, unknown>
  }
  // A malformed `mcpServers` is the user's data too; refuse rather than replace it.
  if (
    document.mcpServers !== undefined &&
    (typeof document.mcpServers !== 'object' ||
      document.mcpServers === null ||
      Array.isArray(document.mcpServers))
  )
    throw new Error(
      `${path} has a non-object "mcpServers" value. Fix or move it, then rerun init.`,
    )
  const servers = (document.mcpServers ?? {}) as Record<string, unknown>
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry))
    return 'unchanged'
  const next = {...document, mcpServers: {...servers, [SERVER_NAME]: entry}}
  if (!dryRun) {
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
  }
  return text === undefined ? 'created' : 'updated'
}

/** Replaces or appends one `[mcp_servers.assethub]` table; every other line is kept verbatim. */
const writeTomlSection = async (
  path: string,
  section: string,
  dryRun: boolean,
): Promise<WriteStatus> => {
  const header = `[mcp_servers.${SERVER_NAME}]`
  const body = section.trimEnd()
  const text = await readText(path)
  const lines = (text ?? '').split('\n')
  const start = lines.findIndex(line => line.trim() === header)
  let next: string
  if (start === -1) {
    const base = (text ?? '').trimEnd()
    next = `${base ? `${base}\n\n` : ''}${body}\n`
  } else {
    const endOffset = lines
      .slice(start + 1)
      .findIndex(line => /^\s*\[/.test(line))
    const end = endOffset === -1 ? lines.length : start + 1 + endOffset
    if (lines.slice(start, end).join('\n').trimEnd() === body) return 'unchanged'
    const before = lines.slice(0, start).join('\n').trimEnd()
    const after = lines.slice(end).join('\n').trim()
    next = `${before ? `${before}\n\n` : ''}${body}\n${after ? `\n${after}\n` : ''}`
  }
  if (!dryRun) {
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, next)
  }
  return text === undefined ? 'created' : 'updated'
}

// ── Skill install and sync ───────────────────────────────────────────

type SkillStatus = 'installed' | 'updated' | 'unchanged' | 'kept-existing'

const readMarker = async (dir: string): Promise<string | undefined> =>
  (await readText(join(dir, VERSION_MARKER)))?.trim()

/**
 * Stage the new copy beside the target, then swap with two renames, so the
 * installed skill is never deleted before its replacement is complete. A
 * failed swap puts the previous copy back. Two CLIs syncing at the same
 * moment use distinct staging names; whichever copy lands is complete, and
 * the loser's error is swallowed by the caller.
 */
const replaceSkillDir = async (
  source: string,
  target: string,
  version: string,
): Promise<void> => {
  const staging = `${target}.next-${pid}`
  const previous = `${target}.prev-${pid}`
  await rm(staging, {recursive: true, force: true})
  await mkdir(dirname(target), {recursive: true})
  await cp(source, staging, {recursive: true})
  await writeFile(join(staging, VERSION_MARKER), `${version}\n`)
  const hadTarget = await isDirectory(target)
  if (hadTarget) await rename(target, previous)
  try {
    await rename(staging, target)
  } catch (error) {
    if (hadTarget) await rename(previous, target).catch(() => undefined)
    await rm(staging, {recursive: true, force: true})
    throw error
  }
  if (hadTarget) await rm(previous, {recursive: true, force: true})
}

export const installSkill = async ({
  home,
  version,
  dryRun,
}: {
  home: string
  version: string
  dryRun: boolean
}): Promise<{path: string; status: SkillStatus; version?: string}> => {
  const source = packagedSkillDir()
  if (!(await isDirectory(source)))
    throw new Error(
      'This CLI installation does not include the packaged agent skill.',
    )
  const target = canonicalSkillDir(home)
  const marker = await readMarker(target)
  // A directory without our marker is the user's own; leave it alone.
  const status: SkillStatus =
    marker === undefined
      ? (await isDirectory(target))
        ? 'kept-existing'
        : 'installed'
      : marker === version
        ? 'unchanged'
        : 'updated'
  if (!dryRun && (status === 'installed' || status === 'updated'))
    await replaceSkillDir(source, target, version)
  return {
    path: target,
    status,
    ...(status === 'kept-existing' ? {} : {version}),
  }
}

type LinkStatus = 'linked' | 'relinked' | 'unchanged' | 'kept-existing'

const linkSkill = async (
  agentSkillsDir: string,
  canonical: string,
  dryRun: boolean,
): Promise<{path: string; status: LinkStatus}> => {
  const link = join(agentSkillsDir, SKILL_NAME)
  const relativeTarget = relative(agentSkillsDir, canonical)
  let existing: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    existing = await lstat(link)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  if (existing?.isSymbolicLink()) {
    if (resolve(agentSkillsDir, await readlink(link)) === canonical)
      return {path: link, status: 'unchanged'}
    if (!dryRun) {
      await rm(link)
      await symlink(relativeTarget, link, 'dir')
    }
    return {path: link, status: 'relinked'}
  }
  if (existing) return {path: link, status: 'kept-existing'}
  if (!dryRun) {
    await mkdir(agentSkillsDir, {recursive: true})
    await symlink(relativeTarget, link, 'dir')
  }
  return {path: link, status: 'linked'}
}

let synced = false

/**
 * Refresh an installed skill after a CLI upgrade. Runs before every command;
 * the steady-state cost is one small file read. Never throws — a read-only or
 * missing home must not fail the user's actual command.
 */
export const syncInstalledSkill = async (): Promise<void> => {
  if (synced) return
  synced = true
  try {
    const target = canonicalSkillDir(cliHome())
    const installed = await readMarker(target)
    if (installed === undefined) return
    const version = await cliVersion()
    if (installed === version) return
    const source = packagedSkillDir()
    if (!(await isDirectory(source))) return
    await replaceSkillDir(source, target, version)
  } catch {
    // best effort
  }
}

// ── init ─────────────────────────────────────────────────────────────

export type InitOptions = {
  baseUrl: string
  workspaceId?: string
  /** Agent ids to configure; defaults to every agent detected under home. */
  agents?: string[]
  /** Write project-level MCP config into the working directory instead of the user's home. */
  project?: boolean
  dryRun?: boolean
  cwd?: string
  home?: string
}

export type InitReport = {
  version: string
  dryRun: boolean
  scope: 'global' | 'project'
  skill: Awaited<ReturnType<typeof installSkill>>
  agents: {
    id: AgentId
    name: string
    detected: boolean
    mcp: {path: string; status: WriteStatus}
    skill: {path: string; status: LinkStatus}
  }[]
  next: string[]
}

export const initAgents = async (options: InitOptions): Promise<InitReport> => {
  const home = options.home ?? cliHome()
  const cwd = options.cwd ?? processCwd()
  const dryRun = options.dryRun ?? false
  const version = await cliVersion()

  const requested = options.agents ?? []
  const unknown = requested.filter(
    id => !(AGENT_IDS as readonly string[]).includes(id),
  )
  if (unknown.length > 0)
    throw new Error(
      `Unknown agent: ${unknown.join(', ')}. Use --agent ${AGENT_IDS.join('|')}.`,
    )

  const detected = new Map(
    await Promise.all(
      AGENTS.map(
        async agent =>
          [agent.id, await isDirectory(join(home, agent.detectDir))] as const,
      ),
    ),
  )
  const selected =
    requested.length > 0
      ? AGENTS.filter(agent => requested.includes(agent.id))
      : AGENTS.filter(agent => detected.get(agent.id))
  if (selected.length === 0)
    throw new Error(
      `No supported coding agent found under ${home}. Pass --agent ${AGENT_IDS.join('|')} to choose one.`,
    )

  const skill = await installSkill({home, version, dryRun})
  const agents: InitReport['agents'] = []
  for (const spec of selected) {
    const mcpPath = options.project
      ? join(cwd, spec.projectMcpPath)
      : join(home, spec.globalMcpPath)
    const mcp =
      spec.format === 'codex'
        ? await writeTomlSection(
            mcpPath,
            mcpConfig('codex', options.baseUrl, false, options.workspaceId),
            dryRun,
          )
        : await writeJsonServer(
            mcpPath,
            mcpServerEntry(spec.format, options.baseUrl, options.workspaceId),
            dryRun,
          )
    const link = await linkSkill(join(home, spec.skillDir), skill.path, dryRun)
    agents.push({
      id: spec.id,
      name: spec.name,
      detected: detected.get(spec.id) ?? false,
      mcp: {path: mcpPath, status: mcp},
      skill: link,
    })
  }

  return {
    version,
    dryRun,
    scope: options.project ? 'project' : 'global',
    skill,
    agents,
    next: [
      ...(env.ASSETHUB_API_KEY
        ? []
        : [
            "Provide ASSETHUB_API_KEY in each agent's environment; the MCP entries read it from there and never store it.",
          ]),
      'Restart the agent so it reloads MCP servers and skills.',
      'Run `assethub doctor --mcp` to verify the connection.',
    ],
  }
}
