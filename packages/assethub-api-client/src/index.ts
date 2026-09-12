/*
Intervention types are re-exported from a generated module, never declared here.
`src/generated/intervention.ts` is emitted from the same zod schema the v2 route
validates against (`@assethub/production-contracts`), so the published client
cannot advertise an op the server rejects. Adding a hand-written variant of one
of these types to this file defeats the gate — extend the contract instead.
*/
export {INTERVENTION_OPS} from './generated/intervention.js'
export {createWorkspaceClient, WorkspaceClientError} from './workspaces.js'
export type {
  Workspace,
  WorkspaceMember,
  WorkspaceMembersResult,
  WorkspaceInviteResult,
  WorkspaceMemberRoleResult,
  WorkspaceMemberRemoveResult,
  WorkspaceListResult,
  WorkspaceListOptions,
  WorkspaceCreateResult,
  WorkspaceSelectResult,
  WorkspaceApiKey,
  WorkspaceClientOptions,
  WorkspaceClient,
} from './workspaces.js'
export type {
  Intervention,
  InterventionOp,
  ParamsSetIntervention,
  PartAddIntervention,
  PartExcludeIntervention,
  PartIncludeIntervention,
  PartRegenerateIntervention,
  PartRejectIntervention,
  PartRenameIntervention,
} from './generated/intervention.js'

export type {
  CanvasExport,
  CanvasExportAsset,
  CanvasExportStep,
} from './canvasExport.js'
import type {CanvasExport} from './canvasExport.js'
import type {Intervention, InterventionOp} from './generated/intervention.js'
import type {
  ApiCapabilities,
  Canvas,
  CanvasExecution,
  CanvasGraph,
  CanvasGraphOptions,
  CanvasNodesResult,
  Evaluation,
  EvaluationSubmission,
  ExecutionContext,
  Page,
  PageOptions,
  MeshComposerPart,
  MeshVolumeCentroid,
} from './canvas.js'
import type {
  GraphListResult,
  HistoricalGraph,
  HistoricalGraphOptions,
  MeshListOptions,
  MeshListResult,
} from './historical.js'
export type {
  GraphListResult,
  GraphSummary,
  HistoricalGraph,
  HistoricalGraphEdge,
  HistoricalGraphNode,
  HistoricalGraphOptions,
  HistoricalGraphSource,
  MeshAsset,
  MeshListOptions,
  MeshListResult,
} from './historical.js'
export type {
  ApiCapabilities,
  Canvas,
  CanvasExecution,
  CanvasGraph,
  CanvasGraphOptions,
  CanvasNode,
  CanvasNodesResult,
  Evaluation,
  EvaluationReport,
  EvaluationSubmission,
  ExecutionContext,
  Page,
  PageOptions,
  MeshComposerPart,
  MeshVolumeCentroid,
} from './canvas.js'

export type ProjectContext = {
  version: number
  sha256: string
  updatedAt: string
  updatedById: string
  document: Record<string, unknown>
}
export type CanvasProjectContext = {
  orgId: string
  actorId: string
  canvasId: number
  orderId: string
  projectContext: ProjectContext
}
export type MoodboardRevision = {
  id: string
  boardId: string
  revisionNumber: number
  status: 'draft' | 'analyzing' | 'ready' | 'failed'
  referenceAssets: {assetId: string; hash: string; previewUrl?: string}[]
  representativeAssetIds: string[]
  userNote: string
  styleProfile: {
    summary: string
    palette: string[]
    linework: string
    shading: string
    texture: string
    medium: string
    avoid: string[]
  } | null
  analysisJobId?: string | null
  analysisAttempts?: number
  errorCode: string | null
  createdAt: string
  updatedAt: string
}
export type Moodboard = {
  id: string
  ownerId: string
  name: string
  currentRevisionId: string | null
  currentRevision: MoodboardRevision | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
export type CanvasLayoutInput = {
  images: {
    assetId: string
    role: 'source' | 'output'
    x: number
    y: number
    name?: string
    width?: number
    height?: number
  }[]
  connections?: {sourceAssetId: string; targetAssetId: string}[]
}
export type CanvasLayoutResult = {
  canvasId: number
  status: 'committed' | 'already_present'
  addedRecordIds: string[]
  existingRecordIds: string[]
  serverClock: number
}

export type MoodboardInput = {
  name: string
  assetIds: string[]
  representativeAssetIds?: string[]
  userNote?: string
}

export type AssetHubApiVersion = 'v1' | 'v2'

export type AssetHubClientOptions = {
  apiKey: string
  workspaceId?: string
  baseUrl?: string
  fetch?: typeof fetch
}

export type ApiSuccess<T> = {
  success: true
  data: T
}

export type ApiErrorPayload = {
  success?: false
  error?: {
    code?: string
    message?: string
    requestId?: string
    details?: Record<string, unknown>
  }
}

export type BlobLocation =
  | {
      type: 'supabase'
      bucket: string
      path: string
    }
  | {
      type: 'signedSupabase'
      signedUrl: string
    }
  | {
      type: 'asset'
      assetId: string
    }

export type Source =
  | {
      resourceId: string
      uploadId?: never
      fileRef?: never
      url?: never
    }
  | {
      uploadId: string
      resourceId?: never
      fileRef?: never
      url?: never
    }
  | {
      fileRef: BlobLocation
      uploadId?: never
      resourceId?: never
      url?: never
    }
  | {
      url: string
      uploadId?: never
      resourceId?: never
      fileRef?: never
    }

type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Omit<T, Keys> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Omit<Pick<T, Keys>, K>>
  }[Keys]

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type PublicJobStep =
  | 'queued'
  | 'dispatched'
  | 'processing'
  | 'completed'
  | 'failed'

export type PublicJobDomain =
  | 'imageGen'
  | 'meshGen'
  | 'meshProcess'
  | 'remesh'
  | 'rig'
  | 'precacheModel'
  | 'languageModel'

/** One asset a job produced. `url` is absent unless the API signed it. */
export type PublicJobOutput = {
  assetId: string
  url?: string
  expiresAt?: string
}

/** Stable representation returned by the v2 job foundation endpoints. */
export type PublicJob<Result = unknown> = {
  id: string
  status: JobStatus
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  step?: PublicJobStep
  progress?: number
  domain?: string
  resourceId?: string
  error?: {
    code: string
    message: string
  }
  result?: Result
  /**
   * Assets this job produced, one entry per asset. Signed urls are present
   * only on getJob(); the list endpoints return assetId alone.
   */
  outputs?: PublicJobOutput[]
}

export type JobListOptions = {
  status?: JobStatus
  domain?: PublicJobDomain
  /** Page size. The API accepts 1 through 100 and defaults to 25. */
  limit?: number
  /** Opaque value returned as `nextCursor`; pass it back unchanged. */
  cursor?: string
}

export type JobListResult<Result = unknown> = {
  items: Array<PublicJob<Result>>
  nextCursor: string | null
}

export type JobNotFoundResult = {
  id: string
  error: {
    code: 'NOT_FOUND'
    message: 'Job not found'
  }
}

export type JobQueryResult<Result = unknown> = {
  /** One result per requested ID, preserving input order and duplicates. */
  items: Array<PublicJob<Result> | JobNotFoundResult>
}

export type JobCancellationResult<Result = unknown> = {
  id: string
  cancellation: {
    state: 'requested' | 'already_terminal' | 'too_late'
    provider: 'requested' | 'unsupported' | 'not_requested'
  }
  job: PublicJob<Result>
}

export type AccountPlanTier = 'free' | 'pro' | 'max' | 'studio' | 'enterprise'

export type AccountResult = {
  balance: number
  /** Spendable balance after active reservations, or null when unavailable. */
  availableBalance: number | null
  reservedCredits: number | null
  balanceReliable: boolean
  /** True only for a server-verified request from the registered synthetic actor. */
  synthetic: boolean
  pools: {
    free: number | null
    subscription: number | null
    paid: number | null
  }
  plan: {
    tier: AccountPlanTier
    subscription: {
      planId: string
      startsAt: string
      endsAt: string
    } | null
    trialExpiresAt: string | null
  }
}

export type AccountUsageOptions = {
  /** Page size. The API accepts 1 through 100 and defaults to 25. */
  limit?: number
  /** Opaque value returned as `nextCursor`; pass it back unchanged. */
  cursor?: string
  /** Inclusive ISO 8601 lower timestamp bound. */
  from?: string
  /** Inclusive ISO 8601 upper timestamp bound. */
  to?: string
}

export type AccountUsageEntry = {
  id: string
  credits: number
  status: 'consumed' | 'released' | 'pending'
  source: 'api' | 'app'
  createdAt: string
  completedAt: string | null
  operation?: string
  endpoint?: string
  creditModelId?: string
  jobId?: string
}

export type AccountUsageResult = {
  items: AccountUsageEntry[]
  nextCursor: string | null
}

export type CreditAlertState = 'unknown' | 'above' | 'low'

export type CreditAlert = {
  /** Opaque revision token, or null when no configuration exists. */
  configToken: string | null
  enabled: boolean
  threshold: number | null
  state: CreditAlertState
  lastEvaluatedBalance: number | null
  lastEvaluatedAt: string | null
  /** Durable balance.low event ID matching Webhook-Id and payload.eventId. */
  lastTriggeredEventId: string | null
  lastTriggeredAt: string | null
}

