// Register / remove our session hooks.
//
// Claude Code: one project's .claude/settings.local.json (the default for
// `hooks install`), or with --global the user's ~/.claude/settings.json.
// Codex: one project's .codex/hooks.json, or with --global
// $CODEX_HOME/hooks.json. Codex has no personal per-project file, so the
// project file is kept out of git (info/exclude) and a tracked one is refused.
//
// Merge rules: keep every existing key and hook, identify our entry by its
// command string (`<assethub> hooks save`), never duplicate it, and back the
// original file up before any change.

import {execFile} from 'node:child_process'
import {appendFile, copyFile, mkdir, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises'
import {basename, dirname, join, relative, resolve, sep} from 'node:path'
import {promisify} from 'node:util'

import {resolveHome} from './paths.js'
import type {HookClient} from './types.js'

export const HOOK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd', 'PreCompact'] as const
export const HOOK_TIMEOUT_SECONDS = 30
/**
 * SessionEnd hooks share a 1.5 s budget that a longer per-hook `timeout` raises
 * (up to 60 s). The save itself is local; the upload runs in a detached process.
 */
export const SESSION_END_TIMEOUT_SECONDS = 10
export const MAX_SETTINGS_BACKUPS = 3

/** Where the hooks go: one project folder, or every project when omitted (--global). */
export type HookScope = {projectDir?: string}

/** Where each client keeps its config, per project and for the user. */
type ClientPaths = {home?: string; codexHome?: string}

const CLIENT_NAME: Record<HookClient, string> = {claude: 'Claude Code', codex: 'Codex'}
const PROJECT_DIR: Record<HookClient, string> = {claude: '.claude', codex: '.codex'}
const PROJECT_FILE: Record<HookClient, string> = {claude: 'settings.local.json', codex: 'hooks.json'}

const projectSettingsPath = (projectDir: string, client: HookClient = 'claude'): string =>
  join(resolve(projectDir), PROJECT_DIR[client], PROJECT_FILE[client])

/** The client's user-level folder: ~/.claude, or $CODEX_HOME (default ~/.codex). */
const userConfigDir = (client: HookClient, paths: ClientPaths): string =>
  client === 'codex' ? (paths.codexHome ?? join(resolveHome(paths.home), '.codex')) : join(resolveHome(paths.home), '.claude')

const settingsPath = (client: HookClient, paths: ClientPaths, scope: HookScope): string =>
  scope.projectDir
    ? projectSettingsPath(scope.projectDir, client)
    : join(userConfigDir(client, paths), client === 'codex' ? 'hooks.json' : 'settings.json')

/** What `hooks install` and `setup` must tell the user before recording starts. */
export const sessionSaveDisclosure = (scope: HookScope, client: HookClient = 'claude'): string => {
  const name = CLIENT_NAME[client]
  const where = scope.projectDir
    ? `${projectSettingsPath(scope.projectDir, client)}. ` +
      `Every ${name} session opened in ${resolve(scope.projectDir)} (and only there)`
    : `${client === 'codex' ? '$CODEX_HOME/hooks.json' : '~/.claude/settings.json'} (--global). Every ${name} session on this machine, in any project,`
  const remove = scope.projectDir
    ? `\`assethub hooks uninstall --client ${client}\` from that folder`
    : `\`assethub hooks uninstall --client ${client} --global\``
  return (
    `Session saving adds SessionStart, Stop, PreCompact and SessionEnd hooks to ${where} ` +
    'is then copied to ~/.assethub/sessions/ when it ends ' +
    '(the conversation only: your prompts, the agent\'s replies and tool calls, with recognised secrets masked, readable only by you; copies older than 30 days are deleted), ' +
    'and uploaded to AssetHub as a coding-agent session only you can read (internal accounts only for now): the masked transcript, ' +
    'your prompts, the agent\'s replies, its tool calls and images from the project. Uploads that fail are retried in the background ' +
    'when a later session starts or ends. Secret masking is best effort. ' +
    'Opt a project out with .assethub/no-session-save, or turn it off with ASSETHUB_SESSION_SAVE=off / ASSETHUB_SESSION_UPLOAD=off; ' +
    `remove it with ${remove}.`
  )
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  value != null && typeof value === 'object' && !Array.isArray(value)

// Only a command that runs the CLI itself: `assethub hooks save`, optionally a
// (quoted) path to it. `echo assethub hooks save` is somebody else's hook.
const OUR_COMMAND_RE =
  /^\s*(?:"(?:[^"]*[/\\])?assethub(?:\.js)?"|'(?:[^']*[/\\])?assethub(?:\.js)?'|(?:[^\s"']*[/\\])?assethub(?:\.js)?)\s+hooks\s+save(?:\s|$)/

export const isOurCommand = (command: unknown): boolean =>
  typeof command === 'string' && OUR_COMMAND_RE.test(command)

const quoteIfNeeded = (value: string): string => (/\s/.test(value) ? JSON.stringify(value) : value)

/** Codex hooks name their client, so the saved session is recorded as Codex. */
export const hookCommand = (cliPath?: string, client: HookClient = 'claude'): string =>
  `${quoteIfNeeded(cliPath ?? 'assethub')} hooks save${client === 'codex' ? ' --client codex' : ''}`

// Symlinks are followed: a project path or a client folder that leads to the
// home folder is the home folder. A path that does not exist yet is taken as is.
const realOrResolved = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path))

