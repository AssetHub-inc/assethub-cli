// Saved session -> `ag.graph-folder.v1` folder, using the same canonical
// normalize/hash code the `runs upload` reader recomputes.
//
// The whole redacted transcript travels as content-addressed blobs of at most
// TRANSCRIPT_CHUNK_BYTES, cut on line boundaries. A transcript only grows, so
// every chunk but the last keeps its hash from one upload to the next and the
// server already holds it: re-uploading a grown session sends only the tail.
// The message, prompt and tool-call nodes are an index for browsing and for
// building skills; the transcript blobs are the record.

import {createHash} from 'node:crypto'
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {
  canonicalGraphHash,
  canonicalJsonLine,
  normalizeArtifactGraph,
  type ArtifactEdge,
  type ArtifactNode,
} from '../runsUpload/artifactGraphModel.js'
import {CONTROL_MAX_BLOB_BYTES} from '../runsUpload/controlEndpoints.js'
import {
  EDGES_FILE_NAME,
  GRAPH_FOLDER_SCHEMA_VERSION,
  MANIFEST_FILE_NAME,
  NODES_FILE_NAME,
  deriveFlows,
  deriveStates,
} from '../runsUpload/graphFolder.js'
import {readMeta} from './paths.js'
import {redactText} from './redact.js'
import {parseTranscript, type TranscriptItem} from './transcript.js'

export const SESSION_GRAPH_FOLDER = 'graph-folder'
export const SESSION_GENERATOR = 'assethub-cli:hooks.save'
export const TRANSCRIPT_BLOB_MIME = 'application/x-ndjson'
/** Under the 4 MiB blob limit, with room to spare. */
export const TRANSCRIPT_CHUNK_BYTES = 3 * 1024 * 1024

const MAX_TOOL_INPUT_BYTES = 8 * 1024
const MAX_TEXT_CHARS = 16 * 1024
/**
 * Canonical bytes of the message and tool-call nodes kept in one snapshot. The
 * push is refused over 4 MiB (CONTROL_MAX_PUSH_BYTES), and the edges, image
 * and transcript nodes, manifest and envelope need the rest. A longer session
 * keeps its newest messages in the index and records how many were left out;
 * the transcript blobs still hold every one of them.
 */
export const MAX_MESSAGE_NODE_BYTES = 2.5 * 1024 * 1024
/** Rough canonical size of the `continues` edge that links each kept message. */
const EDGE_BYTES_ESTIMATE = 160

/**
 * Compaction after an upload failed for size or time. Each level halves the
 * index budget and the per-message clips; from level 2 on images stay local.
 * The transcript blobs are never dropped: they are the record.
 */
export const MAX_COMPACT_LEVEL = 4
const SKIP_IMAGES_FROM_LEVEL = 2

type Limits = {indexBytes: number; textChars: number; toolInputBytes: number; images: boolean}
export const compactLimits = (level: number): Limits => {
  const factor = 2 ** Math.max(0, Math.min(level, MAX_COMPACT_LEVEL))
  return {
    indexBytes: Math.floor(MAX_MESSAGE_NODE_BYTES / factor),
    textChars: Math.max(1024, Math.floor(MAX_TEXT_CHARS / factor)),
    toolInputBytes: Math.max(512, Math.floor(MAX_TOOL_INPUT_BYTES / factor)),
    images: level < SKIP_IMAGES_FROM_LEVEL,
  }
}

const pad = (n: number): string => String(n).padStart(6, '0')

const clip = (text: string, max: number): {text: string; truncated?: true} =>
  text.length > max ? {text: text.slice(0, max), truncated: true} : {text}

const redactedInput = (input: unknown, maxBytes: number): Record<string, unknown> => {
  const json = redactText(JSON.stringify(input ?? {}) ?? '{}')
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return {value: parsed}
    } catch {
      // fall through to the preview form
    }
  }
  return {truncated: true, preview: json.slice(0, maxBytes)}
}

const isoZ = (value: string | undefined, fallback: Date): string => {
  const date = value ? new Date(value) : fallback
  return `${(Number.isNaN(date.getTime()) ? fallback : date).toISOString().slice(0, 19)}Z`
}

export const sessionGraphId = (sessionDirName: string): string => {
  const slug = sessionDirName
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 100)
  return `import_session_${slug}`
}

