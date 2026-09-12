import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createAssetHubClient, type CanvasExecution} from '@assethub/api-client'
import {
  executeRecorded,
  openExecutionSession,
  resumeRecorded,
  waitForExecution,
} from '../execution.js'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map(path => rm(path, {recursive: true, force: true})),
  )
})
const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    headers: {'content-type': 'application/json'},
  })
const canvas = {
  id: 42,
  name: 'Test',
  ownerId: 'org-a',
  url: 'https://api.test/workflow/42',
}
const capabilities = {
  ownerId: 'org-a',
  executionContext: {
    status: 'available',
    operations: ['image.generate', 'mesh.generate'],
  },
  evaluators: [],
}
const receipt = (
  runId: string,
  status: CanvasExecution['status'] = 'queued',
): CanvasExecution => ({
  schemaVersion: 'assethub.execution.v1',
  runId,
  operation: 'image.generate',
  status,
  canvas,
  jobIds: ['job-1'],
  orderIds: [],
  graphRefs: [],
  outputs: [],
  history: {status: 'recorded'},
  usage: {reservedCredits: null, chargedCredits: null},
  createdAt: '2026-09-07T00:00:00Z',
  input: {},
  context: {
    canvasId: 42,
    clientOperationId: '84e8530b-b362-45c7-9064-2b03b6f95b24',
    source: 'cli',
  },
})
const stateDir = async () => {
  const path = await mkdtemp(join(tmpdir(), 'assethub-execution-'))
  folders.push(path)
  return path
}

