export type WorkspaceSkillMode = 'automatic' | 'manual' | 'off'
export type WorkspaceSkillPhase = 'plan' | 'generate' | 'review' | 'repair'
export type WorkspaceSkillPurpose = 'generation' | 'correction'

export type WorkspaceSkillEvidenceRef = {
  graphId: string
  artifactId: string
  contentSha256: string
  sourceRevision: number
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

export type WorkspaceSkill = {
  schemaVersion: 'ag.memory-skill.v1' | 'ag.memory-skill.v2'
  skillId: string
  revision: number
  contentSha256: string
  purpose: WorkspaceSkillPurpose
  title: string
  goal: string
  applicability: WorkspaceSkillApplicability
  steps: WorkspaceSkillStep[]
  evidence: Array<WorkspaceSkillEvidenceRef & Record<string, unknown>>
  uncertainties: string[]
  derivedFrom: {
    skillId: string | null
    revision: number | null
    contentSha256: string | null
    evidenceKeys: string[]
  }
  origin?: 'workspace' | 'official'
  taskKind?: 'part_separation' | 'concept_art' | 'part_composition'
  phase?: WorkspaceSkillPhase
}

export type WorkspaceSkillSummary = {
  summary: string
  taskKind: WorkspaceSkill['taskKind'] | null
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
  canAccept: boolean
  eligibility: string | null
  draft: {
    draftSha256: string
    candidate: Omit<WorkspaceSkill, 'contentSha256'>
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
