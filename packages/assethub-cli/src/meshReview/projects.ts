// packages/assethub-cli/src/meshReview/projects.ts
import {MESH_REVIEW_API_PREFIX, meshReviewCall} from './syncMeshReview.js'

export type MeshReviewProject = {id: string; name: string; created_at: string}

const PAGE_LIMIT = 100
// 100 per page * 50 pages = 5,000 projects in one workspace; far beyond any real org, still bounded.
const MAX_PAGES = 50

export const listMeshReviewProjects = async (input: {
  baseUrl: string
  apiKey: string
  workspaceId?: string | undefined
  fetchImpl?: typeof fetch
}): Promise<MeshReviewProject[]> => {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const base = `${input.baseUrl.replace(/\/+$/, '')}${MESH_REVIEW_API_PREFIX}/projects`
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    ...(input.workspaceId ? {'x-assethub-workspace': input.workspaceId} : {}),
  }
  const projects: MeshReviewProject[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `limit=${PAGE_LIMIT}${cursor != null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const envelope = await meshReviewCall(fetchImpl, `${base}?${query}`, {method: 'GET', headers})
    const data = envelope.data as {projects?: MeshReviewProject[]; nextCursor?: string | null}
    projects.push(...(data.projects ?? []))
    cursor = data.nextCursor ?? null
    if (cursor == null) break
  }
  return projects
}

export type CreatedMeshReviewProject = MeshReviewProject & {created: boolean}

export const createMeshReviewProject = async (input: {
  baseUrl: string
  apiKey: string
  name: string
  workspaceId?: string | undefined
  fetchImpl?: typeof fetch
}): Promise<CreatedMeshReviewProject> => {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const url = `${input.baseUrl.replace(/\/+$/, '')}${MESH_REVIEW_API_PREFIX}/projects`
  const envelope = await meshReviewCall(fetchImpl, url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
      ...(input.workspaceId ? {'x-assethub-workspace': input.workspaceId} : {}),
    },
    body: JSON.stringify({name: input.name}),
  })
  return envelope.data as CreatedMeshReviewProject
}
