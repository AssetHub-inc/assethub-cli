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
      },
    },
  )

test('reads historical meshes and graphs through the built CLI', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-historical-cli-'))
  const requests: string[] = []
  let downloadHadAuth = false
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    requests.push(path)
    if (path === '/download/mesh.glb') {
      downloadHadAuth = req.headers.authorization != null
      res.writeHead(200, {'content-type': 'model/gltf-binary'})
      res.end(Buffer.from('mesh-bytes'))
      return
    }
    let data: unknown
    if (path.startsWith('/api/v2/meshes?'))
      data = {items: [{assetId: 'mesh/1', name: 'Chair', createdAt: '2026-09-08T00:00:00Z'}], nextCursor: null}
    else if (path === '/api/v2/assets/mesh%2F1')
      data = {assetId: 'mesh/1', url: `http://${req.headers.host}/download/mesh.glb`, expiresAt: '2026-09-09T00:00:00Z'}
    else if (path.startsWith('/api/v2/graphs?'))
      data = {items: [{graphId: 'graph-1', source: 'generated', updatedAt: null, lastRev: 4}], nextCursor: null}
    else if (path.startsWith('/api/v2/graphs/graph-1?'))
      data = {
        graphId: 'graph-1', source: 'generated', revision: 'rev-4', lastRev: 4,
        nodes: [{id: 'node-1', artifactKind: 'mesh', metadata: {assetId: 'mesh/1'}}],
        edges: [], nextCursor: null, truncated: false,
      }
    else if (path === '/api/v2/capabilities')
      data = {
        ownerId: 'org-a',
        executionContext: {status: 'available', operations: []},
        evaluators: [],
      }
    else if (path === '/api/v2/canvases/42')
      data = {
        id: 42,
        name: 'Canvas graph',
        ownerId: 'org-a',
        url: 'https://app.assethub.io/workflow/42',
      }
    else if (path.startsWith('/api/v2/canvases/42/graph?'))
      data = {
        graphId: 'canvas-graph',
        canvas: {
          id: 42,
          name: 'Canvas graph',
          ownerId: 'org-a',
          url: 'https://app.assethub.io/workflow/42',
        },
        revision: 'canvas-rev-1',
        nodes: [],
        edges: [],
        nextCursor: null,
        truncated: false,
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
  const outDir = join(stateDir, 'download')
  try {
    const meshes = JSON.parse(
      (await cli(baseUrl, stateDir, ['mesh', 'list', '--query', 'chair & shell', '--cursor', 'c/+', '--limit', '10'])).stdout,
    )
    expect(meshes.items[0].assetId).toBe('mesh/1')
    expect(requests[0]).toContain('/api/v2/meshes?q=chair+%26+shell&cursor=c%2F%2B&limit=10')

    const asset = JSON.parse((await cli(baseUrl, stateDir, ['mesh', 'get', 'mesh/1'])).stdout)
    expect(asset.assetId).toBe('mesh/1')
    const downloaded = JSON.parse((await cli(baseUrl, stateDir, ['mesh', 'download', 'mesh/1', '--out-dir', outDir])).stdout)
    expect(downloaded.asset.assetId).toBe('mesh/1')
    expect(downloadHadAuth).toBe(false)
    expect(await readFile(join(outDir, '001-mesh.glb'), 'utf8')).toBe('mesh-bytes')

    const graphs = JSON.parse((await cli(baseUrl, stateDir, ['graph', 'list', '--limit', '10'])).stdout)
    expect(graphs.items[0].graphId).toBe('graph-1')
    const lineage = JSON.parse((await cli(baseUrl, stateDir, ['graph', 'lineage', '--graph', 'graph-1', '--artifact', 'node-1', '--direction', 'ancestors', '--depth', '2'])).stdout)
    expect(lineage.graphId).toBe('graph-1')
    const lineagePath = join(stateDir, 'lineage.json')
    const savedLineage = JSON.parse((await cli(baseUrl, stateDir, ['graph', 'lineage', '--graph', 'graph-1', '--artifact', 'node-1', '--out', lineagePath])).stdout)
    expect(savedLineage.path).toBe(lineagePath)
    expect(JSON.parse(await readFile(lineagePath, 'utf8')).nodes[0].id).toBe('node-1')
    const shownPath = join(stateDir, 'shown.json')
    await cli(baseUrl, stateDir, ['graph', 'show', '--graph', 'graph-1', '--out', shownPath])
    expect(JSON.parse(await readFile(shownPath, 'utf8')).graphId).toBe('graph-1')

    const output = join(stateDir, 'graph.json')
    const exported = JSON.parse((await cli(baseUrl, stateDir, ['graph', 'export', '--graph', 'graph-1', '--out', output])).stdout)
    expect(exported.path).toBe(output)
    expect(JSON.parse(await readFile(output, 'utf8')).lastRev).toBe(4)
    const canvasGraph = JSON.parse((await cli(baseUrl, stateDir, ['graph', 'show', '--canvas', '42'])).stdout)
    expect(canvasGraph.graphId).toBe('canvas-graph')

    await expect(cli(baseUrl, stateDir, ['graph', 'show', '--graph', 'graph-1', '--canvas', '42'])).rejects.toThrow(/cannot combine --graph and --canvas/)
    await expect(cli(baseUrl, stateDir, ['graph', 'show', '--source', 'upload'])).rejects.toThrow(/--source requires --graph/)
    await expect(cli(baseUrl, stateDir, ['graph', 'lineage', '--graph', 'graph-1'])).rejects.toThrow(/Missing required flag: --artifact/)
    await expect(cli(baseUrl, stateDir, ['mesh', 'get', 'foreign'])).rejects.toThrow(/AssetHub API error \[404\]/)
  } finally {
    await Promise.all(cleanup.splice(0).map(fn => fn()))
  }
}, 30000)
