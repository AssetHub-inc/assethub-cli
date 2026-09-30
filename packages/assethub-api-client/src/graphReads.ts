/**
 * Read-only view of a memorized artifact graph (`artifact_graph_snapshot`) --
 * the same store the Skill Builder's own agent tools read. Distinct from
 * `HistoricalGraph` in `historical.ts`, which reads the authority/generated
 * store instead.
 */

/**
 * Length bounds the server documents (and the MCP tool schemas must mirror)
 * for the two path identifiers on this read surface --
 * `GET /graphs/{graphId}/...` and `GET /canvases/{canvasId}/graph-id`. Single
 * source of truth for both the frontend's OpenAPI contract
 * (`app/api/v2/openapi/_spec/graphReads.ts`) and `assethub-mcp`'s
 * `graphTools.ts`, so the two cannot drift the way they did before (the MCP
 * schema allowed 300-character graphIds against a 200-character contract).
 */
export const MEMORIZED_GRAPH_ID_MAX_LENGTH = 200
export const MEMORIZED_GRAPH_NODE_ID_MAX_LENGTH = 300

/**
 * Cap on the RAW (pre-base64) bytes `GET /graphs/{graphId}/nodes/{nodeId}/image`
 * will serve, shared by the route's own enforcement
 * (`exposedApi/serverUtil/publicOps/graphReads.ts`) and this contract's
 * OpenAPI description so the two numbers cannot drift apart.
 *
 * Vercel's function response body limit is 4.5 MiB (4.5 * 1024 * 1024 =
 * 4,718,592 bytes). Base64 inflates raw bytes by 4/3, and the JSON success
 * envelope the route wraps the image in adds further bytes on top of that.
 * 3 MiB (3 * 1024 * 1024 = 3,145,728 bytes) raw base64-encodes to exactly
 * 4 MiB (4,194,304 bytes), leaving 524,288 bytes (512 KiB) of headroom under
 * the 4.5 MiB platform limit for the envelope and any other response bytes.
 */
export const MAX_GRAPH_IMAGE_HTTP_RESPONSE_BYTES = 3 * 1024 * 1024

export type MemorizedGraphNodeSummary = {
  id: string
  artifactKind: string
  semanticType?: string
  tags: string[]
  title: string
}

export type MemorizedGraphSnapshot = {
  graphId: string
  lastRev: number
  nodeCount: number
  edgeCount: number
  nodes: MemorizedGraphNodeSummary[]
  /** Pass as `offset` to read the next page; null once exhausted. */
  nextOffset: number | null
}

export type GraphSnapshotOptions = {
  offset?: number
  /** Capped at the same page size (80) the Skill Builder agent's own tool uses. */
  limit?: number
}

export type MemorizedGraphEdgeRef = {id: string; from: string; to: string}

export type MemorizedGraphNode = {
  graphId: string
  id: string
  artifactKind: string
  semanticType?: string
  tags: string[]
  metadata: Record<string, unknown>
  payload: unknown
  edges: {
    incoming: MemorizedGraphEdgeRef[]
    outgoing: MemorizedGraphEdgeRef[]
  }
}

export type MemorizedGraphNodeImage = {
  mediaType: string
  /** Base64-encoded image bytes, no `data:` prefix. */
  data: string
  /** Decoded byte length of `data`. */
  bytes: number
}

export type CanvasGraphIds = {
  canvasId: number
  memorizeGraphId: string
  memorizeSnapshotExists: boolean
  exportGraphId: string
  exportSnapshotExists: boolean
}