export type UpdateCreditAlertRequest = {
  /** Exact revision to replace; null requires no existing configuration. */
  configToken?: string | null
  enabled?: boolean
  /** Positive integer credit threshold; the alert is low at balance <= threshold. */
  threshold?: number
}

export type Job<Result = unknown, Domain extends string = string> = {
  id: string
  status: JobStatus
  domain?: Domain
  resourceId?: string
  result?: Result
  createdAt?: string
  updatedAt?: string
  startedAt?: string
  completedAt?: string
  failedAt?: string
  created_at?: string
  updated_at?: string
  error?: {
    code?: string
    message?: string
  }
  [key: string]: unknown
}

export type ModelSummary = {
  id: string
  domain: string
  name: string
  description?: string
  tags: string[]
  /** @deprecated Historical duration metadata. Use creditCost for billing. */
  credits: number | null
  /** Price of the model's base public consume plan. */
  creditCost: number | null
  creditPlanId: string
  /** Price charged when model-specific request options are omitted. */
  defaultCreditCost: number | null
  defaultCreditPlanId: string
  duration: number | null
  type: string
  familyId?: string
  productVersion: string | null
  providerFamily: string | null
  provider: string | null
  providerModel: string | null
  apiAvailable: boolean
  availability: {
    status: 'available' | 'unavailable'
    reason: 'missing-credit-plan' | 'not-public-contract' | 'retired' | null
    contractStatus: 'guaranteed' | 'catalog-dependent' | 'legacy' | 'not-public'
    guaranteed: boolean
    source: 'live-model-catalog'
  }
  apiCapabilities: string[]
  options: Record<string, unknown> | null
  deprecated: boolean
  [key: string]: unknown
}

export type ModelDetail = {
  id: string
  [key: string]: unknown
}

export type PublicCreditPlan = {
  id: string
  credits: number
  description?: string
}

export type ModelCatalogResult = {
  models: ModelSummary[]
  /** Only plans selectable by public endpoints are returned. */
  creditPlans: PublicCreditPlan[]
}

export type ModelListOptions = {
  domain?: 'meshGen' | 'imageGen' | 'meshProcess' | 'remesh' | 'rig'
  capability?:
    | 'image.generate'
    | 'mesh.generate'
    | 'mesh.process.uv_unwrap'
    | 'mesh.process.retopo_ai'
    | 'mesh.process.part_segmentation'
    | 'mesh.process.texture_ai'
    | 'mesh.process.quality_eval'
}

export type WorkflowStreamEvent = Record<string, unknown> & {
  type?: string
  status?: string
  payload?: Record<string, unknown>
  data?: Record<string, unknown>
}

export type FileMediaType = 'image' | 'mesh'

export type FileImportResult = {
  fileRef: BlobLocation
  mediaType: FileMediaType
  contentType: string
  fileName: string
  size: number
  /** Present for quota-accounted private staging uploads. */
  uploadId?: string
  /** Present when the staged object has a server-managed retention deadline. */
  retentionExpiresAt?: string
}

export type PrivateUploadFileRef = {
  type: 'supabase'
  bucket: 'external_api_uploads'
  path: string
}

export type LargeUploadReservation = {
  uploadId: string
  uploadUrl: string
  uploadToken: string
  /** ISO 8601 expiration of the two-hour upload reservation. */
  expiresAt: string
  expiresIn: 7200
  fileRef: PrivateUploadFileRef
  mediaType: FileMediaType
  contentType: string
  fileName: string
  size: number
}

export type CompletedLargeUpload = {
  uploadId: string
  fileRef: PrivateUploadFileRef
  mediaType: FileMediaType
  contentType: string
  fileName: string
  size: number
  /** The staging input is reclaimed after this time. Generated outputs persist. */
  retentionExpiresAt: string
}

export type QueuedMeshResult = {
  execution?: CanvasExecution
  jobId: string
  meshGenId: string
  status: 'queued'
  modelId: string
  inputMode: 'image' | 'multiview'
  imageCount: number
}

/**
 * What `POST /v2/image/multiview` answers with.
 *
 * The views do not exist yet. Poll `getJob(jobId)`: a completed job carries
 * one `outputs` entry per view that was produced, each with a durable
 * `assetId` and a signed `url`.
 */
export type QueuedMultiviewResult = {
  jobId: string
  message: string
}

/**
 * What `POST /v2/image/edit` answers with.
 *
 * The edited images do not exist yet. Poll `getJob(jobId)`: a completed job
 * carries one `outputs` entry per image that was produced, each with a durable
 * `assetId` and a signed `url`.
 */
export type QueuedImageEditResult = {
  jobId: string
  message: string
}

/**
 * What `POST /v2/agent/parts-separation` answers with.
 *
 * The separated parts do not exist yet. Poll `getJob(jobId)`: a completed job
 * carries one `outputs` entry per part image that was produced, each with a
 * durable `assetId` and a signed `url`.
 */
export type QueuedPartsSeparationResult = {
  jobId: string
  message: string
}

export type QueuedImageResult = {
  execution?: CanvasExecution
  jobId: string
  imageGenId: string
  status: 'queued'
  modelId: string
  batchSize: number
  referenceImageCount: number
  aspectRatio?: string
  resolution?: number
  strength?: number
}

export type LanguageRequest = {
  prompt: string
  modelId?: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
}
export type VisionRequest = LanguageRequest & {
  modelId: string
  imageAssetIds: string[]
}
export type LanguageResult = {texts: string[]; jobId?: string}

export type ImageGenerationRequest = {
  projectContext?: {canvasId: number; version: number; sourceKeys?: string[]}
  moodboardRevisionId?: string
  executionContext?: ExecutionContext
  prompt: string
  modelId?: string
  batchSize?: number
  negativePrompt?: string
  seed?: number
  steps?: number
  cfgScale?: number
  resolution?: number
  aspectRatio?: string
  strength?: number
  strictOptions?: boolean
} & (
  | {source?: never; sources?: never}
  | {source: Source; sources?: never}
  | {source?: never; sources: [Source, ...Source[]]}
)

export type MeshGenerationRequest = {
  executionContext?: ExecutionContext
  name?: string
  faceLimit?: number
  isLowPoly?: boolean
  inputMode?: 'image' | 'multiview'
  params?: Record<string, string | number | boolean>
  strictOptions?: boolean
} & (
  | {
      modelId: string
      source: Source
      sources?: never
      executionContext?: ExecutionContext & {canvasNode?: never}
    }
  | {
      modelId: string
      source?: never
      sources: [Source, ...Source[]]
      executionContext?: ExecutionContext & {canvasNode?: never}
    }
  | {
      modelId?: string
      source?: never
      sources?: never
      executionContext: ExecutionContext & {canvasNode: {nodeId: string}}
    }
)

export type MeshOperation =
  | 'retopo_ai'
  | 'part_segmentation'
  | 'uv_unwrap'
  | 'texture_ai'

export type QueuedMeshOperationResult = {
  jobId: string
  meshGenId: string
  status: 'queued'
  operation: MeshOperation
}

export type TextMeshRequest = {
  prompt: string
  negativePrompt?: string
  model?: 'v3.1-20260211'
  faceLimit?: number
  quad?: boolean
  texture?: boolean
  pbr?: boolean
  textureQuality?: 'standard' | 'detailed'
  name?: string
}

export type QueuedCapabilityResult<Operation extends string> = {
  jobId: string
  meshGenId: string
  status: 'queued'
  operation: Operation
  message: string
}

export type QueuedRigCheckResult = Omit<
  QueuedCapabilityResult<'rig_check'>,
  'meshGenId'
>

export type RigCheckResult = {
  riggable: boolean
  rig_type: string
}

export type MeshDecimateRequest = {
  source: Source
  faceLimit?: number
  quad?: boolean
  bake?: boolean
  name?: string
}

export type MeshCompleteRequest = {
  meshGroupId: string
  partNames: string[]
  name?: string
}

export type MeshConvertFormat = 'gltf' | 'fbx' | 'usdz' | 'obj' | 'stl' | '3mf'

export type MeshConvertRequest = {
  source: Source
  format?: MeshConvertFormat
  quad?: boolean
  forceSymmetry?: boolean
  faceLimit?: number
  textureSize?: 512 | 1024 | 2048 | 4096 | 8192
  textureFormat?:
    | 'JPEG'
    | 'PNG'
    | 'WEBP'
    | 'BMP'
    | 'DPX'
    | 'HDR'
    | 'OPEN_EXR'
    | 'TARGA'
    | 'TIFF'
  bake?: boolean
  packUv?: boolean
  exportVertexColors?: boolean
  flattenBottom?: boolean
  flattenBottomThreshold?: number
  pivotToCenterBottom?: boolean
  scaleFactor?: number
  withAnimation?: boolean
  animateInPlace?: boolean
  partNames?: string[]
  exportOrientation?: '+x' | '-x' | '-y' | '+y'
  fbxPreset?: 'blender' | '3dsmax' | 'mixamo'
  name?: string
}

export type MeshConvertResult = QueuedCapabilityResult<'conversion'> & {
  targetFormat: MeshConvertFormat
}

export type RigType =
  | 'biped'
  | 'quadruped'
  | 'hexapod'
  | 'octopod'
  | 'avian'
  | 'serpentine'
  | 'aquatic'

export type RigRequest = {
  source: Source
  model?: 'v1.0-20240301' | 'v2.5-20260210'
  rigType?: RigType
  spec?: 'tripo' | 'mixamo'
  outFormat?: 'glb' | 'fbx'
  name?: string
}

