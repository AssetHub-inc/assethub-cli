import {createHash, randomUUID} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {
  AssetHubApiError,
  type AssetHubClient,
  type CanvasExecution,
  type ExecutionContext,
  type ImageGenerationRequest,
  type MeshGenerationRequest,
  type MeshComposeRequest,
  type MeshRefineRequest,
  type ProductionAnalyzeRequest,
  type ProductionExecuteRequest,
  type ProductionAutomationRequest,
} from '@assethub/api-client'
import {readState, resolveCanvasSelection, writeState} from './canvas.js'

const operations = [
  'image.generate',
  'mesh.generate',
  'mesh.compose',
  'mesh.refine',
  'production.analyze',
  'production.execute',
  'production.automation',
] as const
type Operation = (typeof operations)[number]
type SessionOptions = {
  client: AssetHubClient
  stateDir: string
  cwd: string
  canvasId?: number
  operation?: Operation
  create?: boolean
}
export const openExecutionSession = async (options: SessionOptions) => {
  const capabilities = await options.client.v2.getCapabilities()
  if (
    capabilities.executionContext.status !== 'available' ||
    (options.operation &&
      !capabilities.executionContext.operations.includes(options.operation))
  ) {
    throw new Error(
      `Canvas execution history unavailable: ${capabilities.executionContext.reason ?? options.operation ?? 'disabled'}`,
    )
  }
  const scope = {
    ...options,
    baseUrl: options.client.baseUrl,
    ownerId: capabilities.ownerId,
  }
  const canvas = await resolveCanvasSelection(scope)
  return {...scope, canvas, capabilities}
}
type Session = Awaited<ReturnType<typeof openExecutionSession>>
type RequestBody =
  | ImageGenerationRequest
  | MeshGenerationRequest
  | Omit<MeshComposeRequest, 'executionContext'>
  | Omit<MeshRefineRequest, 'executionContext'>
  | ProductionAnalyzeRequest
  | ProductionExecuteRequest
  | ProductionAutomationRequest
type SavedOperation = {
  operation: Operation
  operationId: string
  baseUrl: string
  ownerId: string
  body: RequestBody & {executionContext: ExecutionContext}
  runId?: string
}

export const hasRecordedOperation = async (
  stateDir: string,
  operationId: string,
) => (await loadOperation(operationPath(stateDir, operationId))) !== undefined
type SubmitOptions = {
  operationId?: string
  retryDelayMs?: number
  agent?: ExecutionContext['agent']
  parentRunId?: string
  source?: ExecutionContext['source']
  graphSource?: ExecutionContext['graphSource']
  canvasNode?: ExecutionContext['canvasNode']
}

export class CliExecutionError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly operationId?: string,
    readonly execution?: CanvasExecution,
    readonly runId: string | undefined = execution?.runId,
  ) {
    super(message)
  }
}

/** Kept only for SIGINT reporting; interrupting the client never cancels server work. */
export const activeExecution: {
  operationId?: string
  batchOperationId?: string
  runId?: string
  execution?: CanvasExecution
} = {}

export const childOperationId = (parent: string, step: string) => {
  const hash = createHash('sha256')
    .update(JSON.stringify([parent, step]))
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

const operationPath = (stateDir: string, id: string): string => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new Error('Operation ID must be a UUID')
  return join(stateDir, 'operations', `${id}.json`)
}
const loadOperation = async (
  path: string,
): Promise<SavedOperation | undefined> => {
  const saved = await readState(path)
  if (saved === undefined) return undefined
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('operation' in saved) ||
    !operations.includes(saved.operation as Operation) ||
    !('body' in saved) ||
    !saved.body ||
    typeof saved.body !== 'object' ||
    !('executionContext' in saved.body) ||
    !saved.body.executionContext ||
    typeof saved.body.executionContext !== 'object' ||
    !('canvasId' in saved.body.executionContext) ||
    !Number.isSafeInteger(saved.body.executionContext.canvasId) ||
    !('operationId' in saved) ||
    typeof saved.operationId !== 'string' ||
    !('baseUrl' in saved) ||
    typeof saved.baseUrl !== 'string' ||
    !('ownerId' in saved) ||
    typeof saved.ownerId !== 'string'
  )
    throw new Error('Invalid saved operation')
  return saved as SavedOperation
}

