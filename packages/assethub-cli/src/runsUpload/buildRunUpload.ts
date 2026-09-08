// Turn a local `ag.graph-folder.v1` run folder into an `ag.registry-push.v1`
// envelope, and refuse to build one the server would reject.
//
// Port of assethub-ml research/artifact-graph/artifact-graph-py/
// artifact_graph/registry/validation.py `snapshot_from_graph_folder` ->
// `make_registry_snapshot` -> `_reference_only_manifest` / `_reference_only_blob`,
// plus `service.py::make_push`.
//
// Two things this file is careful about:
//
//  - The wire form is *reference-only*. A folder's manifest blob table carries
//    `file: "blobs/…"` so a reader can find the bytes on disk; the registry
//    rejects any snapshot whose blob entries carry a path, URL or inline bytes
//    (`INLINE_BLOB_FIELDS` in registry-worker/src/validation.js). The paths are
//    kept out-of-band, on the plan, for the uploader to stream from.
//
//  - It validates locally what the server validates remotely. The expensive
//    failure mode is a corrupt folder discovered *after* N blobs have already
//    been uploaded, so every check that can be made from local bytes is made
//    before the first request. `--dry-run` is exactly this function plus a
//    report.

import {stat} from 'node:fs/promises'

import {canonicalGraphHash} from './artifactGraphModel.js'
import {reachableBlobRefs, type ReachableBlobRef} from './blobRefs.js'
import {canonicalJson, isPlainObject, utf8ByteLength} from './canonicalJson.js'
import {
  CONTROL_MAX_BLOB_BYTES,
  CONTROL_MAX_PUSH_BYTES,
  REGISTRY_MAX_GRAPH_ARRAY_BYTES,
  REGISTRY_MAX_MANIFEST_BYTES,
} from './controlEndpoints.js'
import {deriveFlows, deriveStates, type GraphFolder} from './graphFolder.js'
import {RunUploadError} from './runUploadError.js'

export const PUSH_SCHEMA_VERSION = 'ag.registry-push.v1'
export const SNAPSHOT_SCHEMA_VERSION = 'ag.registry-snapshot.v1'
export const GRAPH_FOLDER_SCHEMA_VERSION = 'ag.graph-folder.v1'
export const SHARED_BLOB_STORE = 'shared-content-addressed'
export const DEFAULT_GENERATOR = 'assethub-cli:runs.upload'

const GRAPH_ID_RE =
  /^(?:graph_[A-Za-z0-9][A-Za-z0-9._:-]{0,121}|import_[A-Za-z0-9][A-Za-z0-9._:-]{0,120})$/
const GRAPH_HASH_RE = /^sha256:[0-9a-f]{64}$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const BLOB_REF_FIELDS = ['key', 'mime', 'size', 'sha256', 'name', 'artifactId', 'metadata']
const MANIFEST_FIELDS = [
  'schemaVersion',
  'createdAt',
  'generator',
  'selection',
  'graph',
  'blobStore',
  'flows',
  'states',
  'blobs',
  'missingBlobs',
  'source',
  'run',
]
// ISO-8601 date-time with an explicit offset, matching the worker's own
// `dateTime()` accept set. A plain date, or a time without a zone, is rejected.
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:\d{2}(?::\d{2})?)$/

/** A blob the uploader has to send, with the on-disk file that holds its bytes. */
export type PlannedBlob = {
  blobKey: string
  sha256: string
  mime: string
  name: string
  size: number
  /** Path inside the run folder. Never travels to the server. */
  file: string
}

export type RunUploadPlan = {
  graphId: string
  streamId: string
  rev: number
  graphHash: string
  /** The `ag.registry-push.v1` document. */
  push: Record<string, unknown>
  /** Pre-serialized request body, so the transport never re-stringifies it. */
  pushBody: string
  blobs: PlannedBlob[]
  counts: {nodes: number; edges: number; blobs: number; blobBytes: number}
  sizes: {manifestBytes: number; nodesBytes: number; edgesBytes: number; pushBytes: number}
  /** Registration payload for the graph, derived from the folder's manifest. */
  registration: {
    graphId: string
    description: string
    tags: string[]
    metadata: Record<string, unknown>
  }
  /** Non-fatal observations worth printing before an upload. */
  warnings: string[]
}

