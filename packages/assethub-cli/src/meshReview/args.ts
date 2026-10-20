// packages/assethub-cli/src/meshReview/args.ts
import {basename, dirname, resolve} from 'node:path'

type FlagValue = string | boolean | string[] | undefined
type FlagsLike = Record<string, FlagValue>

export type MeshReviewRunArgs = {
  mode: 'run'
  inputs: string[]
  project: string | undefined
  assetKey: string | undefined
  out: string | undefined
  baseline: string | undefined
  config: string | undefined
  skipHp: boolean
  noRender: boolean
  noSync: boolean
  dryRun: boolean
  engineDir: string | undefined
  /** Approved concept art, comma separated front[,side[,back]]; undefined = the engine discovers it. */
  reference: string | undefined
  /** Why no concept comparison is made; stored in the findings. */
  noConcept: string | undefined
}
export type MeshReviewSyncArgs = {
  mode: 'sync'
  findingsPath: string
  project: string | undefined
  assetKey: string | undefined
  dryRun: boolean
}
export type MeshReviewProjectsArgs = {mode: 'projects'; json: boolean}
export type MeshReviewProjectCreateArgs = {mode: 'project-create'; name: string; json: boolean}
export type MeshReviewArgs = MeshReviewRunArgs | MeshReviewSyncArgs | MeshReviewProjectsArgs | MeshReviewProjectCreateArgs

const ASSET_KEY = /^[A-Za-z0-9._-]{1,80}$/

const str = (flags: FlagsLike, name: string): string | undefined => {
  const value = flags[name]
  if (Array.isArray(value)) return value[value.length - 1]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
const bool = (flags: FlagsLike, name: string): boolean => flags[name] === true || flags[name] === 'true'

const MAX_REFERENCES = 3

const parseConceptFlags = (flags: FlagsLike): {reference: string | undefined; noConcept: string | undefined} => {
  const rawReference = flags.reference
  const rawNoConcept = flags['no-concept']
  let reference: string | undefined
  if (rawReference !== undefined) {
    const parts = (Array.isArray(rawReference) ? rawReference : typeof rawReference === 'string' ? [rawReference] : [])
      .flatMap(value => value.split(','))
      .map(value => value.trim())
      .filter(value => value !== '')
    if (parts.length === 0) {
      throw new Error('--reference needs the approved concept art: <front.png>[,<side.png>[,<back.png>]].')
    }
    if (parts.length > MAX_REFERENCES) {
      throw new Error(`--reference accepts at most ${MAX_REFERENCES} images (front,side,back); got ${parts.length}.`)
    }
    reference = parts.join(',')
  }
  let noConcept: string | undefined
  if (rawNoConcept !== undefined) {
    const reason = str(flags, 'no-concept')
    if (reason == null) {
      throw new Error('--no-concept needs a reason, e.g. --no-concept "no approved concept art was delivered".')
    }
    noConcept = reason.trim()
  }
  if (reference != null && noConcept != null) {
    throw new Error('Pass either --reference <concept art> or --no-concept "<reason>", not both.')
  }
  return {reference, noConcept}
}

const sanitizeAssetKey = (raw: string): string => raw.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)

const resolveAsset = (flags: FlagsLike, fallbackPath: string): string => {
  const explicit = str(flags, 'asset')
  const key = explicit ?? sanitizeAssetKey(basename(fallbackPath.replace(/\/+$/, '')))
  if (!ASSET_KEY.test(key)) {
    throw new Error(`--asset must be 1-80 characters of letters, digits, ".", "_" or "-" (got "${key}").`)
  }
  return key
}

export const parseMeshReviewArgs = (
  subcommand: string | undefined,
  positionals: string[],
  flags: FlagsLike,
): MeshReviewArgs => {
  if (subcommand === 'projects' && positionals[2] === 'create') {
    const name = positionals.slice(3).join(' ').trim()
    if (name === '' || name.length > 120) {
      throw new Error('assethub mesh-review projects create needs <name> (1-120 characters).')
    }
    return {mode: 'project-create', name, json: bool(flags, 'json')}
  }
  if (subcommand === 'projects') return {mode: 'projects', json: bool(flags, 'json')}
  const project = str(flags, 'project')
  const dryRun = bool(flags, 'dry-run')
  if (subcommand === 'sync') {
    const findingsPath = positionals[2]
    if (findingsPath == null || findingsPath.trim() === '') {
      throw new Error('assethub mesh-review sync needs the path to a findings.json written by the engine.')
    }
    if (project == null && !dryRun) throw new Error('assethub mesh-review sync needs --project <name-or-id>.')
    // The folder holding findings.json names the asset, for bare and Windows paths too.
    const parent = dirname(resolve(findingsPath))
    return {mode: 'sync', findingsPath, project, assetKey: resolveAsset(flags, parent), dryRun}
  }
  if (subcommand !== 'run') {
    throw new Error('Unknown mesh-review command. Use "mesh-review run <folder>", "mesh-review sync <findings.json>" or "mesh-review projects".')
  }
  const inputs = positionals.slice(2).filter(value => value.trim() !== '')
  if (inputs.length === 0) {
    throw new Error('assethub mesh-review run needs the delivery folder (or files) to review.')
  }
  const noSync = bool(flags, 'no-sync')
  if (project == null && !noSync && !dryRun) {
    throw new Error('assethub mesh-review run needs --project <name-or-id> (or --no-sync to only run the engine).')
  }
  return {
    mode: 'run',
    inputs,
    project,
    assetKey: resolveAsset(flags, inputs[0] as string),
    out: str(flags, 'out'),
    baseline: str(flags, 'baseline'),
    config: str(flags, 'config'),
    skipHp: bool(flags, 'skip-hp'),
    noRender: bool(flags, 'no-render'),
    noSync,
    dryRun,
    engineDir: str(flags, 'engine-dir'),
    ...parseConceptFlags(flags),
  }
}
