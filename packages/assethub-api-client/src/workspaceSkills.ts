export type WorkspaceSkillMode = 'automatic' | 'manual' | 'off'
export type WorkspaceSkillPhase = 'plan' | 'generate' | 'review' | 'repair'
export type WorkspaceSkillPurpose = 'generation' | 'correction'

export type WorkspaceSkillEvidenceRef = {
  graphId: string
  artifactId: string
  contentSha256: string
  sourceRevision: number
}

export type WorkspaceSkillEvidence = WorkspaceSkillEvidenceRef & {
  key: string
  rootArtifactId: string
  contentReference: string
  decisionKind:
    | 'creator_approved'
    | 'creator_rejected'
    | 'artist_modified'
    | 'ai_accepted'
    | 'ai_rejected'
    | 'operation_succeeded'
    | 'operation_failed'
    | 'publisher_approved'
  decisionRecordId: string
}

export type WorkspaceSkillImageEvidence = Omit<
  WorkspaceSkillEvidence,
  'decisionKind'
> & {
  kind: 'workspace_image'
  decisionKind: Exclude<
    WorkspaceSkillEvidence['decisionKind'],
    'publisher_approved'
  >
}

export type WorkspaceSkillPublisherPolicyEvidence = {
  kind: 'publisher_policy'
  key: string
  publisherId: string
  releaseId: string
  sourceSkillId: string
  sourceSkillRevision: number
  sourceSnapshotSha256: string
  reviewRecordId: string
  reviewRecordSha256: string
  decisionKind: 'publisher_approved'
}

export type WorkspaceSkillApplicability = {
  category: string
  partKinds: string[]
  requiredTraits: string[]
  issueKinds: string[]
  exclusions: string[]
  requiredReferenceRoles: string[]
}

export type WorkspaceSkillStep = {
  stepId: string
  operation: string
  inputRoles: string[]
  dependsOn: string[]
  instruction: string
  preserve: string[]
  checks: string[]
  /** v4 and v5: which acceptance criteria this step satisfies. */
  criteria?: string[]
  /** v5 only: what this step was learned from (`sources[].key`). */
  basis?: WorkspaceSkillCitationBasis
  supports?: string[]
  counterexamples?: string[]
  /** v6 only: who runs the step, what judges it, where a failure goes. */
  run?: WorkspacePipelineStepRun
  gate?: WorkspacePipelineStepGate
  onFail?: WorkspacePipelineFailureRoute[]
  /** v6 only: paths of the skill `documents` this step relies on. */
  documents?: string[]
}

/** v6: a file the pipeline carries (reference doc, record template, helper
 *  script or agent config), stored byte for byte. Never execute a `script`
 *  without showing it to the user first; `reviewBeforeRun` is always true. */
export type WorkspacePipelineDocument = {
  path: string
  kind: 'instructions' | 'reference' | 'template' | 'script' | 'config'
  mediaType:
    | 'text/markdown'
    | 'application/json'
    | 'text/x-python'
    | 'text/yaml'
    | 'text/plain'
  content: string
  reviewBeforeRun: boolean
}

/** v6: who performs one pipeline step. `operation` is the AssetHub operation
 *  to call (e.g. `POST /v2/image/generate`), or null for judgement, human
 *  review or local tooling; `model` is a hint the runner may substitute. */
export type WorkspacePipelineStepRun = {
  executor:
    | 'llm'
    | 'vlm'
    | 'image_model'
    | 'mesh_model'
    | 'blender'
    | 'code'
    | 'human'
  operation: string | null
  model: string | null
}

/** v6: what decides whether a step's output may be used. */
export type WorkspacePipelineStepGate = {
  kind: 'vlm' | 'human' | 'schema' | 'geometry' | 'job_status' | 'none'
  /** Judge model hint for a `vlm` gate; `escalateTo` is the stronger judge. */
  model: string | null
  escalateTo: string | null
}

/** v6: where a failed step goes, by where the defect came from. */
export type WorkspacePipelineFailureRoute = {
  when: 'image' | 'mesh' | 'interface' | 'transform' | 'unknown' | 'any'
  goTo: string
  maxAttempts: number
}

