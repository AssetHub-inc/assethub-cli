import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {expect, it} from 'vitest'
import {fileURLToPath} from 'node:url'

it('makes every Workspace Skill operation available from the CLI', async () => {
  const requests: Array<{method?: string; url?: string; body: unknown}> = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({
      method: req.method,
      url: req.url,
      body: raw ? JSON.parse(raw) : null,
    })
    res.writeHead(req.url === '/api/v2/workspace-skills/proposals' ? 202 : 200, {
      'content-type': 'application/json',
    })
    res.end(JSON.stringify({success: true, data: {ok: true}}))
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const run = (args: string[]) =>
    new Promise<void>((done, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'skills', ...args],
        {
          env: {
            ...process.env,
            ASSETHUB_API_BASE_URL: baseUrl,
            ASSETHUB_API_KEY: 'test-key',
            ASSETHUB_CLI_CONFIG: '/tmp/nonexistent-assethub-skill-config.json',
          },
        },
      )
      let stderr = ''
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', code =>
        code === 0 ? done() : reject(new Error(stderr)),
      )
      child.stdin.end()
    })
  const graphId = '11111111-1111-4111-8111-111111111111'
  const proposalId = '22222222-2222-4222-8222-222222222222'
  const ref = {
    graphId,
    artifactId: 'result',
    contentSha256: 'a'.repeat(64),
    sourceRevision: 1,
  }
  try {
    await run(['list'])
    await run(['get', 'method', '--revision', '1'])
    await run([
      'learn',
      '--input-json',
      JSON.stringify({
        graphId,
        evidenceRefs: [ref],
        purpose: 'generation',
        phase: 'generate',
      }),
    ])
    await run([
      'update',
      'method',
      '--input-json',
      JSON.stringify({
        expectedRevision: 1,
        expectedGrantRevision: 1,
        title: 'Method',
        goal: 'Goal',
        applicability: {},
        steps: [],
      }),
    ])
    await run([
      'controls',
      'method',
      '--revision',
      '2',
      '--grant-revision',
      '1',
      '--mode',
      'off',
    ])
    await run([
      'prepare',
      '--input-json',
      JSON.stringify({graphId, artifactId: 'result'}),
    ])
    await run(['proposal', proposalId])
    await run([
      'accept',
      proposalId,
      '--input-json',
      JSON.stringify({
        expectedVersion: 1,
        draftSha256: 'b'.repeat(64),
        result: ref,
      }),
    ])
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v2/workspace-skills',
      'GET /api/v2/workspace-skills/method?revision=1',
      'POST /api/v2/workspace-skills/learn',
      'PATCH /api/v2/workspace-skills/method',
      'PATCH /api/v2/workspace-skills/method/controls',
      'POST /api/v2/workspace-skills/proposals',
      `GET /api/v2/workspace-skills/proposals/${proposalId}`,
      `POST /api/v2/workspace-skills/proposals/${proposalId}/accept`,
    ])
  } finally {
    await new Promise<void>(done => server.close(() => done()))
  }
})
