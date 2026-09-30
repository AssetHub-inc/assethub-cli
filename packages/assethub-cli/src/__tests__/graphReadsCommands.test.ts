import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
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

test('reads a memorized graph snapshot, one node, its image, and a canvas graph-id through the built CLI', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-graph-reads-cli-'))
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    requests.push(path)
    let data: unknown
    if (path.startsWith('/api/v2/graphs/graph-1/snapshot?'))
      data = {
        graphId: 'graph-1',
        lastRev: 4,
        nodeCount: 1,
        edgeCount: 0,
        nodes: [
          {id: 'node-1', artifactKind: 'image', tags: ['image'], title: 'Front view'},
        ],
        nextOffset: null,
      }
    else if (path === '/api/v2/graphs/graph-1/nodes/node-1')
      data = {
        graphId: 'graph-1',
        id: 'node-1',
        artifactKind: 'image',
        tags: ['image'],
        metadata: {title: 'Front view'},
        payload: {blobKey: 'image_gen/org-1/front.png'},
        edges: {incoming: [], outgoing: []},
      }
    else if (path === '/api/v2/graphs/graph-1/nodes/node-1/image')
      data = {mediaType: 'image/png', data: 'aGVsbG8=', bytes: 5}
    else if (path === '/api/v2/canvases/40516/graph-id')
      data = {
        canvasId: 40516,
        memorizeGraphId: 'mem-1',
        memorizeSnapshotExists: true,
        exportGraphId: 'exp-1',
        exportSnapshotExists: false,
      }
    else {
      res.writeHead(404)
      res.end()
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
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const snapshot = JSON.parse(
      (
        await cli(baseUrl, stateDir, [
          'graph',
          'snapshot',
          'graph-1',
          '--offset',
          '0',
          '--limit',
          '10',
        ])
      ).stdout,
    )
    expect(snapshot.graphId).toBe('graph-1')
    expect(snapshot.nodes[0].id).toBe('node-1')
    expect(requests[0]).toContain('offset=0')
    expect(requests[0]).toContain('limit=10')

    const node = JSON.parse(
      (await cli(baseUrl, stateDir, ['graph', 'node', 'graph-1', 'node-1']))
        .stdout,
    )
    expect(node.id).toBe('node-1')
    expect(node.payload.blobKey).toBe('image_gen/org-1/front.png')

    const outPath = join(stateDir, 'front.png')
    const image = JSON.parse(
      (
        await cli(baseUrl, stateDir, [
          'graph',
          'image',
          'graph-1',
          'node-1',
          '--out',
          outPath,
        ])
      ).stdout,
    )
    expect(image.path).toBe(outPath)
    expect(image.mediaType).toBe('image/png')
    expect(image.bytes).toBe(5)
    expect(image.data).toBeUndefined()
    expect(await readFile(outPath, 'utf8')).toBe('hello')

    // Without --out, the metadata prints WITHOUT the base64 blob.
    const printedImage = JSON.parse(
      (await cli(baseUrl, stateDir, ['graph', 'image', 'graph-1', 'node-1']))
        .stdout,
    )
    expect(printedImage).toEqual({mediaType: 'image/png', bytes: 5})

    const graphIds = JSON.parse(
      (await cli(baseUrl, stateDir, ['canvas', 'graph-id', '40516'])).stdout,
    )
    expect(graphIds.canvasId).toBe(40516)
    expect(graphIds.memorizeGraphId).toBe('mem-1')
    expect(graphIds.exportGraphId).toBe('exp-1')
    expect(graphIds.memorizeSnapshotExists).toBe(true)
    expect(graphIds.exportSnapshotExists).toBe(false)
  } finally {
    await Promise.all(cleanup.splice(0).map(fn => fn()))
  }
}, 30000)
