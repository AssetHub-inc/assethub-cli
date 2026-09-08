// Reading an `ag.graph-folder.v1` folder off local disk.
//
// Port of assethub-ml research/artifact-graph/artifact-graph-py/
// artifact_graph/graph_folder/ (`format.py` parse_manifest / parse_jsonl /
// manifest_flows / manifest_states / node_state, `load.py` read_graph_folder).
//
// A folder written by `save_graph_folder` is already byte-canonical: its
// nodes.jsonl / edges.jsonl lines are the `normalize_graph_state` output, one
// canonical JSON line each, in canonical order. Re-normalizing them here is
// therefore a no-op for a healthy folder and a repair for a hand-edited one —
// and because the manifest's graphHash was taken over that same output,
// re-hashing is what proves the folder still describes itself.

import {readFile, stat} from 'node:fs/promises'
import {basename, join} from 'node:path'

import {
  codePointCompare,
  normalizeArtifactGraph,
  type ArtifactGraph,
  type ArtifactNode,
} from './artifactGraphModel.js'
import {isPlainObject} from './canonicalJson.js'
import {RunUploadError} from './runUploadError.js'

export const GRAPH_FOLDER_SCHEMA_VERSION = 'ag.graph-folder.v1'
export const MANIFEST_FILE_NAME = 'manifest.json'
export const NODES_FILE_NAME = 'nodes.jsonl'
export const EDGES_FILE_NAME = 'edges.jsonl'

export type GraphFolder = {
  /** Absolute-or-as-given folder path, used verbatim in error messages. */
  path: string
  /** The folder's own name, the default source for a graphId. */
  name: string
  manifest: Record<string, unknown>
  /** Normalized + canonically ordered, ready to hash. */
  graph: ArtifactGraph
  /** blobKey -> the file inside the folder that holds its bytes. */
  blobFiles: Map<string, string>
}

/** Port of format.py `manifest_flows`: metadata.flow.id ∪ `flow:*` tag suffixes. */
export const deriveFlows = (graph: ArtifactGraph): string[] => {
  const flows = new Set<string>()
  for (const node of graph.nodes ?? []) {
    const metadata = isPlainObject(node.metadata) ? node.metadata : {}
    const flow = isPlainObject(metadata.flow) ? metadata.flow : {}
    const flowId = String(flow.id ?? '').trim()
    if (flowId) flows.add(flowId)
    for (const tag of Array.isArray(node.tags) ? node.tags : []) {
      if (String(tag).startsWith('flow:')) flows.add(String(tag).slice('flow:'.length))
    }
  }
  return [...flows].sort(codePointCompare)
}

/** Port of format.py `node_state`. */
export const nodeState = (node: ArtifactNode): string => {
  for (const tag of Array.isArray(node.tags) ? node.tags : []) {
    if (String(tag).startsWith('state:')) return String(tag).slice('state:'.length)
  }
  return ''
}

/** Port of format.py `manifest_states`: `state:*` tag counts, key-sorted. */
export const deriveStates = (graph: ArtifactGraph): Record<string, number> => {
  const states: Record<string, number> = {}
  for (const node of graph.nodes ?? []) {
    const state = nodeState(node)
    if (state) states[state] = (states[state] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(states).sort(([a], [b]) => codePointCompare(a, b)))
}

/** Port of `read_graph_folder`. */
export const readGraphFolder = async (path: string): Promise<GraphFolder> => {
  const manifest = await parseManifest(join(path, MANIFEST_FILE_NAME), path)
  const nodes = await parseJsonl(join(path, NODES_FILE_NAME), NODES_FILE_NAME)
  const edges = await parseJsonl(join(path, EDGES_FILE_NAME), EDGES_FILE_NAME)
  const graph = normalizeArtifactGraph({nodes, edges})

  const blobFiles = new Map<string, string>()
  for (const entry of Array.isArray(manifest.blobs) ? manifest.blobs : []) {
    if (!isPlainObject(entry)) continue
    const key = typeof entry.key === 'string' ? entry.key : ''
    const file = typeof entry.file === 'string' ? entry.file : ''
    if (key && file) blobFiles.set(key, join(path, file))
  }

  return {path, name: basename(path), manifest, graph, blobFiles}
}

const parseManifest = async (
  file: string,
  folderPath: string,
): Promise<Record<string, unknown>> => {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) {
      const exists = await pathExists(folderPath)
      throw new RunUploadError(
        'folder_not_a_graph_folder',
        exists
          ? `${folderPath} is not an artifact graph run folder: ${MANIFEST_FILE_NAME} is missing. ` +
              `Point the command at the folder that holds ${MANIFEST_FILE_NAME}, ${NODES_FILE_NAME} and ${EDGES_FILE_NAME}.`
          : `No such run folder: ${folderPath}. Expected a folder containing ${MANIFEST_FILE_NAME}.`,
        {cause: error},
      )
    }
    throw new RunUploadError(
      'folder_unreadable',
      `Could not read ${MANIFEST_FILE_NAME} in ${folderPath}: ${messageOf(error)}`,
      {cause: error},
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RunUploadError(
      'manifest_invalid_json',
      `${file} is not valid JSON: ${messageOf(error)}`,
      {cause: error},
    )
  }
  if (!isPlainObject(parsed)) {
    throw new RunUploadError('manifest_invalid_json', `${file} must contain a JSON object.`)
  }
  if (parsed.schemaVersion !== GRAPH_FOLDER_SCHEMA_VERSION) {
    throw new RunUploadError(
      'manifest_unsupported_schema',
      `Unsupported run folder schemaVersion ${JSON.stringify(parsed.schemaVersion ?? null)} in ${file}; ` +
        `this CLI uploads ${GRAPH_FOLDER_SCHEMA_VERSION} folders. Re-export the run with a current artifact-graph build.`,
    )
  }
  return parsed
}

const parseJsonl = async (file: string, label: string): Promise<Record<string, unknown>[]> => {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) {
      throw new RunUploadError(
        'folder_not_a_graph_folder',
        `Run folder is missing ${label}: ${file}.`,
        {cause: error},
      )
    }
    throw new RunUploadError('folder_unreadable', `Could not read ${file}: ${messageOf(error)}`, {
      cause: error,
    })
  }

  const items: Record<string, unknown>[] = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    let item: unknown
    try {
      item = JSON.parse(line)
    } catch (error) {
      throw new RunUploadError(
        'jsonl_invalid',
        `Invalid JSONL in ${label} line ${index + 1}: ${messageOf(error)}`,
        {cause: error},
      )
    }
    if (!isPlainObject(item)) {
      throw new RunUploadError(
        'jsonl_invalid',
        `Invalid JSONL in ${label} line ${index + 1}: expected an object.`,
      )
    }
    items.push(item)
  }
  return items
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const isNotFound = (error: unknown): boolean =>
  error != null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
