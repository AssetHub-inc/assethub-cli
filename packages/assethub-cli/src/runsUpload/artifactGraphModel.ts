// The `ag.commit.v1` artifact model plus the canonical normalize + hash that
// every ag.graph-folder.v1 reader recomputes.
//
// Line-faithful port of assethub-ml research/artifact-graph/artifact-graph-py/
// artifact_graph/graph/commit_reducer.py (`_normalize_tags`,
// `_canonical_value_copy`, `_normalize_artifact`, `_normalize_edge`,
// `normalize_graph_state`, `canonical_graph_hash`), taken from the identical
// port already shipping in
// apps/frontend/src/feature/artifactGraph/export/artifactGraphModel.ts.
//
// Do not "improve" ordering/trimming/defaults: byte parity with the Python
// normalize output is what makes a locally computed graphHash verifiable by the
// server that receives it.

import {canonicalJson, isPlainObject, sha256Hex} from './canonicalJson.js'

export {canonicalJson, isPlainObject, sha256Hex} from './canonicalJson.js'

/** `ag.commit.v1` artifact node — output shape of Python `_normalize_artifact`. */
export type ArtifactNode = {
  id: string
  artifactKind: string
  tags: string[]
  metadata: Record<string, unknown>
  semanticType?: string
  lifecycle?: string
  payload?: Record<string, unknown>
  schemaRef?: string
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

/** Artifact edge — output shape of Python `_normalize_edge`. */
export type ArtifactEdge = {
  id: string
  from: string
  to: string
  kind: string
  tags: string[]
  metadata: Record<string, unknown>
  createdBy?: string
}

export type ArtifactGraph = {nodes: ArtifactNode[]; edges: ArtifactEdge[]}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

/** Port of `_normalize_tags`: stringify+trim, drop empties, dedupe, sort
 *  (code-point order — Python `sorted`, NOT localeCompare). */
const normalizeTags = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  for (const item of raw) {
    const tag = String(item ?? '').trim()
    if (tag) seen.add(tag)
  }
  return [...seen].sort(codePointCompare)
}

export const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Port of `_canonical_value_copy`: deep-copy JSON-shaped values. The Python
 *  side also coerces integral floats to ints here; JSON.parse already
 *  collapses 1.0 to 1 in JS, and canonicalJson renders integral doubles as
 *  plain digits, so a plain structural copy is the faithful equivalent. */
const canonicalValueCopy = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValueCopy)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = canonicalValueCopy(item)
    }
    return out
  }
  return value
}

/** Port of `_normalize_artifact`: returns null for anything that is not a
 *  valid `ag.commit.v1` artifact; keeps only the schema's fields. */
export const normalizeArtifact = (value: unknown): ArtifactNode | null => {
  if (!isPlainObject(value)) return null
  const id = stringOrNull(value.id)
  const artifactKind = stringOrNull(value.artifactKind)
  if (!id || !artifactKind || !isPlainObject(value.metadata)) return null
  const out: ArtifactNode = {
    id,
    artifactKind,
    tags: normalizeTags(value.tags),
    metadata: canonicalValueCopy(value.metadata) as Record<string, unknown>,
  }
  assignOptionalString(out, 'semanticType', value.semanticType)
  assignOptionalString(out, 'lifecycle', value.lifecycle)
  if (isPlainObject(value.payload)) {
    out.payload = canonicalValueCopy(value.payload) as Record<string, unknown>
  }
  assignOptionalString(out, 'schemaRef', value.schemaRef)
  assignOptionalString(out, 'createdBy', value.createdBy)
  assignOptionalString(out, 'createdAt', value.createdAt)
  assignOptionalString(out, 'updatedAt', value.updatedAt)
  return out
}

/** Port of `_normalize_edge`. */
export const normalizeEdge = (value: unknown): ArtifactEdge | null => {
  if (!isPlainObject(value)) return null
  const id = stringOrNull(value.id)
  const from = stringOrNull(value.from)
  const to = stringOrNull(value.to)
  if (!id || !from || !to) return null
  const out: ArtifactEdge = {
    id,
    from,
    to,
    kind: stringOrNull(value.kind) ?? 'uses',
    tags: normalizeTags(value.tags),
    metadata: isPlainObject(value.metadata)
      ? (canonicalValueCopy(value.metadata) as Record<string, unknown>)
      : {},
  }
  assignOptionalString(out, 'createdBy', value.createdBy)
  return out
}

const assignOptionalString = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  const normalized = stringOrNull(value)
  if (normalized) target[key] = normalized
}

/** Port of `normalize_graph_state`: dedupe by id (last wins), drop edges with
 *  missing endpoints, sort both arrays by id (code-point order). Idempotent —
 *  a reader normalizes our JSONL lines and must get them back byte-identical,
 *  or the manifest hash won't verify. */
export const normalizeArtifactGraph = (
  value: {nodes?: unknown[]; edges?: unknown[]} | null,
): ArtifactGraph => {
  const nodesById = new Map<string, ArtifactNode>()
  const edgesById = new Map<string, ArtifactEdge>()
  for (const raw of Array.isArray(value?.nodes) ? value.nodes : []) {
    const node = normalizeArtifact(raw)
    if (node) nodesById.set(node.id, node)
  }
  for (const raw of Array.isArray(value?.edges) ? value.edges : []) {
    const edge = normalizeEdge(raw)
    if (edge && nodesById.has(edge.from) && nodesById.has(edge.to)) {
      edgesById.set(edge.id, edge)
    }
  }
  return {
    nodes: [...nodesById.keys()].sort(codePointCompare).map(key => nodesById.get(key)!),
    edges: [...edgesById.keys()].sort(codePointCompare).map(key => edgesById.get(key)!),
  }
}

/** Port of `canonical_graph_hash` — callers pass normalizeArtifactGraph output. */
export const canonicalGraphHash = (graph: ArtifactGraph): string =>
  `sha256:${sha256Hex(canonicalJson(graph))}`

/** Port of `canonical_json_line` (graph_folder/format.py) — one JSONL line. */
export const canonicalJsonLine = (value: unknown): string => canonicalJson(value)
