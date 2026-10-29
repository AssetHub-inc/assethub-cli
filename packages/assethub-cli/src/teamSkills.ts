/**
 * Team skills: ordinary agent skill folders (SKILL.md plus scripts and
 * references) kept in the AssetHub workspace with numbered revisions.
 *
 * `skills push` reads a skill folder, or every skill of a Claude Code plugin,
 * checks it for secrets and machine paths, and saves it. `skills pull` copies
 * the newest revision of each team skill to `~/.agents/skills/<id>` and links
 * it into Claude Code, Codex and Cursor, so a teammate's next session already
 * has it. A copy the person changed is never overwritten: it stays theirs
 * until they push it or ask for the team's. Nothing is run at pull time.
 */
import {isUtf8} from 'node:buffer'
import {createHash} from 'node:crypto'
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {basename, join, relative, sep} from 'node:path'
import {pid} from 'node:process'
import type {
  SkillPackage,
  SkillPackagePushed,
  SkillPackagePushInput,
  SkillPackageSummary,
} from '@assethub/api-client'
import {agentSpec, linkSkill, type AgentId, type LinkStatus} from './agentSetup.js'

export const MAX_SKILL_FILES = 64
export const MAX_SKILL_BYTES = 2 * 1024 * 1024
const MARKER = '.assethub-skill.json'
const LOCK = '.assethub-team-skills.json'
/** Never uploaded or replaced: machine-specific settings such as a Maya folder. */
const LOCAL_SETTINGS = 'local.json'
/** The CLI's own guide; a team skill can never take its place. */
const RESERVED_IDS = new Set(['assethub'])
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv'])

export type SkillFolder = {
  dir: string
  skillId: string
  name: string
  description: string
  files: Record<string, string>
  /** Files left out, with why (binary, local settings). */
  skipped: {path: string; reason: string}[]
  source?: {plugin?: string; pluginVersion?: string}
}

// ── Reading a skill folder ───────────────────────────────────────────

/** `Rig Adapt (CC2)` -> `rig-adapt-cc2`. */
export const slugSkillId = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')

/** `name` and `description` from SKILL.md's YAML frontmatter (single-line values). */
export const readFrontmatter = (text: string): {name?: string; description?: string} => {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return {name: fields.name || undefined, description: fields.description || undefined}
}

const isEnoent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

const isDirectory = async (path: string) => {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

const readTextIfExists = async (path: string) => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
}

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, {withFileTypes: true})
  const nested = await Promise.all(
    entries
      .filter(entry => !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name))
      .map(entry =>
        entry.isDirectory()
          ? listFiles(join(dir, entry.name))
          : Promise.resolve(entry.isFile() ? [join(dir, entry.name)] : []),
      ),
  )
  return nested.flat()
}

/** Line endings are normalised so a Windows and a Mac copy of one skill hash the same. */
const normaliseText = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * Reads one skill folder (SKILL.md at its root). Hidden files, `local.json`
 * and binary files are left out and listed in `skipped`.
 */
export const readSkillFolder = async (
  dir: string,
  source?: SkillFolder['source'],
): Promise<SkillFolder> => {
  const skillMd = await readTextIfExists(join(dir, 'SKILL.md'))
  if (skillMd === undefined) throw new Error(`${dir} has no SKILL.md, so it is not a skill folder.`)
  const front = readFrontmatter(normaliseText(skillMd))
  const name = front.name ?? basename(dir)
  const skillId = slugSkillId(name)
  if (!skillId) throw new Error(`${dir}: the skill name "${name}" has no letters or digits to make an id from.`)
  const files: Record<string, string> = {}
  const skipped: SkillFolder['skipped'] = []
  let bytes = 0
  for (const path of (await listFiles(dir)).sort()) {
    const rel = relative(dir, path).split(sep).join('/')
    if (rel === LOCAL_SETTINGS) {
      skipped.push({path: rel, reason: 'settings for this computer only'})
      continue
    }
    const buffer = await readFile(path)
    // NUL bytes, or bytes that are not UTF-8, mean a binary that text would corrupt.
    if (buffer.includes(0) || !isUtf8(buffer)) {
      skipped.push({path: rel, reason: 'not a text file'})
      continue
    }
    const text = normaliseText(buffer.toString('utf8'))
    bytes += Buffer.byteLength(text)
    files[rel] = text
  }
  if (Object.keys(files).length > MAX_SKILL_FILES)
    throw new Error(`${name} has more than ${MAX_SKILL_FILES} files. Move data that is not part of the method out of the folder.`)
  if (bytes > MAX_SKILL_BYTES)
    throw new Error(`${name} is larger than 2 MB of text. Move data that is not part of the method out of the folder.`)
  return {
    dir,
    skillId,
    name,
    description: front.description ?? '',
    files,
    skipped,
    ...(source ? {source} : {}),
  }
}

