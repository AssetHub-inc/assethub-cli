import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '@assethub/api-client'
import {
  executeRecorded,
  openExecutionSession,
  resumeRecorded,
} from '../execution.js'
import {executeNodeMeshBatch} from '../nodeMeshBatch.js'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map(path => rm(path, {recursive: true, force: true})),
  )
})
const operationId = '11111111-1111-4111-8111-111111111111'
const fixture = async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-native-replay-'))
  folders.push(stateDir)
  const scope = {ownerId: 'org-a'}
  const posted: Array<{key: string; body: Record<string, unknown>}> = []
  const runs = new Map<string, unknown>()
  const canvas = {
    id: 42,
    name: 'Canvas',
    ownerId: scope.ownerId,
    url: 'https://api.test/workflow/42',
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    let data: unknown
    if (String(url).endsWith('/capabilities'))
      data = {
        ownerId: scope.ownerId,
        executionContext: {
          status: 'available',
          operations: ['mesh.generate', 'mesh.compose'],
        },
        evaluators: [],
      }
    else if (String(url).endsWith('/canvases/42')) data = canvas
    else if (String(url).includes('/runs/'))
      data = runs.get(String(url).split('/').at(-1)!)
    else {
      const key = new Headers(init?.headers).get('Idempotency-Key')!
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posted.push({key, body})
      const execution = {
        runId: key,
        status: 'completed',
        operation: String(url).endsWith('compose')
          ? 'mesh.compose'
          : 'mesh.generate',
        history: {status: 'recorded'},
        outputs: [],
        context: body.executionContext,
        canvas,
      }
      runs.set(key, execution)
      data = {execution}
    }
    return new Response(JSON.stringify({success: true, data}), {
      headers: {'content-type': 'application/json'},
    })
  })
  const client = createAssetHubClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    fetch,
  })
  const session = await openExecutionSession({
    client,
    stateDir,
    cwd: stateDir,
    canvasId: 42,
  })
  return {session, scope, posted, fetch}
}

// @testdoc Omitting or changing a saved native override must reject operation-ID reuse; the full matching body still resumes without a new dispatch.
it.each(['mesh.generate', 'mesh.compose'] as const)(
  'compares the complete saved %s body on native resume',
  async operation => {
    const f = await fixture()
    const body =
      operation === 'mesh.generate'
        ? {modelId: 'saved-model'}
        : {agentVersion: 'saved-version'}
    await executeRecorded(f.session, operation, body as never, {
      operationId,
      canvasNode: {nodeId: 'shape:node'},
    })
    for (const expectedBody of [{}, {...body, name: 'changed'}])
      await expect(
        resumeRecorded({...f.session, operationId, expectedBody}),
      ).rejects.toThrow('different inputs')
    await expect(
      resumeRecorded({...f.session, operationId, expectedBody: body}),
    ).resolves.toMatchObject({execution: {runId: operationId}})
    expect(f.posted).toHaveLength(1)
  },
)

// @testdoc Any existing batch reservation, including falsy or malformed JSON, prevents its ID from becoming a normal paid operation.
it.each(['null', 'false', '0', '""', '{'])(
  'keeps batch reservation for file content %s',
  async content => {
    const f = await fixture()
    const path = join(f.session.stateDir, 'node-batches', `${operationId}.json`)
    await mkdir(join(f.session.stateDir, 'node-batches'))
    await writeFile(path, content)
    await expect(
      executeRecorded(f.session, 'mesh.generate', {} as never, {
        operationId,
        canvasNode: {nodeId: 'shape:node'},
      }),
    ).rejects.toThrow()
    expect(f.posted).toHaveLength(0)
    expect(await readFile(path, 'utf8')).toBe(content)
  },
)

// @testdoc A competing exclusive batch insert reuses the original target set and completed child receipts, after checking owner, canvas, node and the complete body.
it('adopts a pinned batch on EEXIST without changing targets or dispatching completed children', async () => {
  const f = await fixture()
  const input = {
    operationId,
    nodeId: 'shape:production',
    body: {modelId: 'saved'},
    children: ['shape:original'],
    skipped: [],
  }
  const first = await executeNodeMeshBatch(f.session, input)
  const second = await executeNodeMeshBatch(f.session, {
    ...input,
    children: ['shape:newly-discovered'],
  })
  expect(second).toEqual(first)
  expect(f.posted).toHaveLength(1)
  for (const changed of [
    {nodeId: 'shape:other'},
    {body: {}},
    {body: {modelId: 'changed'}},
  ])
    await expect(
      executeNodeMeshBatch(f.session, {...input, ...changed}),
    ).rejects.toThrow('different')
  await expect(
    executeNodeMeshBatch(
      {...f.session, canvas: {...f.session.canvas, id: 43}},
      input,
    ),
  ).rejects.toThrow('different canvas')
  f.scope.ownerId = 'org-b'
  await expect(
    executeNodeMeshBatch({...f.session, ownerId: 'org-b'}, input),
  ).rejects.toThrow('different organization')
  expect(f.posted).toHaveLength(1)
})

// @testdoc Simultaneous commands publish complete batch and child journals before adoption, and both callers reuse the same pinned child idempotency keys.
it('safely adopts batches created concurrently with Promise.all', async () => {
  const f = await fixture()
  const input = {
    operationId,
    nodeId: 'shape:production',
    body: {params: {description: 'saved scene '.repeat(200000)}},
    children: ['shape:original'],
    skipped: [],
  }
  const results = await Promise.all([
    executeNodeMeshBatch(f.session, input),
    executeNodeMeshBatch(f.session, input),
  ])
  expect(results[1]).toEqual(results[0])
  expect(new Set(f.posted.map(request => request.key)).size).toBe(1)
  const saved = JSON.parse(
    await readFile(
      join(f.session.stateDir, 'node-batches', `${operationId}.json`),
      'utf8',
    ),
  )
  expect(saved.children.map((child: {nodeId: string}) => child.nodeId)).toEqual(
    ['shape:original'],
  )
})
