import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  canonicalGraphHash,
  canonicalJson,
  normalizeArtifactGraph,
  sha256Hex,
} from '../runsUpload/artifactGraphModel.js'
import {buildRunUploadPlan} from '../runsUpload/buildRunUpload.js'
import {readGraphFolder} from '../runsUpload/graphFolder.js'
import {RunUploadError} from '../runsUpload/runUploadError.js'

const BLOB_BYTES = Buffer.from('hello artifact graph')
const BLOB_SHA = createHash('sha256').update(BLOB_BYTES).digest('hex')
const BLOB_KEY = `sha256:${BLOB_SHA}`

type Json = Record<string, unknown>

const rawGraph = (): {nodes: Json[]; edges: Json[]} => ({
  nodes: [
    {
      id: 'art_image_1',
      artifactKind: 'image',
      tags: ['flow:pluffy', 'state:completed'],
      metadata: {flow: {id: 'pluffy', stage: 'render'}, title: 'Hero'},
      payload: {
        blobRef: {
          key: BLOB_KEY,
          mime: 'image/png',
          size: BLOB_BYTES.length,
          sha256: BLOB_SHA,
          name: 'hero.png',
        },
      },
    },
    {id: 'art_run_1', artifactKind: 'run', tags: ['state:completed'], metadata: {}},
  ],
  edges: [
    {id: 'edge_1', from: 'art_run_1', to: 'art_image_1', kind: 'produces', tags: [], metadata: {}},
  ],
})

const manifestBlobEntry = (): Json => ({
  key: BLOB_KEY,
  mime: 'image/png',
  name: 'hero.png',
  artifactId: 'art_image_1',
  size: BLOB_BYTES.length,
  sha256: BLOB_SHA,
  file: 'blobs/hero-abcdef.png',
})

type FolderOptions = {
  graph?: {nodes: Json[]; edges: Json[]}
  manifestPatch?: (manifest: Json) => Json
  writeBlobFile?: boolean
  blobBytes?: Buffer
}

const writeGraphFolder = async (
  root: string,
  name: string,
  options: FolderOptions = {},
): Promise<string> => {
  const dir = join(root, name)
  const graph = normalizeArtifactGraph(options.graph ?? rawGraph())
  const graphHash = canonicalGraphHash(graph)
  const baseManifest: Json = {
    schemaVersion: 'ag.graph-folder.v1',
    createdAt: '2026-07-30T04:05:06Z',
    generator: 'artifact-graph-py:artifact_graph.graph_folder',
    selection: {kind: 'whole-graph'},
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      graphHash,
    },
    flows: ['pluffy'],
    states: {completed: 2},
    blobs: [manifestBlobEntry()],
    missingBlobs: [],
  }
  const manifest = options.manifestPatch ? options.manifestPatch(baseManifest) : baseManifest

  await mkdir(join(dir, 'blobs'), {recursive: true})
  if (options.writeBlobFile !== false) {
    await writeFile(join(dir, 'blobs', 'hero-abcdef.png'), options.blobBytes ?? BLOB_BYTES)
  }
  await writeFile(
    join(dir, 'nodes.jsonl'),
    graph.nodes.map(node => `${canonicalJson(node)}\n`).join(''),
    'utf8',
  )
  await writeFile(
    join(dir, 'edges.jsonl'),
    graph.edges.map(edge => `${canonicalJson(edge)}\n`).join(''),
    'utf8',
  )
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return dir
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'assethub-runs-upload-'))
})

afterEach(async () => {
  await rm(root, {recursive: true, force: true})
})