export type BuildRunUploadPlanInput = {
  folder: GraphFolder
  graphId?: string
  streamId?: string
  rev?: number
  description?: string
  tags?: string[]
  now?: Date
}

export const buildRunUploadPlan = async ({
  folder,
  graphId: graphIdInput,
  streamId: streamIdInput,
  rev: revInput,
  description = '',
  tags = [],
  now = new Date(),
}: BuildRunUploadPlanInput): Promise<RunUploadPlan> => {
  const warnings: string[] = []
  const manifest = folder.manifest
  const source = isPlainObject(manifest.source) ? manifest.source : null

  const graphId = validateGraphId(
    graphIdInput ?? defaultGraphId(folder.name),
    graphIdInput == null ? folder.name : undefined,
  )
  const streamId = validateStreamId(streamIdInput ?? defaultStreamId(source, graphId))
  const rev = validateRev(revInput ?? asNonNegativeInteger(source?.rev) ?? 0)

  const graph = folder.graph
  const graphHash = canonicalGraphHash(graph)

  // --- manifest, rewritten reference-only -----------------------------------
  rejectUnknownFields(manifest, MANIFEST_FIELDS, 'manifest.json')

  const missingBlobs = manifest.missingBlobs
  if (Array.isArray(missingBlobs) && missingBlobs.length > 0) {
    throw new RunUploadError(
      'folder_incomplete',
      `This run folder is incomplete: manifest.missingBlobs lists ${missingBlobs.length} blob(s) whose bytes were never exported, ` +
        'and Production Control only accepts a run whose every referenced blob is present. ' +
        'Re-export the run with its blobs, then upload that folder.',
      {details: {blobKeys: missingBlobs.slice(0, 20)}},
    )
  }

  const createdAt = manifestCreatedAt(manifest, now)
  const generator = manifestGenerator(manifest)
  if (isPlainObject(manifest.selection) && manifest.selection.kind !== 'whole-graph') {
    // The reference implementation overwrites this unconditionally; matching it
    // keeps the bytes identical, but a relabelled subgraph is worth saying out
    // loud rather than shipping silently.
    warnings.push(
      `manifest.selection.kind was ${JSON.stringify(manifest.selection.kind)}; ` +
        'the snapshot declares selection {"kind":"whole-graph"}, so this upload will present the folder as a whole graph.',
    )
  }

  // --- blobs ----------------------------------------------------------------
  const declaredRaw = Array.isArray(manifest.blobs) ? manifest.blobs : []
  if (!Array.isArray(manifest.blobs)) {
    throw new RunUploadError(
      'manifest_blobs_invalid',
      'manifest.json must carry a `blobs` array (the folder blob table).',
    )
  }
  const declared = declaredRaw.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new RunUploadError(
        'manifest_blobs_invalid',
        `manifest.blobs[${index}] must be an object.`,
      )
    }
    return referenceOnlyBlob(entry, index)
  })
  const seen = new Set<string>()
  for (const ref of declared) {
    if (seen.has(ref.key)) {
      throw new RunUploadError(
        'manifest_blobs_invalid',
        `manifest.blobs declares the blob key ${ref.key} twice.`,
      )
    }
    seen.add(ref.key)
  }
  declared.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const reachable = reachableBlobRefs(graph)
  assertBlobSetsAgree(reachable, declared)
  assertBlobMetadataAgrees(reachable, declared)

  const nextManifest: Record<string, unknown> = {
    ...manifest,
    schemaVersion: GRAPH_FOLDER_SCHEMA_VERSION,
    createdAt,
    generator,
    selection: {kind: 'whole-graph'},
    graph: manifest.graph,
    flows: deriveFlows(graph),
    states: deriveStates(graph),
    blobs: declared,
    missingBlobs: [],
  }
  if ('blobStore' in nextManifest) nextManifest.blobStore = SHARED_BLOB_STORE

  // --- the folder must still describe itself --------------------------------
  assertManifestGraphMatches(manifest.graph, graph, graphHash, folder.path)

  // --- sizes ----------------------------------------------------------------
  const manifestBytes = utf8ByteLength(canonicalJson(nextManifest))
  const nodesBytes = utf8ByteLength(canonicalJson(graph.nodes))
  const edgesBytes = utf8ByteLength(canonicalJson(graph.edges))
  assertUnderLimit('manifest', manifestBytes, REGISTRY_MAX_MANIFEST_BYTES)
  assertUnderLimit('nodes', nodesBytes, REGISTRY_MAX_GRAPH_ARRAY_BYTES)
  assertUnderLimit('edges', edgesBytes, REGISTRY_MAX_GRAPH_ARRAY_BYTES)

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    graphId,
    streamId,
    rev,
    graphHash,
    blobStore: SHARED_BLOB_STORE,
    manifest: nextManifest,
    nodes: graph.nodes,
    edges: graph.edges,
    blobs: declared,
  }
  const push: Record<string, unknown> = {
    schemaVersion: PUSH_SCHEMA_VERSION,
    graphId,
    streamId,
    rev,
    graphHash,
    snapshot,
  }
  const pushBody = JSON.stringify(push)
  const pushBytes = utf8ByteLength(pushBody)
  if (pushBytes > CONTROL_MAX_PUSH_BYTES) {
    throw new RunUploadError(
      'push_too_large',
      `This run's snapshot is ${formatBytes(pushBytes)}, over the ${formatBytes(CONTROL_MAX_PUSH_BYTES)} Production Control accepts in one request ` +
        `(${graph.nodes.length} nodes, ${graph.edges.length} edges). Nothing was sent. ` +
        'Export a narrower selection of the run, or ask for the upload limit to be raised before retrying.',
      {details: {pushBytes, limitBytes: CONTROL_MAX_PUSH_BYTES}},
    )
  }

  // --- the bytes each blob needs, checked but not read ----------------------
  const blobs = await planBlobs(declared, folder)

  return {
    graphId,
    streamId,
    rev,
    graphHash,
    push,
    pushBody,
    blobs,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      blobs: blobs.length,
      blobBytes: blobs.reduce((total, blob) => total + blob.size, 0),
    },
    sizes: {manifestBytes, nodesBytes, edgesBytes, pushBytes},
    registration: {
      graphId,
      description,
      tags: normalizeTags(tags),
      metadata: registrationMetadata(folder, createdAt, generator),
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** `import_` rather than `graph_`: a local run folder is an import, not a graph
 *  this deployment owns the authority for. */
export const defaultGraphId = (folderName: string): string => {
  const slug = folderName
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 121)
    .replace(/-+$/, '')
  if (!slug) {
    throw new RunUploadError(
      'graph_id_undeterminable',
      `Could not derive a graph id from the folder name ${JSON.stringify(folderName)}. Pass --graph-id import_<name> explicitly.`,
    )
  }
  return `import_${slug}`
}

