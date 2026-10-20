// packages/assethub-cli/src/__tests__/meshReviewSync.test.ts
import {createHash} from 'node:crypto'
import {
  mkdtemp, mkdir, readFile, rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {computeClientRunKey, MeshReviewSyncError, syncMeshReview,
} from '../meshReview/syncMeshReview.js'

const API_KEY = 'ah_live_supersecret_do_not_leak'
const BASE_URL = 'https://app.assethub.io'
const RUN = '22222222-2222-4222-8222-222222222222'

const findings = {
  schema: 'mesh-review/v1',
  inputs: [],
  config: {},
  findings: [
    {
      rule: 'hard_edge_without_uv_split', severity: 'error', object: 'Axe', elements: {}, metrics: {count: 1},
      message: 'm', renders: ['renders/grey/a.png', 'renders/textured/a.png'],
    },
  ],
  summary: {error: 1, warn: 0, info: 0},
}

type Call = {url: string
  method: string
  headers: Record<string, string>
  body: unknown}
const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({success: true, data}), {status, headers: {'content-type': 'application/json'},
  })
const fail = (status: number, code: string, message = 'nope', details?: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify({success: false, error: {code, message, details}}), {status, headers: {'content-type': 'application/json'}},
  )

const lower = (init?: RequestInit): Record<string, string> =>
  Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)],
    ),
  )

const recorder = (respond: (call: Call) => Response) => {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit,
  ) => {
    const call = {url: String(input), method: String(init?.method ?? 'GET'), headers: lower(init), body: init?.body,
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return {calls, fetchImpl}
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mesh-review-sync-'))
  await mkdir(join(dir, 'renders', 'grey'), {recursive: true})
  await mkdir(join(dir, 'renders', 'textured'), {recursive: true})
  await writeFile(join(dir, 'findings.json'), JSON.stringify(findings))
  await writeFile(join(dir, 'renders', 'grey', 'a.png'), Buffer.from([1, 2, 3]))
  await writeFile(join(dir, 'renders', 'textured', 'a.png'), Buffer.from([4, 5, 6]),
  )
})
afterAll(() => rm(dir, {recursive: true, force: true}))

const input = (fetchImpl: typeof fetch) => ({
  findingsPath: join(dir, 'findings.json'), project: 'Axe Project', assetKey: 'axe',
  baseUrl: BASE_URL, apiKey: API_KEY, workspaceId: 'ws-1', fetchImpl,
})

const happy = (call: Call): Response => {
  if (call.url.endsWith('/api/v2/production/mesh-reviews/runs')) {
    return ok({runId: RUN, version: 1, status: 'running', created: true, uploads: [
      {path: 'renders/grey/a.png', signedUrl: 'https://storage.example/up/grey?token=t',
          },
      {path: 'renders/textured/a.png', signedUrl: 'https://storage.example/up/tex?token=t',
          },
    ],
      }, 201,
    )
  }
  if (call.url.includes('storage.example')) return new Response('{}', {status: 200})
  return ok({runId: RUN, status: 'needs_fix', summary: findings.summary, baselineRunId: null, unchanged: false,
  })
}

describe('computeClientRunKey', () => {
  it('is deterministic and sensitive to project, asset and bytes', () => {
    const a = computeClientRunKey({project: 'p', assetKey: 'a', findingsBytes: Buffer.from('x'),
    })
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(computeClientRunKey({project: 'p', assetKey: 'a', findingsBytes: Buffer.from('x'),
      }),
    ).toBe(a)
    expect(computeClientRunKey({project: 'q', assetKey: 'a', findingsBytes: Buffer.from('x'),
      }),
    ).not.toBe(a)
    expect(computeClientRunKey({project: 'p', assetKey: 'a', findingsBytes: Buffer.from('y'),
      }),
    ).not.toBe(a)
  })
})