describe('canonical hashing (vendored from artifact-graph)', () => {
  // Golden vector: pins the vendored canonicalJson + sha256 against the
  // artifact-graph reference. If this moves, every graphHash the CLI sends
  // stops matching what the registry recomputes, and every push 400s.
  it('hashes the empty graph to the reference digest', () => {
    expect(canonicalJson({nodes: [], edges: []})).toBe('{"edges":[],"nodes":[]}')
    expect(sha256Hex('{"edges":[],"nodes":[]}')).toBe(
      createHash('sha256').update('{"edges":[],"nodes":[]}', 'utf8').digest('hex'),
    )
    expect(canonicalGraphHash({nodes: [], edges: []})).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('sorts object keys and renders integral doubles as plain digits', () => {
    expect(canonicalJson({b: 1, a: 2.0, c: [3, {z: 1, y: 2}]})).toBe(
      '{"a":2,"b":1,"c":[3,{"y":2,"z":1}]}',
    )
  })
})

describe('readGraphFolder', () => {
  it('reads manifest, nodes, edges and the on-disk blob files', async () => {
    const dir = await writeGraphFolder(root, 'run-a')
    const folder = await readGraphFolder(dir)

    expect(folder.manifest.schemaVersion).toBe('ag.graph-folder.v1')
    expect(folder.graph.nodes).toHaveLength(2)
    expect(folder.graph.edges).toHaveLength(1)
    expect(folder.blobFiles.get(BLOB_KEY)).toBe(join(dir, 'blobs', 'hero-abcdef.png'))
  })

  it('names the missing file and the folder when manifest.json is absent', async () => {
    await expect(readGraphFolder(join(root, 'nope'))).rejects.toThrow(/manifest\.json/)
  })

  it('rejects an unsupported folder schemaVersion', async () => {
    const dir = await writeGraphFolder(root, 'run-b', {
      manifestPatch: manifest => ({...manifest, schemaVersion: 'ag.graph-folder.v2'}),
    })
    await expect(readGraphFolder(dir)).rejects.toThrow(/ag\.graph-folder\.v1/)
  })
})

describe('buildRunUploadPlan', () => {
  it('builds an ag.registry-push.v1 envelope that mirrors its snapshot', async () => {
    const dir = await writeGraphFolder(root, 'run-c')
    const plan = await buildRunUploadPlan({folder: await readGraphFolder(dir), rev: 3})

    const push = plan.push as Json
    expect(push.schemaVersion).toBe('ag.registry-push.v1')
    expect(push.graphId).toBe(plan.graphId)
    expect(push.streamId).toBe(plan.streamId)
    expect(push.rev).toBe(3)
    expect(push.graphHash).toBe(plan.graphHash)

    const snapshot = push.snapshot as Json
    expect(snapshot.schemaVersion).toBe('ag.registry-snapshot.v1')
    expect(snapshot.blobStore).toBe('shared-content-addressed')
    for (const field of ['graphId', 'streamId', 'rev', 'graphHash'] as const) {
      expect(snapshot[field]).toBe(push[field])
    }
  })

  it('defaults graphId to an import_ id derived from the folder name', async () => {
    const dir = await writeGraphFolder(root, 'pluffy run 2026-07-30')
    const plan = await buildRunUploadPlan({folder: await readGraphFolder(dir)})

    expect(plan.graphId).toBe('import_pluffy-run-2026-07-30')
    expect(plan.graphId).toMatch(/^(graph_|import_)/)
  })

  it('rejects an explicit graphId that the registry would reject', async () => {
    const dir = await writeGraphFolder(root, 'run-d')
    const folder = await readGraphFolder(dir)
    await expect(buildRunUploadPlan({folder, graphId: 'run_1'})).rejects.toThrow(
      /graph_ or import_/,
    )
  })

  it('strips the folder-only blob fields so the snapshot is reference-only', async () => {
    const dir = await writeGraphFolder(root, 'run-e')
    const plan = await buildRunUploadPlan({folder: await readGraphFolder(dir)})
    const snapshot = (plan.push as Json).snapshot as Json
    const blobs = snapshot.blobs as Json[]
    const manifest = snapshot.manifest as Json

    expect(blobs).toEqual([
      {
        key: BLOB_KEY,
        mime: 'image/png',
        size: BLOB_BYTES.length,
        sha256: BLOB_SHA,
        name: 'hero.png',
        artifactId: 'art_image_1',
      },
    ])
    expect(manifest.blobs).toEqual(blobs)
    expect(manifest.missingBlobs).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('blobs/hero-abcdef.png')
  })

  it('carries the on-disk path for every declared blob without reading the bytes', async () => {
    const dir = await writeGraphFolder(root, 'run-f')
    const plan = await buildRunUploadPlan({folder: await readGraphFolder(dir)})

    expect(plan.blobs).toEqual([
      {
        blobKey: BLOB_KEY,
        sha256: BLOB_SHA,
        mime: 'image/png',
        name: 'hero.png',
        size: BLOB_BYTES.length,
        file: join(dir, 'blobs', 'hero-abcdef.png'),
      },
    ])
  })

  it('reports counts and byte sizes for --dry-run', async () => {
    const dir = await writeGraphFolder(root, 'run-g')
    const plan = await buildRunUploadPlan({folder: await readGraphFolder(dir)})

    expect(plan.counts).toEqual({nodes: 2, edges: 1, blobs: 1, blobBytes: BLOB_BYTES.length})
    expect(plan.sizes.manifestBytes).toBeGreaterThan(0)
    expect(plan.sizes.nodesBytes).toBeGreaterThan(0)
    expect(plan.sizes.edgesBytes).toBeGreaterThan(0)
  })

  // The whole point of validating locally: a folder whose manifest hash no
  // longer describes its own nodes.jsonl is corrupt, and the registry would
  // answer with an opaque 400 after the caller had already uploaded blobs.
  it('refuses a folder whose manifest graphHash does not match its nodes/edges', async () => {
    const dir = await writeGraphFolder(root, 'run-h', {
      manifestPatch: manifest => ({
        ...manifest,
        graph: {...(manifest.graph as Json), graphHash: `sha256:${'0'.repeat(64)}`},
      }),
    })
    const folder = await readGraphFolder(dir)
    await expect(buildRunUploadPlan({folder})).rejects.toThrow(
      /manifest graph counts or hash do not match/,
    )
  })

  it('refuses a folder whose manifest node count does not match its nodes.jsonl', async () => {
    const dir = await writeGraphFolder(root, 'run-i', {
      manifestPatch: manifest => ({
        ...manifest,
        graph: {...(manifest.graph as Json), nodeCount: 99},
      }),
    })
    await expect(buildRunUploadPlan({folder: await readGraphFolder(dir)})).rejects.toThrow(
      /manifest graph counts or hash do not match/,
    )
  })

  it('refuses a folder that declares blobs the graph does not reference', async () => {
    const orphan = `sha256:${'a'.repeat(64)}`
    const dir = await writeGraphFolder(root, 'run-j', {
      manifestPatch: manifest => ({
        ...manifest,
        blobs: [
          ...(manifest.blobs as Json[]),
          {key: orphan, mime: 'image/png', size: 1, sha256: 'a'.repeat(64), file: 'blobs/x.png'},
        ],
      }),
    })
    await expect(buildRunUploadPlan({folder: await readGraphFolder(dir)})).rejects.toThrow(
      /unreferenced/,
    )
  })

  it('refuses a folder whose blob bytes were never exported', async () => {
    const dir = await writeGraphFolder(root, 'run-k', {
      manifestPatch: manifest => ({...manifest, missingBlobs: [BLOB_KEY]}),
    })
    await expect(buildRunUploadPlan({folder: await readGraphFolder(dir)})).rejects.toThrow(
      /missingBlobs/,
    )
  })

  it('refuses a declared blob whose file is absent from the folder', async () => {
    const dir = await writeGraphFolder(root, 'run-l', {writeBlobFile: false})
    await expect(buildRunUploadPlan({folder: await readGraphFolder(dir)})).rejects.toThrow(
      /hero-abcdef\.png/,
    )
  })

  it('refuses a blob whose sha256 disagrees with its content-addressed key', async () => {
    const dir = await writeGraphFolder(root, 'run-m', {
      manifestPatch: manifest => ({
        ...manifest,
        blobs: [{...manifestBlobEntry(), sha256: 'b'.repeat(64)}],
      }),
    })
    await expect(buildRunUploadPlan({folder: await readGraphFolder(dir)})).rejects.toThrow(
      /content-addressed key/,
    )
  })

  it('raises RunUploadError with a stable code so the CLI can explain itself', async () => {
    const dir = await writeGraphFolder(root, 'run-n', {
      manifestPatch: manifest => ({...manifest, missingBlobs: [BLOB_KEY]}),
    })
    const folder = await readGraphFolder(dir)
    await expect(buildRunUploadPlan({folder})).rejects.toBeInstanceOf(RunUploadError)
  })
})