const defaultStreamId = (source: Record<string, unknown> | null, graphId: string): string => {
  const authorityId = typeof source?.authorityId === 'string' ? source.authorityId.trim() : ''
  return authorityId || `stream_cli_${graphId}`
}

const validateGraphId = (value: string, derivedFrom?: string): string => {
  if (!GRAPH_ID_RE.test(value)) {
    throw new RunUploadError(
      'invalid_graph_id',
      derivedFrom == null
        ? `--graph-id must start with graph_ or import_ and then use only letters, digits, '.', '_', ':' or '-' (got ${JSON.stringify(value)}).`
        : `The graph id derived from the folder name ${JSON.stringify(derivedFrom)} is not valid (${JSON.stringify(value)}). ` +
            "It must start with graph_ or import_ and then use only letters, digits, '.', '_', ':' or '-'. Pass --graph-id to set it explicitly.",
    )
  }
  return value
}

const validateStreamId = (value: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new RunUploadError(
      'invalid_stream_id',
      '--stream-id must be a non-empty string of at most 256 characters.',
    )
  }
  return value
}

const validateRev = (value: number): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RunUploadError('invalid_rev', '--rev must be a non-negative integer.')
  }
  return value
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

const manifestCreatedAt = (manifest: Record<string, unknown>, now: Date): string => {
  const raw = manifest.createdAt
  if (raw === undefined || raw === null || raw === '') return isoNoMs(now)
  if (typeof raw !== 'string' || !ISO_DATE_TIME_RE.test(raw)) {
    throw new RunUploadError(
      'manifest_created_at_invalid',
      `manifest.createdAt must be an ISO-8601 date-time including a timezone (got ${JSON.stringify(raw)}).`,
    )
  }
  return raw
}