type WorkspaceSkillBase = {
  skillId: string
  revision: number
  contentSha256: string
  purpose: WorkspaceSkillPurpose
  title: string
  goal: string
  applicability: WorkspaceSkillApplicability
  steps: WorkspaceSkillStep[]
  /** v1-v4 only ever hold strings; a v5 body may hold either, so a reader
   *  has to handle both shapes. */
  uncertainties: (
    | string
    | {
        id: string
        text: string
        basis?: WorkspaceSkillCitationBasis
        supports?: string[]
        counterexamples?: string[]
      }
  )[]
  derivedFrom: {
    skillId: string | null
    revision: number | null
    contentSha256: string | null
    evidenceKeys: string[]
  }
}

type WorkspaceSkillFields = {
  origin: 'workspace' | 'official'
  taskKind: 'part_separation' | 'concept_art' | 'part_composition'
  phase: WorkspaceSkillPhase
  workflowRef: {
    graphId: string
    nodeId: string
    sourceRevision: number
    contentSha256: string
  } | null
  budgetRequirements: {maxOperations: number; maxRepairs: number}
}

/** What "good" means for a built skill. `must` gates a run; `should` is advice. */
export type WorkspaceSkillAcceptanceCriterion = {
  id: string
  text: string
  severity: 'must' | 'should'
}

/** What going wrong looks like — drawn from the attempts that were rejected. */
export type WorkspaceSkillFailureMode = {id: string; text: string}

/** Where in the evidence the builder found the method. */
export type WorkspaceSkillReference =
  | {
      kind: 'canvas_graph'
      canvasId: number
      graphId: string
      sourceRevision: number
      nodeIds: string[]
      why: string
    }
  | {
      kind: 'memory_path'
      memoryId: string
      graphId: string
      sourceRevision: number
      nodeIds: string[]
      why: string
    }

export type WorkspaceSkillBuildProvenance = {
  buildId: string
  source: 'canvas_graph' | 'memory_path'
  model: string
  promptVersion: number
}

export type WorkspaceSkill = WorkspaceSkillBase &
  (
    | {schemaVersion: 'ag.memory-skill.v1'; evidence: WorkspaceSkillEvidence[]}
    | (WorkspaceSkillFields & {
        schemaVersion: 'ag.memory-skill.v2'
        evidence: WorkspaceSkillEvidence[]
      })
    | (WorkspaceSkillFields & {
        schemaVersion: 'ag.memory-skill.v3'
        evidence: (
          | WorkspaceSkillImageEvidence
          | WorkspaceSkillPublisherPolicyEvidence
        )[]
      })
    // A BUILT skill. It carries no bound workflow, so replay refuses it with
    // 422 SKILL_NOT_REPLAYABLE, and its `evidence` may be empty because its
    // provenance lives in `references` and `build` instead.
    | (WorkspaceSkillFields & {
        schemaVersion: 'ag.memory-skill.v4'
        evidence: WorkspaceSkillImageEvidence[]
        instructions: string
        acceptanceCriteria: WorkspaceSkillAcceptanceCriterion[]
        failureModes: WorkspaceSkillFailureMode[]
        references: WorkspaceSkillReference[]
        build: WorkspaceSkillBuildProvenance
      })
    // v4 plus the citation layer: `sources` names everything citable, and each
    // rule names which of them backs it or contradicts it. Replay refuses it
    // for the same reason it refuses v4.
    | (WorkspaceSkillFields & {
        schemaVersion: 'ag.memory-skill.v5'
        evidence: WorkspaceSkillImageEvidence[]
        instructions: string
        acceptanceCriteria: (WorkspaceSkillAcceptanceCriterion &
          WorkspaceSkillCitation)[]
        failureModes: (WorkspaceSkillFailureMode & WorkspaceSkillCitation)[]
        references: WorkspaceSkillReference[]
        sources: WorkspaceSkillSource[]
        repair: {stopConditions: string[]} | null
        build: WorkspaceSkillBuildProvenance & {
          compiler: {
            kind: 'skill_builder' | 'ag_compiler'
            manifestSha256?: string | null
            runId?: string | null
            validationSha256?: string | null
          }
        }
      })
    // A pipeline: one skill whose ordered steps chain a whole
    // workflow, each step carrying `run`, `gate` and `onFail`. No AssetHub
    // runtime applies it; fetch it and execute it with an agent.
    | {
        schemaVersion: 'ag.memory-skill.v6'
        // `official` installs from a release (one publisher policy);
        // `workspace` is authored via POST /workspace-skills/pipelines (none).
        origin: 'workspace' | 'official'
        taskKind: 'pipeline'
        phase: 'plan'
        workflowRef: null
        budgetRequirements: {maxOperations: number; maxRepairs: number}
        evidence: WorkspaceSkillPublisherPolicyEvidence[]
        instructions: string
        documents: WorkspacePipelineDocument[]
      }
  )

