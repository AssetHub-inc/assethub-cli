import composerHistoryLifecycle from '../../../assethub-api-client/__tests__/fixtures/composerHistoryLifecycle.json'
// The /workspace-skills/reviews/* part of the server's OpenAPI document,
// exported from the application repository's spec.
import workspaceSkillReviewSpec from '../../../assethub-api-client/__tests__/fixtures/workspaceSkillReviewSpec.json'
import conceptImageAdmission from '../../../assethub-api-client/__tests__/fixtures/conceptImageAdmission.json'
import graphPolicyExecution from '../../../assethub-api-client/__tests__/fixtures/graphPolicyExecution.json'
import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {afterEach, expect, it} from 'vitest'

const operationId = '11111111-1111-4111-8111-111111111111'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assethub-api-cli-'))
  cleanups.push(() => rm(directory, {recursive: true, force: true}))
  const requests: Array<{
    url: string
    method: string
    key?: string
    authorization?: string
    body: unknown
  }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) : undefined
    requests.push({
      url: request.url!,
      method: request.method!,
      key: request.headers['idempotency-key'] as string | undefined,
      authorization: request.headers.authorization,
      body,
    })
    response.setHeader('content-type', 'application/json')
    if (request.url?.endsWith('/openapi')) {
      response.end(
        JSON.stringify({
          components: {schemas: workspaceSkillReviewSpec.schemas},
          paths: request.url.includes('/v2/')
            ? {
                ...workspaceSkillReviewSpec.paths,
                '/runs/{runId}/history/{eventId}/{sha256}': {
                  get: {
                    responses: {
                      '200': {
                        content: {
                          'application/octet-stream': {
                            schema: {type: 'string', format: 'binary'},
                          },
                        },
                      },
                    },
                  },
                },
                '/runs/{runId}': {get: {summary: 'Read production run'}},
                '/image/generate': {post: {summary: 'Generate image'}},
                '/mesh/refine/foreground': {
                  post: {summary: 'Composer foreground history lifecycle'},
                },
                '/mesh/compose': {post: {summary: 'Compose saved parts'}},
                '/canvases/{canvasId}/nodes': {
                  get: {summary: 'Read saved nodes'},
                },
              }
            : {},
        }),
      )
      return
    }
    if (request.url === '/api/v2/mesh/refine/foreground') {
      response.end(
        JSON.stringify(
          body.action === 'admit'
            ? {
                success: true,
                data: {skillRunId: composerHistoryLifecycle.runId},
              }
            : composerHistoryLifecycle.terminal,
        ),
      )
      return
    }
    if (
      request.url?.startsWith('/api/v2/runs/') &&
      !request.url.includes('/history/')
    ) {
      response.end(JSON.stringify(graphPolicyExecution))
      return
    }
    if (request.url === '/api/v2/image/generate') {
      response.end(JSON.stringify(conceptImageAdmission))
      return
    }
    if (request.url?.includes('/history/')) {
      const type = new URL(request.url, 'http://localhost').searchParams.get(
        'type',
      )
      response.setHeader(
        'content-type',
        type === 'json' ? 'application/json' : 'application/octet-stream',
      )
      if (type === 'oversize') {
        response.setHeader('content-length', String(64 * 1024 * 1024 + 1))
        response.write('x')
        response.end()
        return
      }
      response.end(Buffer.from([0, 255, 10]))
      return
    }
    if (body?.fail) {
      response.statusCode = 409
      response.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'EXECUTION_RECOVERY_REQUIRED',
            message: 'Inspect original run',
            details: {runId: 'original-run'},
          },
        }),
      )
      return
    }
    response.end(JSON.stringify({success: true, data: {runId: 'saved-run'}}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  )
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing test listener')
  const run = (args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
        'api',
        ...args,
      ],
      {
        env: {
          ...process.env,
          ASSETHUB_API_KEY: 'test-key',
          ASSETHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          ASSETHUB_CLI_CONFIG: join(directory, 'auth.json'),
          ASSETHUB_CLI_STATE_DIR: directory,
        },
      },
    )
  return {directory, requests, run}
}

