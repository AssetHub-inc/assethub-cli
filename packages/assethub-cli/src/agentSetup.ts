/**
 * The agent-facing half of `assethub setup`: which coding agents are on this
 * machine, where their MCP config lives, and the skill they read on demand.
 *
 * Coding agents learn a tool from two local files: an MCP server entry in their
 * own config, and a skill directory. `setup` writes both, merging into existing
 * config rather than replacing it and never writing credentials: the MCP entries
 * reference `ASSETHUB_API_KEY` from the agent's environment.
 *
 * The skill is copied once to `<root>/.agents/skills/assethub` (root is the home
 * folder, or the project with --project) and symlinked into each agent's skill
 * directory. A version marker lets every later command refresh the home copy
 * when the CLI has been upgraded, so agents never read rules written for a
 * version they are no longer running.
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
import {env, pid} from 'node:process'
import {fileURLToPath} from 'node:url'
import {cliVersion, validatedBaseUrl} from './setup.js'

export const AGENT_IDS = ['claude-code', 'codex', 'cursor'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export type AgentSpec = {
  id: AgentId
  name: string
  /** The command on PATH; finding it, or `detectDir` under home, means the agent is installed. */
  binary: string
  detectDir: string
  skillDir: string
  format: 'claude' | 'cursor' | 'codex'
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    binary: 'claude',
    detectDir: '.claude',
    skillDir: '.claude/skills',
    format: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    binary: 'codex',
    detectDir: '.codex',
    skillDir: '.codex/skills',
    format: 'codex',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    binary: 'cursor',
    detectDir: '.cursor',
    skillDir: '.cursor/skills',
    format: 'cursor',
  },
]

export const agentSpec = (id: AgentId): AgentSpec =>
  AGENT_SPECS.find(agent => agent.id === id) as AgentSpec

/** `--agent` values: repeatable or comma separated; `claude` is accepted for `claude-code`. Keeps AGENT_IDS order. */
export const parseAgentIds = (values: string[]): AgentId[] => {
  const names = values.flatMap(value => value.split(',')).map(value => value.trim().toLowerCase()).filter(Boolean)
  const ids = names.map(name => (name === 'claude' ? 'claude-code' : name))
  const unknown = ids.filter(id => !(AGENT_IDS as readonly string[]).includes(id))
  if (unknown.length > 0)
    throw new Error(`Unknown agent: ${unknown.join(', ')}. Use --agent ${AGENT_IDS.join('|')}.`)
  return AGENT_IDS.filter(id => ids.includes(id))
}

/** Agents installed here: their folder exists under home (or $CODEX_HOME for Codex), or their command is on PATH. */
export const detectAgents = async (
  home: string,
  findBinary: (name: string) => Promise<string | undefined>,
  codexHome?: string,
): Promise<AgentId[]> => {
  const found = await Promise.all(
    AGENT_SPECS.map(
      async agent =>
        (await isDirectory(join(home, agent.detectDir))) ||
        (agent.id === 'codex' && codexHome !== undefined && (await isDirectory(codexHome))) ||
        (await findBinary(agent.binary)) !== undefined,
    ),
  )
  return AGENT_SPECS.filter((_, index) => found[index]).map(agent => agent.id)
}

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

/** The `mcpServers.assethub` entry of a JSON config, or undefined when the file has none or cannot be read. */
export const readJsonServer = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as {mcpServers?: Record<string, unknown>}
    return parsed?.mcpServers?.[SERVER_NAME]
  } catch {
    return undefined
  }
}

/**
 * Sets `mcpServers.assethub` in a JSON config and keeps every other key.
 * Returns the new text, or the input unchanged when the entry already matches.
 */
export const mergeJsonServer = (
  path: string,
  text: string | undefined,
  entry: Record<string, unknown>,
): string => {
  let document: Record<string, unknown> = {}
  if (text !== undefined && text.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${path} is not valid JSON. Fix or move it, then rerun setup.`)
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
      `${path} has a non-object "mcpServers" value. Fix or move it, then rerun setup.`,
    )
  const servers = (document.mcpServers ?? {}) as Record<string, unknown>
  if (text !== undefined && JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry))
    return text
  return `${JSON.stringify({...document, mcpServers: {...servers, [SERVER_NAME]: entry}}, null, 2)}\n`
}

// ── Skill install and sync ───────────────────────────────────────────

export type SkillStatus = 'installed' | 'updated' | 'unchanged' | 'kept-existing'

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
  root,
  version,
  dryRun,
}: {
  /** The home folder, or the project folder for a project install. */
  root: string
  version: string
  dryRun: boolean
}): Promise<{path: string; status: SkillStatus; version?: string}> => {
  const source = packagedSkillDir()
  if (!(await isDirectory(source)))
    throw new Error(
      'This CLI installation does not include the packaged agent skill.',
    )
  const target = canonicalSkillDir(root)
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

export type LinkStatus = 'linked' | 'relinked' | 'unchanged' | 'kept-existing'

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

export type SkillsReport = {
  path: string
  status: SkillStatus
  version?: string
  links: {agent: AgentId; path: string; status: LinkStatus}[]
}

/** Installs the skill under `<root>/.agents/skills` and links it into each agent's skill folder under root. */
export const installAgentSkills = async ({
  root,
  agents,
  dryRun,
}: {
  root: string
  agents: AgentId[]
  dryRun: boolean
}): Promise<SkillsReport> => {
  const skill = await installSkill({root, version: await cliVersion(), dryRun})
  const links: SkillsReport['links'] = []
  for (const agent of agents)
    links.push({agent, ...(await linkSkill(join(root, agentSpec(agent).skillDir), skill.path, dryRun))})
  return {...skill, links}
}