/** Every schema the Skill Builder produces. A built skill carries no bound
 *  workflow, so replay refuses it with 422 SKILL_NOT_REPLAYABLE — keyed on the
 *  set rather than on one literal, so a later version is one entry here and not
 *  a hunt through every caller that meant "built". */
export const BUILT_WORKSPACE_SKILL_VERSIONS = [
  'ag.memory-skill.v4',
  'ag.memory-skill.v5',
] as const
export const isBuiltWorkspaceSkill = (skill: {
  schemaVersion: string
}): boolean =>
  (BUILT_WORKSPACE_SKILL_VERSIONS as readonly string[]).includes(
    skill.schemaVersion,
  )

export type WorkspaceSkillCitationBasis =
  | 'observation'
  | 'generalization'
  | 'proposed_check'
  | null

/** What one rule was learned from. Both lists name a `sources[].key`. */
export type WorkspaceSkillCitation = {
  basis?: WorkspaceSkillCitationBasis
  supports?: string[]
  counterexamples?: string[]
}

/** A graph source is located in a stored revision. A behaviour event is not —
 *  it carries the id the canvas export minted for it instead. */
export type WorkspaceSkillSource =
  | {
      kind:
        | 'goal'
        | 'memory'
        | 'trajectory'
        | 'image'
        | 'evaluation'
        | 'human_decision'
      key: string
      graphId: string
      nodeId: string
      sourceRevision: number
      contentSha256?: string | null
      canvasId?: number | null
      memoryId?: string | null
    }
  | {
      kind: 'behavior_event'
      key: string
      eventSource: string
      eventRowId: string
      canvasId: number
    }

export type WorkspaceSkillBuildSource =
  | {kind: 'canvas_graph'; canvasIds: number[]}
  | {kind: 'memory_path'; memoryIds: string[]}

/** The end result a built skill delivers. part_separation works for every
 *  account; the others need the v7 Skill Builder (400 TASK_KIND_NOT_SUPPORTED). */
export const WORKSPACE_SKILL_BUILD_TASK_KINDS = [
  'part_separation',
  'concept_art',
  'part_composition',
  'mesh_generation',
  'mesh_processing',
  'rigging_animation',
  'character_production',
] as const

export type WorkspaceSkillBuildInput = {
  goal: string
  instructions?: string
  taskKind: (typeof WORKSPACE_SKILL_BUILD_TASK_KINDS)[number]
  source: WorkspaceSkillBuildSource
}

export type WorkspaceSkillBuildStatus =
  | 'queued'
  | 'loading_source'
  | 'analyzing'
  | 'drafting'
  | 'ready'
  | 'accepted'
  | 'discarded'
  | 'failed'
  | 'cancelled'

/** A build a person has not decided on yet will never change again. */
export const TERMINAL_WORKSPACE_SKILL_BUILD_STATUSES: WorkspaceSkillBuildStatus[] =
  ['accepted', 'discarded', 'failed', 'cancelled']

export type WorkspaceSkillBuild = {
  buildId: string
  status: WorkspaceSkillBuildStatus
  /** The goal the build was started with, as written. */
  goal: string
  /** ISO timestamp the build was started. */
  createdAt: string
  progress: {step: number; of: 4}
  source: WorkspaceSkillBuildSource
  graphs: unknown[]
  /** Present once status is ready. Nothing is published until it is accepted. */
  draft: WorkspaceSkill | null
  skill: {skillId: string; revision: number} | null
  error: {code: string; detail: string | null} | null
  credits: {
    reserved: number
    settled: number | null
    /** `reservation_missing` means the hold was reaped and the usage went
     *  unbilled — a financial signal, not noise. */
    settlement: 'settled' | 'reservation_missing' | 'failed' | null
  }
}

export type WorkspaceSkillBuildAcceptInput = {
  /** The draft hash you reviewed. A mismatch returns 409 DRAFT_CHANGED rather
   *  than publishing bytes you were never shown. */
  expectedDraftSha256: string
  edits?: Record<string, unknown>
}