const manifestGenerator = (manifest: Record<string, unknown>): string => {
  const raw = manifest.generator
  if (raw === undefined || raw === null || raw === '') return DEFAULT_GENERATOR
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 256) {
    throw new RunUploadError(
      'manifest_generator_invalid',
      'manifest.generator must be a non-empty string of at most 256 characters.',
    )
  }
  return raw
}

const assertManifestGraphMatches = (
  value: unknown,
  graph: {nodes: unknown[]; edges: unknown[]},
  graphHash: string,
  folderPath: string,
): void => {
  if (!isPlainObject(value)) {
    throw new RunUploadError(
      'manifest_graph_invalid',
      'manifest.graph must be an object with nodeCount, edgeCount and graphHash.',
    )
  }
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'edgeCount,graphHash,nodeCount') {
    throw new RunUploadError(
      'manifest_graph_invalid',
      'manifest.graph must contain exactly nodeCount, edgeCount and graphHash.',
    )
  }
  const actual = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    graphHash,
  }
  if (
    value.nodeCount !== actual.nodeCount ||
    value.edgeCount !== actual.edgeCount ||
    value.graphHash !== actual.graphHash
  ) {
    throw new RunUploadError(
      'folder_corrupt',
      `This run folder no longer describes itself: its manifest graph counts or hash do not match its own nodes.jsonl / edges.jsonl. ` +
        `manifest says nodeCount=${String(value.nodeCount)} edgeCount=${String(value.edgeCount)} graphHash=${String(value.graphHash)}; ` +
        `the files hash to nodeCount=${actual.nodeCount} edgeCount=${actual.edgeCount} graphHash=${actual.graphHash}. ` +
        `Nothing was sent. Re-export ${folderPath} instead of editing it by hand.`,
      {details: {expected: actual}},
    )
  }
}

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

/** Port of `_reference_only_blob`: keeps only the fields the wire form allows,
 *  which is also what drops the folder-only `file` path. */
