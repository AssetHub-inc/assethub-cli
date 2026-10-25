import type {MeshReviewSession} from './session.js'
// packages/assethub-cli/src/meshReview/command.ts
import type {MeshReviewArgs} from './args.js'
import type {RunEngineOptions} from './runEngine.js'
import type {CreatedMeshReviewProject, MeshReviewProject} from './projects.js'
import type {SyncInput, SyncResult} from './syncMeshReview.js'

export type MeshReviewDeps = {
  auth: {baseUrl: string; apiKey: string; workspaceId?: string | undefined}
  runEngine: (
    options: RunEngineOptions,
  ) => Promise<{exitCode: number; findingsPath: string}>
  sync: (input: SyncInput) => Promise<SyncResult>
  findEngineCli: (engineDir: string | undefined) => Promise<string | null>
  prepareSession?: (input: {
    args: Extract<MeshReviewArgs, {mode: 'run'}>
    auth: MeshReviewDeps['auth']
    cliPath: string
    signal?: AbortSignal
  }) => Promise<MeshReviewSession>
  signal?: AbortSignal
  log: (line: string) => void
  createProject?: (input: {
    baseUrl: string
    apiKey: string
    name: string
    workspaceId?: string | undefined
  }) => Promise<CreatedMeshReviewProject>
  listProjects?: (input: {
    baseUrl: string
    apiKey: string
    workspaceId?: string | undefined
  }) => Promise<MeshReviewProject[]>
}

export type MeshReviewOutcome = {
  exitCode: number
  result: Record<string, unknown>
}

/** The Production Control page for a synced run, so agents can hand the reviewer a link. */
const reportUrl = (baseUrl: string, runId: string): string =>
  new URL(
    `/control/mesh-reviews/${encodeURIComponent(runId)}`,
    baseUrl,
  ).toString()