export type WorkspaceSkillSummary = {
  summary: string
  /** `pipeline` is a v6 skill: a whole workflow for an agent to execute. */
  taskKind:
    | 'part_separation'
    | 'concept_art'
    | 'part_composition'
    | 'pipeline'
    | null
  phase: WorkspaceSkillPhase | null
  origin: 'workspace' | 'official'
  officialSkillId: string | null
  officialRevision: number | null
  skillId: string
  revision: number
  grantRevision: number
  mode: WorkspaceSkillMode
  scope: 'artist' | 'project' | 'organization'
  authorId: string | null
}

export type WorkspaceSkillListResult = {
  items: WorkspaceSkillSummary[]
  canEdit: boolean
  nextCursor: string | null
}

export type WorkspaceSkillDetail = {
  orgId?: string
  skill: WorkspaceSkill
  canEdit: boolean
  mode: WorkspaceSkillMode
  scope: 'artist' | 'project' | 'organization'
  grantRevision: number
  authorId: string | null
  officialSkillId: string | null
  officialRevision: number | null
  publisher: {
    publisherId: string
    releaseId: string
    manifestSha256: string
    revoked: boolean
    sourceSnapshot: Record<string, unknown>
    reviewRecord: Record<string, unknown>
  } | null
  revisions: {revision: number; content_sha256: string}[]
}

export type OfficialWorkspaceSkillSummary = {
  skill: WorkspaceSkill
  publisherId: string
  releaseId: string
  manifestSha256: string
  sourceSnapshot: Record<string, unknown>
  reviewRecord: Record<string, unknown>
  installedRevision: number | null
  grantRevision: number | null
  mode: WorkspaceSkillMode | null
  updateAvailable: boolean
}

export type OfficialWorkspaceSkillList = {
  items: OfficialWorkspaceSkillSummary[]
  canEdit: boolean
}

export type OfficialWorkspaceSkillInstall = {
  revision: number
  expectedRevision: number | null
  expectedGrantRevision: number | null
  confirmedContentSha256: string
}

export type OfficialWorkspaceSkillCustomize = {
  body: unknown
  expectedSourceRevision: number
  expectedSourceGrantRevision: number
  confirmedContentSha256: string
}

export type OfficialWorkspaceSkillCustomizationPrepare = Pick<
  WorkspaceSkill,
  'title' | 'goal' | 'applicability' | 'steps'
> & {
  targetSkillId: string
  expectedSourceRevision: number
  expectedSourceGrantRevision: number
}

export type WorkspaceSkillUpdate = Pick<
  WorkspaceSkill,
  'title' | 'goal' | 'applicability' | 'steps'
> & {
  expectedRevision: number
  expectedGrantRevision: number
  restoreRevision?: number
  confirmedContentSha256?: string
}

export type WorkspaceSkillControls = {
  expectedRevision: number
  expectedGrantRevision: number
  mode: WorkspaceSkillMode
  share?: boolean
}

export type WorkspaceSkillLearnInput = {
  graphId: string
  evidenceRefs: WorkspaceSkillEvidenceRef[]
  purpose: WorkspaceSkillPurpose
  phase: WorkspaceSkillPhase
  autoRevision?: boolean
  parentSkillId?: string
}

export type WorkspaceSkillLearnResult = {
  graphId: string
  rootArtifactId: string
  skillId: string
}

export type WorkspaceSkillProposalPrepareInput = {
  graphId: string
  artifactId: string
  projectId?: number
  taskKind?: 'concept_art' | 'part_separation'
}

export type WorkspaceSkillProposalPrepareResult =
  | {status: 'task_choice_required' | 'execution_unverified'}
  | {status: 'prepared'; proposalId: string; state: string}
  | {
      status: 'waiting_for_archive'
      source: WorkspaceSkillProposalPrepareInput & {projectId: number}
    }

export type WorkspaceSkillProposalSummary = {
  proposalId: string
  state: string
  version: number
  authorId: string
  snoozedUntil: string | null
  confirmationTarget: WorkspaceSkillEvidenceRef | null
  canAccept: boolean
  eligibility: string | null
  draft: {
    draftSha256: string
    candidate: Omit<
      Extract<WorkspaceSkill, {schemaVersion: 'ag.memory-skill.v2'}>,
      'contentSha256'
    >
  } | null
  results: Array<{
    reference: WorkspaceSkillEvidenceRef
    imageUrl: string
    beforeImages: Array<{
      artifactId: string
      contentSha256: string
      imageUrl: string
    }>
  }>
  publication:
    | ({skillId: string; revision: number; contentSha256: string} & {
        graphId: string
        artifactId: string
      })
    | null
  error: string | null
}

