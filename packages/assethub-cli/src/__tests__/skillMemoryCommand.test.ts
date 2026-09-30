import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {afterEach, expect, test} from 'vitest'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

const cli = (baseUrl: string, stateDir: string, args: string[]) =>
  promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), ...args],
    {
      env: {
        ...process.env,
        ASSETHUB_API_KEY: 'test-key',
        ASSETHUB_API_BASE_URL: baseUrl,
        ASSETHUB_CLI_STATE_DIR: stateDir,
        ASSETHUB_CLI_CONFIG: join(stateDir, 'auth.json'),
      },
    },
  )

const LINKS = {
  skillId: 'clean-character-silhouette',
  revision: 4,
  contentSha256: 'a'.repeat(64),
  workflowRef: {
    graphId: 'graph-1',
    nodeId: 'node-2',
    sourceRevision: 3,
    contentSha256: 'b'.repeat(64),
    status: 'resolved',
    memoryId: 'graph-1:node-2',
    node: {id: 'node-2', artifactKind: 'image', tags: [], hasImage: true},
  },
  evidence: [
    {
      key: 'ev-1',
      kind: 'workspace_image',
      graphId: 'graph-1',
      artifactId: 'node-1',
      contentSha256: 'c'.repeat(64),
      sourceRevision: 3,
      decisionKind: 'artist_approved',
      status: 'resolved',
      memoryId: 'graph-1:node-1',
      node: {id: 'node-1', artifactKind: 'image', tags: [], hasImage: true},
    },
    {
      // Cited but forgotten: a status, not a failure.
      key: 'ev-2',
      kind: 'workspace_image',
      graphId: 'graph-2',
      artifactId: 'node-9',
      contentSha256: 'd'.repeat(64),
      sourceRevision: 1,
      decisionKind: 'artist_approved',
      status: 'graph_not_found',
      memoryId: 'graph-2:node-9',
    },
    {
      // Resolved but carries no image — must not be downloaded.
      key: 'ev-3',
      kind: 'workspace_image',
      graphId: 'graph-1',
      artifactId: 'node-3',
      contentSha256: 'e'.repeat(64),
      sourceRevision: 3,
      decisionKind: 'artist_approved',
      status: 'resolved',
      memoryId: 'graph-1:node-3',
      node: {id: 'node-3', artifactKind: 'text', tags: [], hasImage: false},
    },
  ],
  references: [
    {
      kind: 'canvas_graph',
      canvasId: 40516,
      graphId: 'graph-1',
      sourceRevision: 118,
      why: 'the silhouette pass',
      nodes: [
        {
          nodeId: 'node-4',
          status: 'resolved',
          memoryId: 'graph-1:node-4',
          node: {id: 'node-4', artifactKind: 'image', tags: [], hasImage: true},
        },
      ],
    },
  ],
  counts: {total: 5, resolved: 4, unresolved: 1},
  truncated: false,
}

const startServer = async (stateDir: string, requests: string[]) => {
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    requests.push(path)
    let data: unknown
    if (
      path.startsWith(
        '/api/v2/workspace-skills/clean-character-silhouette/memory',
      )
    )
      data = LINKS
    else if (path === '/api/v2/graphs/graph-1/nodes/node-1/image')
      data = {mediaType: 'image/png', data: 'aGVsbG8=', bytes: 5}
    else if (path === '/api/v2/graphs/graph-1/nodes/node-2/image')
      data = {mediaType: 'image/png', data: 'd29ybGQ=', bytes: 5}
    else if (path === '/api/v2/graphs/graph-1/nodes/node-4/image')
      data = {mediaType: 'image/png', data: 'cmVmcw==', bytes: 4}
    else {
      res.writeHead(404, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          success: false,
          error: {code: 'NOT_FOUND', message: 'nope'},
        }),
      )
      return
    }
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({success: true, data}))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  return `http://127.0.0.1:${address.port}`
}

test('skills memory prints the resolved refs and their replayable memory ids', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-skill-memory-cli-'))
  const requests: string[] = []
  const baseUrl = await startServer(stateDir, requests)

  const result = JSON.parse(
    (
      await cli(baseUrl, stateDir, [
        'skills',
        'memory',
        'clean-character-silhouette',
        '--revision',
        '4',
      ])
    ).stdout,
  )

  expect(requests[0]).toBe(
    '/api/v2/workspace-skills/clean-character-silhouette/memory?revision=4',
  )
  expect(result.counts).toEqual({total: 5, resolved: 4, unresolved: 1})
  expect(
    result.evidence.map((ref: {memoryId: string}) => ref.memoryId),
  ).toEqual(['graph-1:node-1', 'graph-2:node-9', 'graph-1:node-3'])
  // A forgotten memory is reported, not fatal.
  expect(result.evidence[1].status).toBe('graph_not_found')
  // Without --images nothing is downloaded.
  expect(requests.filter(path => path.endsWith('/image'))).toEqual([])
})

test('--images downloads only the refs that actually carry one', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-skill-memory-img-'))
  const requests: string[] = []
  const baseUrl = await startServer(stateDir, requests)
  const outDir = join(stateDir, 'evidence')

  const result = JSON.parse(
    (
      await cli(baseUrl, stateDir, [
        'skills',
        'memory',
        'clean-character-silhouette',
        '--images',
        outDir,
      ])
    ).stdout,
  )

  // workflowRef, one evidence node and one reference node have images; the
  // text node and the unresolved one must not be requested at all.
  expect(requests.filter(path => path.endsWith('/image')).sort()).toEqual([
    '/api/v2/graphs/graph-1/nodes/node-1/image',
    '/api/v2/graphs/graph-1/nodes/node-2/image',
    '/api/v2/graphs/graph-1/nodes/node-4/image',
  ])
  expect(result.images.downloaded).toHaveLength(3)
  expect(result.images.failed).toEqual([])
  // The memory id is not a safe file name as-is — the colon is replaced.
  const written = (await readdir(outDir)).sort()
  expect(written).toEqual([
    'graph-1_node-1.png',
    'graph-1_node-2.png',
    'graph-1_node-4.png',
  ])
  expect(await readFile(join(outDir, 'graph-1_node-1.png'), 'utf8')).toBe(
    'hello',
  )
})

test('a failed image download is recorded and exits non-zero', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-skill-memory-fail-'))
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    requests.push(path)
    if (path.startsWith('/api/v2/workspace-skills/')) {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({success: true, data: LINKS}))
      return
    }
    // Every image is over the inline cap.
    res.writeHead(413, {'content-type': 'application/json'})
    res.end(
      JSON.stringify({
        success: false,
        error: {code: 'IMAGE_TOO_LARGE', message: 'too big'},
      }),
    )
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const baseUrl = `http://127.0.0.1:${address.port}`

  await expect(
    cli(baseUrl, stateDir, [
      'skills',
      'memory',
      'clean-character-silhouette',
      '--images',
      join(stateDir, 'evidence'),
    ]),
  ).rejects.toMatchObject({code: 1})
})