const submitSaved = async (
  session: Session,
  saved: SavedOperation,
  retryDelayMs = 250,
) => {
  activeExecution.operationId = saved.operationId
  activeExecution.execution = undefined
  activeExecution.runId = saved.runId
  try {
    if (saved.runId) {
      const execution = await session.client.v2.getRun(saved.runId)
      activeExecution.execution = execution
      // An unacknowledged Composer receipt can precede a failed Trigger POST.
      // Resume repeats its saved body/key; the server uses the same native key.
      if (
        !(
          (saved.operation === 'mesh.compose' ||
            saved.operation === 'mesh.refine') &&
          execution.status === 'queued' &&
          execution.history.status === 'pending'
        )
      )
        return {execution}
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const options = {idempotencyKey: saved.operationId}
        const queued = await (async () => {
          switch (saved.operation) {
            case 'image.generate':
              return session.client.v2.generateImage(
                saved.body as ImageGenerationRequest,
                options,
              )
            case 'mesh.generate':
              return session.client.v2.generateMesh(
                saved.body as MeshGenerationRequest,
                options,
              )
            case 'mesh.compose':
              return session.client.v2.composeMesh(
                saved.body as MeshComposeRequest,
                options,
              )
            case 'mesh.refine':
              return session.client.v2.refineMesh(
                saved.body as MeshRefineRequest,
                options,
              )
            case 'production.analyze':
              return session.client.v1.analyzeProduction(
                saved.body as ProductionAnalyzeRequest,
                options,
              )
            case 'production.execute':
              return session.client.v1.executeProduction(
                saved.body as ProductionExecuteRequest,
                options,
              )
            case 'production.automation':
              return session.client.v1.runProductionAutomation(
                saved.body as ProductionAutomationRequest,
                options,
              )
          }
        })()
        if (!queued.execution)
          throw new CliExecutionError(
            'Server omitted the canvas execution receipt; resume with the same operation ID',
            1,
            saved.operationId,
          )
        activeExecution.runId = queued.execution.runId
        activeExecution.execution = queued.execution
        saved.runId = queued.execution.runId
        await writeState(
          operationPath(session.stateDir, saved.operationId),
          saved,
        )
        return {...queued, execution: queued.execution}
      } catch (error) {
        const retryable =
          error instanceof TypeError ||
          (error instanceof AssetHubApiError &&
            ([429, 502, 503, 504].includes(error.status) ||
              error.code === 'IDEMPOTENCY_IN_PROGRESS'))
        if (!retryable || attempt >= 2) throw error
        await delay(retryDelayMs * 2 ** attempt)
      }
    }
  } catch (error) {
    if (
      error instanceof AssetHubApiError &&
      error.code === 'EXECUTION_RECOVERY_REQUIRED' &&
      error.runId
    ) {
      saved.runId = error.runId
      activeExecution.runId = error.runId
      await writeState(
        operationPath(session.stateDir, saved.operationId),
        saved,
      )
      activeExecution.execution = await session.client.v2
        .getRun(error.runId, {signal: AbortSignal.timeout(5_000)})
        .catch(() => undefined)
      throw new CliExecutionError(
        error.message,
        3,
        saved.operationId,
        activeExecution.execution,
        error.runId,
      )
    }
    throw new CliExecutionError(
      error instanceof Error ? error.message : String(error),
      error instanceof AssetHubApiError &&
        (error.status < 500 ||
          ['CANVAS_EXECUTION_UNAVAILABLE', 'EVALUATOR_UNAVAILABLE'].includes(
            error.code,
          ))
        ? 2
        : 1,
      saved.operationId,
      activeExecution.execution,
    )
  }
}

