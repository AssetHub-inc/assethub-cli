import {createHash} from 'node:crypto'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {
  CONTROL_RUN_UPLOAD_API_PREFIX,
  controlRunUploadUrls,
} from '../runsUpload/controlEndpoints.js'
import {RunUploadError} from '../runsUpload/runUploadError.js'
import {uploadRun} from '../runsUpload/uploadRun.js'
import type {PlannedBlob, RunUploadPlan} from '../runsUpload/buildRunUpload.js'

const API_KEY = 'ah_live_supersecret_do_not_leak'
const BASE_URL = 'https://app.assethub.io'

type Call = {url: string; method: string; headers: Record<string, string>; body: unknown}

const ok = (data: unknown = {}): Response =>
  new Response(JSON.stringify({success: true, data}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

const fail = (
  status: number,
  code: string,
  message = 'nope',
  details?: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify({success: false, error: {code, message, details}}), {
    status,
    headers: {'content-type': 'application/json'},
  })

const lowerHeaders = (init: RequestInit | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  )

const recorder = (
  respond: (call: Call) => Response,
): {calls: Call[]; fetchImpl: typeof fetch} => {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: lowerHeaders(init),
      body: init?.body,
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return {calls, fetchImpl}
}

let root: string
let blobA: PlannedBlob
let blobB: PlannedBlob

const writeBlob = async (name: string, content: string): Promise<PlannedBlob> => {
  const bytes = Buffer.from(content)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const file = join(root, name)
  await writeFile(file, bytes)
  return {blobKey: `sha256:${sha256}`, sha256, mime: 'image/png', name, size: bytes.length, file}
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'assethub-runs-transport-'))
  blobA = await writeBlob('alpha.png', 'alpha bytes')
  blobB = await writeBlob('beta.png', 'beta bytes')
})

afterAll(async () => {
  await rm(root, {recursive: true, force: true})
})

const planWith = (blobs: PlannedBlob[]): RunUploadPlan => ({
  graphId: 'import_run_a',
  streamId: 'stream_cli_import_run_a',
  rev: 2,
  graphHash: `sha256:${'1'.repeat(64)}`,
  push: {schemaVersion: 'ag.registry-push.v1'},
  pushBody: '{"schemaVersion":"ag.registry-push.v1"}',
  blobs,
  counts: {
    nodes: 1,
    edges: 0,
    blobs: blobs.length,
    blobBytes: blobs.reduce((total, blob) => total + blob.size, 0),
  },
  sizes: {manifestBytes: 1, nodesBytes: 1, edgesBytes: 1, pushBytes: 1},
  registration: {graphId: 'import_run_a', description: '', tags: [], metadata: {}},
  warnings: [],
})

describe('controlRunUploadUrls', () => {
  it('keeps every route under the single configurable prefix', () => {
    const urls = controlRunUploadUrls(BASE_URL)
    expect(urls.graphs).toBe(`${BASE_URL}${CONTROL_RUN_UPLOAD_API_PREFIX}/graphs`)
    expect(urls.snapshot('import_x')).toBe(
      `${BASE_URL}${CONTROL_RUN_UPLOAD_API_PREFIX}/graphs/import_x/snapshot`,
    )
    expect(urls.blob('import_x', 'sha256:ab')).toBe(
      `${BASE_URL}${CONTROL_RUN_UPLOAD_API_PREFIX}/blobs/import_x/sha256%3Aab`,
    )
  })

  it('tolerates a trailing slash on the base URL like @assethub/api-client does', () => {
    expect(controlRunUploadUrls('https://app.assethub.io//').graphs).toBe(
      `https://app.assethub.io${CONTROL_RUN_UPLOAD_API_PREFIX}/graphs`,
    )
  })
})

