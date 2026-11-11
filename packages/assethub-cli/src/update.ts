// `assethub update`: move a global install to the latest published version.
// It only runs the package manager that installed the CLI; the saved login in
// ~/.assethub/config.json lives outside the package, so it survives untouched.
// The agent skill copies setup installed are then overwritten with the new
// version's skill, so agents never read rules for a CLI they no longer run.

import {execFile, spawn} from 'node:child_process'
import {readFile, readlink, realpath, rename, stat, symlink, unlink} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {argv, cwd, env, platform, stderr, stdin} from 'node:process'
import {createInterface} from 'node:readline/promises'
import {promisify} from 'node:util'
import {cliVersion} from './setup.js'

const execFileAsync = promisify(execFile)

export const PACKAGE_NAME = '@assethub/cli'

export type Installer = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta'
export type Install =
  | {kind: 'global'; installer: Installer}
  /** The official installer: <root>/releases/npm-<version>/node_modules/@assethub/cli, linked from ~/.local/bin/assethub. */
  | {kind: 'managed'; root: string}
  | {kind: 'npx'}
  | {kind: 'project'}
  | {kind: 'source'}

export type UpdateOptions = {check?: boolean; dryRun?: boolean; yes?: boolean}

export type UpdateDeps = {
  currentVersion: () => Promise<string>
  latestVersion: () => Promise<string>
  /** Real path of the running entry file, symlinks resolved. */
  binPath: () => Promise<string>
  npmGlobalRoot: () => Promise<string | undefined>
  run: (command: string, args: string[]) => Promise<{code: number}>
  /** Managed installs only: points the `assethub` symlink at the freshly installed release. */
  repointManaged?: (root: string, version: string) => Promise<void>
  /** Runs the freshly installed binary: its version and whether the saved login still works. */
  verify: () => Promise<{version: string; auth: 'pass' | 'fail' | 'not_configured'}>
  /** Has the freshly installed binary rewrite each agent skill copy setup installed. */
  refreshSkills: () => Promise<SkillRefresh[]>
  interactive: boolean
  confirm: (question: string) => Promise<boolean>
  say: (message: string) => void
}

export type SkillRefresh = {path: string; change: 'updated' | 'unchanged'; version?: string}

export type UpdateReport =
  | {status: 'up_to_date'; from: string; latest: string}
  | {status: 'update_available'; from: string; latest: string}
  | {status: 'dry_run'; from: string; latest: string; installer: Installer | 'managed'; command: string}
  | {
      status: 'updated'
      from: string
      to: string
      installer: Installer | 'managed'
      auth: 'pass' | 'fail' | 'not_configured'
      skills: SkillRefresh[]
    }

const parseVersion = (version: string) => {
  const [core, prerelease] = version.split('-', 2)
  return {core: core.split('.').map(Number), prerelease}
}

/** Semver precedence for plain `x.y.z[-pre]` versions (build metadata unused). */
export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === undefined) return 1
  if (right.prerelease === undefined) return -1
  return left.prerelease.localeCompare(right.prerelease, 'en', {numeric: true})
}

const managedLayout = /^(.*\/assethub-cli)\/releases\/npm-[^/]+\/node_modules\/@assethub\/cli\//

const packageSegment = `/node_modules/${PACKAGE_NAME}/`

export const detectInstall = (binPath: string, npmGlobalRoot?: string): Install => {
  const path = binPath.replaceAll('\\', '/')
  if (!path.includes(packageSegment)) return {kind: 'source'}
  if (path.includes('/_npx/')) return {kind: 'npx'}
  const managed = managedLayout.exec(path)
  if (managed) return {kind: 'managed', root: managed[1]}
  if (path.includes('/.volta/')) return {kind: 'global', installer: 'volta'}
  if (path.includes('/.bun/install/global/')) return {kind: 'global', installer: 'bun'}
  if (path.includes('/pnpm/global/')) return {kind: 'global', installer: 'pnpm'}
  if (path.includes('/yarn/global/')) return {kind: 'global', installer: 'yarn'}
  const root = npmGlobalRoot?.replaceAll('\\', '/').replace(/\/+$/, '')
  if (root && path.startsWith(`${root}/`)) return {kind: 'global', installer: 'npm'}
  return {kind: 'project'}
}