const referenceOnlyBlob = (
  raw: Record<string, unknown>,
  index: number,
): Record<string, unknown> & {key: string; mime: string; size: number; sha256: string} => {
  const key = raw.key
  if (typeof key !== 'string' || !GRAPH_HASH_RE.test(key)) {
    throw new RunUploadError(
      'blob_key_invalid',
      `manifest.blobs[${index}].key must be a lowercase sha256: digest (got ${JSON.stringify(key ?? null)}).`,
    )
  }
  const mime = raw.mime
  if (typeof mime !== 'string' || !mime.trim() || mime.length > 255) {
    throw new RunUploadError(
      'blob_mime_invalid',
      `manifest.blobs[${index}] (${key}) must carry a non-empty mime of at most 255 characters.`,
    )
  }
  const size = raw.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new RunUploadError(
      'blob_size_invalid',
      `manifest.blobs[${index}] (${key}) must carry a non-negative integer size.`,
    )
  }
  const keyDigest = key.slice('sha256:'.length)
  const sha = 'sha256' in raw ? raw.sha256 : keyDigest
  if (typeof sha !== 'string' || !SHA256_HEX_RE.test(sha) || sha !== keyDigest) {
    throw new RunUploadError(
      'blob_sha256_mismatch',
      `manifest.blobs[${index}] declares sha256 ${JSON.stringify(sha ?? null)}, which does not match its content-addressed key ${key}. ` +
        'The folder is corrupt; re-export the run.',
    )
  }
  const out: Record<string, unknown> & {
    key: string
    mime: string
    size: number
    sha256: string
  } = {key, mime, size, sha256: sha}
  if ('name' in raw) {
    if (typeof raw.name !== 'string' || raw.name.length > 512) {
      throw new RunUploadError(
        'blob_name_invalid',
        `manifest.blobs[${index}] (${key}) name must be a string of at most 512 characters.`,
      )
    }
    out.name = raw.name
  }
  if ('artifactId' in raw) {
    if (typeof raw.artifactId !== 'string' || !raw.artifactId.trim()) {
      throw new RunUploadError(
        'blob_artifact_id_invalid',
        `manifest.blobs[${index}] (${key}) artifactId must be a non-empty string.`,
      )
    }
    out.artifactId = raw.artifactId
  }
  if ('metadata' in raw) {
    if (!isPlainObject(raw.metadata)) {
      throw new RunUploadError(
        'blob_metadata_invalid',
        `manifest.blobs[${index}] (${key}) metadata must be an object.`,
      )
    }
    out.metadata = raw.metadata
  }
  // Anything else on the folder entry — `file` above all — is deliberately
  // dropped: the registry rejects a snapshot whose blob entries carry a path.
  return out
}

const assertBlobSetsAgree = (
  reachable: ReachableBlobRef[],
  declared: {key: string}[],
): void => {
  const reachableKeys = new Set(reachable.map(ref => ref.key))
  const declaredKeys = new Set(declared.map(ref => ref.key))
  const missing = [...reachableKeys].filter(key => !declaredKeys.has(key)).sort()
  const unreferenced = [...declaredKeys].filter(key => !reachableKeys.has(key)).sort()
  if (missing.length === 0 && unreferenced.length === 0) return
  throw new RunUploadError(
    'folder_corrupt',
    'This run folder\'s blob table does not match the blobs its graph references, and Production Control requires an exact match. ' +
      (missing.length > 0
        ? `${missing.length} referenced blob(s) are absent from manifest.blobs (${missing.slice(0, 5).join(', ')}). `
        : '') +
      (unreferenced.length > 0
        ? `${unreferenced.length} declared blob(s) are unreferenced by the graph (${unreferenced.slice(0, 5).join(', ')}). `
        : '') +
      'Nothing was sent. Re-export the run.',
    {details: {missing, unreferenced}},
  )
}

const assertBlobMetadataAgrees = (
  reachable: ReachableBlobRef[],
  declared: Record<string, unknown>[],
): void => {
  const byKey = new Map(declared.map(ref => [String(ref.key), ref]))
  for (const ref of reachable) {
    const entry = byKey.get(ref.key)
    if (!entry) continue
    for (const field of ['mime', 'size', 'sha256', 'name'] as const) {
      const value = ref[field]
      if (value === undefined) continue
      if (entry[field] !== value) {
        throw new RunUploadError(
          'folder_corrupt',
          `This run folder disagrees with itself about blob ${ref.key}: the graph reference says ${field}=${JSON.stringify(value)} ` +
            `but manifest.blobs says ${field}=${JSON.stringify(entry[field] ?? null)}. Production Control rejects that. ` +
            'Nothing was sent. Re-export the run.',
          {details: {key: ref.key, field}},
        )
      }
    }
  }
}