export const runMeshReviewCommand = async (
  args: MeshReviewArgs,
  deps: MeshReviewDeps,
): Promise<MeshReviewOutcome> => {
  const sync = async (
    findingsPath: string,
    project: string,
    assetKey: string,
    clientRunKey?: string,
  ): Promise<SyncResult> =>
    deps.sync({
      findingsPath,
      ...(clientRunKey ? {clientRunKey} : {}),
      ...(deps.signal ? {signal: deps.signal} : {}),
      project,
      assetKey,
      baseUrl: deps.auth.baseUrl,
      apiKey: deps.auth.apiKey,
      workspaceId: deps.auth.workspaceId,
      onProgress: event =>
        deps.log(
          `[mesh-review] ${event.kind}${'path' in event ? ` ${event.path}` : ''}`,
        ),
    })

  if (args.mode === 'project-create') {
    if (deps.createProject == null)
      throw new Error(
        'mesh-review projects create is not available in this build.',
      )
    const project = await deps.createProject({
      baseUrl: deps.auth.baseUrl,
      apiKey: deps.auth.apiKey,
      name: args.name,
      workspaceId: deps.auth.workspaceId,
    })
    return {exitCode: 0, result: {project}}
  }

  if (args.mode === 'projects') {
    if (deps.listProjects == null)
      throw new Error('mesh-review projects is not available in this build.')
    const projects = await deps.listProjects({
      baseUrl: deps.auth.baseUrl,
      apiKey: deps.auth.apiKey,
      workspaceId: deps.auth.workspaceId,
    })
    return {exitCode: 0, result: {projects}}
  }

  if (args.mode === 'sync') {
    if (args.dryRun) {
      return {
        exitCode: 0,
        result: {
          dryRun: true,
          findingsPath: args.findingsPath,
          project: args.project,
          assetKey: args.assetKey,
        },
      }
    }
    const result = await sync(
      args.findingsPath,
      args.project as string,
      args.assetKey as string,
    )
    return {
      exitCode: result.summary.error > 0 ? 1 : 0,
      result: {
        ...result,
        reportUrl: reportUrl(deps.auth.baseUrl, result.runId),
        findingsPath: args.findingsPath,
      },
    }
  }

  const cliPath = await deps.findEngineCli(args.engineDir)
  if (cliPath == null) {
    throw new Error(
      'Could not find tools/mesh-review/cli.py. Run this from a checkout of the AssetHub monorepo, or pass --engine-dir <path to tools/mesh-review> (or set MESH_REVIEW_ENGINE_DIR).',
    )
  }
  const session =
    !args.noSync && !args.dryRun && deps.prepareSession
      ? await deps.prepareSession({args, auth: deps.auth, cliPath, ...(deps.signal ? {signal: deps.signal} : {})})
      : null
  try {
    if (session) {
      deps.log(`[mesh-review] ${reportUrl(deps.auth.baseUrl, session.runId)}`)
      deps.log(`[mesh-review] resume output: ${session.out}`)
      if (
        ['passed', 'needs_fix', 'failed'].includes(session.status) &&
        (!session.findingsPath || session.status === 'failed')
      )
        return {
          exitCode:
            session.status === 'passed'
              ? 0
              : session.status === 'failed'
                ? 2
                : 1,
          result: {
            runId: session.runId,
            status: session.status,
            unchanged: true,
            reportUrl: reportUrl(deps.auth.baseUrl, session.runId),
          },
        }
    }
    if (session?.findingsPath) {
      const result = await sync(
        session.findingsPath,
        args.project as string,
        args.assetKey as string,
        session.clientRunKey,
      )
      return {
        exitCode: result.status === 'needs_fix' ? 1 : 0,
        result: {
          ...result,
          reportUrl: reportUrl(deps.auth.baseUrl, result.runId),
          findingsPath: session.findingsPath,
          synced: true,
          resumed: true,
        },
      }
    }
    let engine: {exitCode: number; findingsPath: string}
    try {
      engine = deps.signal?.aborted
        ? {exitCode: 130, findingsPath: ''}
        : await deps.runEngine({
            cliPath,
            ...(deps.signal ? {signal: deps.signal} : {}),
            inputs: args.inputs,
            ...(args.phase ? {phase: args.phase} : {}),
            out: session?.out ?? args.out,
            baseline: args.baseline,
            config: args.config,
            skipHp: args.skipHp,
            noRender: args.noRender,
            reference: args.reference,
            noConcept: args.noConcept,
          })
    } catch (error) {
      if (session)
        await session
          .fail()
          .catch(() =>
            deps.log(
              '[mesh-review] Failure could not be recorded; check the same report before retrying.',
            ),
          )
      throw error
    }
    // Engine exit: 0 no errors, 1 errors found (still a valid run, still synced), 2 CLI/Blender failure.
    if (engine.exitCode !== 0 && engine.exitCode !== 1) {
      let failureRecorded = false
      if (session) {
        try {
          await session.fail()
          failureRecorded = true
        } catch {
          deps.log(
            '[mesh-review] Could not record the failure. Check the same report before retrying.',
          )
        }
      }
      return {
        exitCode: engine.exitCode === 130 ? 130 : 2,
        result: {
          ...(session
            ? {
                runId: session.runId,
                status: failureRecorded ? 'failed' : 'unknown',
                reportUrl: reportUrl(deps.auth.baseUrl, session.runId),
              }
            : {}),
          engineExitCode: engine.exitCode,
          synced: false,
          hint:
            engine.exitCode === 130
              ? 'Local analysis was interrupted. Check this report; use a new output directory to start another analysis.'
              : 'The engine failed. If its log says no concept reference was found, pass the approved concept art with --reference <front.png>[,<side.png>[,<back.png>]], or --no-concept "<reason>" when none exists.',
        },
      }
    }
    if (args.noSync || args.dryRun) {
      return {
        exitCode: engine.exitCode,
        result: {synced: false, findingsPath: engine.findingsPath},
      }
    }
    await session?.markEngineCompleted?.()
    const result = await sync(
      engine.findingsPath,
      args.project as string,
      args.assetKey as string,
      session?.clientRunKey,
    )
    return {
      exitCode: engine.exitCode,
      result: {
        ...result,
        reportUrl: reportUrl(deps.auth.baseUrl, result.runId),
        findingsPath: engine.findingsPath,
        synced: true,
      },
    }
  } catch (error) {
    if (session && deps.signal?.aborted)
      return {
        exitCode: 130,
        result: {
          runId: session.runId,
          status: 'pending_upload',
          reportUrl: reportUrl(deps.auth.baseUrl, session.runId),
          hint: `Analysis output is preserved. Resume the same command with --out ${session.out}.`,
        },
      }
    throw error
  } finally {
    await session?.release?.()
  }
}