export type RigCheckRequest = {
  source: Source
  name?: string
}

type RetargetBaseRequest = {
  resourceId: string
  outFormat?: 'glb' | 'fbx'
  bakeAnimation?: boolean
  exportWithGeometry?: boolean
  animateInPlace?: boolean
  name?: string
}

export type AnimationRetargetRequest = RetargetBaseRequest &
  (
    | {animation: string; animations?: never}
    | {animations: string[]; animation?: never}
  )

export type AnimationPresetsQuery = {
  model?: 'v1.0-20240301' | 'v2.5-20260210'
  rigType?: RigType
}

export type AnimationPreset = {
  id: string
  label: string
  tag: 'Basic' | 'Emotion' | 'Action' | 'Sport' | 'Dance' | 'Social'
  model: 'v1.0-20240301' | 'v2.5-20260210'
  rigType: RigType
}

export type AnimationPresetsResult = {
  items: AnimationPreset[]
  nextCursor: string | null
  recommendedModels: Partial<Record<RigType, 'v1.0-20240301' | 'v2.5-20260210'>>
}

export type WebhookEventType = 'job.completed' | 'job.failed' | 'balance.low'

export type WebhookSubscription = {
  id: string
  url: string
  description: string | null
  events: WebhookEventType[]
  enabled: boolean
  secretVersion: number
  previousSecretValidUntil: string | null
  createdAt: string
  updatedAt: string
}

export type WebhookSubscriptionWithSecret = WebhookSubscription & {
  /** Returned once on create or rotation. Store it immediately. */
  secret: string
}

export type WebhookSubscriptionUpdateResult = WebhookSubscription & {
  /** Present only when the request rotates the signing secret. */
  secret?: string
}

export type CreateWebhookRequest = {
  url: string
  description?: string | null
  events?: WebhookEventType[]
}

export type UpdateWebhookRequest = {
  url?: string
  description?: string | null
  enabled?: boolean
  events?: WebhookEventType[]
  rotateSecret?: boolean
}

export type WebhookDeliveryStatus =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'retryable_failed'
  | 'dead'

export type WebhookDelivery = {
  id: string
  eventId: string
  eventType: WebhookEventType
  status: WebhookDeliveryStatus
  attemptCount: number
  lastHttpStatus: number | null
  lastErrorCode: string | null
  lastResponseExcerpt: string | null
  nextAttemptAt: string
  deliveredAt: string | null
  createdAt: string
  updatedAt: string
}

export type IdempotentMutationOptions = {
  /**
   * API-key-scoped retry key, at most 200 characters. Reuse the same value
   * after a timeout or lost response to recover the original mutation result.
   * Paid queued calls also avoid reserving credits or submitting provider work
   * again.
   */
  idempotencyKey?: string
}

const idempotencyRequestInit = (
  options: IdempotentMutationOptions,
): {headers?: Record<string, string>} =>
  options.idempotencyKey == null
    ? {}
    : {headers: {'Idempotency-Key': options.idempotencyKey}}

export type ProductionOrderStatus =
  | 'draft'
  | 'analyzing'
  | 'ready'
  | 'in_progress'
  | 'completed'
  | 'failed'

export type ProductionPartExtractionMode = 'fast' | 'high_quality'
export type ProductionPartImageModelVariant =
  | 'nano_banana_2'
  | 'nano_banana_2_lite'
  | 'nano_banana_pro'
export type ProductionPartImageModelScope = 'isolate_only' | 'all_steps'
export type ProductionTransformModelVariant =
  | 'nano_banana_2'
  | 'nano_banana_pro'
export type ProductionPartImageModelResolvedVia = 'user' | 'default' | 'ab_gate'
export type ProductionTaskReviewStatus = 'approved' | 'rejected'
export type ProductionTargetPose = 'tpose' | 'apose'

export type CreditInfo = {
  shadowCredits: number
  billableCredits: number
  isFreeByAdminDashboardFlag: boolean
}

export type ProductionAnalyzeRequest = RequireAtLeastOne<
  {
    imageUrl?: string
    imageBlobLocation?: BlobLocation
    imageAssetId?: string
    uploadId?: string
    executionContext?: ExecutionContext
    agentVersion: string
    name?: string
  },
  'imageUrl' | 'imageBlobLocation' | 'imageAssetId' | 'uploadId'
>

export type ProductionAnalyzeResult = {
  execution?: CanvasExecution
  engine?: 'artifact-graph'
  graphId?: string
  orderId: string
  runId: string
  publicAccessToken: string
  agentVersion: string
  status: 'analyzing' | 'in_progress'
  credits?: CreditInfo
}

export type ProductionExecuteResult = {
  execution?: CanvasExecution
  orderId: string
  missionId: string
  runId: string
  publicAccessToken: string
  status: 'executing'
  agentVersion?: string | null
  tag?: string
  partExtractionMode?: ProductionPartExtractionMode | null
  effectiveOptions: ProductionEffectiveOptions
  confirmedParts?: string[]
  credits?: CreditInfo
}

export type ProductionExecuteRequest = {
  executionContext?: ExecutionContext
  orderId: string
  missionId: string
  confirmedTaskIds: string[]
  agentVersion: string
  partExtractionMode?: ProductionPartExtractionMode
  partImageModelVariant?: ProductionPartImageModelVariant
  partImageModelScope?: ProductionPartImageModelScope
  transformModelVariant?: ProductionTransformModelVariant
}

export type ProductionRunMode = 'approval' | 'full_auto'

/**
 * Reserved A/B overrides for a production run. A single mesh or part-image
 * value is applied to the dispatched run; fan-out is not enabled, so requests
 * that resolve to multiple variants are rejected by the server.
 */
export type ProductionRunAbAxes = {
  /** Mesh generation model IDs (axis a). */
  meshModelIds?: string[]
  /** Reserved style axis. Any non-empty value is currently rejected. */
  styleTargets?: string[]
  /** Part image model variants (axis d). */
  partImageModelVariants?: ProductionPartImageModelVariant[]
}

export type ProductionEffectiveOptions = {
  partExtractionMode: ProductionPartExtractionMode | null
  partImageModelVariant: ProductionPartImageModelVariant | null
  partImageModelScope: ProductionPartImageModelScope | null
  partImageModelResolvedVia: ProductionPartImageModelResolvedVia
  transformModelVariant: ProductionTransformModelVariant | null
}

export type ProductionRunRequest = {
  orderId: string
  missionId: string
  /** Task IDs to run. Defaults to every task in the mission when omitted. */
  confirmedTaskIds?: string[]
  agentVersion: string
  /** Defaults to full_auto for headless callers. */
  runMode?: ProductionRunMode
  partExtractionMode?: ProductionPartExtractionMode
  partImageModelVariant?: ProductionPartImageModelVariant
  partImageModelScope?: ProductionPartImageModelScope
  transformModelVariant?: ProductionTransformModelVariant
  /** Allowed mesh-gen model IDs for the auto-pipeline planning phase. */
  allowedModelIds?: string[]
  /** Reserved iteration control. Any explicit value currently returns 501. */
  maxIterations?: number
  /** Caller-supplied credit ceiling for the whole run. */
  maxCostCredits?: number
  /** Optional A/B axes (fan-out gated by the server). */
  abAxes?: ProductionRunAbAxes
}

export type ProductionRunResult = {
  orderId: string
  missionId: string
  runId: string
  publicAccessToken: string
  tag: string
  status: 'running' | 'executing'
  runMode: ProductionRunMode
  agentVersion?: string | null
  confirmedParts?: string[]
  maxIterations: number
  maxIterationsEnabled: false
  abVariantCount: number
  estimatedCostCredits: number
  maxCostCredits?: number | null
  effectiveOptions: ProductionEffectiveOptions & {meshModelIds: string[]}
  credits?: CreditInfo
}

export type MeshComposeRequest = {
  agentRuntime?: ComposerAgentRuntime
  agentVersion?: string
  mode?: 'quick' | 'quality'
  /** Every part: position xyz, quaternion xyzw, scale xyz. */
  transforms?: Record<string, number[]>
  targetCharacterHeightM?: number
  projectName?: string
  executionContext: ExecutionContext
} & (
  | {
      executionContext: ExecutionContext & {canvasNode?: never}
      parts: Omit<MeshComposerPart, 'volumeCentroid'>[]
      fullBodyImageAssetId: string
    }
  | {
      parts?: never
      fullBodyImageAssetId?: never
      executionContext: ExecutionContext & {canvasNode: {nodeId: string}}
    }
)

export type MeshTransform = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]
export type MeshRefinementMode =
  | 'standard'
  | 'thorough'
  | 'placement'
  | 'workshop'
  | 'blender'
export type MeshRefinementModeInfo = {
  id: MeshRefinementMode
  available: boolean
  reason?: string
  maxRounds: number
  budgetMs: number
}
export type MeshRefinementCapabilities = {
  defaultMode: 'standard'
  modes: MeshRefinementModeInfo[]
}
export type ComposerAgentRuntime = {
  provider: 'openrouter' | 'agents-api'
  model: string
}
export type MeshRefineRequest = {
  agentRuntime?: ComposerAgentRuntime
  parts: MeshComposerPart[]
  fullBodyImageAssetId: string
  transforms: Record<string, MeshTransform>
  referenceTransform?: MeshTransform
  mode?: MeshRefinementMode
  instruction: string
  maxRounds?: number
  executionContext: ExecutionContext
}
export type MeshRefineResult = {
  execution: CanvasExecution
  triggerRunId?: string
}
export type MeshComposerCapabilities = {
  models: Array<{id: string; label: string; modes: Array<'quick' | 'quality'>}>
  defaultModel: string
  modes: Array<'quick' | 'quality'>
}
export type MeshComposeResult = {
  execution: CanvasExecution
  triggerRunId?: string
}