describe('uploadRun', () => {
  it('registers, then sends only the blobs the server does not have, then pushes', async () => {
    const {calls, fetchImpl} = recorder(call => {
      if (call.method === 'HEAD') {
        return new Response(null, {
          status: call.url.includes(encodeURIComponent(blobA.blobKey)) ? 200 : 404,
        })
      }
      return ok({status: 'published'})
    })

    const result = await uploadRun({
      plan: planWith([blobA, blobB]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    })

    expect(calls.map(call => call.method)).toEqual(['POST', 'HEAD', 'HEAD', 'PUT', 'PUT'])
    // The PUT that carries bytes is for the blob whose HEAD said 404.
    expect(calls[3].url).toContain(encodeURIComponent(blobB.blobKey))
    expect(calls[3].headers['x-artifact-blob-sha256']).toBe(blobB.sha256)
    expect(calls[3].headers['x-artifact-blob-size']).toBe(String(blobB.size))
    expect(calls[4].url).toContain('/snapshot')
    expect(result).toMatchObject({
      registered: true,
      blobsUploaded: 1,
      blobsSkipped: 1,
      bytesUploaded: blobB.size,
      status: 'published',
    })
  })

  // Resume: the second run of the identical command finds every blob present
  // and sends no bytes at all. Nothing is persisted locally to make this work —
  // content addressing means the server already knows what it has.
  it('sends zero blob bytes when a re-run finds every blob already uploaded', async () => {
    const {calls, fetchImpl} = recorder(call =>
      call.method === 'HEAD' ? new Response(null, {status: 200}) : ok({status: 'unchanged'}),
    )

    const result = await uploadRun({
      plan: planWith([blobA, blobB]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    })

    expect(
      calls.filter(call => call.method === 'PUT' && !call.url.includes('/snapshot')),
    ).toEqual([])
    expect(result).toMatchObject({
      blobsUploaded: 0,
      blobsSkipped: 2,
      bytesUploaded: 0,
      status: 'unchanged',
    })
  })

  it('reports progress for every blob so a long upload is not silent', async () => {
    const {fetchImpl} = recorder(call =>
      call.method === 'HEAD' ? new Response(null, {status: 404}) : ok(),
    )
    const events: string[] = []

    await uploadRun({
      plan: planWith([blobA, blobB]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
      onProgress: event => events.push(event.kind === 'blob' ? `blob:${event.status}` : event.kind),
    })

    expect(events).toEqual(['register', 'blob:uploaded', 'blob:uploaded', 'push'])
  })

  it('sends the API key in the Authorization header and never in a URL', async () => {
    const {calls, fetchImpl} = recorder(call =>
      call.method === 'HEAD' ? new Response(null, {status: 200}) : ok(),
    )

    await uploadRun({
      plan: planWith([blobA]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    })

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.url).not.toContain(API_KEY)
      expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`)
    }
  })

  it('skips registration when asked', async () => {
    const {calls, fetchImpl} = recorder(() => ok())
    const result = await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
      skipRegister: true,
    })
    expect(calls.map(call => call.method)).toEqual(['PUT'])
    expect(result.registered).toBe(false)
  })

  it('treats STALE_SNAPSHOT as the desired end state rather than a failure', async () => {
    const {fetchImpl} = recorder(call =>
      call.url.includes('/snapshot') && call.method === 'PUT'
        ? fail(409, 'STALE_SNAPSHOT', 'newer revision stored')
        : ok(),
    )

    const result = await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    })
    expect(result.status).toBe('stale')
  })

  it('turns MISSING_BLOBS into an instruction to re-run, naming the keys', async () => {
    const missing = `sha256:${'c'.repeat(64)}`
    const {fetchImpl} = recorder(call =>
      call.url.includes('/snapshot') && call.method === 'PUT'
        ? fail(409, 'MISSING_BLOBS', 'pool is missing bytes', {blobKeys: [missing]})
        : ok(),
    )

    const error = (await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    }).catch((thrown: unknown) => thrown)) as RunUploadError

    expect(error).toBeInstanceOf(RunUploadError)
    expect(error.code).toBe('MISSING_BLOBS')
    expect(error.message).toContain(missing)
    expect(error.message).toMatch(/run the same command again/i)
  })

  it('explains a SNAPSHOT_CONFLICT in terms of the flags that resolve it', async () => {
    const {fetchImpl} = recorder(call =>
      call.url.includes('/snapshot') && call.method === 'PUT'
        ? fail(409, 'SNAPSHOT_CONFLICT', 'different hash at this rev')
        : ok(),
    )

    const error = (await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    }).catch((thrown: unknown) => thrown)) as RunUploadError

    expect(error.message).toContain('--rev')
  })

  // Both 404s, so only the code separates them. Reading a NOT_REGISTERED as
  // "you have no access" sends someone chasing an entitlement they already have.
  it('distinguishes NOT_REGISTERED from a missing entitlement', async () => {
    const {fetchImpl} = recorder(() =>
      fail(404, 'NOT_REGISTERED', 'Register it before uploading blobs or pushing a snapshot.'),
    )

    const error = (await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
      skipRegister: true,
    }).catch((thrown: unknown) => thrown)) as RunUploadError

    expect(error.code).toBe('NOT_REGISTERED')
    expect(error.message).toMatch(/not registered for your org/)
    expect(error.message).toMatch(/--skip-register/)
    expect(error.message).not.toMatch(/entitlement/)
  })

  // The routes are internal-only and answer 404 rather than 403 so the path's
  // existence is not disclosed. A bare "404" would read as a CLI bug.
  it('reads an uncoded 404 as "this key cannot upload runs"', async () => {
    const {fetchImpl} = recorder(() => fail(404, 'NOT_FOUND', 'not found'))

    const error = (await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    }).catch((thrown: unknown) => thrown)) as RunUploadError

    expect(error.message).toMatch(/cannot upload runs to Production Control/)
    expect(error.message).not.toContain(API_KEY)
  })

  it('says what to do next when the network is down, and never echoes the key', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', {cause: new Error('getaddrinfo ENOTFOUND')})
    }) as unknown as typeof fetch

    const error = (await uploadRun({
      plan: planWith([]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    }).catch((thrown: unknown) => thrown)) as RunUploadError

    expect(error.code).toBe('network_unreachable')
    expect(error.message).toContain('https://app.assethub.io')
    expect(error.message).toMatch(/run the same command again/)
    expect(error.message).toContain('ENOTFOUND')
    expect(error.message).not.toContain(API_KEY)
  })

  it('refuses to send a blob whose bytes no longer match the folder', async () => {
    const {fetchImpl} = recorder(call =>
      call.method === 'HEAD' ? new Response(null, {status: 404}) : ok(),
    )

    const error = (await uploadRun({
      plan: planWith([{...blobA, blobKey: `sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64)}]),
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl,
    }).catch((thrown: unknown) => thrown)) as RunUploadError

    expect(error.code).toBe('blob_digest_mismatch')
    expect(error.message).toMatch(/re-export the run/i)
  })
})
