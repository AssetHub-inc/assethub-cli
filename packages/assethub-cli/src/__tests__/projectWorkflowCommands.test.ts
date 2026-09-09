import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import {expect, test} from 'vitest'

// Built CLI + HTTP boundary: verifies the standalone artifact, command wiring,
// context pinning, moodboard recovery and portable source/output review.
test('runs the project workflow through the built standalone CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-project-cli-'))
  const requests: {
    path: string
    method: string
    body: Record<string, unknown>
  }[] = []
  let analyses = 0
  let leakedAuth = false
  const revision = {id: 'revision-1', status: 'ready', analysisJobId: 'job-1'}
  const board = {id: 'board-1', currentRevision: revision}
  const server = createServer(async (req, res) => {
    const path = req.url!
    if (path === '/source.png') {
      leakedAuth ||= !!req.headers.authorization
      res.writeHead(200, {'content-type': 'image/png'})
      res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body: Record<string, unknown> = raw ? JSON.parse(raw) : {}
    requests.push({path, method: req.method!, body})
    const canvas = {
      id: 42,
      name: 'Review',
      ownerId: 'org-a',
      url: `http://${req.headers.host}/workflow/42`,
    }
    let data: unknown
    if (path.endsWith('/capabilities'))
      data = {
        ownerId: 'org-a',
        executionContext: {status: 'available', operations: ['image.generate']},
        evaluators: [],
      }
    else if (path.endsWith('/canvases/42')) data = canvas
    else if (path.endsWith('/canvases/42/context'))
      data = {
        canvasId: 42,
        projectContext: {
          version: 3,
          sha256: 'context-sha',
          document: body.document ?? {title: 'IP facts'},
        },
      }
    else if (path.endsWith('/canvases/42/layout'))
      data = {
        canvasId: 42,
        status: 'committed',
        addedRecordIds: ['shape:source'],
        existingRecordIds: [],
        serverClock: 3,
      }
    else if (path.endsWith('/canvases/42/assets'))
      data = {canvasId: 42, assetId: 'source-asset', mediaType: 'image'}
    else if (path.endsWith('/moodboards/board-1/analyze')) {
      analyses++
      data = {...revision, status: 'analyzing'}
    } else if (
      path.endsWith('/moodboards') ||
      path.endsWith('/moodboards/board-1')
    )
      data = board
    else if (path.includes('/assets/'))
      data = {
        assetId: path.split('/').at(-1),
        url: `http://${req.headers.host}/source.png`,
      }
    else if (path.endsWith('/language/vision'))
      data = {
        texts: ['Source facts and proposed background'],
        jobId: 'vision-1',
      }
    else if (path.endsWith('/image/generate'))
      data = {
        jobId: 'job-2',
        execution: {
          schemaVersion: 'assethub.execution.v1',
          runId: 'run-1',
          status: 'completed',
          operation: 'image.generate',
          canvas,
          jobIds: [],
          orderIds: [],
          graphRefs: [],
          outputs: [],
          history: {status: 'recorded'},
          context: body.executionContext,
          input: body,
        },
      }
    else {
      res.writeHead(404)
      res.end(JSON.stringify({success: false, error: {message: path}}))
      return
    }
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({success: true, data}))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const cli = async (...args: string[]) => {
    const result = await promisify(execFile)(
      process.execPath,
      [resolve('packages/assethub-cli/dist/index.js'), ...args],
      {
        env: {
          ...process.env,
          ASSETHUB_API_KEY: 'test-key',
          ASSETHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          ASSETHUB_CLI_STATE_DIR: dir,
          ASSETHUB_CLI_CONFIG: join(dir, 'auth.json'),
        },
      },
    )
    return JSON.parse(result.stdout)
  }
  try {
    const contextPath = join(dir, 'context.json')
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        title: 'IP facts',
        instructions: {must: ['same face'], avoid: ['generic panda']},
        sources: [],
      }),
    )
    await cli(
      'canvas',
      'context',
      'put',
      '--canvas',
      '42',
      '--file',
      contextPath,
      '--if-version',
      '2',
    )
    expect(
      requests.find(request => request.method === 'PUT')?.body.expectedVersion,
    ).toBe(2)
    const savedPath = join(dir, 'saved.json')
    await cli('canvas', 'context', 'get', '--canvas', '42', '--out', savedPath)
    expect(JSON.parse(await readFile(savedPath, 'utf8'))).toEqual({
      title: 'IP facts',
    })
    await cli(
      'canvas',
      'import',
      '--canvas',
      '42',
      '--resource-id',
      'source-asset',
    )
    expect(
      requests.find(request => request.path.endsWith('/canvases/42/assets'))
        ?.body.source,
    ).toEqual({resourceId: 'source-asset'})
    await cli(
      'moodboard',
      'create',
      '--input-json',
      JSON.stringify({name: 'Style', assetIds: ['source-asset']}),
      '--operation-id',
      '00000000-0000-4000-8000-000000000001',
    )
    expect(
      (
        await cli(
          'moodboard',
          'analyze',
          'board-1',
          '--wait',
          '--interval-ms',
          '1',
        )
      ).status,
    ).toBe('ready')
    expect(analyses).toBe(1)
    await expect(
      cli('moodboard', 'analyze', 'board-1', '--interval-ms', 'invalid'),
    ).rejects.toThrow()
    expect(analyses).toBe(1)
    await cli(
      'moodboard',
      'create',
      '--input-json',
      JSON.stringify({name: 'Repeatable', assetIds: ['source-asset']}),
    )
    await cli(
      'moodboard',
      'create',
      '--input-json',
      JSON.stringify({name: 'Repeatable', assetIds: ['source-asset']}),
    )
    const repeatable = requests.filter(
      request =>
        request.path.endsWith('/moodboards') &&
        request.body.name === 'Repeatable',
    )
    expect(repeatable[0]?.body.clientOperationId).toBe(
      repeatable[1]?.body.clientOperationId,
    )
    const analysisPath = join(dir, 'analysis.json')
    await cli(
      'language',
      'vision',
      '--input-json',
      JSON.stringify({
        modelId: 'example/model',
        prompt: 'Read source facts and infer background separately',
        imageAssetIds: ['source-asset'],
      }),
      '--operation-id',
      '00000000-0000-4000-8000-000000000003',
      '--out',
      analysisPath,
    )
    expect(JSON.parse(await readFile(analysisPath, 'utf8')).texts).toEqual([
      'Source facts and proposed background',
    ])

    await cli(
      'image',
      'generate',
      '--canvas',
      '42',
      '--context',
      '42',
      '--moodboard-revision',
      'revision-1',
      '--prompt',
      '3D storyboard',
    )
    expect(
      requests.find(request => request.path.endsWith('/image/generate'))?.body,
    ).toMatchObject({
      projectContext: {canvasId: 42, version: 3},
      moodboardRevisionId: 'revision-1',
      executionContext: {canvasId: 42},
    })
    const comparisonPath = join(dir, 'review.html')
    await cli(
      'canvas',
      'compare',
      '--canvas',
      '42',
      '--source-id',
      'source-asset',
      '--asset-id',
      'output-asset',
      '--out',
      comparisonPath,
      '--title',
      '<script>bad</script>',
    )
    const html = await readFile(comparisonPath, 'utf8')
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('awaiting_creator_review')
    expect(leakedAuth).toBe(false)
    const layout = await cli(
      'canvas',
      'layout',
      '--canvas',
      '42',
      '--input-json',
      JSON.stringify({
        images: [
          {assetId: 'source-asset', role: 'source', x: 0, y: 0},
          {assetId: 'output-asset', role: 'output', x: 600, y: 0},
        ],
        connections: [
          {sourceAssetId: 'source-asset', targetAssetId: 'output-asset'},
        ],
      }),
    )
    expect(layout.status).toBe('committed')
    expect(layout).not.toHaveProperty('token')

    await expect(
      cli(
        'image',
        'generate',
        '--canvas',
        '42',
        '--context',
        '43',
        '--prompt',
        'Mismatch',
      ),
    ).rejects.toThrow()
    expect(
      requests.filter(request => request.path.endsWith('/image/generate')),
    ).toHaveLength(1)
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    await rm(dir, {recursive: true, force: true})
  }
}, 30000)
