import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {expect, it} from 'vitest'
import {fileURLToPath} from 'node:url'

it('makes every Workspace Skill operation available from the CLI', async () => {
  const requests: Array<{
    method?: string
    url?: string
    body: unknown
    operationId: string | undefined
  }> = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({
      operationId: req.headers['idempotency-key'] as string | undefined,
      method: req.method,
      url: req.url,
      body: raw ? JSON.parse(raw) : null,
    })
    res.writeHead(
      req.url === '/api/v2/workspace-skills/proposals' ? 202 : 200,
      {
        'content-type': 'application/json',
      },
    )
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
      '--operation-id',
      proposalId,
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
      JSON.stringify({
        graphId,
        artifactId: 'result',
        projectId: 42,
        taskKind: 'concept_art',
      }),
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
    expect(requests[5]?.body).toEqual({
      graphId,
      artifactId: 'result',
      projectId: 42,
      taskKind: 'concept_art',
    })
    expect(requests[2]?.operationId).toBe(proposalId)
    await expect(run(['learn', '--input-json', '{}'])).rejects.toThrow(
      'operation-id',
    )
    await expect(
      run(['learn', '--operation-id', 'invalid', '--input-json', '{}']),
    ).rejects.toThrow('UUID')
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual(
      [
        'GET /api/v2/workspace-skills',
        'GET /api/v2/workspace-skills/method?revision=1',
        'POST /api/v2/workspace-skills/learn',
        'PATCH /api/v2/workspace-skills/method',
        'PATCH /api/v2/workspace-skills/method/controls',
        'POST /api/v2/workspace-skills/proposals',
        `GET /api/v2/workspace-skills/proposals/${proposalId}`,
        `POST /api/v2/workspace-skills/proposals/${proposalId}/accept`,
      ],
    )
  } finally {
    await new Promise<void>(done => server.close(() => done()))
  }
})

// The three FREE pre-flight operations: `skills validate`, `skills schema`,
// and `skills build --dry-run`. None of them should ever need an
// Idempotency-Key -- nothing is written.
it('validates a draft, reads the draft schema, and dry-runs a build from the CLI', async () => {
  const requests: Array<{method?: string; url?: string; body: unknown}> = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({
      method: req.method,
      url: req.url,
      body: raw ? JSON.parse(raw) : null,
    })
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(
      JSON.stringify({
        success: true,
        data: req.url?.includes('/drafts/validate')
          ? {valid: true, contentSha256: 'a'.repeat(64), referencesChecked: true}
          : req.url?.includes('/drafts/schema')
            ? {
                promptVersion: 3,
                shape: 'Skill fields...',
                stampedFields: ['build'],
                enums: {phases: ['plan'], operations: ['plan'], roles: ['source_image'], severities: ['must']},
                limits: {
                  steps: {min: 1, max: 5},
                  acceptanceCriteria: {min: 1, max: 12},
                  failureModes: {min: 0, max: 12},
                  references: {min: 1, max: 13},
                  uncertainties: {min: 0, max: 16},
                },
              }
            : {
                wouldStart: true,
                source: 'canvas_graph',
                canvasIds: [999],
                estimatedCredits: 60,
                promptVersion: 3,
              },
      }),
    )
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const buildId = '9c31f0aa-1111-4111-8111-111111111111'
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
            ASSETHUB_CLI_CONFIG: '/tmp/nonexistent-assethub-skill-config-2.json',
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
  try {
    await run(['validate', '--input-json', JSON.stringify({phase: 'plan'}), '--build', buildId])
    await run(['schema'])
    await run(['build', '--goal', 'Separate parts', '--canvas', '999', '--dry-run'])
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'POST /api/v2/workspace-skills/drafts/validate',
      'GET /api/v2/workspace-skills/drafts/schema',
      'POST /api/v2/workspace-skills/builds/dry-run',
    ])
    expect(requests[0]?.body).toEqual({skill: {phase: 'plan'}, buildId})
    expect(requests[2]?.body).toEqual({
      goal: 'Separate parts',
      instructions: undefined,
      taskKind: 'part_separation',
      source: {kind: 'canvas_graph', canvasIds: [999]},
    })
  } finally {
    await new Promise<void>(done => server.close(() => done()))
  }
})