export type WorkspaceSkillProposalAcceptInput = {
  expectedVersion: number
  draftSha256: string
  result: WorkspaceSkillEvidenceRef
}

export type WorkspaceSkillPublication = {
  skillId: string
  revision: number
  contentSha256: string
  graphId: string
  artifactId: string
}

/** Display metadata from the actual image queue; clients cannot supply this as authority. */
export type WorkspaceSkillAdmissionDecision =
  | {
      status: 'applied'
      operationId: string
      stepId: string
      receipt: {
        schemaVersion: 'ag.workspace-skill-run.v1'
        operationId: string
        taskKind: 'concept_art' | 'part_composition'
        phase: 'plan' | 'generate' | 'review' | 'repair'
        selection: {mode: 'auto' | 'manual'; explicitSkillIds: string[]}
        catalogRevision: number
        selectedSkills: {
          skillId: string
          skillRevision: number
          contentSha256: string
          grantRevision: number
          evidenceFingerprint: string
        }[]
        workflowRef: {
          graphId: string
          nodeId: string
          sourceRevision: number
          contentSha256: string
        } | null
      }
    }
  | {
      status: 'skipped'
      operationId: string
      reason:
        | 'gate_unavailable'
        | 'unsupported_inputs'
        | 'ambiguous_brief'
        | 'unsupported_provider'
        | 'output_capacity'
        | 'no_compatible_skill'
        | 'lookup_unavailable'
      exclusions: {skillId: string; revision: number; reason: string}[]
    }

export type WorkspaceSkillReview = {
  outputAssetId: string
  status: 'pending' | 'pass' | 'needs_human_review' | 'unverified' | 'cancelled'
  canResume: boolean
  canCancel: boolean
  usage: {
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    cost: number | null
  }
}
/** One memorized path a match run surfaced. `memoryId` is what a skill build
 *  takes in `source.memoryIds`. */
export type MemoryMatchCandidate = {
  memoryId?: string
  headline?: string
  goalType?: string
  scope?: string
  canvasId?: number
  [key: string]: unknown
}

/**
 * A match run. `searching` means the walk is still going — poll by calling
 * again with the same query rather than treating it as empty.
 */
export type MemoryMatchResult = {
  matchId: string
  expiresAt?: string
  status: 'searching' | 'ready' | 'failed'
  reason?: string
  preparedMemoryId?: string
  candidates?: MemoryMatchCandidate[]
  steps?: unknown[]
}

export type MemoryMatchInput = {
  goal?: string
  imageAssetId?: string
  imageUrl?: string
}

export const WORKSPACE_SKILL_ENHANCE_SECTIONS = [
  'title',
  'goal',
  'instructions',
  'acceptanceCriteria',
  'failureModes',
  'steps',
  'applicability',
] as const
export type WorkspaceSkillEnhanceSection =
  (typeof WORKSPACE_SKILL_ENHANCE_SECTIONS)[number]

/** A suggestion for ONE section. Nothing is written: applying it is the
 *  reviewer's act, and accepting the draft is still a separate call. */
export type WorkspaceSkillEnhanceResult = {
  section: WorkspaceSkillEnhanceSection
  suggestion: unknown
  model: string
  promptVersion: number
  enhanceCount: number
}

/** The partial v4 body as the model writes it. Everything `submit_skill_draft`
 *  stamps (identity, goal, instructions, each reference's graph facts, build)
 *  is filled in server-side from `buildId` -- or a placeholder without one --
 *  never read from this field. */
export type WorkspaceSkillDraftValidateInput = {
  skill: Record<string, unknown>
  /** When present, checks every reference against that build's real graphs
   *  (`referencesChecked: true`). Without it, only schema and structure are
   *  checked. */
  buildId?: string
}

/** FREE. Never a 4xx for an invalid draft -- invalid is a result.
 *
 * Without `buildId` there is no build to give the draft a real identity or
 * provenance, so `contentSha256` is absent -- a hash over a placeholder
 * buildId/model is not one `build-accept` would recognize, so it is never
 * returned. Only the `buildId`-scoped, `referencesChecked: true` result
 * carries a usable hash. */