const planBlobs = async (
  declared: Record<string, unknown>[],
  folder: GraphFolder,
): Promise<PlannedBlob[]> => {
  const blobs: PlannedBlob[] = []
  const oversize: {key: string; size: number}[] = []
  for (const entry of declared) {
    const blobKey = String(entry.key)
    const file = folder.blobFiles.get(blobKey)
    if (!file) {
      throw new RunUploadError(
        'blob_file_missing',
        `manifest.blobs declares ${blobKey} but gives no \`file\` for it, so its bytes are not in ${folder.path}. ` +
          'Nothing was sent. Re-export the run with its blobs.',
        {details: {blobKey}},
      )
    }
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(file)
    } catch (error) {
      throw new RunUploadError(
        'blob_file_missing',
        `Run folder blob file is missing: ${file} (for ${blobKey}). Nothing was sent. Re-export the run with its blobs.`,
        {cause: error, details: {blobKey}},
      )
    }
    const declaredSize = Number(entry.size)
    if (stats.size !== declaredSize) {
      throw new RunUploadError(
        'blob_file_size_mismatch',
        `${file} is ${stats.size} bytes but manifest.blobs says ${declaredSize} for ${blobKey}. ` +
          'The folder is corrupt; nothing was sent. Re-export the run.',
        {details: {blobKey, onDisk: stats.size, declared: declaredSize}},
      )
    }
    if (stats.size > CONTROL_MAX_BLOB_BYTES) oversize.push({key: blobKey, size: stats.size})
    blobs.push({
      blobKey,
      sha256: String(entry.sha256),
      mime: String(entry.mime),
      name: typeof entry.name === 'string' && entry.name ? entry.name : blobKey,
      size: stats.size,
      file,
    })
  }
  if (oversize.length > 0) {
    throw new RunUploadError(
      'blob_too_large',
      `${oversize.length} blob(s) in this run are larger than the ${formatBytes(CONTROL_MAX_BLOB_BYTES)} Production Control accepts per blob, ` +
        `the largest being ${formatBytes(Math.max(...oversize.map(item => item.size)))}. Nothing was sent — this run cannot be uploaded as-is. ` +
        'Re-export it with downscaled assets, or ask for the per-blob limit to be raised.',
      {details: {blobKeys: oversize.map(item => item.key), limitBytes: CONTROL_MAX_BLOB_BYTES}},
    )
  }
  return blobs
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

const registrationMetadata = (
  folder: GraphFolder,
  createdAt: string,
  generator: string,
): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {
    uploadedBy: 'assethub-cli',
    runFolder: folder.name,
    graphFolderCreatedAt: createdAt,
    generator,
  }
  if (isPlainObject(folder.manifest.run)) metadata.run = folder.manifest.run
  if (isPlainObject(folder.manifest.source)) metadata.source = folder.manifest.source
  return metadata
}

const normalizeTags = (tags: string[]): string[] =>
  [...new Set(tags.map(tag => String(tag ?? '').trim()).filter(Boolean))].sort()

const rejectUnknownFields = (
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void => {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value)
    .filter(field => !allowedSet.has(field))
    .sort()
  if (unknown.length > 0) {
    throw new RunUploadError(
      'manifest_unknown_fields',
      `${label} carries fields the registry snapshot format does not allow: ${unknown.join(', ')}. ` +
        'Nothing was sent. Re-export the run with a current artifact-graph build.',
      {details: {fields: unknown}},
    )
  }
}

const assertUnderLimit = (label: string, bytes: number, limit: number): void => {
  if (bytes <= limit) return
  throw new RunUploadError(
    'payload_too_large',
    `This run's ${label} is ${formatBytes(bytes)}, over the ${formatBytes(limit)} the snapshot format allows. Nothing was sent.`,
    {details: {bytes, limitBytes: limit}},
  )
}

const asNonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

const isoNoMs = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