export type ProductionAutomationImage = RequireAtLeastOne<
  {
    imageAssetId?: string
    imageUrl?: string
    imageBlobLocation?: BlobLocation
    uploadId?: string
  },
  'imageAssetId' | 'imageUrl' | 'imageBlobLocation' | 'uploadId'
>

export type ProductionAutomationConfig = {
  /** Prompt override used when cleanBackground is enabled. */
  cleanup?: {prompt: string}
  partEval?: boolean
  cleanBackground?: boolean
  normalizePose?: boolean
  /**
   * Part composition after mesh generation. Absent means ON (defaults to
   * `true`). Takes precedence over the deprecated `meshCompare.autoCompose`.
   */
  autoCompose?: boolean
  meshCompare?: {
    models?: string[]
    /** @deprecated Use the top-level `autoCompose`. Still honored. */
    autoCompose?: boolean
  }
}

export type ProductionAutomationRequest = {
  executionContext?: ExecutionContext
  images: ProductionAutomationImage[]
  config?: ProductionAutomationConfig
  agentVersion: string
  writeToCanvas?: boolean
  allowedModelIds?: string[]
  partExtractionMode?: ProductionPartExtractionMode
  name?: string
  maxCostCredits?: number
}

export type ProductionAutomationResult = {
  execution?: CanvasExecution
  batchId: string
  agentVersion: string
  estimatedCostCredits: number
  images: Array<{
    imageIndex: number
    orderId: string
    projectId: number
    url: string
    runId: string
    publicAccessToken: string
  }>
}

export type ProductionAutomationBatchStatusResult = {
  batchId: string
  images: Array<{
    orderId: string
    projectId: number | null
    imageIndex: number
    status: ProductionOrderStatus
    name: string | null
    url: string | null
    createdAt: string
    updatedAt: string
  }>
  summary: {
    total: number
    completed: number
    failed: number
    inProgress: number
  }
}

export type ProductionAgent = {
  agentVersion: string
  internalVersion: string
  label: string
  defaultAgent: boolean
  extractionModes: ProductionPartExtractionMode[]
  supportedRunModes: ProductionRunMode[]
  partImageModelVariants: ProductionPartImageModelVariant[]
  partImageModelScopes: ProductionPartImageModelScope[]
  transformModelVariants: ProductionTransformModelVariant[]
  supportedOnClassicEndpoint: boolean
  supportedOnAutomation: boolean
  supportedOnGraphEndpoint?: boolean
  graphEndpoint?: string
  requiresAnalysis?: boolean
}

export type ProductionFrontendSurfaceId =
  | 'session_chat_configure'
  | 'production_canvas'

export type ProductionFrontendOptionSource = {
  kind:
    | 'boolean_mapping'
    | 'inline'
    | 'internal_agent_profile'
    | 'internal_dynamic_catalog'
  catalog?: string
  values?: string[]
  filters?: string[]
}

export type ProductionApiOptionSource = {
  kind: 'inline' | 'response_collection' | 'response_values'
  path?: string
  valueField?: string
  values?: string[]
}

export type ProductionFrontendControl = {
  key: string
  label: string
  surfaces: ProductionFrontendSurfaceId[]
  apiFields: string[]
  frontendConditions?: string[]
  frontendOptionSource?: ProductionFrontendOptionSource
  apiOptionSource?: ProductionApiOptionSource
  constraintPath?: string
}

export type ProductionApiOnlyOption = ProductionFrontendControl & {
  apiOptionSource: ProductionApiOptionSource
}

export type ProductionFrontendOnlyControl = Omit<
  ProductionFrontendControl,
  'apiFields'
> & {
  apiFields?: string[]
  publicApiStatus: 'not_enabled' | 'not_exposed'
}

export type ProductionAgentsResult = {
  defaultAgent: string
  agents: ProductionAgent[]
  extractionModes: ProductionPartExtractionMode[]
  supportedRunModes: ProductionRunMode[]
  batchLimit: number
  maxIterations: number
  defaultIterations: number
  options: {
    partImageModels: {
      defaultVariant: ProductionPartImageModelVariant
      options: Array<{
        variant: ProductionPartImageModelVariant
        label: string
        default: boolean
        deprecated: boolean
        deprecationReason?: string
      }>
    }
    partImageModelScopes: {
      defaultScope: ProductionPartImageModelScope
      options: Array<{
        scope: ProductionPartImageModelScope
        default: boolean
        description: string
      }>
    }
    transformModels: {
      defaultVariant: ProductionTransformModelVariant | null
      options: Array<{
        variant: ProductionTransformModelVariant
        label: string
      }>
    }
    meshModels: {modelIds: string[]}
  }
  constraints: {
    run: {
      abFanOutEnabled: boolean
      maxAbVariants: number
      maxIterationsEnabled: boolean
      legacyMaxIterations: number
      legacyDefaultIterations: number
      unsupportedAxes: string[]
    }
    automation: {maxImages: number}
  }
  frontendControls: {
    visibility: 'internal_only'
    generalUserUiAvailable: false
    surfaces: Array<{
      id: ProductionFrontendSurfaceId
      label: string
      visibility: 'internal_only'
    }>
    selectableControls: ProductionFrontendControl[]
    apiOnlyOptions: ProductionApiOnlyOption[]
    frontendOnlyControls: ProductionFrontendOnlyControl[]
  }
  requiresAnalysis: boolean
}

export type ProductionSourceImageInput = {
  imageUrl?: string
  sourceImageUrl?: string
  imageBlobLocation?: BlobLocation
  sourceImageBlobLocation?: BlobLocation
  imageAssetId?: string
  sourceImageAssetId?: string
}

export type ProductionTaskReviewResult = {
  taskId: string
  status: ProductionTaskReviewStatus
  missionId?: string
  allResolved: boolean
  meshGenMissionId?: string
}

export type ProductionTaskRunResult = {
  taskId: string
  missionId?: string
  runId: string
  publicAccessToken: string
  regenerationExecutionId?: string
  status: 'processing'
  agentVersion?: string | null
}

export type ProductionPoseDetectResult = {
  orderId: string
  missionId: string
  route?: 'ml' | 'web-trigger'
  runId?: string
  publicAccessToken?: string
  status?: 'processing'
  output?: {
    detectedPose?: string
    poseType?: string
    poseName?: string
    isCharacter?: boolean
    confidence?: number
    [key: string]: unknown
  }
}

export type ProductionPoseTransformResult = {
  orderId: string
  targetPose: ProductionTargetPose
  runId: string
  publicAccessToken: string
  status: 'processing'
}

export type ProductionTaskOutput = {
  type?: string
  url?: string
  error?: string | null
  message?: string | null
  metadata?: {
    source?: unknown
    collageKey?: string
    [key: string]: unknown
  }
  [key: string]: unknown
} | null

export type ProductionTaskConfig = {
  canonicalKey?: string
  bboxNorm?: {
    xmin?: number
    ymin?: number
    xmax?: number
    ymax?: number
    [key: string]: unknown
  }
  confidence?: number
  detailedDescription?: string
  [key: string]: unknown
}

export type ProductionStatusSummary = {
  totalTasks: number
  completedTasks: number
  failedTasks: number
  pendingTasks: number
}

export type ProductionStatusResult = {
  order: {
    id: string
    name?: string
    status: ProductionOrderStatus
    createdAt?: string
    updatedAt?: string
  }
  missions: Array<{
    id: string
    type?: string
    status?: string
    orderIndex?: number
    agentVersion: string | null
    partExtractionMode?: ProductionPartExtractionMode | null
    suggestedParts?: string[]
    confirmedParts?: string[]
    bboxOverlay?: {
      artifactId?: string
      url?: string
      [key: string]: unknown
    } | null
    tasks: Array<{
      id: string
      name: string
      status: string
      output?: ProductionTaskOutput
      config?: ProductionTaskConfig
      createdAt?: string
      updatedAt?: string
    }>
    createdAt?: string
    updatedAt?: string
  }>
  summary?: ProductionStatusSummary
}

/**
 * One entry of an order's intervention log.
 *
 * `op` and `payload` are kept separate rather than returned as a parsed
 * `Intervention` so a row that fails the contract can still be listed:
 * `{op, ...payload}` is the contract object, and `contractError` explains the
 * row when it is not one. The listing reduces nothing, so a single malformed
 * historical row must not hide the rest of the trail.
 */
export type InterventionLogEntry = {
  seq: number
  op: InterventionOp | string
  payload: Record<string, unknown>
  actorKind: 'user' | 'api_key' | 'agent'
  actorUserId: string | null
  idempotencyKey: string | null
  createdAt: string
  /** Absent when `{op, ...payload}` satisfies the intervention contract. */
  contractError?: string
}

export type InterventionAppendResult = {
  orderId: string
  appendedCount: number
  /**
   * False when no `idempotencyKey` was supplied: the append happened, but a
   * replay of the same request would append the ops a second time. Stated
   * rather than implied so a caller cannot believe it had a guarantee it never
   * asked for.
   */
  idempotent: boolean
}