/**
 * The skill folders a push path holds: the folder itself when it has a
 * SKILL.md, else every `skills/<name>/SKILL.md` of a Claude Code plugin (its
 * name and semver go with each skill), else every child folder with a SKILL.md.
 */
export const findSkillFolders = async (path: string): Promise<SkillFolder[]> => {
  if (!(await isDirectory(path))) throw new Error(`${path} is not a folder.`)
  if ((await readTextIfExists(join(path, 'SKILL.md'))) !== undefined) return [await readSkillFolder(path)]
  const manifest = await readTextIfExists(join(path, '.claude-plugin', 'plugin.json'))
  let source: SkillFolder['source']
  if (manifest !== undefined) {
    try {
      const plugin = JSON.parse(manifest) as {name?: unknown; version?: unknown}
      source = {
        ...(typeof plugin.name === 'string' ? {plugin: plugin.name} : {}),
        ...(typeof plugin.version === 'string' ? {pluginVersion: plugin.version} : {}),
      }
    } catch {
      source = {plugin: basename(path)}
    }
  }
  const parent = (await isDirectory(join(path, 'skills'))) ? join(path, 'skills') : path
  const folders: SkillFolder[] = []
  for (const entry of (await readdir(parent, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(parent, entry.name)
    if ((await readTextIfExists(join(dir, 'SKILL.md'))) !== undefined) folders.push(await readSkillFolder(dir, source))
  }
  if (folders.length === 0)
    throw new Error(`${path} has no SKILL.md, and no skills/<name>/SKILL.md inside it.`)
  return folders
}

// ── Checks before anything leaves the computer ───────────────────────

export type SkillFinding = {path: string; line: number; kind: string; text: string}

const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa|id_ed25519|credentials[^/]*\.json|.*\.p12)$/i

const LINE_CHECKS: {kind: string; pattern: RegExp}[] = [
  {kind: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
  {kind: 'API key or token', pattern: /\b(sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|ah_[A-Za-z0-9_-]{24,})\b/},
  {kind: 'password or key in the text', pattern: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i},
  {kind: 'signed or private link', pattern: /[?&](X-Amz-Signature|X-Goog-Signature|Signature|sig|token|key)=[^&\s'"]{16,}/i},
  // Home folders differ per computer; `<you>`, `$USER` and `%USERNAME%` placeholders are fine.
  {kind: 'path on one computer (move it to local.json)', pattern: /(\/Users\/[^/\s'"<$%{]+\/|\/home\/[^/\s'"<$%{]+\/|\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"<$%{]+)/},
]

/** Everything that blocks a push; each finding names the file and line. */
export const findSkillProblems = (files: Record<string, string>): SkillFinding[] => {
  const findings: SkillFinding[] = []
  for (const [path, text] of Object.entries(files)) {
    if (SECRET_FILE.test(path)) {
      findings.push({path, line: 0, kind: 'secret file', text: path})
      continue
    }
    text.split('\n').forEach((line, index) => {
      for (const check of LINE_CHECKS)
        if (check.pattern.test(line))
          findings.push({path, line: index + 1, kind: check.kind, text: line.trim().slice(0, 120)})
    })
  }
  return findings
}

// ── Local install and the lock file ──────────────────────────────────

/** sha256 of the files as sorted-key JSON; the same files always give the same sha. */
export const filesSha256 = (files: Record<string, string>): string =>
  createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))))
    .digest('hex')

export type TeamSkillLock = {
  version: 1
  skills: Record<
    string,
    {
      revision: number
      /** The server's sha of that revision. */
      remoteSha256: string
      /** sha of the files as written here, to notice the person's own edits. */
      localSha256?: string
      /** Set by `skills use <id>@<n>`: pull leaves this revision in place. */
      pinned?: boolean
    }
  >
}

export const teamSkillsDir = (home: string) => join(home, '.agents', 'skills')

export const readLock = async (home: string): Promise<TeamSkillLock> => {
  const text = await readTextIfExists(join(teamSkillsDir(home), LOCK))
  if (text === undefined) return {version: 1, skills: {}}
  try {
    const parsed = JSON.parse(text) as TeamSkillLock
    return parsed?.version === 1 && parsed.skills && typeof parsed.skills === 'object' ? parsed : {version: 1, skills: {}}
  } catch {
    return {version: 1, skills: {}}
  }
}

export const writeLock = async (home: string, lock: TeamSkillLock) => {
  const dir = teamSkillsDir(home)
  await mkdir(dir, {recursive: true})
  const temporary = join(dir, `${LOCK}.${pid}`)
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`)
  await rename(temporary, join(dir, LOCK))
}

const isTeamCopy = async (dir: string) => (await readTextIfExists(join(dir, MARKER))) !== undefined

/** The sha the copy had when pull wrote it, kept in its marker so a lost lock file never hides an edit. */
const markerLocalSha = async (dir: string): Promise<string | undefined> => {
  try {
    const marker = JSON.parse((await readTextIfExists(join(dir, MARKER))) ?? '{}') as {localSha256?: unknown}
    return typeof marker.localSha256 === 'string' ? marker.localSha256 : undefined
  } catch {
    return undefined
  }
}

/** sha of the folder as it is now, read the way a push would read it. */
const currentSha = async (dir: string) => filesSha256((await readSkillFolder(dir)).files)

/** Writes one revision beside the old copy and swaps it in; `local.json` stays. */
const writeTeamCopy = async (dir: string, pkg: SkillPackage) => {
  const staging = `${dir}.next-${pid}`
  const previous = `${dir}.prev-${pid}`
  await rm(staging, {recursive: true, force: true})
  for (const [path, text] of Object.entries(pkg.files)) {
    if (path.split('/').some(part => part === '..' || part === '' || part.startsWith('.')) || path === LOCAL_SETTINGS)
      throw new Error(`${pkg.skillId} rev ${pkg.revision} has a file path this CLI will not write: ${path}`)
    const target = join(staging, ...path.split('/'))
    await mkdir(join(target, '..'), {recursive: true})
    await writeFile(target, text)
  }
  await mkdir(staging, {recursive: true})
  const settings = await readTextIfExists(join(dir, LOCAL_SETTINGS))
  if (settings !== undefined) await writeFile(join(staging, LOCAL_SETTINGS), settings)
  await writeFile(
    join(staging, MARKER),
    // The files are written exactly as received, so their local sha is known before reading them back.
    `${JSON.stringify({skillId: pkg.skillId, revision: pkg.revision, filesSha256: pkg.filesSha256, localSha256: filesSha256(pkg.files)}, null, 2)}\n`,
  )
  const hadCopy = await isDirectory(dir)
  if (hadCopy) await rename(dir, previous)
  try {
    await rename(staging, dir)
  } catch (error) {
    if (hadCopy) await rename(previous, dir).catch(() => undefined)
    await rm(staging, {recursive: true, force: true})
    throw error
  }
  if (hadCopy) await rm(previous, {recursive: true, force: true})
}

const linkAgents = async (home: string, agents: AgentId[], skillId: string, dryRun: boolean) => {
  const links: {agent: AgentId; status: LinkStatus}[] = []
  for (const agent of agents) {
    const {status} = await linkSkill(join(home, agentSpec(agent).skillDir), join(teamSkillsDir(home), skillId), dryRun, skillId)
    links.push({agent, status})
  }
  return links
}

// ── Commands ─────────────────────────────────────────────────────────

/** The part of the SDK these commands use, so tests pass a fake. */
export type TeamSkillsApi = {
  pushSkillPackage(body: SkillPackagePushInput): Promise<SkillPackagePushed>
  listSkillPackages(): Promise<{items: SkillPackageSummary[]}>
  getSkillPackage(skillId: string, options?: {revision?: number}): Promise<SkillPackage>
}

export type PushPlan = {
  skills: {
    skillId: string
    name: string
    files: string[]
    skipped: SkillFolder['skipped']
    baseRevision: number | null
    source?: SkillFolder['source']
  }[]
  problems: SkillFinding[]
}

/** What a push would send, and everything that blocks it. Sends nothing. */
export const planPush = async (path: string, home: string, idOverride?: string): Promise<{plan: PushPlan; folders: SkillFolder[]}> => {
  const folders = await findSkillFolders(path)
  if (idOverride !== undefined) {
    if (folders.length !== 1) throw new Error('--id works only when pushing a single skill folder.')
    const id = slugSkillId(idOverride)
    if (!id) throw new Error('--id needs letters or digits.')
    folders[0] = {...folders[0], skillId: id}
  }
  const reserved = folders.find(folder => RESERVED_IDS.has(folder.skillId))
  if (reserved) throw new Error(`"${reserved.skillId}" is the AssetHub CLI's own guide. Give the skill another name (or pass --id).`)
  const lock = await readLock(home)
  const problems = folders.flatMap(folder =>
    findSkillProblems(folder.files).map(finding => ({...finding, path: folders.length > 1 ? `${folder.skillId}/${finding.path}` : finding.path})),
  )
  return {
    folders,
    plan: {
      skills: folders.map(folder => ({
        skillId: folder.skillId,
        name: folder.name,
        files: Object.keys(folder.files),
        skipped: folder.skipped,
        baseRevision: lock.skills[folder.skillId]?.revision ?? null,
        ...(folder.source ? {source: folder.source} : {}),
      })),
      problems,
    },
  }
}

export type PushResult = {skillId: string; revision: number; created: boolean; previousRevision: number | null}

/**
 * Saves each planned skill. The caller has already shown the plan and had the
 * person agree. `onTop` saves on top of a newer team revision instead of
 * stopping, for when the person chose that after the 409.
 */
export const pushSkills = async (
  api: TeamSkillsApi,
  home: string,
  folders: SkillFolder[],
  options: {note?: string; onTop?: boolean} = {},
): Promise<PushResult[]> => {
  const lock = await readLock(home)
  const results: PushResult[] = []
  // Check every skill against the team's latest before saving any, so a
  // plugin push never stops halfway with only some of its skills saved.
  const latest = new Map((await api.listSkillPackages()).items.map(item => [item.skillId, item]))
  if (!options.onTop) {
    const stale = folders
      .map(folder => latest.get(folder.skillId))
      .find((item, index) => {
        const folder = folders[index]
        return item && item.revision > (lock.skills[folder.skillId]?.revision ?? 0) && item.filesSha256 !== filesSha256(folder.files)
      })
    if (stale)
      throw Object.assign(new Error(`${stale.skillId} has a newer team revision`), {code: 'SKILL_PACKAGE_STALE', details: {latest: stale}})
  }
  try {
  for (const folder of folders) {
    const known = lock.skills[folder.skillId]
    const baseRevision: number | null = options.onTop ? (latest.get(folder.skillId)?.revision ?? null) : (known?.revision ?? null)
    const saved = await api.pushSkillPackage({
      skillId: folder.skillId,
      name: folder.name,
      description: folder.description,
      files: folder.files,
      ...(options.note ? {note: options.note} : {}),
      baseRevision,
      ...(folder.source ? {source: folder.source} : {}),
    })
    results.push({skillId: saved.skillId, revision: saved.revision, created: saved.created, previousRevision: known?.revision ?? null})
    // Pushing the installed copy makes it the team's revision, so a later pull
    // does not mistake the person's own change for a local edit.
    const installed = join(teamSkillsDir(home), folder.skillId)
    const localSha256 = (await isTeamCopy(installed)) ? await currentSha(installed) : undefined
    lock.skills[folder.skillId] = {
      revision: saved.revision,
      remoteSha256: saved.filesSha256,
      ...(localSha256 ? {localSha256} : {}),
      ...(known?.pinned ? {pinned: true} : {}),
    }
  }
  } finally {
    // Whatever was saved before an error is recorded, so the next push starts from it.
    await writeLock(home, lock)
  }
  return results
}

export type PullStatus =
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'pinned'
  /** The person changed their copy; the team's newer revision waits. */
  | 'kept-local'
  /** A folder of the same name that pull did not write. */
  | 'kept-existing'

export type PullItem = {
  skillId: string
  status: PullStatus
  revision: number
  previousRevision: number | null
  author: string | null
  note: string | null
  links: {agent: AgentId; status: LinkStatus}[]
}

/** Brings this computer's team skills to the latest revisions (or their pins) and links them into each agent. */
export const pullSkills = async (
  api: TeamSkillsApi,
  home: string,
  agents: AgentId[],
  options: {dryRun?: boolean; replaceLocal?: string[]} = {},
): Promise<PullItem[]> => {
  const dryRun = options.dryRun ?? false
  const replace = new Set(options.replaceLocal ?? [])
  const lock = await readLock(home)
  const items: PullItem[] = []
  for (const summary of (await api.listSkillPackages()).items) {
    if (RESERVED_IDS.has(summary.skillId) || !slugSkillId(summary.skillId) || slugSkillId(summary.skillId) !== summary.skillId) continue
    const dir = join(teamSkillsDir(home), summary.skillId)
    const known = lock.skills[summary.skillId]
    const base = {
      skillId: summary.skillId,
      revision: summary.revision,
      previousRevision: known?.revision ?? null,
      author: summary.author,
      note: summary.note,
    }
    const exists = await isDirectory(dir)
    if (exists && !(await isTeamCopy(dir))) {
      items.push({...base, status: 'kept-existing', links: []})
      continue
    }
    // Without a recorded sha (lost lock, old marker) the copy counts as edited: keeping it is the safe side.
    const expectedSha = known?.localSha256 ?? (exists ? await markerLocalSha(dir) : undefined)
    const edited = exists && (expectedSha === undefined || (await currentSha(dir)) !== expectedSha)
    if (known?.pinned && !edited) {
      // A pinned copy that was deleted comes back at its pinned revision.
      if (!exists && !dryRun) {
        const pkg = await api.getSkillPackage(summary.skillId, {revision: known.revision})
        await writeTeamCopy(dir, pkg)
        lock.skills[summary.skillId] = {...known, localSha256: await currentSha(dir)}
      }
      items.push({...base, revision: known.revision, status: 'pinned', links: await linkAgents(home, agents, summary.skillId, dryRun)})
      continue
    }
    if (exists && known?.revision === summary.revision && known.remoteSha256 === summary.filesSha256 && !edited) {
      items.push({...base, status: 'unchanged', links: await linkAgents(home, agents, summary.skillId, dryRun)})
      continue
    }
    if (edited && !replace.has(summary.skillId)) {
      items.push({...base, status: 'kept-local', links: await linkAgents(home, agents, summary.skillId, dryRun)})
      continue
    }
    if (!dryRun) {
      const pkg = await api.getSkillPackage(summary.skillId, {revision: summary.revision})
      await writeTeamCopy(dir, pkg)
      lock.skills[summary.skillId] = {revision: pkg.revision, remoteSha256: pkg.filesSha256, localSha256: await currentSha(dir)}
    }
    items.push({...base, status: exists ? 'updated' : 'installed', links: await linkAgents(home, agents, summary.skillId, dryRun)})
  }
  if (!dryRun) await writeLock(home, lock)
  return items
}

/** `skills use <id>@<n>` pins one revision; `<id>@latest` drops the pin and takes the newest. */
export const useSkillRevision = async (
  api: TeamSkillsApi,
  home: string,
  agents: AgentId[],
  skillId: string,
  revision: number | 'latest',
): Promise<PullItem> => {
  const dir = join(teamSkillsDir(home), skillId)
  if ((await isDirectory(dir)) && !(await isTeamCopy(dir)))
    throw new Error(`${dir} is a folder this CLI did not write; move it away first.`)
  const lock = await readLock(home)
  const known = lock.skills[skillId]
  const pkg = await api.getSkillPackage(skillId, revision === 'latest' ? {} : {revision})
  await writeTeamCopy(dir, pkg)
  lock.skills[skillId] = {
    revision: pkg.revision,
    remoteSha256: pkg.filesSha256,
    localSha256: await currentSha(dir),
    ...(revision === 'latest' ? {} : {pinned: true}),
  }
  await writeLock(home, lock)
  return {
    skillId,
    status: known ? 'updated' : 'installed',
    revision: pkg.revision,
    previousRevision: known?.revision ?? null,
    author: pkg.author,
    note: pkg.note,
    links: await linkAgents(home, agents, skillId, false),
  }
}

/** One plain line per change, for the start of a session. Unchanged skills say nothing. */
export const describePull = (items: PullItem[]): string[] =>
  items.flatMap(item => {
    const by = [item.author, item.note].filter(Boolean).join(': ')
    const tail = by ? ` (${by})` : ''
    if (item.status === 'installed') return [`New team skill: ${item.skillId} rev ${item.revision}${tail}`]
    if (item.status === 'updated') return [`${item.skillId} rev ${item.previousRevision ?? '?'} -> rev ${item.revision}${tail}`]
    if (item.status === 'kept-local')
      return [
        `${item.skillId}: you changed your copy, so it was kept. The team has rev ${item.revision}${tail}. Keep yours and share it: assethub skills push ~/.agents/skills/${item.skillId}. Take the team's: assethub skills pull --replace-local ${item.skillId}`,
      ]
    if (item.status === 'kept-existing')
      return [`${item.skillId}: a folder of yours has the same name, so the team skill was not installed.`]
    return []
  })