/**
 * A project install in the home folder would land in ~/.claude (or ~/.codex),
 * which the client also reads for every project, so it is refused rather than
 * silently global.
 */
export const hookScopeError = async (
  home: string | undefined,
  scope: HookScope,
  client: HookClient = 'claude',
  codexHome?: string,
): Promise<string | undefined> => {
  if (!scope.projectDir) return undefined
  const homeDir = resolveHome(home)
  const [project, projectConfig, realHome, userConfig] = await Promise.all([
    realOrResolved(scope.projectDir),
    realOrResolved(join(scope.projectDir, PROJECT_DIR[client])),
    realOrResolved(homeDir),
    realOrResolved(userConfigDir(client, {home, codexHome})),
  ])
  return project === realHome || projectConfig === userConfig
    ? 'Run this inside a project folder: in your home folder the hooks would apply to every project. Use --global if that is what you want.'
    : undefined
}

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string | undefined> =>
  run('git', ['-C', cwd, ...args]).then(({stdout}) => stdout, () => undefined)

/**
 * Codex reads hooks only from .codex/hooks.json, which a repository may share.
 * Ours stay personal: a tracked file is refused, an untracked one goes into
 * the repository's info/exclude (never the shared .gitignore).
 */
const keepCodexHooksOutOfGit = async (path: string): Promise<string | undefined> => {
  const dir = dirname(dirname(path))
  const found = await git(dir, 'rev-parse', '--show-toplevel', '--git-path', 'info/exclude')
  if (!found) return undefined // not a repository, or no git
  const [top, excludePath] = found.trim().split('\n')
  const file = relative(await realOrResolved(top), join(await realOrResolved(dir), PROJECT_DIR.codex, PROJECT_FILE.codex))
  if (file.startsWith('..')) return undefined
  if ((await git(top, 'ls-files', '--', file))?.trim())
    return `${path} is tracked by git, so the hooks would be shared with everyone using the repository; left untouched.`
  const exclude = resolve(dir, excludePath)
  // The file and the backups an install leaves next to it.
  const pattern = `/${file.split(sep).join('/')}*`
  const current = await readFile(exclude, 'utf8').catch(() => '')
  if (!current.split('\n').includes(pattern)) {
    await mkdir(dirname(exclude), {recursive: true})
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`)
  }
  return undefined
}

/** `[projects."<path>"]` sections with `trust_level = "trusted"` in Codex's config.toml. */
const codexTrustedProjects = async (codexDir: string): Promise<Set<string>> => {
  const toml = await readFile(join(codexDir, 'config.toml'), 'utf8').catch(() => '')
  const trusted = new Set<string>()
  const sections = toml.split(/^(?=\[)/m)
  for (const section of sections) {
    const header = /^\[projects\."((?:[^"\\]|\\.)*)"\]/.exec(section)
    if (header && /^\s*trust_level\s*=\s*"trusted"/m.test(section)) trusted.add(header[1].replace(/\\(.)/g, '$1'))
  }
  return trusted
}

/** What Codex still needs before the hooks run. */
const codexNotes = async (codexDir: string, scope: HookScope): Promise<string> => {
  const review = ' Codex runs a new or changed hook only after you approve it: open /hooks in Codex.'
  if (!scope.projectDir) return review
  const dir = scope.projectDir
  const top = (await git(dir, 'rev-parse', '--show-toplevel'))?.trim()
  const candidates = [resolve(dir), await realOrResolved(dir), ...(top ? [top, await realOrResolved(top)] : [])]
  const trusted = await codexTrustedProjects(codexDir)
  if (candidates.some(path => trusted.has(path))) return review
  return (
    ` Codex loads a project's hooks only when the project is trusted: add [projects."${resolve(dir)}"] ` +
    `with trust_level = "trusted" to ${join(codexDir, 'config.toml')}, or trust the folder when Codex asks.` +
    review
  )
}

type Loaded = {path: string; exists: boolean; settings: Json; raw: string}

const load = async (
  client: HookClient,
  paths: ClientPaths,
  scope: HookScope,
): Promise<Loaded | {error: string; path: string}> => {
  const path = settingsPath(client, paths, scope)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {path, exists: false, settings: {}, raw: ''}
    }
    return {path, error: `Could not read ${path}: ${(error as Error).message}`}
  }
  if (!raw.trim()) return {path, exists: true, settings: {}, raw}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) return {path, error: `${path} is not a JSON object; left untouched.`}
    return {path, exists: true, settings: parsed, raw}
  } catch {
    return {path, error: `${path} is not valid JSON; left untouched.`}
  }
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const pruneBackups = async (path: string): Promise<void> => {
  const dir = dirname(path)
  const backupRe = new RegExp(`^${escapeRe(basename(path))}\\.bak-\\d+$`)
  const ours = (await readdir(dir)).filter(name => backupRe.test(name))
  const byAge = ours.sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
  for (const name of byAge.slice(MAX_SETTINGS_BACKUPS)) await rm(join(dir, name), {force: true})
}