// @testdoc The built CLI discovers only authenticated advertised routes and maps an exact operation plus JSON path/query parameters to the existing API transport.
it('searches and describes contracts then calls a read operation', async () => {
  const {run, requests} = await setup()
  expect(
    JSON.parse((await run(['search', 'Compose saved parts'])).stdout),
  ).toMatchObject({
    operations: [
      {operation: 'POST /mesh/compose', summary: 'Compose saved parts'},
    ],
  })
  expect(
    JSON.parse((await run(['describe', 'POST /mesh/compose'])).stdout),
  ).toMatchObject({id: 'POST /mesh/compose', path: '/api/v2/mesh/compose'})
  expect(
    JSON.parse(
      (
        await run([
          'call',
          'GET /canvases/{canvasId}/nodes',
          '--path-json',
          '{"canvasId":"42"}',
          '--query-json',
          '{"query":"head & body"}',
        ])
      ).stdout,
    ),
  ).toMatchObject({success: true, data: {runId: 'saved-run'}})
  expect(requests.at(-1)).toMatchObject({
    url: '/api/v2/canvases/42/nodes?query=head+%26+body',
    method: 'GET',
    authorization: 'Bearer test-key',
  })
})

// @testdoc CLI mutations use the caller's explicit UUID and exact JSON file input; missing keys and traversal never reach a mutation endpoint.
it('requires a mutation key and preserves its body from a file', async () => {
  const {run, directory, requests} = await setup()
  const body = {parts: ['mesh_1', 'mesh_2']}
  const path = join(directory, 'compose.json')
  await writeFile(path, JSON.stringify(body))
  await expect(
    run(['call', 'POST /mesh/compose', '--input-json', `@${path}`]),
  ).rejects.toMatchObject({code: 2})
  await expect(
    run([
      'call',
      'GET /canvases/{canvasId}/nodes',
      '--path-json',
      '{"canvasId":"../private"}',
    ]),
  ).rejects.toMatchObject({code: 2})
  expect(
    requests.filter(request => !request.url.endsWith('/openapi')),
  ).toHaveLength(0)
  await run([
    'call',
    'POST /mesh/compose',
    '--input-json',
    `@${path}`,
    '--operation-id',
    operationId,
  ])
  expect(requests.at(-1)).toMatchObject({
    url: '/api/v2/mesh/compose',
    method: 'POST',
    key: operationId,
    body,
  })
})

// @testdoc A failed generic mutation reports its original operation/run IDs through normal CLI error output and sends the write only once.
it('preserves recovery identity without retrying the mutation', async () => {
  const {run, requests} = await setup()
  const error = await run([
    'call',
    'POST /mesh/compose',
    '--input-json',
    '{"fail":true}',
    '--operation-id',
    operationId,
  ]).catch(error => error)
  expect(error.code).toBe(2)
  expect(JSON.parse(error.stdout)).toMatchObject({
    error: {code: 'EXECUTION_RECOVERY_REQUIRED'},
    operationId,
    runId: 'original-run',
  })
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
})

// @testdoc The built CLI discovers and reads the same existing run receipt, retaining canonical policy and outputs as JSON.
it('retains a graph policy receipt through CLI api call', async () => {
  const {run, requests} = await setup()
  expect(
    JSON.parse((await run(['describe', 'GET /runs/{runId}'])).stdout),
  ).toMatchObject({path: '/api/v2/runs/{runId}'})
  const result = await run([
    'call',
    'GET /runs/{runId}',
    '--path-json',
    JSON.stringify({runId: graphPolicyExecution.data.runId}),
  ])
  expect(JSON.parse(result.stdout)).toEqual(graphPolicyExecution)
  expect(requests.filter(request => !request.url.endsWith('/openapi'))).toEqual(
    [
      expect.objectContaining({
        url: `/api/v2/runs/${graphPolicyExecution.data.runId}`,
        method: 'GET',
        authorization: 'Bearer test-key',
      }),
    ],
  )
})

