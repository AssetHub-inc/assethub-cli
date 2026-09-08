// Port of assethub-ml research/artifact-graph/artifact-graph-py/
// artifact_graph/graph/blob_refs.py — the walk that decides which blobs a graph
// can reach. The registry compares its own walk's output against the blobs a
// snapshot declares, so the qualification rules, the dedupe (first wins) and
// the sort-by-key order all have to stay identical.
//
// Taken from the identical port in
// apps/frontend/src/feature/artifactGraph/export/blobRefs.ts. Only
// `reachableBlobRefs` is carried over: the CLI reads a folder whose blobs are
// already content-addressed, so it never needs `mapBlobRefs` (the re-keying
// path the web publisher uses).

import {codePointCompare, type ArtifactGraph} from './artifactGraphModel.js'
import {isPlainObject} from './canonicalJson.js'

export type ReachableBlobRef = {
  key: string
  blobKey: string
  artifactId?: string
  mime?: string
  name?: string
  sha256?: string
  size?: number
}

/** Port of `reachable_blob_refs`. */
export const reachableBlobRefs = (graph: ArtifactGraph): ReachableBlobRef[] => {
  const byKey = new Map<string, ReachableBlobRef>()
  for (const node of graph.nodes ?? []) {
    collectBlobRefs(node, byKey, typeof node?.id === 'string' ? node.id : '')
  }
  return [...byKey.keys()].sort(codePointCompare).map(key => byKey.get(key)!)
}

/** Port of `collect_blob_refs` — recursive walk; explicit `blobRef` fields and
 *  direct `{key|blobKey, ...}` dicts both qualify. */
const collectBlobRefs = (
  value: unknown,
  byKey: Map<string, ReachableBlobRef>,
  artifactId: string,
): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, byKey, artifactId)
    return
  }
  if (!isPlainObject(value)) return

  const explicitRef = reportBlobRef(value.blobRef, artifactId, true)
  if (explicitRef && !byKey.has(explicitRef.key)) byKey.set(explicitRef.key, explicitRef)
  const directRef = reportBlobRef(value, artifactId, false)
  if (directRef && !byKey.has(directRef.key)) byKey.set(directRef.key, directRef)
  for (const item of Object.values(value)) collectBlobRefs(item, byKey, artifactId)
}

/** Port of `report_blob_ref`. A non-explicit dict qualifies only when it has a
 *  `blobKey` field or one of mime/size/sha256 alongside `key` — a bare id-ish
 *  `key` alone is not a blob ref. */
const reportBlobRef = (
  value: unknown,
  artifactId: string,
  explicit: boolean,
): ReachableBlobRef | null => {
  if (!isPlainObject(value)) return null
  const key = String(
    (typeof value.key === 'string' && value.key) ||
      (typeof value.blobKey === 'string' && value.blobKey) ||
      '',
  ).trim()
  if (!key) return null
  if (
    !explicit &&
    !('blobKey' in value) &&
    !('mime' in value) &&
    !('size' in value) &&
    !('sha256' in value)
  ) {
    return null
  }
  const out: ReachableBlobRef = {key, blobKey: key}
  if (artifactId) out.artifactId = artifactId
  for (const field of ['mime', 'name', 'sha256'] as const) {
    const item = value[field]
    if (item) out[field] = String(item)
  }
  if (value.size !== null && value.size !== undefined) {
    const size = Number(value.size)
    if (Number.isFinite(size)) out.size = Math.trunc(size)
  }
  return out
}
