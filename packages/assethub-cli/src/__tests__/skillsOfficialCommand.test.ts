import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {afterEach, expect, it} from 'vitest'

const contentSha256 = 'a'.repeat(64)
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assethub-skills-official-cli-'))
  cleanups.push(() => rm(directory, {recursive: true, force: true}))
  const requests: Array<{url: string; method: string; body: unknown}> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) : undefined
    requests.push({url: request.url!, method: request.method!, body})
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({success: true, data: {ok: true}}))
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
        'skills',
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

// @testdoc `skills official list` reads the official catalog without a body.
it('lists official workspace skills', async () => {
  const {run, requests} = await setup()
  await run(['official', 'list'])
  expect(requests).toEqual([
    expect.objectContaining({
      url: '/api/v2/workspace-skills/official',
      method: 'GET',
    }),
  ])
})

// @testdoc `skills official install` sends the confirmed content hash the caller saw from `list`, with unset expectations defaulting to null.
it('installs an official workspace skill with the confirmed content hash', async () => {
  const {run, requests} = await setup()
  await run([
    'official',
    'install',
    'assethub-source-pose-asymmetry',
    '--revision',
    '1',
    '--content-sha256',
    contentSha256,
  ])
  expect(requests).toEqual([
    expect.objectContaining({
      url: '/api/v2/workspace-skills/official/assethub-source-pose-asymmetry/install',
      method: 'POST',
      body: {
        revision: 1,
        expectedRevision: null,
        expectedGrantRevision: null,
        confirmedContentSha256: contentSha256,
      },
    }),
  ])
})

// @testdoc `--expected-revision` and `--expected-grant-revision` pass through when the caller supplies them.
it('installs an official workspace skill with explicit expected revisions', async () => {
  const {run, requests} = await setup()
  await run([
    'official',
    'install',
    'assethub-source-pose-asymmetry',
    '--revision',
    '2',
    '--expected-revision',
    '1',
    '--expected-grant-revision',
    '1',
    '--content-sha256',
    contentSha256,
  ])
  expect(requests).toEqual([
    expect.objectContaining({
      body: {
        revision: 2,
        expectedRevision: 1,
        expectedGrantRevision: 1,
        confirmedContentSha256: contentSha256,
      },
    }),
  ])
})

// @testdoc `skills official install` refuses without `--content-sha256` and never reaches the network.
it('refuses to install without --content-sha256', async () => {
  const {run, requests} = await setup()
  const error = await run([
    'official',
    'install',
    'assethub-source-pose-asymmetry',
    '--revision',
    '1',
  ]).catch(error => error)
  expect(error.code).not.toBe(0)
  expect(requests).toEqual([])
})

// @testdoc `skills official install` refuses without `--revision` and never reaches the network; installing must use the exact revision confirmed from `list`.
it('refuses to install without --revision', async () => {
  const {run, requests} = await setup()
  const error = await run([
    'official',
    'install',
    'assethub-source-pose-asymmetry',
    '--content-sha256',
    contentSha256,
  ]).catch(error => error)
  expect(error.code).not.toBe(0)
  expect(requests).toEqual([])
})

// @testdoc An unknown `skills official` action reports the exact usage list and never reaches the network.
// A skill-id is supplied so the unknown-action error itself is reached (a
// bare `skills official nope` would fail one positional earlier, on the
// missing skill-id, before this message is ever produced).
it('rejects an unknown skills official action', async () => {
  const {run, requests} = await setup()
  const error = await run([
    'official',
    'nope',
    'assethub-source-pose-asymmetry',
  ]).catch(error => error)
  expect(error.code).not.toBe(0)
  expect(String(error.stdout)).toContain(
    'Use skills official list|install|prepare|customize',
  )
  expect(requests).toEqual([])
})

// @testdoc `skills official prepare` forwards the caller's JSON body unchanged to the `/customize/prepare` step; its response is the exact body to resubmit to `customize`.
it('prepares an official workspace skill customization from a JSON file body', async () => {
  const {run, requests, directory} = await setup()
  const body = {
    targetSkillId: 'workspace-11111111-1111-4111-8111-111111111111',
    expectedSourceRevision: 1,
    expectedSourceGrantRevision: 1,
    title: 'Customized title',
    goal: 'Customized goal',
    applicability: {
      category: 'part',
      partKinds: [],
      requiredTraits: [],
      issueKinds: [],
      exclusions: [],
      requiredReferenceRoles: [],
    },
    steps: [
      {
        stepId: 'step-1',
        operation: 'generate',
        inputRoles: [],
        dependsOn: [],
        instruction: 'Do the thing.',
        preserve: [],
        checks: [],
      },
    ],
  }
  const path = join(directory, 'prepare.json')
  await writeFile(path, JSON.stringify(body))
  await run([
    'official',
    'prepare',
    'assethub-source-pose-asymmetry',
    '--input-json',
    `@${path}`,
  ])
  expect(requests).toEqual([
    expect.objectContaining({
      url: '/api/v2/workspace-skills/official/assethub-source-pose-asymmetry/customize/prepare',
      method: 'POST',
      body,
    }),
  ])
})

// @testdoc `skills official customize` forwards the caller's JSON body unchanged, unlike install which is built from flags.
it('customizes an official workspace skill from a JSON file body', async () => {
  const {run, requests, directory} = await setup()
  const body = {
    body: {steps: ['inspect', 'fix']},
    expectedSourceRevision: 1,
    expectedSourceGrantRevision: 1,
    confirmedContentSha256: contentSha256,
  }
  const path = join(directory, 'customize.json')
  await writeFile(path, JSON.stringify(body))
  await run([
    'official',
    'customize',
    'assethub-source-pose-asymmetry',
    '--input-json',
    `@${path}`,
  ])
  expect(requests).toEqual([
    expect.objectContaining({
      url: '/api/v2/workspace-skills/official/assethub-source-pose-asymmetry/customize',
      method: 'POST',
      body,
    }),
  ])
})
