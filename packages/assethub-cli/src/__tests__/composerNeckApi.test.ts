import fixture from '../../../assethub-api-client/__tests__/fixtures/composerNeckPublicOperation.json'
import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

// @testdoc The built generic CLI reads the advertised public neck schema, sends exact file input with one replay identity, and recovers the original needs_review run using GET.
it('uses existing api commands for neck discovery replay and recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neck-api-parity-'))
  const requests: Array<{
    method?: string
    key: string | string[] | undefined
    body: unknown
  }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    requests.push({
      method: request.method,
      key: request.headers['idempotency-key'],
      body: text ? JSON.parse(text) : undefined,
    })
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify(
        request.url?.endsWith('/openapi')
          ? request.url.includes('/v2/')
            ? fixture.openapi
            : {paths: {}}
          : fixture.terminal,
      ),
    )
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture listener')
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
            ASSETHUB_API_KEY: 'fixture-key',
            ASSETHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
            ASSETHUB_CLI_CONFIG: join(directory, 'auth.json'),
            ASSETHUB_CLI_STATE_DIR: directory,
            ASSETHUB_NO_AUTO_UPDATE: '1',
          },
        },
      )
    expect((await run(['search', 'compose'])).stdout).toContain(
      fixture.operation,
    )
    const description = JSON.parse(
      (await run(['describe', fixture.operation])).stdout,
    )
    expect(
      description.components.schemas.MeshComposeRequest.properties
        .headBodyConnection,
    ).toEqual(fixture.publicOptionSchema)
    const input = join(directory, 'input.json')
    await writeFile(input, JSON.stringify(fixture.request))
    for (let replay = 0; replay < 2; replay++) {
      expect(
        JSON.parse(
          (
            await run([
              'call',
              fixture.operation,
              '--operation-id',
              fixture.operationId,
              '--input-json',
              `@${input}`,
            ])
          ).stdout,
        ),
      ).toEqual(fixture.terminal)
    }
    expect(
      JSON.parse(
        (
          await run([
            'call',
            'GET /runs/{runId}',
            '--path-json',
            JSON.stringify({runId: fixture.runId}),
          ])
        ).stdout,
      ),
    ).toEqual(fixture.terminal)
    const posts = requests.filter(request => request.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts).toEqual(
      [0, 1].map(() => ({
        method: 'POST',
        key: fixture.operationId,
        body: fixture.request,
      })),
    )
    expect(requests.at(-1)?.method).toBe('GET')
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    )
    await rm(directory, {recursive: true, force: true})
  }
})