describe('syncMeshReview', () => {
  it('creates, uploads each render to its signed url, then completes, with bearer auth only in headers', async () => {
    const {calls, fetchImpl} = recorder(happy)
    const result = await syncMeshReview(input(fetchImpl))
    expect(result).toMatchObject({runId: RUN, status: 'needs_fix', rendersUploaded: 2, unchanged: false,
    })
    const create = calls[0]!
    expect(create.method).toBe('POST')
    expect(create.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(create.headers['x-assethub-workspace']).toBe('ws-1')
    const body = JSON.parse(String(create.body))
    expect(body).toMatchObject({project: 'Axe Project', assetKey: 'axe', source: 'local',
    })
    expect(body.renders).toEqual([{path: 'renders/grey/a.png', size: 3}, {path: 'renders/textured/a.png', size: 3},
    ])
    const uploads = calls.filter(c => c.url.includes('storage.example'))
    expect(uploads).toHaveLength(2)
    for (const upload of uploads) expect(upload.headers.authorization).toBeUndefined()
    expect(calls.at(-1)!.url).toBe(`${BASE_URL}/api/v2/production/mesh-reviews/runs/${RUN}/complete`,
    )
    expect(calls.every(c => !c.url.includes(API_KEY))).toBe(true)
  })

  it('records the run id next to findings.json so a retry is visible', async () => {
    const {fetchImpl} = recorder(happy)
    await syncMeshReview(input(fetchImpl))
    const state = JSON.parse(await readFile(join(dir, 'mesh-review-sync.json'), 'utf8'),
    )
    expect(state.runId).toBe(RUN)
    expect(JSON.stringify(state)).not.toContain(API_KEY)
  })

  it('resumes: a repeated call sends the same client run key', async () => {
    const first = recorder(happy)
    await syncMeshReview(input(first.fetchImpl))
    const second = recorder(happy)
    await syncMeshReview(input(second.fetchImpl))
    expect(JSON.parse(String(second.calls[0]!.body)).clientRunKey).toBe(JSON.parse(String(first.calls[0]!.body)).clientRunKey,
    )
  })

  it('re-uploads exactly the missing renders once when complete answers MISSING_RENDERS', async () => {
    let completes = 0
    const {calls, fetchImpl} = recorder(call => {
      if (call.url.endsWith('/complete')) {
        completes += 1
        return completes === 1
          ? fail(409, 'MISSING_RENDERS', 'missing', {missing: ['renders/textured/a.png'],
            })
          : ok({runId: RUN, status: 'needs_fix', summary: findings.summary, baselineRunId: null, unchanged: false,
            })
      }
      return happy(call)
    })
    await syncMeshReview(input(fetchImpl))
    expect(completes).toBe(2)
    expect(calls.filter(c => c.url.includes('up/tex'))).toHaveLength(2)
    expect(calls.filter(c => c.url.includes('up/grey'))).toHaveLength(1)
  })

  it('retries complete with bounded backoff while the server answers 409 RUN_FINALIZING', async () => {
    let completes = 0
    const delays: number[] = []
    const {fetchImpl} = recorder(call => {
      if (call.url.endsWith('/complete')) {
        completes += 1
        return completes < 3
          ? fail(409, 'RUN_FINALIZING', 'busy')
          : ok({runId: RUN, status: 'needs_fix', summary: findings.summary, baselineRunId: null, unchanged: false,
            })
      }
      return happy(call)
    })
    const result = await syncMeshReview({...input(fetchImpl), sleep: async ms => void delays.push(ms),
    })
    expect(result.status).toBe('needs_fix')
    expect(completes).toBe(3)
    expect(delays).toHaveLength(2)
    expect(delays[1]!).toBeGreaterThan(delays[0]!)
  })

  it('gives up after a few RUN_FINALIZING attempts', async () => {
    let completes = 0
    const {fetchImpl} = recorder(call => {
      if (call.url.endsWith('/complete')) {
        completes += 1
        return fail(409, 'RUN_FINALIZING', 'busy')
      }
      return happy(call)
    })
    await expect(syncMeshReview({...input(fetchImpl), sleep: async () => undefined}),
    ).rejects.toMatchObject({code: 'RUN_FINALIZING'})
    expect(completes).toBeLessThanOrEqual(6)
    expect(completes).toBeGreaterThan(1)
  })

  it('rejects before any request when a referenced render is missing locally or findings are too large', async () => {
    await rm(join(dir, 'renders', 'grey', 'a.png'))
    const {calls, fetchImpl} = recorder(happy)
    await expect(syncMeshReview(input(fetchImpl))).rejects.toMatchObject({code: 'render_missing',
    })
    expect(calls).toHaveLength(0)
    await writeFile(join(dir, 'renders', 'grey', 'a.png'), Buffer.from([1, 2, 3]),
    )
  })

  it('tells the operator to repeat the same command on a network failure after create', async () => {
    const {fetchImpl} = recorder(call => {
      if (call.url.includes('storage.example')) throw new TypeError('fetch failed')
      return happy(call)
    })
    const error = await syncMeshReview(input(fetchImpl)).catch((e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MeshReviewSyncError)
    expect((error as MeshReviewSyncError).code).toBe('network_unreachable')
    expect((error as MeshReviewSyncError).message).toContain('same command')
    expect((error as MeshReviewSyncError).message).not.toContain(API_KEY)
  })

  it('surfaces server error codes without echoing the key', async () => {
    const {fetchImpl} = recorder(() => fail(404, 'NOT_FOUND', 'Not found'))
    const error = (await syncMeshReview(input(fetchImpl)).catch((e: unknown) => e,
    )) as MeshReviewSyncError
    expect(error.code).toBe('NOT_FOUND')
    expect(error.status).toBe(404)
    expect(error.message).not.toContain(API_KEY)
  })
})

// Comparison frames may be independent of mechanical findings and still require uploading.
it('plans private concept frames and rejects traversal before contacting the API', async () => {
  const file = join(dir, 'concept.json')
  const config = {conceptReview: {schema: 'concept-review/v1', views: [{reference: {path: 'renders/grey/a.png'}, models: {color: {path: 'renders/textured/a.png'}},
        },
      ],
    },
  }
  await writeFile(file, JSON.stringify({...findings, findings: [], config}))
  const {calls, fetchImpl} = recorder(happy)
  expect(await syncMeshReview({...input(fetchImpl), findingsPath: file}),
  ).toMatchObject({rendersUploaded: 2})
  expect(JSON.parse(String(calls[0]!.body)).renders).toHaveLength(2)
  config.conceptReview.views[0]!.reference.path = '../../secret.png'
  await writeFile(file, JSON.stringify({...findings, config}))
  const blocked = recorder(happy)
  await expect(syncMeshReview({...input(blocked.fetchImpl), findingsPath: file}),
  ).rejects.toMatchObject({code: 'findings_invalid'})
  expect(blocked.calls).toHaveLength(0)
})

// Diagnostic images can exist only in execution checks, and stale evidence must never upload.
it('uploads execution-only evidence with matching hashes and rejects missing or changed hashes before create', async () => {
  const file = join(dir, 'execution.json')
  const path = 'renders/grey/a.png'
  const hash = createHash('sha256')
    .update(Buffer.from([1, 2, 3]))
    .digest('hex')
  const reviewExecution = {
    schema: 'review-execution/v1',
    checks: [
      {
        id: 'uv',
        label: 'UV',
        status: 'pass',
        detail: 'Measured.',
        evidence: [path],
      },
    ],
    renderHashes: {[path]: hash},
  }
  const doc = {...findings, findings: [], config: {reviewExecution}}
  await writeFile(file, JSON.stringify(doc))
  const valid = recorder(call => {
    if (call.url.endsWith('/runs'))
      return ok({
        runId: RUN,
        created: true,
        uploads: [{path, signedUrl: 'https://storage.example/up/uv'}],
      })
    return happy(call)
  })
  expect(
    await syncMeshReview({...input(valid.fetchImpl), findingsPath: file}),
  ).toMatchObject({rendersUploaded: 1})
  expect(JSON.parse(String(valid.calls[0]!.body)).renders).toEqual([
    {path, size: 3},
  ])
  expect(
    valid.calls.filter(call => call.url.includes('storage.example')),
  ).toHaveLength(1)
  for (const renderHashes of [{[path]: '0'.repeat(64)}, {}]) {
    await writeFile(
      file,
      JSON.stringify({
        ...doc,
        config: {reviewExecution: {...reviewExecution, renderHashes}},
      }),
    )
    const blocked = recorder(happy)
    await expect(
      syncMeshReview({...input(blocked.fetchImpl), findingsPath: file}),
    ).rejects.toMatchObject({
      code: Object.keys(renderHashes).length
        ? 'render_hash_mismatch'
        : 'findings_invalid',
    })
    expect(blocked.calls).toHaveLength(0)
  }
})

it('rejects execution evidence traversal and excessive checks before reading or requesting files', async () => {
  const file = join(dir, 'unsafe-execution.json')
  for (const checks of [
    [
      {
        id: 'uv',
        label: 'UV',
        status: 'pass',
        detail: 'Measured.',
        evidence: ['../../private.png'],
      },
    ],
    Array(101).fill({
      id: 'uv',
      label: 'UV',
      status: 'pass',
      detail: 'Measured.',
      evidence: [],
    }),
  ]) {
    await writeFile(
      file,
      JSON.stringify({
        ...findings,
        config: {reviewExecution: {schema: 'review-execution/v1', checks}},
      }),
    )
    const blocked = recorder(happy)
    await expect(
      syncMeshReview({...input(blocked.fetchImpl), findingsPath: file}),
    ).rejects.toMatchObject({code: 'findings_invalid'})
    expect(blocked.calls).toHaveLength(0)
  }
})

// Hash validation must also cover a file changed after create, before the signed upload.
it('refuses evidence changed between planning and upload', async () => {
  const file = join(dir, 'changing-execution.json')
  const path = 'renders/grey/a.png'
  const original = Buffer.from([1, 2, 3])
  const hash = createHash('sha256').update(original).digest('hex')
  await writeFile(
    file,
    JSON.stringify({
      ...findings,
      findings: [],
      config: {
        reviewExecution: {
          schema: 'review-execution/v1',
          checks: [
            {
              id: 'uv',
              label: 'UV',
              status: 'pass',
              detail: 'Measured.',
              evidence: [path],
            },
          ],
          renderHashes: {[path]: hash},
        },
      },
    }),
  )
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    await writeFile(join(dir, path), Buffer.from([9, 9, 9]))
    return ok({
      runId: RUN,
      created: true,
      uploads: [{path, signedUrl: 'https://storage.example/up/uv'}],
    })
  }) as typeof fetch
  try {
    await expect(
      syncMeshReview({...input(fetchImpl), findingsPath: file}),
    ).rejects.toMatchObject({code: 'render_hash_mismatch'})
    expect(calls).toHaveLength(1)
  } finally {
    await writeFile(join(dir, path), original)
  }
})

it('does not upload a render symlink that resolves outside the review directory', async () => {
  const external = await mkdtemp(join(tmpdir(), 'mesh-review-external-'))
  const linked = join(dir, 'renders/grey/external.png')
  const file = join(dir, 'linked-execution.json')
  try {
    await writeFile(join(external, 'image.png'), Buffer.from([7, 8, 9]))
    await symlink(join(external, 'image.png'), linked)
    await writeFile(
      file,
      JSON.stringify({
        ...findings,
        findings: [
          {...findings.findings[0], renders: ['renders/grey/external.png']},
        ],
      }),
    )
    const blocked = recorder(happy)
    await expect(
      syncMeshReview({...input(blocked.fetchImpl), findingsPath: file}),
    ).rejects.toMatchObject({code: 'findings_invalid'})
    expect(blocked.calls).toHaveLength(0)
  } finally {
    await rm(linked, {force: true})
    await rm(external, {recursive: true, force: true})
  }
})