export type WorkspaceSkillDraftValidateResult =
  | {valid: true; referencesChecked: false}
  | {valid: true; contentSha256: string; referencesChecked: true}
  | {
      valid: false
      /** One entry per issue, as "path: message". */
      errors: string[]
      referencesChecked: boolean
    }

/** What the builder agent is told, sourced straight from the same
 *  contract/prompt modules `submit_skill_draft` uses. */
export type WorkspaceSkillDraftSchema = {
  promptVersion: number
  shape: string
  /** Fields the model never writes -- the server fills every one. */
  stampedFields: string[]
  enums: {
    phases: string[]
    operations: string[]
    roles: string[]
    severities: string[]
    sourceKinds: string[]
    citationBases: string[]
  }
  limits: {
    steps: {min: number; max: number}
    acceptanceCriteria: {min: number; max: number}
    failureModes: {min: number; max: number}
    references: {min: number; max: number}
    uncertainties: {min: number; max: number}
    sources: {min: number; max: number}
  }
}

/** FREE and read-only for credits: what `POST .../builds` would do, without
 *  doing it. `estimatedCredits` may be `null` when pricing cannot be
 *  resolved. */
export type WorkspaceSkillBuildDryRunResult = {
  wouldStart: true
  source: 'canvas_graph' | 'memory_path'
  canvasIds?: number[]
  memoryIds?: string[]
  estimatedCredits: number | null
  /** Wall clock this source will be given, in whole minutes. Grows with the
   *  number of canvases or memory paths: a build costs one model turn per
   *  round, and rounds grow with the source. A budget, not a prediction. */
  estimatedMinutes: number
  promptVersion: number
}

/**
 * Per-reference outcome of `getSkillMemoryLinks`. A Skill can outlive the
 * memory it cites, so one dead reference is a status, never a failed request.
 *
 * `graph_not_found` covers BOTH a graph that does not exist and one this
 * workspace does not own — the server keeps those two indistinguishable on
 * purpose, so do not branch on it as if it meant "deleted". An infrastructure
 * failure is deliberately NOT one of these: the request fails instead, so an
 * outage is never reported as a vanished memory.
 */
export type SkillMemoryRefStatus =
  | 'resolved'
  | 'graph_not_found'
  | 'node_not_found'
  | 'not_a_graph_reference'
  | 'not_resolved_truncated'

export type SkillMemoryTrajectory = {
  memoryId: string
  headline: string | null
  description: string | null
  goalType: string | null
  keywords: string[]
}

export type SkillMemoryNode = {
  id: string
  artifactKind: string
  semanticType?: string
  tags: string[]
  title?: unknown
  /** Whether `getGraphNodeImage(graphId, id)` would serve bytes. An image over
   *  that endpoint's size cap is still `true` here and answers 413 there. */
  hasImage: boolean
}

/** What resolving one `(graphId, nodeId)` pair produced. Each citing shape
 *  below intersects this with its OWN fields — they are deliberately not
 *  merged into one type, because a workflow reference does not carry
 *  evidence's `key`/`artifactId`/`decisionKind` and must not be typed as if
 *  it did. */
export type SkillMemoryResolution = {
  status: SkillMemoryRefStatus
  /** `graphId:nodeId` — the same handle `startMemoryReplay` accepts, so a
   *  cited memory can be replayed without reassembling the id. Absent only for
   *  a reference that names no graph at all. */
  memoryId?: string
  node?: SkillMemoryNode
  trajectory?: SkillMemoryTrajectory
}

/** One `evidence[]` entry. A v3 `publisher_policy` entry names no graph and
 *  comes back with `not_a_graph_reference`, which is why the graph fields are
 *  nullable here. */
export type SkillMemoryRef = SkillMemoryResolution & {
  key: string | null
  kind: string
  graphId: string | null
  artifactId: string | null
  contentSha256: string | null
  sourceRevision: number | null
  decisionKind: string | null
}

/** The canvas trajectory a LEARNED skill was bound to. Null on a built
 *  (`ag.memory-skill.v4`) skill, which records its provenance in
 *  `references` instead. */
export type SkillMemoryWorkflowRef = SkillMemoryResolution & {
  graphId: string
  nodeId: string
  sourceRevision: number | null
  contentSha256: string | null
}

