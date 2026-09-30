/** Public canvas execution contracts shared by CLI and MCP consumers. */
import type {
  ComposerRefineCalibration,
  ComposerReferenceViews,
} from './index.js'

export type ExecutionContext = {
  canvasId: number
  clientOperationId: string
  source: 'cli' | 'mcp' | 'api'
  agent?: {name: string; sessionId?: string}
  parentRunId?: string | null
  graphSource?: {graphId: string; nodeId: string; revision: string}
  canvasNode?: {nodeId: string}
}

export type CanvasNode = {
  nodeId: string
  type: string
  name?: string
  sourceNodeId?: string
  partTaskId?: string
  meshStatus?: string
  actions: Array<'mesh.generate' | 'mesh.compose'>
}
export type CanvasNodesResult = {items: CanvasNode[]}
export type MeshVolumeCentroid = [number, number, number]
export type MeshComposerPart = {
  sourceAssetId?: string
  transform?: number[]
  assetId: string
  name?: string
  canonicalKey?: string
  partImageAssetId?: string
  partTaskId?: string
  volumeCentroid?: MeshVolumeCentroid
}

export type Canvas = {
  id: number
  name: string
  url: string
  ownerId: string
  createdAt?: string
}
export type Page<T> = {items: T[]; nextCursor: string | null}
export type PageOptions = {cursor?: string; limit?: number}
export type EvaluationVerdict = 'pass' | 'fail' | 'needs_review'
export type EvaluationReport = {
  schemaVersion: 'assethub.evaluation-submission.v1'
  rubric: {id: string; version: string}
  referenceAssetIds: string[]
  verdict: EvaluationVerdict
  criteria: Array<{
    id: string
    verdict: EvaluationVerdict
    reason: string
    score?: {
      value: number
      unit: string
      min: number
      max: number
      higherIsBetter: boolean
    }
  }>
  evidenceAssetIds: string[]
  suggestedNextAction?: string
}
export type Evaluation = {
  id: string
  canvasId: number
  artifactId: string
  kind: 'agent_submission'
  runId: string | null
  referenceAssetIds: string[]
  evaluator: {name: string; version?: string}
  report: EvaluationReport
  actorId: string | null
  createdAt: string
}
export type EvaluationSubmission = {
  canvasId: number
  clientOperationId: string
  runId?: string
  artifactId: string
  referenceAssetIds: string[]
  evaluator: {name: string; version?: string}
  report: EvaluationReport
}
/**
 * A V4 Character Assembly run's progress, in the words the canvas uses. Set on
 * `CanvasExecution.progress` while the run works and after it finishes.
 */
export type CharacterAssemblyProgress = {
  kind: 'character_assembly'
  phase: 'plan' | 'body' | 'parts' | 'assembly' | 'done'
  /** 1 plan, 2 base body, 3 parts, 4 assembly (a finished run stays on 4). */
  step: number
  steps: 4
  /** One line, e.g. `Step 3 of 4 · Making the parts · 6 of 10 meshes ready`. */
  summary: string
  headline: string
  partsReady: number
  partsTotal: number
  parts: Array<{
    label: string
    state:
      | 'waiting'
      | 'drawing'
      | 'meshing'
      | 'checking'
      | 'redoing'
      | 'ready'
      | 'kept'
      | 'failed'
    stateText: string
    note?: string
    meshModel?: string
    drawingAttempts: number
    meshAttempts: number
  }>
  rounds: Array<{
    round: number
    state: 'running' | 'accepted' | 'repair' | 'failed'
    stateText: string
    summary?: string
  }>
  /** Set before the first assembly round. */
  note?: string
  /** Set once the run stopped for good; `detail` says what stopped it. */
  outcome?: {
    accepted: boolean
    outcome: string
    stopReason?: string
    detail?: string
  }
}
export type CanvasExecution = {
  schemaVersion: 'assethub.execution.v1'
  runId: string
  operation: string
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'partial'
    | 'cancelled'
    | 'needs_review'
  canvas: Canvas
  jobIds: string[]
  meshGeneration?: {id: string; progress?: number}
  /** V4 Character Assembly runs only, while running and after they finish. */
  progress?: CharacterAssemblyProgress
  judgmentPolicy?:
    | 'complete-object-evidence-v1'
    | 'complete-object-evidence-v2'
    | 'complete-object-evidence-body-neutral-v1'
  orderIds: string[]
  graphRefs: Array<{graphId: string; nodeId?: string; revision?: string}>
  outputs: Array<{
    assetId: string
    graphId?: string
    artifactId?: string
    mediaType?: 'image' | 'mesh' | 'json'
    url?: string
    expiresAt?: string
    format?: string
  }>
  history: {status: 'recorded' | 'pending' | 'failed'; error?: string}
  composition?: {
    turntableRefinement?: Record<string, unknown>
    transforms?: Record<string, number[]>
    parts?: MeshComposerPart[]
    referenceTransform?: number[]
  }
  /** Pinned methods used for this run; never execution authority or creator adoption. */
  appliedSkills?: {skillId: string; skillRevision: number}[]
  refinement?: {
    mode:
      | 'standard'
      | 'thorough'
      | 'placement'
      | 'workshop'
      | 'blender'
      | 'codex'
    report?: Record<string, unknown>
    message?: string
    calibration?: ComposerRefineCalibration
    referenceViews?: ComposerReferenceViews
    geometrySources?: Record<string, string>
  }
  usage: {
    reservedCredits: number | null
    chargedCredits: number | null
    creditPlanId?: string
    estimatedCredits?: number
  }
  createdAt: string
  actorId?: string | null
  requestedInput?: Record<string, unknown>
  resolvedInput?: Record<string, unknown>
  input: Record<string, unknown>
  inputAssets?: Array<{
    assetId: string
    mediaType: 'image' | 'mesh'
    uploadId?: string
    sourceAssetId?: string
  }>
  context: ExecutionContext
  error?: {code: string; message: string}
  evaluationsTruncated?: boolean
  evaluations?: Evaluation[]
}
export type ApiCapabilities = {
  ownerId: string
  executionContext: {
    status: 'available' | 'unavailable'
    reason?: string
    operations: string[]
  }
  evaluators: Array<{
    id: string
    status: 'available' | 'unavailable'
    reason?: string
  }>
}
/** Read-only projection, using the existing Artifact Graph export vocabulary. */
export type CanvasGraph = {
  graphId: string
  canvas: Canvas
  revision: string
  nodes: Array<{
    id: string
    artifactKind?: string
    metadata: Record<string, unknown>
    tags?: string[]
    [key: string]: unknown
  }>
  edges: Array<{
    id: string
    from: string
    to: string
    kind?: string
    [key: string]: unknown
  }>
  nextCursor: string | null
  truncated?: boolean
}
export type CanvasGraphOptions = {
  artifactId?: string
  direction?: 'ancestors' | 'descendants' | 'both'
  depth?: number
}