export type InterventionListResult = {
  orderId: string
  count: number
  /** True when the order's log exceeded the server's read ceiling. */
  truncated: boolean
  interventions: InterventionLogEntry[]
}

export type PollJobOptions = {
  intervalMs?: number
  timeoutMs?: number
  onPoll?: (job: Job) => void
}

export class AssetHubApiError extends Error {
  readonly status: number
  readonly code: string
  readonly payload: unknown
  readonly requestId?: string
  readonly runId?: string

  constructor({
    status,
    code,
    message,
    payload,
    requestId,
  }: {
    status: number
    code: string
    message: string
    payload: unknown
    requestId?: string
  }) {
    super(message)
    this.name = 'AssetHubApiError'
    this.status = status
    this.code = code
    this.payload = payload
    this.requestId = requestId
    const runId = (payload as ApiErrorPayload | null)?.error?.details?.runId
    this.runId = typeof runId === 'string' ? runId : undefined
  }
}

export class AssetHubWorkflowError extends Error {
  readonly event: WorkflowStreamEvent

  constructor(event: WorkflowStreamEvent) {
    const status =
      event.status ??
      (typeof event.payload?.status === 'string'
        ? event.payload.status
        : undefined) ??
      (typeof event.data?.status === 'string' ? event.data.status : undefined)
    super(
      `AssetHub workflow stream failed${status == null ? '' : `: ${status}`}`,
    )
    this.name = 'AssetHubWorkflowError'
    this.event = event
  }
}

const defaultBaseUrl = 'https://app.assethub.io'

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const normalizePath = (path: string): string =>
  path.startsWith('/') ? path : `/${path}`

const withQuery = (
  path: string,
  values: Record<string, string | number | undefined>,
): string => {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) searchParams.set(key, String(value))
  }
  const query = searchParams.toString()
  return query === '' ? path : `${path}?${query}`
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const isFormDataBody = (body: unknown): body is FormData =>
  typeof FormData !== 'undefined' && body instanceof FormData

const isFailedWorkflowEvent = (event: WorkflowStreamEvent): boolean => {
  const statuses = [event.status, event.payload?.status, event.data?.status]
  return (
    event.type === 'error' ||
    event.type === 'tool-error' ||
    event.type === 'workflow-error' ||
    event.type === 'workflow-step-error' ||
    statuses.some(
      status =>
        typeof status === 'string' &&
        ['failed', 'error', 'cancelled'].includes(status.toLowerCase()),
    )
  )
}

