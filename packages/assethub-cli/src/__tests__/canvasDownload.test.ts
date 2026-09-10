import {createServer} from 'node:http'
import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, expect, test, vi} from 'vitest'
import type {CanvasExport} from '@assethub/api-client'
import {downloadCanvas} from '../canvasDownload.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

const fixture = async (fail: boolean) => {
  const outDir = await mkdtemp(join(tmpdir(), 'canvas-handoff-'))
  cleanup.push(() => rm(outDir, {recursive: true, force: true}))
  const authorizations: unknown[] = []
  let exported: CanvasExport
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      const data = req.url.startsWith('/api/v2/capabilities')
        ? {
            ownerId: 'org-a',
            executionContext: {status: 'available', operations: []},
            evaluators: [],
          }
        : req.url.includes('/export')
          ? exported
          : exported.canvas
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({success: true, data}))
      return
    }
    authorizations.push(req.headers.authorization)
    if (req.url?.startsWith('/mesh')) {
      res.writeHead(fail ? 503 : 200, {'content-type': 'model/gltf-binary'})
      res.end(fail ? 'PRIVATE FAILURE BODY' : 'mesh bytes')
    } else {
      res.writeHead(200, {'content-type': 'image/png'})
      res.write(Buffer.from([137, 80, 78, 71]))
      res.end(Buffer.from([13, 10, 26, 10]))
    }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing test server port')
  const origin = `http://127.0.0.1:${address.port}`
  exported = {
    schemaVersion: 'assethub.canvas-export.v1',
    canvas: {
      id: 42,
      name: '<script>bad()</script>',
      ownerId: 'org-a',
      url: 'https://app.assethub.io/workflow/42',
    },
    assets: [
      {
        id: 'source',
        name: '../../source<script>',
        mediaType: 'image',
        role: 'recorded_input',
        url: `${origin}/image?token=SECRET`,
      },
      {
        id: 'mesh_1',
        name: 'Mesh',
        mediaType: 'mesh',
        format: 'glb',
        role: 'visible',
        url: `${origin}/mesh?token=SECRET`,
      },
    ],
    steps: [
      {
        id: 'generation',
        source: 'mesh_generation',
        operation: 'Generate mesh',
        prompt: '<script>prompt()</script>',
        inputs: [
          {
            id: 'source',
            role: 'front',
            evidence: 'mesh_generation.input_images',
          },
        ],
        outputs: ['mesh_1'],
        warnings: [],
      },
    ],
    warnings: [],
    truncated: false,
  }
  const exportCanvas = vi.fn().mockResolvedValue(exported)
  return {outDir, origin, authorizations, client: {v2: {exportCanvas}}}
}

test('streams images and final meshes into safe local history without signed tokens or API credentials', async () => {
  const input = await fixture(false)
  const result = await downloadCanvas({...input, canvasId: 42, mesh: 'mesh_1'})
  expect(input.client.v2.exportCanvas).toHaveBeenCalledWith(42, {
    mesh: 'mesh_1',
  })
  expect(result).toMatchObject({downloaded: 2, failed: 0, exitCode: 0})
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
  expect(manifest.assets.map((file: {bytes: number}) => file.bytes)).toEqual([
    8, 10,
  ])
  expect(manifest.assets[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(
    await readFile(join(input.outDir, manifest.assets[1].path), 'utf8'),
  ).toBe('mesh bytes')
  const html = await readFile(result.htmlPath, 'utf8')
  expect(html).toContain('&lt;script&gt;prompt()&lt;/script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('Content-Security-Policy')
  expect(await readFile(result.historyPath, 'utf8')).toContain(
    'Outputs: [Mesh](files/',
  )
  expect(JSON.stringify(manifest)).not.toContain('SECRET')
  expect(input.authorizations).toEqual([undefined, undefined])
  expect(
    (await readdir(join(input.outDir, 'files'))).every(
      name => !name.startsWith('.') && !name.includes('/'),
    ),
  ).toBe(true)
  await expect(downloadCanvas({...input, canvasId: 42})).rejects.toThrow(
    'empty output directory',
  )
})

test('the built CLI accepts canvas download and reports its local bundle paths', async () => {
  const input = await fixture(false)
  const stateDir = await mkdtemp(join(tmpdir(), 'canvas-handoff-state-'))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  const {stdout, stderr} = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
      'canvas',
      'download',
      '--canvas',
      '42',
      '--mesh',
      'mesh_1',
      '--out-dir',
      input.outDir,
    ],
    {
      env: {
        ...process.env,
        ASSETHUB_API_KEY: 'test-key',
        ASSETHUB_API_BASE_URL: input.origin,
        ASSETHUB_CLI_STATE_DIR: stateDir,
        ASSETHUB_CLI_CONFIG: join(stateDir, 'auth.json'),
      },
    },
  )
  expect(JSON.parse(stdout)).toMatchObject({
    downloaded: 2,
    failed: 0,
    manifestPath: join(input.outDir, 'manifest.json'),
  })
  expect(stderr).toContain('Downloading 2/2')
  expect(input.authorizations).toEqual([undefined, undefined])
})

test('retains successful files and a readable partial manifest when a file download fails', async () => {
  const input = await fixture(true)
  const result = await downloadCanvas({...input, canvasId: 42})
  expect(result).toMatchObject({downloaded: 1, failed: 1, exitCode: 1})
  const content = await readFile(result.manifestPath, 'utf8')
  const manifest = JSON.parse(content)
  expect(manifest.assets[1]).toMatchObject({id: 'mesh_1', error: 'HTTP 503'})
  expect(manifest.assets[1].path).toBeUndefined()
  expect(content).not.toMatch(/SECRET|PRIVATE FAILURE BODY/)
  expect(await readdir(join(input.outDir, 'files'))).toHaveLength(1)
})