export const installCommand = (installer: Installer, version: string): [string, string[]] => {
  const spec = `${PACKAGE_NAME}@${version}`
  switch (installer) {
    case 'npm':
      return ['npm', ['install', '--global', spec]]
    case 'pnpm':
      return ['pnpm', ['add', '--global', spec]]
    case 'yarn':
      return ['yarn', ['global', 'add', spec]]
    case 'bun':
      return ['bun', ['add', '--global', spec]]
    case 'volta':
      return ['volta', ['install', spec]]
  }
}

/** What the official installer does: a fresh releases/npm-<version> prefix (then the symlink is repointed). */
export const managedInstallCommand = (root: string, version: string): [string, string[]] => [
  'npm',
  ['install', '--prefix', `${root}/releases/npm-${version}`, '--no-audit', '--no-fund', `${PACKAGE_NAME}@${version}`],
]

/**
 * Points the first candidate symlink that currently targets this managed root
 * at the new release, through a temp link + rename so the swap is atomic.
 */
export const repointManagedLink = async (root: string, version: string, candidates: string[]): Promise<void> => {
  const releases = `${root.replaceAll('\\', '/')}/releases/`
  const target = join(root, 'releases', `npm-${version}`, 'node_modules', '@assethub', 'cli', 'dist', 'index.js')
  await stat(target) // never repoint at something that is not there
  for (const link of candidates) {
    const current = await readlink(link).then(
      value => value.replaceAll('\\', '/'),
      () => undefined,
    )
    if (current === undefined || !current.startsWith(releases)) continue
    const temp = `${link}.tmp-${process.pid}`
    await unlink(temp).catch(() => undefined)
    await symlink(target, temp)
    await rename(temp, link)
    return
  }
  throw new Error(`No symlink pointing into ${root}/releases was found (looked at ${candidates.join(', ') || 'nothing'}); set ASSETHUB_BIN_LINK to the assethub symlink.`)
}

const refusal = (install: Exclude<Install, {kind: 'global' | 'managed'}>, latest: string): string => {
  switch (install.kind) {
    case 'npx':
      return `This CLI is running from the npx cache; run \`npx ${PACKAGE_NAME}@latest\` to use ${latest}.`
    case 'project':
      return `This CLI is installed as a project dependency; update ${PACKAGE_NAME} to ${latest} in that project's package.json.`
    case 'source':
      return 'This CLI is running from a source checkout; pull and rebuild it instead.'
  }
}