export class AssetHubClient {
  readonly baseUrl: string
  readonly apiKey: string
  readonly workspaceId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: AssetHubClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('AssetHub API key is required')
    }
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? defaultBaseUrl)
    this.apiKey = options.apiKey
    this.workspaceId = options.workspaceId
    this.fetchImpl = options.fetch ?? fetch
  }

  async request<T>(
    version: AssetHubApiVersion,
    path: string,
    init: RequestInit = {},
  ): Promise<ApiSuccess<T>> {
    const body = init.body
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/${version}${normalizePath(path)}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.workspaceId ? {'X-AssetHub-Workspace': this.workspaceId} : {}),
          ...(isFormDataBody(body) ? {} : {'Content-Type': 'application/json'}),
          ...(init.headers ?? {}),
        },
      },
    )

    const payload = (await response.json().catch(() => ({}))) as
      | ApiSuccess<T>
      | ApiErrorPayload

    if (!response.ok || payload.success !== true) {
      const errorPayload = payload as ApiErrorPayload
      const code = errorPayload.error?.code ?? 'UNKNOWN_ERROR'
      const message =
        errorPayload.error?.message ??
        `AssetHub API request failed with status ${response.status}`
      throw new AssetHubApiError({
        status: response.status,
        code,
        message,
        payload,
        requestId:
          errorPayload.error?.requestId ??
          response.headers.get('X-Request-ID') ??
          undefined,
      })
    }

    return payload as ApiSuccess<T>
  }

  private async *requestNdJson<T extends WorkflowStreamEvent>(
    version: AssetHubApiVersion,
    path: string,
    init: RequestInit,
  ): AsyncGenerator<T> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/${version}${normalizePath(path)}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.workspaceId ? {'X-AssetHub-Workspace': this.workspaceId} : {}),
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      },
    )
    if (!response.ok) {
      const payload = (await response
        .json()
        .catch(() => ({}))) as ApiErrorPayload
      throw new AssetHubApiError({
        status: response.status,
        code: payload.error?.code ?? 'UNKNOWN_ERROR',
        message:
          payload.error?.message ??
          `AssetHub API request failed with status ${response.status}`,
        payload,
        requestId:
          payload.error?.requestId ??
          response.headers.get('X-Request-ID') ??
          undefined,
      })
    }
    if (response.body == null) {
      throw new AssetHubApiError({
        status: response.status,
        code: 'EMPTY_STREAM',
        message: 'AssetHub workflow returned no stream body',
        payload: null,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const parseLine = (line: string): T | null => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return null
      const json = trimmed.startsWith('data:')
        ? trimmed.slice(5).trim()
        : trimmed
      return JSON.parse(json) as T
    }
    const emit = (line: string): T | null => {
      const event = parseLine(line)
      if (event != null && isFailedWorkflowEvent(event)) {
        throw new AssetHubWorkflowError(event)
      }
      return event
    }

    try {
      while (true) {
        const {done, value} = await reader.read()
        if (done) break
        buffer += decoder.decode(value, {stream: true})
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = emit(line)
          if (event != null) yield event
        }
      }
      buffer += decoder.decode()
      const event = emit(buffer)
      if (event != null) yield event
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  readonly v1 = {
    generateImage: async (
      body: {
        prompt: string
        imageBlobLocation?: BlobLocation
        imageUrl?: string
        modelId?: string
        batchSize?: number
        negativePrompt?: string
        seed?: number
        steps?: number
        cfgScale?: number
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedImageResult> =>
      (
        await this.request<QueuedImageResult>('v1', '/image/generate', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    getJob: async (jobId: string): Promise<Job> =>
      (
        await this.request<Job>('v1', `/jobs/${encodeURIComponent(jobId)}`, {
          method: 'GET',
        })
      ).data,

    getProductionAgents: async (): Promise<ProductionAgentsResult> =>
      (
        await this.request<ProductionAgentsResult>('v1', '/production/agents', {
          method: 'GET',
        })
      ).data,

    pollJob: async (
      jobId: string,
      options: PollJobOptions = {},
    ): Promise<Job> => {
      const intervalMs = options.intervalMs ?? 5000
      const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
      const startedAt = Date.now()

      while (Date.now() - startedAt <= timeoutMs) {
        const job = await this.v1.getJob(jobId)
        options.onPoll?.(job)
        if (job.status === 'completed' || job.status === 'failed') {
          return job
        }
        await sleep(intervalMs)
      }

      throw new Error(
        `Polling timeout: job=${jobId} did not reach terminal state within ${timeoutMs}ms`,
      )
    },

    analyzeProduction: async (
      body: ProductionAnalyzeRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<ProductionAnalyzeResult> =>
      (
        await this.request<ProductionAnalyzeResult>(
          'v1',
          '/production/analyze',
          {
            method: 'POST',
            ...idempotencyRequestInit(options),
            body: JSON.stringify(body),
          },
        )
      ).data,

    executeProduction: async (
      body: ProductionExecuteRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<ProductionExecuteResult> =>
      (
        await this.request<ProductionExecuteResult>(
          'v1',
          '/production/execute',
          {
            method: 'POST',
            ...idempotencyRequestInit(options),
            body: JSON.stringify(body),
          },
        )
      ).data,

    runProduction: async (
      body: ProductionRunRequest,
    ): Promise<ProductionRunResult> =>
      (
        await this.request<ProductionRunResult>('v1', '/production/run', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).data,

    runProductionAutomation: async (
      body: ProductionAutomationRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<ProductionAutomationResult> =>
      (
        await this.request<ProductionAutomationResult>(
          'v1',
          '/production/automation',
          {
            method: 'POST',
            ...idempotencyRequestInit(options),
            body: JSON.stringify(body),
          },
        )
      ).data,

    getProductionAutomationStatus: async (
      batchId: string,
    ): Promise<ProductionAutomationBatchStatusResult> =>
      (
        await this.request<ProductionAutomationBatchStatusResult>(
          'v1',
          `/production/automation/${encodeURIComponent(batchId)}`,
          {method: 'GET'},
        )
      ).data,

    reviewProductionTask: async (
      taskId: string,
      body: {
        status: ProductionTaskReviewStatus
        reason?: string
      },
    ): Promise<ProductionTaskReviewResult> =>
      (
        await this.request<ProductionTaskReviewResult>(
          'v1',
          `/production/tasks/${encodeURIComponent(taskId)}/review`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        )
      ).data,

    regenerateProductionTask: async (
      taskId: string,
      body: {userFeedback?: string} = {},
    ): Promise<ProductionTaskRunResult> =>
      (
        await this.request<ProductionTaskRunResult>(
          'v1',
          `/production/tasks/${encodeURIComponent(taskId)}/regenerate`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        )
      ).data,

    redetectProductionTask: async (
      taskId: string,
      body: ProductionSourceImageInput = {},
    ): Promise<ProductionTaskRunResult> =>
      (
        await this.request<ProductionTaskRunResult>(
          'v1',
          `/production/tasks/${encodeURIComponent(taskId)}/redetect`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        )
      ).data,

    detectProductionPose: async (
      body: {orderId: string; traceId?: string} & ProductionSourceImageInput,
    ): Promise<ProductionPoseDetectResult> =>
      (
        await this.request<ProductionPoseDetectResult>(
          'v1',
          '/production/pose-detect',
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        )
      ).data,

    transformProductionPose: async (
      body: {
        orderId: string
        targetPose: ProductionTargetPose
      } & ProductionSourceImageInput,
    ): Promise<ProductionPoseTransformResult> =>
      (
        await this.request<ProductionPoseTransformResult>(
          'v1',
          '/production/pose-transform',
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        )
      ).data,

    getProductionStatus: async (
      orderId: string,
      options: {signal?: AbortSignal} = {},
    ): Promise<ProductionStatusResult> =>
      (
        await this.request<ProductionStatusResult>(
          'v1',
          `/production/status/${encodeURIComponent(orderId)}`,
          {method: 'GET', signal: options.signal},
        )
      ).data,
  }

  readonly v2 = {
    languageText: async (
      body: LanguageRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<LanguageResult> =>
      (
        await this.request<LanguageResult>('v2', '/language/text', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    languageVision: async (
      body: VisionRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<LanguageResult> =>
      (
        await this.request<LanguageResult>('v2', '/language/vision', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    getCapabilities: async (): Promise<ApiCapabilities> =>
      (
        await this.request<ApiCapabilities>('v2', '/capabilities', {
          method: 'GET',
        })
      ).data,

    createCanvas: async (
      body: {name: string},
      options: {idempotencyKey: string},
    ): Promise<Canvas> =>
      (
        await this.request<Canvas>('v2', '/canvases', {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            clientOperationId: options.idempotencyKey,
          }),
          ...idempotencyRequestInit(options),
        })
      ).data,

    listCanvases: async (options: PageOptions = {}): Promise<Page<Canvas>> =>
      (
        await this.request<Page<Canvas>>(
          'v2',
          withQuery('/canvases', {...options}),
          {method: 'GET'},
        )
      ).data,

    getCanvas: async (canvasId: number): Promise<Canvas> =>
      (
        await this.request<Canvas>(
          'v2',
          `/canvases/${encodeURIComponent(canvasId)}`,
          {method: 'GET'},
        )
      ).data,

    exportCanvas: async (
      canvasId: number,
      options: {mesh?: string} = {},
    ): Promise<CanvasExport> =>
      (
        await this.request<CanvasExport>(
          'v2',
          withQuery(`/canvases/${encodeURIComponent(canvasId)}/export`, {
            ...options,
          }),
          {method: 'GET'},
        )
      ).data,

    getCanvasContext: async (canvasId: number): Promise<CanvasProjectContext> =>
      (
        await this.request<CanvasProjectContext>(
          'v2',
          `/canvases/${encodeURIComponent(canvasId)}/context`,
          {method: 'GET'},
        )
      ).data,

    putCanvasContext: async (
      canvasId: number,
      body: {document: Record<string, unknown>; expectedVersion?: number},
    ): Promise<CanvasProjectContext> =>
      (
        await this.request<CanvasProjectContext>(
          'v2',
          `/canvases/${encodeURIComponent(canvasId)}/context`,
          {method: 'PUT', body: JSON.stringify(body)},
        )
      ).data,

    appendCanvasLayout: async (
      canvasId: number,
      body: CanvasLayoutInput,
    ): Promise<CanvasLayoutResult> =>
      (
        await this.request<CanvasLayoutResult>(
          'v2',
          `/canvases/${encodeURIComponent(canvasId)}/layout`,
          {method: 'POST', body: JSON.stringify(body)},
        )
      ).data,

    importCanvasAsset: async (
      canvasId: number,
      body: {source: Source; name?: string},
    ): Promise<{assetId: string; mediaType: 'image'; canvasId: number}> =>
      (
        await this.request<{
          assetId: string
          mediaType: 'image'
          canvasId: number
        }>('v2', `/canvases/${encodeURIComponent(canvasId)}/assets`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).data,

    getAsset: async (
      assetId: string,
    ): Promise<{assetId: string; url: string; expiresAt: string}> =>
      (
        await this.request<{assetId: string; url: string; expiresAt: string}>(
          'v2',
          `/assets/${encodeURIComponent(assetId)}`,
          {method: 'GET'},
        )
      ).data,

    listMeshes: async (
      options: MeshListOptions = {},
    ): Promise<MeshListResult> =>
      (
        await this.request<MeshListResult>(
          'v2',
          withQuery('/meshes', {
            q: options.query,
            cursor: options.cursor,
            limit: options.limit,
          }),
          {method: 'GET'},
        )
      ).data,

    listGraphs: async (
      options: PageOptions = {},
    ): Promise<GraphListResult> =>
      (
        await this.request<GraphListResult>(
          'v2',
          withQuery('/graphs', {...options}),
          {method: 'GET'},
        )
      ).data,

    getGraph: async (
      graphId: string,
      options: HistoricalGraphOptions = {},
    ): Promise<HistoricalGraph> =>
      (
        await this.request<HistoricalGraph>(
          'v2',
          withQuery(`/graphs/${encodeURIComponent(graphId)}`, {
            source: options.source ?? 'generated',
            artifactId: options.artifactId,
            direction: options.direction,
            depth: options.depth,
          }),
          {method: 'GET'},
        )
      ).data,

    listMoodboards: async (
      options: PageOptions = {},
    ): Promise<{moodboards: Moodboard[]; nextCursor: string | null}> =>
      (
        await this.request<{
          moodboards: Moodboard[]
          nextCursor: string | null
        }>('v2', withQuery('/moodboards', {...options}), {method: 'GET'})
      ).data,

    createMoodboard: async (
      body: MoodboardInput & {clientOperationId: string},
    ): Promise<Moodboard> =>
      (
        await this.request<Moodboard>('v2', '/moodboards', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit({idempotencyKey: body.clientOperationId}),
        })
      ).data,

    getMoodboard: async (
      boardId: string,
      options: {signal?: AbortSignal} = {},
    ): Promise<Moodboard> =>
      (
        await this.request<Moodboard>(
          'v2',
          `/moodboards/${encodeURIComponent(boardId)}`,
          {method: 'GET', signal: options.signal},
        )
      ).data,

    updateMoodboard: async (
      boardId: string,
      body: MoodboardInput,
    ): Promise<Moodboard> =>
      (
        await this.request<Moodboard>(
          'v2',
          `/moodboards/${encodeURIComponent(boardId)}`,
          {method: 'PUT', body: JSON.stringify(body)},
        )
      ).data,

    archiveMoodboard: async (boardId: string): Promise<unknown> =>
      (
        await this.request<unknown>(
          'v2',
          `/moodboards/${encodeURIComponent(boardId)}`,
          {method: 'DELETE'},
        )
      ).data,

    analyzeMoodboard: async (
      boardId: string,
      body: {revisionId?: string} = {},
      options: {signal?: AbortSignal} = {},
    ): Promise<MoodboardRevision> =>
      (
        await this.request<MoodboardRevision>(
          'v2',
          `/moodboards/${encodeURIComponent(boardId)}/analyze`,
          {method: 'POST', body: JSON.stringify(body), signal: options.signal},
        )
      ).data,

    listCanvasRuns: async (
      canvasId: number,
      options: PageOptions = {},
    ): Promise<Page<CanvasExecution>> =>
      (
        await this.request<Page<CanvasExecution>>(
          'v2',
          withQuery(`/canvases/${encodeURIComponent(canvasId)}/runs`, {
            ...options,
          }),
          {method: 'GET'},
        )
      ).data,

    getRun: async (
      runId: string,
      options: {signal?: AbortSignal} = {},
    ): Promise<CanvasExecution> =>
      (
        await this.request<CanvasExecution>(
          'v2',
          `/runs/${encodeURIComponent(runId)}`,
          {method: 'GET', signal: options.signal},
        )
      ).data,

    listCanvasNodes: async (canvasId: number): Promise<CanvasNodesResult> =>
      (
        await this.request<CanvasNodesResult>(
          'v2',
          `/canvases/${encodeURIComponent(canvasId)}/nodes`,
          {method: 'GET'},
        )
      ).data,

    getCanvasGraph: async (
      canvasId: number,
      options: CanvasGraphOptions = {},
    ): Promise<CanvasGraph> =>
      (
        await this.request<CanvasGraph>(
          'v2',
          withQuery(`/canvases/${encodeURIComponent(canvasId)}/graph`, {
            ...options,
          }),
          {method: 'GET'},
        )
      ).data,

    submitEvaluation: async (
      body: EvaluationSubmission,
      options: IdempotentMutationOptions = {},
    ): Promise<Evaluation> =>
      (
        await this.request<Evaluation>('v2', '/evaluations/submissions', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    listEvaluations: async (
      options: PageOptions & {canvasId?: number; artifactId?: string} = {},
    ): Promise<Page<Evaluation>> =>
      (
        await this.request<Page<Evaluation>>(
          'v2',
          withQuery('/evaluations', {...options}),
          {method: 'GET'},
        )
      ).data,

    getEvaluation: async (evaluationId: string): Promise<Evaluation> =>
      (
        await this.request<Evaluation>(
          'v2',
          `/evaluations/${encodeURIComponent(evaluationId)}`,
          {method: 'GET'},
        )
      ).data,

    startEvaluation: async (
      body: {
        artifactId: string
        referenceAssetId: string
        evaluatorId: string
        executionContext: ExecutionContext
      },
      options: IdempotentMutationOptions = {},
    ): Promise<{execution: CanvasExecution}> =>
      (
        await this.request<{execution: CanvasExecution}>('v2', '/evaluations', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    importFile: async (body: {
      url: string
      /** Defaults to image when omitted. */
      mediaType?: FileMediaType
    }): Promise<FileImportResult> =>
      (
        await this.request<FileImportResult>('v2', '/files/import', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).data,

    uploadFile: async ({
      file,
      fileName,
      mediaType,
    }: {
      file: Blob
      fileName: string
      mediaType: FileMediaType
    }): Promise<FileImportResult> => {
      const formData = new FormData()
      formData.append('file', file, fileName)
      formData.append('mediaType', mediaType)
      return (
        await this.request<FileImportResult>('v2', '/files/upload', {
          method: 'POST',
          body: formData,
        })
      ).data
    },

    /** Stage-0 endpoint: reserve a private upload target for files up to 150 MiB. */
    presignFile: async (body: {
      fileName: string
      mediaType: FileMediaType
      size: number
      contentType?: string
    }): Promise<LargeUploadReservation> =>
      (
        await this.request<LargeUploadReservation>('v2', '/files/presign', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).data,

    /** Stage-0 endpoint: verify a signed upload and start its 24-hour retention. */
    completeFile: async (uploadId: string): Promise<CompletedLargeUpload> =>
      (
        await this.request<CompletedLargeUpload>('v2', '/files/complete', {
          method: 'POST',
          body: JSON.stringify({uploadId}),
        })
      ).data,

    /**
     * Stage-0 convenience flow: reserve, upload directly to private storage,
     * and verify. The API key is never sent to the storage origin.
     */
    uploadLargeFile: async ({
      file,
      fileName,
      mediaType,
    }: {
      file: Blob
      fileName: string
      mediaType: FileMediaType
    }): Promise<CompletedLargeUpload> => {
      const reservation = await this.v2.presignFile({
        fileName,
        mediaType,
        size: file.size,
        ...(file.type === '' ? {} : {contentType: file.type}),
      })
      const formData = new FormData()
      formData.append('cacheControl', '3600')
      formData.append(
        '',
        file.slice(0, file.size, reservation.contentType),
        fileName,
      )
      const uploadResponse = await this.fetchImpl(reservation.uploadUrl, {
        method: 'PUT',
        headers: {'x-upsert': 'false'},
        body: formData,
      })
      if (!uploadResponse.ok) {
        throw new AssetHubApiError({
          status: uploadResponse.status,
          code: 'SIGNED_UPLOAD_PUT_FAILED',
          message: `AssetHub signed upload failed with status ${uploadResponse.status}`,
          payload: {uploadId: reservation.uploadId},
        })
      }
      return this.v2.completeFile(reservation.uploadId)
    },

    generateImage: async (
      body: ImageGenerationRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedImageResult> =>
      (
        await this.request<QueuedImageResult>('v2', '/image/generate', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /**
     * Queue an image edit and get back the job to poll.
     *
     * This used to stream NDJSON, which meant a dropped connection lost an
     * edit that had finished and been charged. The result now lives on the
     * job, so it survives the connection that started it.
     */
    editImage: async (
      body: {
        source: Source
        goalId:
          | 'face separation'
          | 'Sketch + Geometry'
          | '3D Render/Figure'
          | 'Clean Up'
        prompt?: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedImageEditResult> =>
      (
        await this.request<QueuedImageEditResult>('v2', '/image/edit', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /**
     * Queue a multiview generation and get back the job to poll.
     *
     * This used to stream NDJSON, which meant a dropped connection lost a
     * generation that had finished and been charged. The result now lives on
     * the job, so it survives the connection that started it.
     */
    generateMultiview: async (
      body: {
        source: Source
        goalId: '2-view' | '4-view' | '6-view'
        prompt?: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedMultiviewResult> =>
      (
        await this.request<QueuedMultiviewResult>('v2', '/image/multiview', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /**
     * Queue a parts separation and get back the job to poll.
     *
     * This used to stream NDJSON, which meant a dropped connection lost a
     * separation that had finished and been charged. The result now lives on
     * the job, so it survives the connection that started it.
     */
    separateImageParts: async (
      body: {
        source: Source
        goalId: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedPartsSeparationResult> =>
      (
        await this.request<QueuedPartsSeparationResult>(
          'v2',
          '/agent/parts-separation',
          {
            method: 'POST',
            body: JSON.stringify(body),
            ...idempotencyRequestInit(options),
          },
        )
      ).data,

    getMeshComposers: async (): Promise<MeshComposerCapabilities> =>
      (await this.request<MeshComposerCapabilities>('v2', '/mesh/compose'))
        .data,

    getMeshRefinementModes: async (): Promise<MeshRefinementCapabilities> =>
      (await this.request<MeshRefinementCapabilities>('v2', '/mesh/refine'))
        .data,

    composeMesh: async (
      body: MeshComposeRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<MeshComposeResult> =>
      (
        await this.request<MeshComposeResult>('v2', '/mesh/compose', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    refineMesh: async (
      body: MeshRefineRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<MeshRefineResult> =>
      (
        await this.request<MeshRefineResult>('v2', '/mesh/refine', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    generateMesh: async (
      body: MeshGenerationRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedMeshResult> =>
      (
        await this.request<QueuedMeshResult>('v2', '/generate/mesh', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /** Generate a Tripo 3.1 mesh directly from text. */
    generateMeshFromText: async (
      body: TextMeshRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedCapabilityResult<'text_to_3d'>> =>
      (
        await this.request<QueuedCapabilityResult<'text_to_3d'>>(
          'v2',
          '/generate/mesh/text',
          {
            method: 'POST',
            body: JSON.stringify(body),
            ...idempotencyRequestInit(options),
          },
        )
      ).data,

    /** Reduce polygon count with Tripo Smart Low-Poly. */
    decimateMesh: async (
      body: MeshDecimateRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedCapabilityResult<'decimation'>> =>
      (
        await this.request<QueuedCapabilityResult<'decimation'>>(
          'v2',
          '/mesh/decimate',
          {
            method: 'POST',
            body: JSON.stringify(body),
            ...idempotencyRequestInit(options),
          },
        )
      ).data,

    /** Complete selected parts from a segmentation group. */
    completeMeshParts: async (
      body: MeshCompleteRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedCapabilityResult<'part_completion'>> =>
      (
        await this.request<QueuedCapabilityResult<'part_completion'>>(
          'v2',
          '/mesh/complete',
          {
            method: 'POST',
            body: JSON.stringify(body),
            ...idempotencyRequestInit(options),
          },
        )
      ).data,

    /** Convert an owned mesh and export format. */
    convertMesh: async (
      body: MeshConvertRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<MeshConvertResult> =>
      (
        await this.request<MeshConvertResult>('v2', '/mesh/convert', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /** Check riggability. Poll the job as PublicJob<RigCheckResult>. */
    checkRig: async (
      body: RigCheckRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedRigCheckResult> =>
      (
        await this.request<QueuedRigCheckResult>('v2', '/rig/check', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /** Generate a Tripo or Mixamo-compatible rig. */
    rigMesh: async (
      body: RigRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedCapabilityResult<'rig'>> =>
      (
        await this.request<QueuedCapabilityResult<'rig'>>('v2', '/rig', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /** Apply preset animation(s) to a completed rig resource. */
    retargetAnimation: async (
      body: AnimationRetargetRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedCapabilityResult<'animation_retarget'>> =>
      (
        await this.request<QueuedCapabilityResult<'animation_retarget'>>(
          'v2',
          '/animations/retarget',
          {
            method: 'POST',
            body: JSON.stringify(body),
            ...idempotencyRequestInit(options),
          },
        )
      ).data,

    /**
     * Zero-credit catalogue browse. Lists animation preset ids, labels, and
     * tags for the given model/rigType filter (either or both may be
     * omitted) without queuing a job or requiring a completed rig first.
     */
    listAnimationPresets: async (
      query: AnimationPresetsQuery = {},
    ): Promise<AnimationPresetsResult> =>
      (
        await this.request<AnimationPresetsResult>(
          'v2',
          withQuery('/animations/presets', {
            model: query.model,
            rigType: query.rigType,
          }),
          {method: 'GET'},
        )
      ).data,

    retopo: async (
      body: {
        source: Source
        modelId: string
        faceLevel?: string
        polygonType?: string
        name?: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedMeshOperationResult> =>
      (
        await this.request<QueuedMeshOperationResult>('v2', '/mesh/retopo', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    segment: async (
      body: {
        source: Source
        modelId?: 'meshProcess.tripo_part_segmentation'
        granularity?: 'simple' | 'balanced' | 'detailed'
        name?: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedMeshOperationResult> =>
      (
        await this.request<QueuedMeshOperationResult>('v2', '/mesh/segment', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    uvUnwrap: async (
      body: {
        source: Source
        modelId: string
        name?: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedMeshOperationResult> =>
      (
        await this.request<QueuedMeshOperationResult>('v2', '/mesh/uv-unwrap', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    texture: async (
      body: {
        source: Source
        modelId?: string
        prompt?: string
        style_prompt?: string
        referenceSource?: Source
        textureQuality?: 'detailed' | 'extreme'
        texture_quality?: 'detailed' | 'extreme'
        enablePBR?: boolean
        pbr?: boolean
        name?: string
      },
      options: IdempotentMutationOptions = {},
    ): Promise<QueuedMeshOperationResult> =>
      (
        await this.request<QueuedMeshOperationResult>('v2', '/mesh/texture', {
          method: 'POST',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    getJob: async (jobId: string): Promise<Job> =>
      (
        await this.request<Job>('v2', `/jobs/${encodeURIComponent(jobId)}`, {
          method: 'GET',
        })
      ).data,

    /** Stage-0 endpoint: non-internal API keys receive NOT_FOUND. */
    listJobs: async (options: JobListOptions = {}): Promise<JobListResult> =>
      (
        await this.request<JobListResult>(
          'v2',
          withQuery('/jobs', {
            status: options.status,
            domain: options.domain,
            limit: options.limit,
            cursor: options.cursor,
          }),
          {method: 'GET'},
        )
      ).data,

    /** Stage-0 endpoint: non-internal API keys receive NOT_FOUND. */
    queryJobs: async (jobIds: string[]): Promise<JobQueryResult> =>
      (
        await this.request<JobQueryResult>('v2', '/jobs/query', {
          method: 'POST',
          body: JSON.stringify({jobIds}),
        })
      ).data,

    /** Stage-0 endpoint: non-internal API keys receive NOT_FOUND. */
    cancelJob: async (jobId: string): Promise<JobCancellationResult> =>
      (
        await this.request<JobCancellationResult>(
          'v2',
          `/jobs/${encodeURIComponent(jobId)}/cancel`,
          {method: 'POST'},
        )
      ).data,

    /** Stage-0 endpoint: non-internal API keys receive NOT_FOUND. */
    getAccount: async (): Promise<AccountResult> =>
      (await this.request<AccountResult>('v2', '/account', {method: 'GET'}))
        .data,

    /** Stage-0 endpoint: non-internal API keys receive NOT_FOUND. */
    getAccountUsage: async (
      options: AccountUsageOptions = {},
    ): Promise<AccountUsageResult> =>
      (
        await this.request<AccountUsageResult>(
          'v2',
          withQuery('/account/usage', {
            limit: options.limit,
            cursor: options.cursor,
            from: options.from,
            to: options.to,
          }),
          {method: 'GET'},
        )
      ).data,

    /** Stage-0 endpoint: read the owner-wide low-credit alert state. */
    getCreditAlert: async (): Promise<CreditAlert> =>
      (
        await this.request<CreditAlert>('v2', '/account/credit-alert', {
          method: 'GET',
        })
      ).data,

    /** Stage-0 endpoint: configure the owner-wide balance.low trigger. */
    updateCreditAlert: async (
      body: UpdateCreditAlertRequest,
      options: IdempotentMutationOptions = {},
    ): Promise<CreditAlert> =>
      (
        await this.request<CreditAlert>('v2', '/account/credit-alert', {
          method: 'PATCH',
          body: JSON.stringify(body),
          ...idempotencyRequestInit(options),
        })
      ).data,

    /** Delete the exact owner-wide alert revision without overwriting changes. */
    deleteCreditAlert: async (configToken: string): Promise<CreditAlert> =>
      (
        await this.request<CreditAlert>('v2', '/account/credit-alert', {
          method: 'DELETE',
          headers: {'If-Match': `"${configToken}"`},
        })
      ).data,

    /** Stage-0 endpoint: list owner-scoped webhook subscriptions. */
    listWebhooks: async (): Promise<WebhookSubscription[]> =>
      (
        await this.request<{subscriptions: WebhookSubscription[]}>(
          'v2',
          '/webhooks',
          {method: 'GET'},
        )
      ).data.subscriptions,

    /**
     * Stage-0 endpoint. The signing secret is returned once; create is
     * intentionally not idempotent because plaintext secret replay is unsafe.
     */
    createWebhook: async (
      body: CreateWebhookRequest,
    ): Promise<WebhookSubscriptionWithSecret> =>
      (
        await this.request<WebhookSubscriptionWithSecret>('v2', '/webhooks', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).data,

    /** Stage-0 endpoint: read one webhook without exposing its secret. */
    getWebhook: async (subscriptionId: string): Promise<WebhookSubscription> =>
      (
        await this.request<WebhookSubscription>(
          'v2',
          `/webhooks/${encodeURIComponent(subscriptionId)}`,
          {method: 'GET'},
        )
      ).data,

    /**
     * Stage-0 endpoint. rotateSecret returns a new one-time secret and keeps
     * the previous secret valid for 24 hours.
     */
    updateWebhook: async (
      subscriptionId: string,
      body: UpdateWebhookRequest,
    ): Promise<WebhookSubscriptionUpdateResult> =>
      (
        await this.request<WebhookSubscriptionUpdateResult>(
          'v2',
          `/webhooks/${encodeURIComponent(subscriptionId)}`,
          {method: 'PATCH', body: JSON.stringify(body)},
        )
      ).data,

    /** Stage-0 endpoint: idempotently delete an owned webhook. */
    deleteWebhook: async (
      subscriptionId: string,
      options: IdempotentMutationOptions = {},
    ): Promise<{deleted: true; id: string}> =>
      (
        await this.request<{deleted: true; id: string}>(
          'v2',
          `/webhooks/${encodeURIComponent(subscriptionId)}`,
          {
            method: 'DELETE',
            ...(options.idempotencyKey == null
              ? {}
              : {headers: {'Idempotency-Key': options.idempotencyKey}}),
          },
        )
      ).data,

    /** Stage-0 endpoint: inspect recent webhook delivery state. */
    listWebhookDeliveries: async (
      subscriptionId: string,
      options: {limit?: number} = {},
    ): Promise<{deliveries: WebhookDelivery[]; hasMore: boolean}> =>
      (
        await this.request<{
          deliveries: WebhookDelivery[]
          hasMore: boolean
        }>(
          'v2',
          withQuery(
            `/webhooks/${encodeURIComponent(subscriptionId)}/deliveries`,
            {limit: options.limit},
          ),
          {method: 'GET'},
        )
      ).data,

    /** Stage-0 endpoint: requeue a failed/dead delivery with safe replay. */
    retryWebhookDelivery: async (
      subscriptionId: string,
      deliveryId: string,
      options: IdempotentMutationOptions = {},
    ): Promise<{deliveryId: string; status: 'pending'}> =>
      (
        await this.request<{deliveryId: string; status: 'pending'}>(
          'v2',
          `/webhooks/${encodeURIComponent(subscriptionId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
          {
            method: 'POST',
            ...(options.idempotencyKey == null
              ? {}
              : {headers: {'Idempotency-Key': options.idempotencyKey}}),
          },
        )
      ).data,

    pollJob: async (
      jobId: string,
      options: PollJobOptions = {},
    ): Promise<Job> => {
      const intervalMs = options.intervalMs ?? 5000
      const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
      const startedAt = Date.now()

      while (Date.now() - startedAt <= timeoutMs) {
        const job = await this.v2.getJob(jobId)
        options.onPoll?.(job)
        if (job.status === 'completed' || job.status === 'failed') {
          return job
        }
        await sleep(intervalMs)
      }

      throw new Error(
        `Polling timeout: job=${jobId} did not reach terminal state within ${timeoutMs}ms`,
      )
    },

    /**
     * Appends interventions to a production order's log.
     *
     * Pass `idempotencyKey` when the call can be retried: the server derives a
     * per-op key from it, so a replayed batch collides on every op instead of
     * only the first. Without one the append is not idempotent, and the result's
     * `idempotent: false` says so.
     *
     * A failed append is an error, not a quiet partial success. Because each op
     * is one write rather than one transaction, an `AssetHubApiError` with code
     * `INTERVENTION_APPEND_FAILED` can mean part of the batch landed — call
     * `listInterventions` to find out which.
     */
    appendInterventions: async (
      orderId: string,
      interventions: Intervention[],
      options: {idempotencyKey?: string} = {},
    ): Promise<InterventionAppendResult> =>
      (
        await this.request<InterventionAppendResult>(
          'v2',
          `/production/${encodeURIComponent(orderId)}/interventions`,
          {
            method: 'POST',
            body: JSON.stringify({interventions}),
            ...(options.idempotencyKey == null
              ? {}
              : {headers: {'Idempotency-Key': options.idempotencyKey}}),
          },
        )
      ).data,

    listInterventions: async (
      orderId: string,
    ): Promise<InterventionListResult> =>
      (
        await this.request<InterventionListResult>(
          'v2',
          `/production/${encodeURIComponent(orderId)}/interventions`,
          {method: 'GET'},
        )
      ).data,

    /** Return models together with the public-only credit-plan price table. */
    listModelCatalog: async (
      options: ModelListOptions = {},
    ): Promise<ModelCatalogResult> =>
      (
        await this.request<ModelCatalogResult>(
          'v2',
          withQuery('/models', {
            domain: options.domain,
            capability: options.capability,
          }),
          {method: 'GET'},
        )
      ).data,

    /** Compatibility helper that returns only the model rows. */
    listModels: async (
      options: ModelListOptions = {},
    ): Promise<ModelSummary[]> =>
      (await this.v2.listModelCatalog(options)).models,

    getModel: async (modelId: string): Promise<ModelDetail> =>
      (
        await this.request<{model: ModelDetail}>(
          'v2',
          `/models/${encodeURIComponent(modelId)}`,
          {method: 'GET'},
        )
      ).data.model,
  }
}

export const createAssetHubClient = (
  options: AssetHubClientOptions,
): AssetHubClient => new AssetHubClient(options)
