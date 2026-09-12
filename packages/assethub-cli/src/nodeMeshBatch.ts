import {mkdir, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import type {
  CanvasExecution,
  ExecutionContext,
  MeshGenerationRequest,
} from '@assethub/api-client'
import {readState} from './canvas.js'
import {
  activeExecution,
  childOperationId,
  CliExecutionError,
  executeRecorded,
  openExecutionSession,
  resumeRecorded,
  hasRecordedOperation,
} from './execution.js'

type Session = Parameters<typeof executeRecorded>[0]
type NodeMeshBatch = {
  operationId: string
  nodeId: string
  canvasId: number
  baseUrl: string
  ownerId: string
  body: Record<string, unknown>
  children: Array<{nodeId: string; operationId: string}>
  skipped: Array<{nodeId: string; meshStatus?: string}>
  agent?: ExecutionContext['agent']
  parentRunId?: string
}
export type NodeMeshBatchResult = Pick<
  NodeMeshBatch,
  'operationId' | 'nodeId' | 'skipped'
> & {executions: CanvasExecution[]}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const batchPath = (stateDir: string, id: string) => {
  if (!uuid.test(id)) throw new Error('Operation ID must be a UUID')
  return join(stateDir, 'node-batches', `${id}.json`)
}

const submitBatch = async (
  session: Session,
  batch: NodeMeshBatch,
): Promise<NodeMeshBatchResult> => {
  activeExecution.batchOperationId = batch.operationId
  const executions: CanvasExecution[] = []
  for (const child of batch.children) {
    try {
      const result = (await hasRecordedOperation(
        session.stateDir,
        child.operationId,
      ))
        ? await resumeRecorded({
            ...session,
            operationId: child.operationId,
            expectedCanvasId: batch.canvasId,
            expectedCanvasNodeId: child.nodeId,
            expectedOperation: 'mesh.generate',
            expectedBody: batch.body,
          })
        : await executeRecorded(
            session,
            'mesh.generate',
            batch.body as MeshGenerationRequest,
            {
              operationId: child.operationId,
              canvasNode: {nodeId: child.nodeId},
              agent: batch.agent,
              parentRunId: batch.parentRunId,
            },
          )
      executions.push(result.execution)
    } catch (error) {
      throw new CliExecutionError(
        `Node ${child.nodeId} failed (${child.operationId}). Resume batch ${batch.operationId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof CliExecutionError ? error.exitCode : 1,
        batch.operationId,
      )
    }
  }
  return {
    operationId: batch.operationId,
    nodeId: batch.nodeId,
    executions,
    skipped: batch.skipped,
  }
}

export const executeNodeMeshBatch = async (
  session: Session,
  input: Omit<
    NodeMeshBatch,
    'baseUrl' | 'ownerId' | 'canvasId' | 'children'
  > & {children: string[]},
): Promise<NodeMeshBatchResult> => {
  const batch: NodeMeshBatch = JSON.parse(
    JSON.stringify({
      ...input,
      baseUrl: session.baseUrl,
      ownerId: session.ownerId,
      canvasId: session.canvas.id,
      children: input.children.map(nodeId => ({
        nodeId,
        operationId: childOperationId(input.operationId, nodeId),
      })),
    }),
  ) as NodeMeshBatch
  const path = batchPath(session.stateDir, batch.operationId)
  await mkdir(dirname(path), {recursive: true, mode: 0o700})
  // Pin the entire target set before any paid dispatch. Per-child receipts retain
  // resolved server inputs; a retry never discovers a changed split again.
  await writeFile(path, JSON.stringify(batch), {mode: 0o600, flag: 'wx'})
  return submitBatch(session, batch)
}

export const resumeNodeMeshBatch = async (
  options: Parameters<typeof resumeRecorded>[0],
): Promise<NodeMeshBatchResult | undefined> => {
  const batch = (await readState(
    batchPath(options.stateDir, options.operationId),
  )) as NodeMeshBatch | undefined
  if (batch === undefined) return undefined
  if (
    options.expectedOperation !== undefined &&
    options.expectedOperation !== 'mesh.generate'
  )
    throw new Error('Saved operation has a different operation type')
  if (
    !batch ||
    batch.operationId !== options.operationId ||
    typeof batch.nodeId !== 'string' ||
    !Number.isSafeInteger(batch.canvasId) ||
    typeof batch.baseUrl !== 'string' ||
    typeof batch.ownerId !== 'string' ||
    !batch.body ||
    typeof batch.body !== 'object' ||
    Array.isArray(batch.body) ||
    !Array.isArray(batch.children) ||
    !batch.children.every(
      child =>
        child &&
        typeof child.nodeId === 'string' &&
        uuid.test(child.operationId),
    ) ||
    !Array.isArray(batch.skipped)
  )
    throw new Error('Invalid saved node batch')
  if (batch.baseUrl !== options.client.baseUrl)
    throw new Error('Saved operation belongs to a different API origin')
  if (
    options.expectedCanvasId !== undefined &&
    options.expectedCanvasId !== batch.canvasId
  )
    throw new Error('Saved operation belongs to a different canvas')
  if (
    options.expectedCanvasNodeId !== undefined &&
    options.expectedCanvasNodeId !== batch.nodeId
  )
    throw new Error('Saved operation belongs to a different canvas node')
  if (
    options.expectedBody !== undefined &&
    JSON.stringify(options.expectedBody) !== JSON.stringify(batch.body)
  )
    throw new Error(
      'Operation ID already belongs to different inputs; use runs resume or a new operation ID',
    )
  const session = await openExecutionSession({
    ...options,
    canvasId: batch.canvasId,
    operation: 'mesh.generate',
    create: false,
  })
  if (session.ownerId !== batch.ownerId)
    throw new Error('Saved operation belongs to a different organization')
  return submitBatch(session, batch)
}
