// packages/assethub-cli/src/meshReview/errors.ts
import type {MeshReviewProject} from './projects.js'
import {FEATURE_NOT_AVAILABLE_MESSAGE, isFeatureNotAvailableError} from '../networkErrors.js'
import {MeshReviewSyncError} from './syncMeshReview.js'

export type MeshReviewErrorContext = {profile: string; workspaceId?: string | undefined}

const where = (ctx: MeshReviewErrorContext): string =>
  `profile "${ctx.profile}", ${ctx.workspaceId ? `workspace ${ctx.workspaceId}` : 'no workspace selected (key default)'}`

/**
 * CLI wording for the access failures the server reports to internal keys. Only the server message,
 * the profile name and the workspace id are printed; the API key never is.
 */
export const explainMeshReviewError = (error: MeshReviewSyncError, ctx: MeshReviewErrorContext): string => {
  switch (error.code) {
    case 'MESH_REVIEW_GATE_DISABLED':
      return `Mesh Review is turned off for this account (Statsig gate mesh_review_enabled). Used ${where(ctx)}. Ask an AssetHub admin to enable it for you.`
    case 'MESH_REVIEW_FORBIDDEN_ROLE':
      return `This key's owner needs the Production Control producer or production_admin role in the key's workspace. Used ${where(ctx)}. Ask a workspace admin to grant the role, or switch profile with --profile.`
    case 'MESH_REVIEW_PROJECT_NOT_FOUND':
      return `${error.message} Used ${where(ctx)}. Run "assethub mesh-review projects" to see the projects this key can use, or switch workspace/profile.`
    case 'PROJECT_AMBIGUOUS':
      return `${error.message} Run "assethub mesh-review projects" and pass the project id to --project.`
    default:
      return isFeatureNotAvailableError(error) ? FEATURE_NOT_AVAILABLE_MESSAGE : error.message
  }
}

export const formatMeshReviewProjects = (projects: MeshReviewProject[]): string =>
  projects.length === 0
    ? 'No projects in this key\'s workspace. Create one in Production Control, or check --profile / --workspace.'
    : projects.map(project => `${project.id}  ${project.name}`).join('\n')

export const formatMeshReviewProjectCreated = (project: MeshReviewProject & {created: boolean}): string =>
  `${project.id}  ${project.name}${project.created ? '' : '  (already existed)'}`