export const executeRecorded = async (
  session: Session,
  operation: Operation,
  body: RequestBody,
  options: SubmitOptions = {},
) => {
  if (!session.capabilities.executionContext.operations.includes(operation))
    throw new CliExecutionError(
      `Canvas execution history unavailable: ${operation}`,
      2,
    )
  const operationId = options.operationId ?? randomUUID()
  const path = operationPath(session.stateDir, operationId)
  if (
    await readState(
      join(session.stateDir, 'node-batches', `${operationId}.json`),
    )
  )
    throw new CliExecutionError(
      'Operation ID belongs to a different node batch; use runs resume or a new operation ID',
      2,
      operationId,
    )
  const saved: SavedOperation = JSON.parse(
    JSON.stringify({
      operation,
      operationId,
      baseUrl: session.baseUrl,
      ownerId: session.ownerId,
      body: {
        ...body,
        executionContext: {
          canvasId: session.canvas.id,
          clientOperationId: operationId,
          source: options.source ?? 'cli',
          agent: options.agent,
          parentRunId: options.parentRunId,
          graphSource: options.graphSource,
          canvasNode: options.canvasNode,
        },
      },
    }),
  ) as SavedOperation
  await mkdir(dirname(path), {recursive: true, mode: 0o700})
  try {
    // Exclusive creation prevents concurrent use of one key with different inputs.
    await writeFile(path, JSON.stringify(saved), {mode: 0o600, flag: 'wx'})
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error
    const previous = await loadOperation(path)
    if (
      !previous ||
      JSON.stringify({...previous, runId: undefined}) !== JSON.stringify(saved)
    ) {
      throw new CliExecutionError(
        'Operation ID already belongs to different inputs; use runs resume or a new operation ID',
        1,
        operationId,
      )
    }
    return submitSaved(session, previous, options.retryDelayMs)
  }
  return submitSaved(session, saved, options.retryDelayMs)
}

export const resumeRecorded = async (
  options: Omit<SessionOptions, 'canvasId' | 'operation'> & {
    operationId: string
    retryDelayMs?: number
    expectedCanvasId?: number
    expectedCanvasNodeId?: string
    expectedOperation?: Operation
    expectedBody?: Record<string, unknown>
  },
) => {
  const saved = await loadOperation(
    operationPath(options.stateDir, options.operationId),
  )
  if (!saved || saved.operationId !== options.operationId)
    throw new Error('Saved operation not found')
  if (saved.baseUrl !== options.client.baseUrl)
    throw new Error('Saved operation belongs to a different API origin')
  if (
    options.expectedOperation !== undefined &&
    saved.operation !== options.expectedOperation
  )
    throw new Error('Saved operation has a different operation type')
  if (
    options.expectedCanvasNodeId !== undefined &&
    saved.body.executionContext.canvasNode?.nodeId !==
      options.expectedCanvasNodeId
  )
    throw new Error('Saved operation belongs to a different canvas node')
  if (
    options.expectedCanvasId !== undefined &&
    saved.body.executionContext.canvasId !== options.expectedCanvasId
  )
    throw new Error('Saved operation belongs to a different canvas')
  for (const [key, value] of Object.entries(options.expectedBody ?? {})) {
    if (
      JSON.stringify(
        (saved.body as unknown as Record<string, unknown>)[key],
      ) !== JSON.stringify(value)
    )
      throw new CliExecutionError(
        'Operation ID already belongs to different inputs; use runs resume or a new operation ID',
        2,
        saved.operationId,
      )
  }
  const session = await openExecutionSession({
    ...options,
    canvasId: saved.body.executionContext.canvasId,
    operation: saved.operation,
  })
  if (session.ownerId !== saved.ownerId)
    throw new Error('Saved operation belongs to a different organization')
  return submitSaved(session, saved, options.retryDelayMs)
}

export const waitForExecution = async (
  client: AssetHubClient,
  runId: string,
  options: {
    timeoutMs?: number
    intervalMs?: number
    onProgress?: (execution: CanvasExecution) => void
  } = {},
): Promise<CanvasExecution> => {
  if (activeExecution.execution?.runId !== runId) {
    activeExecution.execution = undefined
    activeExecution.operationId = undefined
  }
  activeExecution.runId = runId
  const deadline = Date.now() + (options.timeoutMs ?? 900_000)
  const timeout = () =>
    new CliExecutionError(
      `Wait timed out; server execution continues. Use runs watch ${runId}.`,
      3,
      activeExecution.operationId,
      activeExecution.execution,
      runId,
    )
  while (true) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    let execution: CanvasExecution
    try {
      execution = await client.v2.getRun(runId, {signal})
    } catch (error) {
      if (signal.aborted) throw timeout()
      throw new CliExecutionError(
        error instanceof Error ? error.message : String(error),
        error instanceof AssetHubApiError && error.status < 500 ? 2 : 1,
        activeExecution.operationId,
        activeExecution.execution,
        runId,
      )
    }
    activeExecution.execution = execution
    options.onProgress?.(execution)
    if (execution.status === 'needs_review') return execution
    if (
      !['queued', 'running'].includes(execution.status) &&
      execution.history.status === 'recorded'
    )
      return execution
    if (Date.now() >= deadline) throw timeout()
    await delay(
      Math.min(options.intervalMs ?? 5_000, Math.max(0, deadline - Date.now())),
    )
  }
}
