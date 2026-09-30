// Register / remove our Claude Code hooks in the user's settings.json.
//
// Merge rules: keep every existing key and hook, identify our entry by its
// command string (`<assethub> hooks save`), never duplicate it, and back the
// original file up before any change.

import {copyFile, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'

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

/** What `hooks install` and `setup` must tell the user before recording starts. */
export const SESSION_SAVE_DISCLOSURE =
  'Session saving adds SessionStart, Stop, PreCompact and SessionEnd hooks to ~/.claude/settings.json. ' +
  'Every Claude Code session on this machine, in any project, is then copied to ~/.assethub/sessions/ when it ends ' +
  '(the full transcript with recognised secrets masked, readable only by you; copies older than 30 days are deleted), ' +
  'and uploaded to AssetHub as a coding-agent session only you can read (internal accounts only for now): the masked transcript, ' +
  'your prompts, the agent\'s replies, its tool calls and images from the project. Uploads that fail are retried in the background ' +
  'when a later session starts or ends. Secret masking is best effort. ' +
  'Opt a project out with .assethub/no-session-save, or turn it off with ASSETHUB_SESSION_SAVE=off / ASSETHUB_SESSION_UPLOAD=off; ' +
  'remove it with `assethub hooks uninstall --client claude`.'

const CODEX_DETAIL = 'Codex: run `assethub hooks save --transcript <path>` manually for now'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const OUR_COMMAND_RE = /(^|[\s/\\"'])assethub(?:\.js)?["']?\s+hooks\s+save(?:\s|$)/

export const isOurCommand = (command: unknown): boolean =>
  typeof command === 'string' && OUR_COMMAND_RE.test(command)

const quoteIfNeeded = (value: string): string => (/\s/.test(value) ? JSON.stringify(value) : value)

export const hookCommand = (cliPath?: string): string =>
  `${quoteIfNeeded(cliPath ?? 'assethub')} hooks save`

const settingsPath = (home?: string): string => join(resolveHome(home), '.claude', 'settings.json')

type Loaded = {path: string; exists: boolean; settings: Json; raw: string}

const load = async (home?: string): Promise<Loaded | {error: string; path: string}> => {
  const path = settingsPath(home)
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

const BACKUP_RE = /^settings\.json\.bak-\d+$/

const pruneBackups = async (path: string): Promise<void> => {
  const dir = dirname(path)
  const ours = (await readdir(dir)).filter(name => BACKUP_RE.test(name))
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
 * spawn work, and run in the background so they never delay the agent.
 * SessionEnd stays synchronous, because Claude Code is exiting and a
 * background hook could be cut off.
 */
export const hookEntry = (event: (typeof HOOK_EVENTS)[number], command: string): HookEntry =>
  event === 'SessionEnd'
    ? {type: 'command', command, timeout: SESSION_END_TIMEOUT_SECONDS}
    : {type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS, async: true}

export const installHooks = async (options: {
  client: HookClient
  home?: string
  cliPath?: string
}): Promise<{installed: boolean; detail: string}> => {
  if (options.client === 'codex') return {installed: false, detail: CODEX_DETAIL}

  const loaded = await load(options.home)
  if ('error' in loaded) return {installed: false, detail: loaded.error}

  const command = hookCommand(options.cliPath)
  const settings: Json = structuredClone(loaded.settings)
  const hooks: Json = isObject(settings.hooks) ? settings.hooks : {}
  let changed = false

  for (const event of HOOK_EVENTS) {
    const groups: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const wanted = hookEntry(event, command)
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
    return {installed: true, detail: `Hooks already installed in ${loaded.path}`}
  }
  await backupAndWrite(loaded, settings)
  return {installed: true, detail: `Installed ${HOOK_EVENTS.join(', ')} hooks in ${loaded.path}`}
}

export const uninstallHooks = async (options: {
  client: HookClient
  home?: string
}): Promise<{removed: boolean; detail: string}> => {
  if (options.client === 'codex') {
    return {removed: false, detail: 'Codex: no hooks were installed by assethub.'}
  }
  const loaded = await load(options.home)
  if ('error' in loaded) return {removed: false, detail: loaded.error}
  if (!loaded.exists || !isObject(loaded.settings.hooks)) {
    return {removed: false, detail: 'No assethub hooks found.'}
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
  if (!changed) return {removed: false, detail: 'No assethub hooks found.'}
  if (Object.keys(hooks).length === 0) delete settings.hooks

  await backupAndWrite(loaded, settings)
  return {removed: true, detail: `Removed assethub hooks from ${loaded.path}`}
}