describe('recorded CLI execution', () => {
  // @testdoc A confirmed dispatch failure keeps its server receipt ID for CLI error output and resumes by reading that receipt without another POST.
  it.each([false, true])('preserves a failed run ID even if its first receipt read fails: %s', async failFirstRead => {
    const dir = await stateDir()
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    const posts: {body: string; key: string | null}[] = []
    let reads = 0
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/capabilities'))
        return ok({...capabilities, executionContext: {status: 'available', operations: ['mesh.refine']}})
      if (String(url).endsWith('/canvases/42')) return ok(canvas)
      if (String(url).endsWith('/runs/failed-refine-run')) {
        expect(init?.method).toBe('GET')
        reads++
        if (failFirstRead && reads === 1) throw new TypeError('Receipt read unavailable')
        return ok({...receipt('failed-refine-run', 'failed'), operation: 'mesh.refine'})
      }
      expect(String(url)).toBe('https://api.test/api/v2/mesh/refine')
      expect(init?.method).toBe('POST')
      posts.push({body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key')})
      return new Response(JSON.stringify({success: false, error: {
        code: 'TRIGGER_BRANCH_UNAVAILABLE',
        message: 'No task was started',
        details: {runId: 'failed-refine-run'},
      }}), {status: 503})
    }
    const client = createAssetHubClient({apiKey: 'secret-key', baseUrl: 'https://api.test', fetch: request})
    const session = await openExecutionSession({client, stateDir: dir, cwd: dir, canvasId: 42, operation: 'mesh.refine'})
    await expect(executeRecorded(session, 'mesh.refine', {
      parts: [{assetId: 'mesh_1'}],
      fullBodyImageAssetId: 'image_abc_0_0_color',
      transforms: {mesh_1: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]},
      mode: 'standard',
      instruction: 'Align with the reference',
    }, {operationId, retryDelayMs: 0})).rejects.toMatchObject({
      exitCode: 1, operationId, runId: 'failed-refine-run',
    })
    const stored = await readFile(join(dir, 'operations', `${operationId}.json`), 'utf8')
    expect(JSON.parse(stored)).toMatchObject({operationId, runId: 'failed-refine-run'})
    expect(stored).not.toContain('secret-key')
    expect(posts).toHaveLength(3)
    expect(new Set(posts.map(post => post.body)).size).toBe(1)
    expect(new Set(posts.map(post => post.key))).toEqual(new Set([operationId]))
    const resumed = await resumeRecorded({client, stateDir: dir, cwd: dir, operationId})
    expect(resumed.execution).toMatchObject({runId: 'failed-refine-run', status: 'failed'})
    expect(reads).toBe(2)
    expect(posts).toHaveLength(3)
  })

  it('preserves a fenced production run from an ambiguous dispatch response and resumes by reading it', async () => {
    const dir = await stateDir()
    let submissions = 0
    const request: typeof fetch = async url => {
      if (String(url).endsWith('/capabilities'))
        return ok({
          ...capabilities,
          executionContext: {
            status: 'available',
            operations: ['production.analyze'],
          },
        })
      if (String(url).endsWith('/canvases/42')) return ok(canvas)
      if (String(url).endsWith('/runs/original-run'))
        return ok({
          ...receipt('original-run', 'needs_review'),
          history: {status: 'pending'},
        })
      submissions++
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'EXECUTION_RECOVERY_REQUIRED',
            message: 'Recover the original run',
            details: {runId: 'original-run'},
          },
        }),
        {status: 409},
      )
    }
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const session = await openExecutionSession({
      client,
      stateDir: dir,
      cwd: dir,
      canvasId: 42,
      operation: 'production.analyze',
    })
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    await expect(
      executeRecorded(
        session,
        'production.analyze',
        {imageAssetId: 'image-1', agentVersion: 'V1.5'},
        {operationId},
      ),
    ).rejects.toMatchObject({
      exitCode: 3,
      operationId,
      runId: 'original-run',
      execution: {runId: 'original-run'},
    })
    const resumed = await resumeRecorded({
      client,
      stateDir: dir,
      cwd: dir,
      operationId,
    })
    expect(resumed.execution.runId).toBe('original-run')
    expect(submissions).toBe(1)
  })

  it('keeps the known run identity when a receipt poll fails', async () => {
    const client = createAssetHubClient({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: {code: 'READ_FAILED', message: 'try again'},
          }),
          {status: 500},
        ),
    })
    await expect(waitForExecution(client, 'known-run')).rejects.toMatchObject({
      exitCode: 1,
      runId: 'known-run',
    })
  })

  it('replays production analysis with the saved key and returns its canvas order', async () => {
    const dir = await stateDir()
    const bodies: string[] = []
    const keys: (string | null)[] = []
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/capabilities'))
        return ok({
          ...capabilities,
          executionContext: {
            status: 'available',
            operations: ['production.analyze'],
          },
        })
      if (String(url).endsWith('/canvases/42')) return ok(canvas)
      expect(String(url)).toBe('https://api.test/api/v1/production/analyze')
      const body = String(init?.body)
      bodies.push(body)
      keys.push(new Headers(init?.headers).get('Idempotency-Key'))
      expect(JSON.parse(body)).toMatchObject({
        uploadId: 'upload-1',
        executionContext: {canvasId: 42, clientOperationId: operationId},
      })
      if (bodies.length === 1) throw new TypeError('lost acknowledgement')
      return ok({
        orderId: 'order-1',
        execution: {
          ...receipt('run-parts'),
          operation: 'production.analyze',
          orderIds: ['order-1'],
          jobIds: [],
        },
      })
    }
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const session = await openExecutionSession({
      client,
      stateDir: dir,
      cwd: dir,
      canvasId: 42,
      operation: 'production.analyze',
    })
    const result = await executeRecorded(
      session,
      'production.analyze',
      {uploadId: 'upload-1', agentVersion: 'existing-model'},
      {operationId, retryDelayMs: 0},
    )
    expect(result.execution.orderIds).toEqual(['order-1'])
    expect(new Set(bodies).size).toBe(1)
    expect(keys).toEqual([operationId, operationId])
  })

  it('bounds a stalled HTTP request and preserves the requested run ID', async () => {
    const request: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          {once: true},
        )
      })
    const client = createAssetHubClient({apiKey: 'test-key', fetch: request})
    await expect(
      waitForExecution(client, 'stalled-run', {timeoutMs: 10}),
    ).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining('stalled-run'),
    })
  })

  it('does not report completed generation as ready while history is pending', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () =>
      ok({
        ...receipt('pending-run', 'completed'),
        history: {status: 'pending'},
      }),
    )
    const client = createAssetHubClient({apiKey: 'test-key', fetch: request})
    await expect(
      waitForExecution(client, 'pending-run', {timeoutMs: 2, intervalMs: 1}),
    ).rejects.toMatchObject({exitCode: 3, execution: {runId: 'pending-run'}})
  })

  it('refuses unsupported history before creating a canvas or calling generation', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      ok({
        ...capabilities,
        executionContext: {status: 'unavailable', operations: []},
      }),
    )
    const client = createAssetHubClient({
      apiKey: 'secret-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const dir = await stateDir()
    await expect(
      openExecutionSession({
        client,
        stateDir: dir,
        cwd: dir,
        operation: 'image.generate',
      }),
    ).rejects.toThrow(/history|execution/i)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('replays an interrupted submission using the identical persisted body and key', async () => {
    const dir = await stateDir()
    const requests: {body: string; key: string | null}[] = []
    let accept = false
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/capabilities')) return ok(capabilities)
      if (String(url).endsWith('/canvases/42')) return ok(canvas)
      if (String(url).endsWith('/image/generate')) {
        requests.push({
          body: String(init?.body),
          key: new Headers(init?.headers).get('Idempotency-Key'),
        })
        if (!accept) throw new TypeError('Connection reset after acceptance')
        return ok({jobId: 'job-1', execution: receipt('run-1')})
      }
      throw new Error(`Unexpected request ${url}`)
    }
    const client = createAssetHubClient({
      apiKey: 'secret-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const session = await openExecutionSession({
      client,
      stateDir: dir,
      cwd: dir,
      canvasId: 42,
      operation: 'image.generate',
    })
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    await expect(
      executeRecorded(
        session,
        'image.generate',
        {prompt: 'robot'},
        {operationId, retryDelayMs: 0},
      ),
    ).rejects.toMatchObject({operationId})
    const stored = await readFile(
      join(dir, 'operations', `${operationId}.json`),
      'utf8',
    )
    expect(stored).not.toContain('secret-key')
    accept = true
    const result = await resumeRecorded({
      client,
      stateDir: dir,
      cwd: dir,
      operationId,
      retryDelayMs: 0,
    })
    expect(result.execution.runId).toBe('run-1')
    expect(new Set(requests.map(item => item.body)).size).toBe(1)
    expect(new Set(requests.map(item => item.key))).toEqual(
      new Set([operationId]),
    )
  })

  it('returns the saved run identity when waiting times out without cancelling it', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => ok(receipt('run-1')))
    const client = createAssetHubClient({
      apiKey: 'secret-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    await expect(
      waitForExecution(client, 'run-1', {timeoutMs: 1, intervalMs: 1}),
    ).rejects.toMatchObject({exitCode: 3, execution: {runId: 'run-1'}})
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
      true,
    )
  })
})