export const runUpdate = async (options: UpdateOptions, deps: UpdateDeps): Promise<UpdateReport> => {
  const [from, latest] = await Promise.all([deps.currentVersion(), deps.latestVersion()])
  if (compareVersions(latest, from) <= 0) return {status: 'up_to_date', from, latest}
  if (options.check) return {status: 'update_available', from, latest}

  const install = detectInstall(await deps.binPath(), await deps.npmGlobalRoot())
  if (install.kind !== 'global' && install.kind !== 'managed') throw new Error(refusal(install, latest))

  const installer = install.kind === 'managed' ? 'managed' : install.installer
  const [command, args] = install.kind === 'managed' ? managedInstallCommand(install.root, latest) : installCommand(install.installer, latest)
  const shown = [command, ...args].join(' ') + (install.kind === 'managed' ? ' && repoint the assethub symlink' : '')
  if (options.dryRun) return {status: 'dry_run', from, latest, installer, command: shown}

  if (deps.interactive && !options.yes && !(await deps.confirm(`Update ${PACKAGE_NAME} ${from} -> ${latest} with \`${shown}\`?`)))
    throw new Error('Update cancelled; nothing was changed.')

  deps.say(`Running ${shown}`)
  const {code} = await deps.run(command, args)
  if (code !== 0) throw new Error(`\`${shown}\` exited with code ${code}; ${PACKAGE_NAME} is still ${from}.`)
  if (install.kind === 'managed') {
    if (!deps.repointManaged) throw new Error('This environment cannot repoint the managed assethub symlink.')
    await deps.repointManaged(install.root, latest)
  }

  // Before verifying: the verifying doctor would quietly sync the home copy itself.
  let skills: SkillRefresh[] = []
  let skillError: string | undefined
  try {
    skills = await deps.refreshSkills()
  } catch (error) {
    skillError = (error as Error).message
  }

  const installed = await deps.verify()
  if (installed.version !== latest)
    throw new Error(
      `\`${shown}\` succeeded but \`assethub --version\` still reports ${installed.version}; another ${PACKAGE_NAME} earlier on PATH may be shadowing this install.`,
    )
  if (installed.auth === 'fail')
    deps.say('Updated, but the saved login did not pass its check. Run `assethub doctor` to see why; the update did not change your login.')

  if (skillError)
    deps.say(`Updated, but the agent skill could not be refreshed (${skillError}). Run \`assethub setup --only skills\` to refresh it.`)
  for (const skill of skills)
    if (skill.change === 'updated') deps.say(`Agent skill updated: ${skill.path} (${skill.version ?? installed.version})`)
  return {status: 'updated', from, to: installed.version, installer, auth: installed.auth, skills}
}

// Windows installs expose `npm.cmd` / `assethub.cmd`, which need a shell.
const shell = platform === 'win32'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const validVersion = (version: unknown, source: string): string => {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version))
    throw new Error(`${source} returned an unexpected version: ${JSON.stringify(version)}`)
  return version
}

/**
 * Prefers the package manager, which applies the user's .npmrc registry,
 * auth token and proxy exactly as the install will; falls back to a direct
 * registry read only when that lookup cannot run (e.g. no npm on PATH).
 */
export const resolveLatestVersion = async (
  viaPackageManager: () => Promise<string>,
  viaRegistry: () => Promise<string>,
): Promise<string> => {
  try {
    return await viaPackageManager()
  } catch (npmError) {
    try {
      return await viaRegistry()
    } catch (registryError) {
      throw new Error(
        `Could not read the latest ${PACKAGE_NAME} version. npm view: ${(npmError as Error).message}. Registry: ${(registryError as Error).message}`,
      )
    }
  }
}

const latestViaNpm = async (): Promise<string> => {
  const {stdout} = await execFileAsync('npm', ['view', `${PACKAGE_NAME}@latest`, 'version', '--json'], {
    shell,
    timeout: 30_000,
  })
  return validVersion(JSON.parse(stdout), 'npm view')
}

const latestViaRegistry = async (): Promise<string> => {
  const registry = (env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '')
  const url = `${registry}/${PACKAGE_NAME.replace('/', '%2f')}/latest`
  const response = await fetch(url, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(15_000)})
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return validVersion(((await response.json()) as {version?: unknown}).version, url)
}

// Mirrors agentSetup.ts: setup marks each skill copy it wrote with this file.
const SKILL_MARKER = join('.agents', 'skills', 'assethub', '.assethub-cli-version')

const readMarker = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').then(
    text => text.trim(),
    () => undefined,
  )

type SetupSkillsReport = {steps?: {name?: string; path?: string; detail?: string}[]}

type DoctorReport = {ok?: boolean; version?: string; checks?: {name?: string; code?: string}[]}

/** Wires runUpdate to the real registry, package manager and freshly installed binary. */
/**
 * `forwardFlags` reach the verifying `assethub doctor` on its command line;
 * `forwardEnv` carries what must not appear there, such as an explicit API key.
 */