/**
 * Cut on line boundaries into pieces of at most `max` bytes. A single line
 * longer than that (a base64 image inside the JSONL) is cut mid-line; the
 * pieces still concatenate back to the original bytes.
 */
export const chunkTranscript = (bytes: Buffer, max = TRANSCRIPT_CHUNK_BYTES): Buffer[] => {
  const chunks: Buffer[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + max, bytes.length)
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(0x0a, end - 1)
      if (newline >= start) end = newline + 1
    }
    chunks.push(bytes.subarray(start, end))
    start = end
  }
  return chunks
}

export const buildSessionGraphFolder = async (
  sessionDir: string,
  options: {compactLevel?: number} = {},
): Promise<string> => {
  const meta = await readMeta(sessionDir)
  if (!meta) throw new Error(`No meta.json in ${sessionDir}`)
  const limits = compactLimits(options.compactLevel ?? 0)
  // A session an older CLI saved has no client: it came from Claude Code.
  const agentTag = `agent:${meta.client ?? 'claude'}`
  const transcriptBytes = await readFile(join(sessionDir, 'transcript.jsonl'))
  const transcript = parseTranscript(transcriptBytes.toString('utf8'))
  await resetSessionGraphFolder(sessionDir)
  const folder = join(sessionDir, SESSION_GRAPH_FOLDER)
  // The folder holds a full copy of the masked transcript: private like the rest.
  await mkdir(join(folder, 'blobs'), {recursive: true, mode: 0o700})

  const savedAt = new Date(meta.savedAt)
  const nodes: ArtifactNode[] = []
  const edges: ArtifactEdge[] = []
  const edge = (from: string, to: string, kind: string): void => {
    edges.push({id: `edge_${kind}_${from}_${to}`, from, to, kind, tags: [], metadata: {}})
  }
  const blobs: Record<string, unknown>[] = []
  const blobKeys = new Set<string>()
  const addBlob = async (bytes: Buffer, mime: string, name: string) => {
    const sha = createHash('sha256').update(bytes).digest('hex')
    const key = `sha256:${sha}`
    if (!blobKeys.has(key)) {
      blobKeys.add(key)
      blobs.push({key, mime, size: bytes.length, sha256: sha, name, file: `blobs/${sha}`})
      await writeFile(join(folder, 'blobs', sha), bytes, {mode: 0o600})
    }
    return {key, mime, size: bytes.length, sha256: sha, name}
  }

  const sessionNodeId = 'session'

  // The record: the whole redacted transcript, chunked.
  const transcriptParts = chunkTranscript(transcriptBytes)
  for (const [index, part] of transcriptParts.entries()) {
    const id = `transcript_${pad(index)}`
    const blobRef = await addBlob(part, TRANSCRIPT_BLOB_MIME, `transcript-${pad(index)}.jsonl`)
    nodes.push({
      id, artifactKind: 'file', semanticType: 'transcript', tags: ['session', agentTag],
      metadata: {part: index, parts: transcriptParts.length},
      payload: {blobRef},
    })
    edge(sessionNodeId, id, 'contains')
  }

  // The index: one node per prompt, reply and tool call.
  const toolNodeById: {id: string; item: TranscriptItem}[] = []
  const ordered: string[] = []
  const messageNodes: {node: ArtifactNode; item: TranscriptItem}[] = []
  transcript.items.forEach((item, index) => {
    const id = `${item.kind === 'tool' ? 'tool' : item.kind === 'prompt' ? 'prompt' : 'text'}_${pad(index)}`
    const createdAt = isoZ(item.timestamp, savedAt)
    const node: ArtifactNode =
      item.kind === 'prompt'
        ? {
            id, artifactKind: 'json', semanticType: 'prompt', tags: ['session'],
            metadata: {role: 'user', timestamp: createdAt},
            payload: clip(redactText(item.text), limits.textChars),
          }
        : item.kind === 'assistant'
          ? {
              id, artifactKind: 'text', tags: ['session', agentTag],
              metadata: {role: 'assistant', timestamp: createdAt},
              payload: clip(redactText(item.text), limits.textChars),
            }
          : {
              id, artifactKind: 'run', tags: ['session', agentTag, `tool:${item.toolName}`],
              metadata: {toolUseId: item.toolUseId, timestamp: createdAt},
              payload: {toolName: item.toolName, input: redactedInput(item.input, limits.toolInputBytes)},
            }
    messageNodes.push({node, item})
  })

  // Keep the newest messages that fit the budget, in their original order.
  let budget = limits.indexBytes
  let firstKept = messageNodes.length
  while (firstKept > 0) {
    const cost =
      Buffer.byteLength(canonicalJsonLine(messageNodes[firstKept - 1].node), 'utf8') + EDGE_BYTES_ESTIMATE
    if (cost > budget) break
    budget -= cost
    firstKept -= 1
  }
  const droppedMessages = firstKept
  for (const {node, item} of messageNodes.slice(firstKept)) {
    nodes.push(node)
    ordered.push(node.id)
    if (item.kind === 'tool') toolNodeById.push({id: node.id, item})
  }

  // Images: only those small enough for the blob limit, and none once compacted.
  const imageNodes: {id: string; original: string}[] = []
  let skippedImages = 0
  for (const [index, image] of (meta.images ?? []).entries()) {
    if (!limits.images) {
      skippedImages += 1
      continue
    }
    const file = join(sessionDir, 'images', image.file)
    let bytes: Buffer
    try {
      if ((await stat(file)).size > CONTROL_MAX_BLOB_BYTES) {
        skippedImages += 1
        continue
      }
      bytes = await readFile(file)
    } catch {
      skippedImages += 1
      continue
    }
    const blobRef = await addBlob(bytes, image.mime, image.file.slice(0, 200))
    const id = `image_${pad(index)}`
    nodes.push({
      id, artifactKind: 'image', tags: ['session', agentTag],
      metadata: {sourcePath: redactText(image.original)},
      payload: {blobRef},
    })
    imageNodes.push({id, original: image.original})
  }

  nodes.push({
    id: sessionNodeId, artifactKind: 'console', semanticType: 'agent-session',
    tags: ['session', agentTag],
    metadata: {
      sessionId: meta.sessionId, client: meta.client, lastEvent: meta.lastEvent,
      messageCount: messageNodes.length, skippedImages,
      transcriptParts: transcriptParts.length,
      ...(droppedMessages > 0 ? {droppedMessages} : {}),
      ...((options.compactLevel ?? 0) > 0 ? {compactLevel: options.compactLevel} : {}),
      ...(meta.canvasId ? {canvasId: meta.canvasId} : {}),
    },
  })

  // Chain: session -> first message, then each message -> the next.
  let previous = sessionNodeId
  for (const id of ordered) {
    edge(previous, id, 'continues')
    previous = id
  }

  // 'uses': the tool call that mentioned or produced an image -> the image.
  for (const image of imageNodes) {
    for (const {id, item} of toolNodeById) {
      if (item.kind !== 'tool') continue
      const inInput = JSON.stringify(item.input ?? {}).includes(image.original)
      const inResult = transcript.resultImages.get(item.toolUseId)?.includes(image.original)
      if (inInput || inResult) edge(id, image.id, 'uses')
    }
  }

  const graph = normalizeArtifactGraph({nodes, edges})
  const graphHash = canonicalGraphHash(graph)
  const manifest = {
    schemaVersion: GRAPH_FOLDER_SCHEMA_VERSION,
    createdAt: `${savedAt.toISOString().slice(0, 19)}Z`,
    generator: SESSION_GENERATOR,
    selection: {kind: 'whole-graph'},
    graph: {nodeCount: graph.nodes.length, edgeCount: graph.edges.length, graphHash},
    flows: deriveFlows(graph),
    states: deriveStates(graph),
    blobs: blobs.sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1)),
    missingBlobs: [],
    run: {sessionId: meta.sessionId, client: meta.client},
  }

  await writeFile(join(folder, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600})
  await writeFile(
    join(folder, NODES_FILE_NAME),
    graph.nodes.map(node => `${canonicalJsonLine(node)}\n`).join(''),
    {mode: 0o600},
  )
  await writeFile(
    join(folder, EDGES_FILE_NAME),
    graph.edges.map(e => `${canonicalJsonLine(e)}\n`).join(''),
    {mode: 0o600},
  )
  return folder
}

/** Remove a previously built folder so stale blobs never linger. */
export const resetSessionGraphFolder = async (sessionDir: string): Promise<void> => {
  await rm(join(sessionDir, SESSION_GRAPH_FOLDER), {recursive: true, force: true})
}