/** One node of a `references[]` entry. */
export type SkillMemoryReferenceNode = SkillMemoryResolution & {nodeId: string}

/** One `references[]` entry of a BUILT skill: a graph plus the nodes in it the
 *  Skill Builder drew the method from. This is the only provenance shape a
 *  built skill is guaranteed to have. */
export type SkillMemoryReference = {
  kind: string
  /** Present when `kind` is `canvas_graph`. */
  canvasId?: number
  /** The `memoryId` the reference itself cited, present when `kind` is
   *  `memory_path`. Distinct from each resolved node's own `memoryId`. */
  sourceMemoryId?: string
  graphId: string | null
  sourceRevision: number | null
  why: string | null
  nodes: SkillMemoryReferenceNode[]
}

export type SkillMemoryLinks = {
  skillId: string
  revision: number
  contentSha256: string
  schemaVersion?: string
  workflowRef: SkillMemoryWorkflowRef | null
  evidence: SkillMemoryRef[]
  references: SkillMemoryReference[]
  /** Over EVERY graph-shaped citation listed: workflowRef, evidence entries
   *  and reference nodes alike. */
  counts: {total: number; resolved: number; unresolved: number}
  /** True when the Skill cites more distinct memories than one call resolves;
   *  the extra refs are still listed, with `not_resolved_truncated`. */
  truncated: boolean
}

/** A skill run's state, as `GET /workspace-skills/{skillId}/runs/{runId}` answers. */
export type WorkspaceSkillRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'budget_exhausted'
  | 'cancelled'

export const TERMINAL_WORKSPACE_SKILL_RUN_STATUSES: readonly WorkspaceSkillRunStatus[] =
  ['completed', 'failed', 'cancelled']

export type WorkspaceSkillRunReference = {
  role: string
  assetId: string
  note?: string
}

export type WorkspaceSkillRunStartInput = {
  clientOperationId: string
  canvasId: number
  /** The image the skill starts from: an image asset on that canvas. */
  sourceImageAssetId: string
  budgetCredits: number
  ask?: string
  authorModel?: string
  /** Refuse instead of charge when the skill changed after it was read. */
  expectedRevision?: number
  expectedContentSha256?: string
  references?: WorkspaceSkillRunReference[]
  executionContext?: {
    canvasId: number
    clientOperationId: string
    source: 'cli' | 'mcp' | 'api'
    agent?: {name: string; sessionId?: string}
  }
}

export type WorkspaceSkillRunStarted = {
  runId: string
  skillId: string
  canvasId: number
  pin: {skillId: string; revision: number; contentSha256: string}
  budget: {credits: number}
  status: 'running'
}

export type WorkspaceSkillRunStep = {
  stepId: string
  stage: string
  /** The first try is 1. */
  attempt: number
  status: string
  artifactId: string
  assetId?: string
  part?: string
}

export type WorkspaceSkillRunVerdict = {
  stepId: string
  attempt: number
  pass: boolean | null
  by: string | null
  reason: string | null
}

export type WorkspaceSkillRunOutput = {
  artifactId: string
  stepId: string | null
  kind: 'image' | 'mesh' | 'json'
  assetId?: string
  /** True only once the goal is met and the outcome names this artifact. */
  verified: boolean
}

export type WorkspaceSkillRun = {
  runId: string
  skillId: string
  status: WorkspaceSkillRunStatus
  budget: {credits: number; spentCredits: number; remainingCredits: number}
  steps: WorkspaceSkillRunStep[]
  verdicts: WorkspaceSkillRunVerdict[]
  outputs: WorkspaceSkillRunOutput[]
  outcome: {status: string; reason?: string; [key: string]: unknown} | null
  parts: {
    id: string
    key: string
    note: string
    status: string
    finals: string[]
    reason: string
  }[]
  /** Present only where the Looks right / Needs changes gate is on. */
  humanVerdict?: unknown
}

export type WorkspaceSkillRunResumeInput = {
  clientOperationId: string
  addCredits: number
}

export type WorkspaceSkillRunVerdictInput = {
  verdict: 'keep' | 'not_right'
  note?: string
}

export type WorkspaceSkillRunHumanVerdictResult = {
  runId: string
  humanVerdict: {verdict: 'keep' | 'not_right'; note: string | null; by: string}
}
