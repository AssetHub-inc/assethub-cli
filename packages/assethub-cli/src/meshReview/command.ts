// packages/assethub-cli/src/meshReview/command.ts
import type {MeshReviewArgs} from './args.js'
import type {RunEngineOptions} from './runEngine.js'
import type {CreatedMeshReviewProject, MeshReviewProject} from './projects.js'
import type {SyncInput, SyncResult} from './syncMeshReview.js'

export type MeshReviewDeps = {
  auth: {baseUrl: string; apiKey: string; workspaceId?: string | undefined}
  runEngine: (options: RunEngineOptions) => Promise<{exitCode: number; findingsPath: string}>
  sync: (input: SyncInput) => Promise<SyncResult>
  findEngineCli: (engineDir: string | undefined) => Promise<string | null>
  log: (line: string) => void
  createProject?: (input: {baseUrl: string; apiKey: string; name: string; workspaceId?: string | undefined}) => Promise<CreatedMeshReviewProject>
  listProjects?: (input: {baseUrl: string; apiKey: string; workspaceId?: string | undefined}) => Promise<MeshReviewProject[]>
}

export type MeshReviewOutcome = {exitCode: number; result: Record<string, unknown>}

/** The Production Control page for a synced run, so agents can hand the reviewer a link. */
const reportUrl = (baseUrl: string, runId: string): string =>
  new URL(`/control/mesh-reviews/${encodeURIComponent(runId)}`, baseUrl).toString()

export const runMeshReviewCommand = async (
  args: MeshReviewArgs,
  deps: MeshReviewDeps,
): Promise<MeshReviewOutcome> => {
  const sync = async (findingsPath: string, project: string, assetKey: string): Promise<SyncResult> =>
    deps.sync({
      findingsPath,
      project,
      assetKey,
      baseUrl: deps.auth.baseUrl,
      apiKey: deps.auth.apiKey,
      workspaceId: deps.auth.workspaceId,
      onProgress: event => deps.log(`[mesh-review] ${event.kind}${'path' in event ? ` ${event.path}` : ''}`),
    })

  if (args.mode === 'project-create') {
    if (deps.createProject == null) throw new Error('mesh-review projects create is not available in this build.')
    const project = await deps.createProject({baseUrl: deps.auth.baseUrl, apiKey: deps.auth.apiKey, name: args.name, workspaceId: deps.auth.workspaceId})
    return {exitCode: 0, result: {project}}
  }

  if (args.mode === 'projects') {
    if (deps.listProjects == null) throw new Error('mesh-review projects is not available in this build.')
    const projects = await deps.listProjects({baseUrl: deps.auth.baseUrl, apiKey: deps.auth.apiKey, workspaceId: deps.auth.workspaceId})
    return {exitCode: 0, result: {projects}}
  }

  if (args.mode === 'sync') {
    if (args.dryRun) {
      return {exitCode: 0, result: {dryRun: true, findingsPath: args.findingsPath, project: args.project, assetKey: args.assetKey}}
    }
    const result = await sync(args.findingsPath, args.project as string, args.assetKey as string)
    return {
      exitCode: result.summary.error > 0 ? 1 : 0,
      result: {...result, reportUrl: reportUrl(deps.auth.baseUrl, result.runId), findingsPath: args.findingsPath},
    }
  }

  const cliPath = await deps.findEngineCli(args.engineDir)
  if (cliPath == null) {
    throw new Error(
      'Could not find tools/mesh-review/cli.py. Run this from a checkout of the AssetHub monorepo, or pass --engine-dir <path to tools/mesh-review> (or set MESH_REVIEW_ENGINE_DIR).',
    )
  }
  const engine = await deps.runEngine({
    cliPath,
    inputs: args.inputs,
    out: args.out,
    baseline: args.baseline,
    config: args.config,
    skipHp: args.skipHp,
    noRender: args.noRender,
    reference: args.reference,
    noConcept: args.noConcept,
  })
  // Engine exit: 0 no errors, 1 errors found (still a valid run, still synced), 2 CLI/Blender failure.
  if (engine.exitCode !== 0 && engine.exitCode !== 1) {
    return {
      exitCode: 2,
      result: {
        engineExitCode: engine.exitCode,
        synced: false,
        hint:
          'The engine failed. If its log says no concept reference was found, pass the approved concept art with --reference <front.png>[,<side.png>[,<back.png>]], or --no-concept "<reason>" when none exists.',
      },
    }
  }
  if (args.noSync || args.dryRun) {
    return {exitCode: engine.exitCode, result: {synced: false, findingsPath: engine.findingsPath}}
  }
  const result = await sync(engine.findingsPath, args.project as string, args.assetKey as string)
  return {
    exitCode: engine.exitCode,
    result: {...result, reportUrl: reportUrl(deps.auth.baseUrl, result.runId), findingsPath: engine.findingsPath, synced: true},
  }
}
