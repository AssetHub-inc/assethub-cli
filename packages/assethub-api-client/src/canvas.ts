/** Public canvas execution contracts shared by CLI and MCP consumers. */
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
  meshStatus?: string
  actions: Array<'mesh.generate' | 'mesh.compose'>
}
export type CanvasNodesResult = {items: CanvasNode[]}
export type MeshVolumeCentroid = [number, number, number]
export type MeshComposerPart = {
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
    transforms?: Record<string, number[]>
    parts?: MeshComposerPart[]
    referenceTransform?: number[]
  }
  refinement?: {
    mode: 'standard' | 'thorough' | 'placement' | 'workshop' | 'blender'
    report?: Record<string, unknown>
    message?: string
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
