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
          paths: request.url.includes('/v2/')
            ? {
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
  expect(JSON.parse((await run(['search', 'compose'])).stdout)).toMatchObject({
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
