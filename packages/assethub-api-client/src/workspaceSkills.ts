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
  evidence: WorkspaceSkillEvidence[]
  uncertainties: string[]
  derivedFrom: {
    skillId: string | null
    revision: number | null
    contentSha256: string | null
    evidenceKeys: string[]
  }
}

export type WorkspaceSkill = WorkspaceSkillBase &
  (
    | {schemaVersion: 'ag.memory-skill.v1'}
    | {
        schemaVersion: 'ag.memory-skill.v2'
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
  )

export type WorkspaceSkillSummary = {
  summary: string
  taskKind: 'part_separation' | 'concept_art' | 'part_composition' | null
  phase: WorkspaceSkillPhase | null
  origin: 'workspace'
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
  skill: WorkspaceSkill
  canEdit: boolean
  mode: WorkspaceSkillMode
  scope: 'artist' | 'project' | 'organization'
  grantRevision: number
  authorId: string | null
  revisions: {revision: number; content_sha256: string}[]
}

export type WorkspaceSkillUpdate = Pick<
  WorkspaceSkill,
  'title' | 'goal' | 'applicability' | 'steps'
> & {
  expectedRevision: number
  expectedGrantRevision: number
  restoreRevision?: number
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