// Write through a temp file and rename, so a concurrent reader (Claude Code)
// never sees a half-written settings.json.
const backupAndWrite = async (loaded: Loaded, next: Json): Promise<void> => {
  await mkdir(dirname(loaded.path), {recursive: true})
  if (loaded.exists) {
    await copyFile(loaded.path, `${loaded.path}.bak-${Date.now()}`)
  }
  const tmp = join(dirname(loaded.path), `.${basename(loaded.path)}.${process.pid}.tmp`)
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
  await rename(tmp, loaded.path)
  await pruneBackups(loaded.path)
}

type HookEntry = {type: 'command'; command: string; timeout: number; async?: true}

/**
 * SessionStart (sweep and retry), Stop (every turn) and PreCompact only mark or
 * spawn work, and run in the background so they never delay Claude Code.
 * SessionEnd stays synchronous, because Claude Code is exiting and a
 * background hook could be cut off. Codex hooks all run synchronously; the
 * work is the same few local file writes.
 */
export const hookEntry = (
  event: (typeof HOOK_EVENTS)[number],
  command: string,
  client: HookClient = 'claude',
): HookEntry =>
  event === 'SessionEnd'
    ? {type: 'command', command, timeout: SESSION_END_TIMEOUT_SECONDS}
    : client === 'codex'
      ? {type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS}
      : {type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS, async: true}

export const installHooks = async (options: HookScope & ClientPaths & {
  client: HookClient
  cliPath?: string
}): Promise<{installed: boolean; detail: string}> => {
  const {client} = options
  const refused = await hookScopeError(options.home, options, client, options.codexHome)
  if (refused) return {installed: false, detail: refused}

  const loaded = await load(client, options, options)
  if ('error' in loaded) return {installed: false, detail: loaded.error}
  if (client === 'codex' && options.projectDir) {
    const shared = await keepCodexHooksOutOfGit(loaded.path)
    if (shared) return {installed: false, detail: shared}
  }
  const notes = client === 'codex' ? await codexNotes(userConfigDir(client, options), options) : ''

  const command = hookCommand(options.cliPath, client)
  const settings: Json = structuredClone(loaded.settings)
  const hooks: Json = isObject(settings.hooks) ? settings.hooks : {}
  let changed = false

  for (const event of HOOK_EVENTS) {
    const groups: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const wanted = hookEntry(event, command, client)
    let found = false
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue
      group.hooks = group.hooks.map((hook: unknown) => {
        if (!isObject(hook) || !isOurCommand(hook.command)) return hook
        found = true
        // Rewrite entries from older installs (no async, old timeout, old path).
        if (JSON.stringify(hook) === JSON.stringify(wanted)) return hook
        changed = true
        return {...wanted}
      })
    }
    if (!found) {
      groups.push({hooks: [{...wanted}]})
      changed = true
    }
    hooks[event] = groups
  }
  settings.hooks = hooks

  if (!changed) {
    return {installed: true, detail: `Hooks already installed in ${loaded.path}.${notes}`}
  }
  await backupAndWrite(loaded, settings)
  return {installed: true, detail: `Installed ${HOOK_EVENTS.join(', ')} hooks in ${loaded.path}.${notes}`}
}

export const uninstallHooks = async (options: HookScope & ClientPaths & {
  client: HookClient
}): Promise<{removed: boolean; detail: string}> => {
  const loaded = await load(options.client, options, options)
  if ('error' in loaded) return {removed: false, detail: loaded.error}
  if (!loaded.exists || !isObject(loaded.settings.hooks)) {
    return {removed: false, detail: `No assethub hooks found in ${loaded.path}.`}
  }

  const settings: Json = structuredClone(loaded.settings)
  const hooks = settings.hooks as Json
  let changed = false
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    const keptGroups: unknown[] = []
    let eventChanged = false
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group)
        continue
      }
      const kept = group.hooks.filter(hook => !(isObject(hook) && isOurCommand(hook.command)))
      if (kept.length === group.hooks.length) {
        keptGroups.push(group)
        continue
      }
      changed = true
      eventChanged = true
      if (kept.length > 0) keptGroups.push({...group, hooks: kept})
    }
    if (keptGroups.length > 0) hooks[event] = keptGroups
    else if (eventChanged) delete hooks[event]
  }
  if (!changed) return {removed: false, detail: `No assethub hooks found in ${loaded.path}.`}
  if (Object.keys(hooks).length === 0) delete settings.hooks

  await backupAndWrite(loaded, settings)
  return {removed: true, detail: `Removed assethub hooks from ${loaded.path}`}
}