export const createNodeUpdateDeps = (forwardFlags: string[], forwardEnv: Record<string, string> = {}): UpdateDeps => ({
  currentVersion: cliVersion,
  latestVersion: () => resolveLatestVersion(latestViaNpm, latestViaRegistry),
  binPath: () => realpath(argv[1]),
  repointManaged: (root, version) =>
    repointManagedLink(
      root,
      version,
      [env.ASSETHUB_BIN_LINK, join(homedir(), '.local', 'bin', 'assethub')].filter((value): value is string => Boolean(value)),
    ),
  npmGlobalRoot: async () => {
    try {
      return (await execFileAsync('npm', ['root', '--global'], {shell})).stdout.trim() || undefined
    } catch {
      return undefined
    }
  },
  // The installer's output goes to stderr so stdout stays one JSON report.
  run: (command, args) =>
    new Promise(resolve => {
      const child = spawn(command, args, {stdio: ['inherit', 2, 'inherit'], shell})
      child.on('error', () => resolve({code: 127}))
      child.on('close', code => resolve({code: code ?? 1}))
    }),
  // Run whatever `assethub` the user's PATH now resolves, so a shadowing older
  // install is caught. Doctor reads the same saved profile the old version used.
  verify: async () => {
    let raw: string
    try {
      raw = (
        await execFileAsync('assethub', ['doctor', ...forwardFlags], {
          shell,
          timeout: 60_000,
          env: {...env, ...forwardEnv},
        })
      ).stdout
    } catch (error) {
      // doctor exits 2 when a check fails but still prints its report.
      raw = (error as {stdout?: string}).stdout ?? ''
      if (!raw) throw new Error(`Could not run the updated \`assethub doctor\`: ${(error as Error).message}`)
    }
    const report = JSON.parse(raw) as DoctorReport
    const unconfigured = report.checks?.some(check => check.code === 'AUTH_CONFIGURATION')
    return {
      version: report.version ?? 'unknown',
      auth: unconfigured ? 'not_configured' : report.ok ? 'pass' : 'fail',
    }
  },
  // The new binary rewrites the copies: the running (old) process may still
  // point at the previous package directory. Only copies setup installed are
  // touched: the home one, and this folder's from `setup --project`.
  refreshSkills: async () => {
    const home = env.ASSETHUB_CLI_HOME || homedir()
    const roots = [{dir: home, project: false}, ...(cwd() === home ? [] : [{dir: cwd(), project: true}])]
    const refreshed: SkillRefresh[] = []
    for (const root of roots) {
      const marker = join(root.dir, SKILL_MARKER)
      // Read before the new binary runs: any of its commands syncs the home copy first.
      const before = await readMarker(marker)
      if (before === undefined) continue
      const args = ['setup', '--only', 'skills', '--json', ...(root.project ? ['--project'] : []), ...forwardFlags]
      let raw: string
      try {
        raw = (await execFileAsync('assethub', args, {shell, timeout: 60_000, cwd: root.dir})).stdout
      } catch (error) {
        raw = (error as {stdout?: string}).stdout ?? ''
        if (!raw) throw new Error(`\`assethub ${args.join(' ')}\` failed: ${(error as Error).message}`)
      }
      const report = JSON.parse(raw) as SetupSkillsReport
      const step = report.steps?.find(candidate => candidate.name === 'skills')
      if (!step?.path) throw new Error(`\`assethub ${args.join(' ')}\` did not report the skill: ${step?.detail ?? 'no skills step'}`)
      const after = await readMarker(marker)
      refreshed.push({path: step.path, change: after !== before ? 'updated' : 'unchanged', ...(after ? {version: after} : {})})
    }
    return refreshed
  },
  interactive: Boolean(stdin.isTTY && stderr.isTTY),
  confirm: async question => {
    const rl = createInterface({input: stdin, output: stderr})
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
    } finally {
      rl.close()
    }
  },
  say: message => {
    stderr.write(`${message}\n`)
  },
})