// @testdoc The built CLI discovers the existing image operation and preserves the exact automatic Concept receipt from one paid request.
it('retains Concept admission through CLI api call', async () => {
  const {run, requests} = await setup()
  expect(
    JSON.parse((await run(['describe', 'POST /image/generate'])).stdout),
  ).toMatchObject({path: '/api/v2/image/generate'})
  const result = await run([
    'call',
    'POST /image/generate',
    '--input-json',
    JSON.stringify({prompt: 'Current concept brief'}),
    '--operation-id',
    operationId,
  ])
  expect(JSON.parse(result.stdout)).toEqual(conceptImageAdmission)
  expect(requests.filter(request => request.method === 'POST')).toEqual([
    expect.objectContaining({
      url: '/api/v2/image/generate',
      key: operationId,
      body: {prompt: 'Current concept brief'},
    }),
  ])
})

it('task4 built CLI discovers and calls the common review command without extra authority', async () => {
  const {run, requests, directory} = await setup()
  expect((await run(['search', 'review'])).stdout).toContain(
    'POST /workspace-skills/reviews/{outputAssetId}/cancel',
  )
  expect(
    (await run(['describe', 'POST /workspace-skills/reviews/{outputAssetId}']))
      .stdout,
  ).toContain('WorkspaceSkillReviewCommand')
  const file = join(directory, 'review.json')
  await writeFile(file, JSON.stringify({canvasId: 42}))
  await run([
    'call',
    'POST /workspace-skills/reviews/{outputAssetId}',
    '--path-json',
    '{"outputAssetId":"image:one"}',
    '--input-json',
    `@${file}`,
    '--operation-id',
    operationId,
  ])
  expect(requests.at(-1)).toMatchObject({
    url: '/api/v2/workspace-skills/reviews/image%3Aone',
    method: 'POST',
    key: operationId,
    body: {canvasId: 42},
  })
})

// @testdoc The built CLI drives the same admitted Composer execution to needs_review through the advertised operation, preserving explicit Off and exact saved-shape identity.
it('executes the Composer history lifecycle through the built CLI', async () => {
  const {run, requests} = await setup()
  for (const body of [
    composerHistoryLifecycle.admission,
    composerHistoryLifecycle.finish,
  ]) {
    const result = JSON.parse(
      (
        await run([
          'call',
          composerHistoryLifecycle.operation,
          '--input-json',
          JSON.stringify(body),
          '--operation-id',
          operationId,
        ])
      ).stdout,
    )
    expect(result).toMatchObject(
      body.action === 'admit'
        ? {success: true, data: {skillRunId: composerHistoryLifecycle.runId}}
        : composerHistoryLifecycle.terminal,
    )
  }
  const calls = requests.filter(
    request => request.url === '/api/v2/mesh/refine/foreground',
  )
  expect(calls.map(call => call.body)).toEqual([
    composerHistoryLifecycle.admission,
    composerHistoryLifecycle.finish,
  ])
  expect(
    calls.every(
      call =>
        call.key === operationId && call.authorization === 'Bearer test-key',
    ),
  ).toBe(true)
})

// @testdoc Built CLI preserves exact private artifact bytes while oversize transport fails without a success preview.
it.each(['json', 'glb', 'oversize'])(
  'handles raw Composer %s through the real CLI process',
  async type => {
    const {run, requests} = await setup()
    const args = [
      'call',
      'GET /runs/{runId}/history/{eventId}/{sha256}',
      '--path-json',
      JSON.stringify({
        runId: operationId,
        eventId: operationId,
        sha256: 'a'.repeat(64),
      }),
      '--query-json',
      JSON.stringify({projectId: 42, type}),
    ]
    if (type === 'oversize') {
      await expect(run(args)).rejects.toMatchObject({
        stdout: expect.stringContaining('API artifact exceeds 64 MiB'),
      })
    } else {
      const response = JSON.parse((await run(args)).stdout)
      expect(response).toMatchObject({
        success: true,
        data: {encoding: 'base64', data: 'AP8K', byteLength: 3},
      })
    }
    expect(requests.at(-1)).toMatchObject({
      authorization: 'Bearer test-key',
      method: 'GET',
    })
    expect(requests.at(-1)?.url).toContain('projectId=42')
  },
)
