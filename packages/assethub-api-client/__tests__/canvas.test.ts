import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    headers: {'content-type': 'application/json'},
  })

describe('canvas execution API', () => {
  it('sends the same canvas creation operation in its body and header', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(ok({id: 42}))
    const client = createAssetHubClient({apiKey: 'test-key', fetch: request})
    const operationId = '84e8530b-b362-45c7-9064-2b03b6f95b24'
    await client.v2.createCanvas(
      {name: 'Agent work'},
      {idempotencyKey: operationId},
    )
    const init = request.mock.calls[0]![1]!
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Agent work',
      clientOperationId: operationId,
    })
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(operationId)
  })

  it('keeps the canvas and operation key on a recorded generation request', async () => {
    const executionContext = {
      canvasId: 42,
      clientOperationId: '84e8530b-b362-45c7-9064-2b03b6f95b24',
      source: 'cli' as const,
    }
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ok({jobId: 'job-1', execution: {runId: 'run-1'}}))
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const result = await client.v2.generateImage(
      {prompt: 'robot', executionContext},
      {idempotencyKey: executionContext.clientOperationId},
    )
    expect(result.execution?.runId).toBe('run-1')
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://api.test/api/v2/image/generate')
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: 'robot',
      executionContext,
    })
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      executionContext.clientOperationId,
    )
  })

  it('encodes the canvas cursor and returns stable run identities', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ok({items: [{runId: 'run-1'}], nextCursor: 'next'}))
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const result = await client.v2.listCanvasRuns(42, {
      cursor: 'cursor/+==',
      limit: 20,
    })
    expect(result.items[0]?.runId).toBe('run-1')
    expect(result.nextCursor).toBe('next')
    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/v2/canvases/42/runs?cursor=cursor%2F%2B%3D%3D&limit=20',
    )
  })

  it('sends evaluation evidence to the submission endpoint without invoking a model', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ok({id: 'eval-1', kind: 'agent_submission'}))
    const client = createAssetHubClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: request,
    })
    const body = {
      canvasId: 42,
      artifactId: 'asset-1',
      clientOperationId: '84e8530b-b362-45c7-9064-2b03b6f95b24',
      evaluator: {name: 'external-agent'},
      referenceAssetIds: ['ref-1'],
      report: {
        schemaVersion: 'assethub.evaluation-submission.v1' as const,
        rubric: {id: 'silhouette', version: '1'},
        referenceAssetIds: ['ref-1'],
        verdict: 'needs_review' as const,
        criteria: [
          {id: 'shape', verdict: 'fail' as const, reason: 'Wing too long'},
        ],
        evidenceAssetIds: ['render-1'],
      },
    }
    const result = await client.v2.submitEvaluation(body, {
      idempotencyKey: 'eval-once',
    })
    expect(result.kind).toBe('agent_submission')
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://api.test/api/v2/evaluations/submissions')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('eval-once')
  })
})
