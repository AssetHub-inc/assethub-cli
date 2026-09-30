import {describe, expect, it, vi} from 'vitest'
import {
  AssetHubApiError,
  childOperationId,
  createAssetHubClient,
  dispatchProductionBatch,
  expandProductionBatch,
  MAX_PRODUCTION_BATCH_ITEMS,
  productionBatchOperationId,
} from '../src/index.js'

const batchId = '0b9f3f55-5a4e-4d7c-9a51-3f7f2d1c6b10'

const apiError = (status: number, code: string, replayed = false) =>
  new AssetHubApiError({
    status,
    code,
    message: code,
    payload: {success: false, error: {code, message: code}},
    replayed,
  })

describe('expandProductionBatch', () => {
  it('runs every image once per repeat, one repeat round at a time', () => {
    expect(
      expandProductionBatch(['harpy', 'satyr'], 2).map(({key, input}) => [
        key,
        input,
      ]),
    ).toEqual([
      ['0#1', 'harpy'],
      ['1#1', 'satyr'],
      ['0#2', 'harpy'],
      ['1#2', 'satyr'],
    ])
  })

  it('rejects an empty batch, a bad repeat and more than the item limit', () => {
    expect(() => expandProductionBatch([], 1)).toThrow(/at least one image/)
    expect(() => expandProductionBatch(['a'], 0)).toThrow(/repeat/)
    expect(() => expandProductionBatch(['a'], 1.5)).toThrow(/repeat/)
    expect(() =>
      expandProductionBatch(['a', 'b'], MAX_PRODUCTION_BATCH_ITEMS / 2 + 1),
    ).toThrow(/at most 20/)
  })
})

describe('productionBatchOperationId', () => {
  it('keeps the first attempt on the plain child key and gives retries their own key', async () => {
    expect(await productionBatchOperationId(batchId, '0#1', 0)).toBe(
      await childOperationId(batchId, '0#1'),
    )
    const retry = await productionBatchOperationId(batchId, '0#1', 1)
    expect(retry).not.toBe(await childOperationId(batchId, '0#1'))
    expect(retry).toBe(await productionBatchOperationId(batchId, '0#1', 1))
    expect(retry).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

describe('dispatchProductionBatch', () => {
  const items = [{key: '0#1'}, {key: '1#1'}, {key: '0#2'}]

  it('dispatches every item under its child operation ID and keeps the input order', async () => {
    const dispatch = vi.fn(async ({key}: {key: string}) => ({runId: `run-${key}`}))
    const outcomes = await dispatchProductionBatch({
      batchOperationId: batchId,
      items,
      dispatch,
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual([
      'dispatched',
      'dispatched',
      'dispatched',
    ])
    expect(outcomes.map(outcome => outcome.key)).toEqual(['0#1', '1#1', '0#2'])
    for (const outcome of outcomes)
      expect(outcome.operationId).toBe(
        await childOperationId(batchId, outcome.key),
      )
    expect(outcomes[1]).toMatchObject({result: {runId: 'run-1#1'}})
  })

  it('never has more than `concurrency` requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    await dispatchProductionBatch({
      batchOperationId: batchId,
      items: Array.from({length: 7}, (_, index) => ({key: `${index}#1`})),
      concurrency: 2,
      dispatch: async () => {
        peak = Math.max(peak, ++inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight--
        return {}
      },
    })
    expect(peak).toBe(2)
  })

  it('defers a fresh 429 without moving to the next attempt', async () => {
    const outcomes = await dispatchProductionBatch({
      batchOperationId: batchId,
      items: [{key: '0#1'}],
      dispatch: async () => {
        throw apiError(429, 'AGENT_OWNER_LIMIT_EXCEEDED')
      },
    })
    expect(outcomes[0]).toMatchObject({
      status: 'deferred',
      reason: 'AGENT_OWNER_LIMIT_EXCEEDED',
      attempt: 0,
      operationId: await childOperationId(batchId, '0#1'),
    })
  })

  it('moves past a replayed 429 to a new attempt and sends that one', async () => {
    const seen: Array<{operationId: string; attempt: number}> = []
    const onAttempt = vi.fn(async () => {})
    const outcomes = await dispatchProductionBatch({
      batchOperationId: batchId,
      items: [{key: '0#1'}],
      onAttempt,
      dispatch: async ({operationId, attempt}) => {
        seen.push({operationId, attempt})
        if (attempt < 2) throw apiError(429, 'AGENT_OWNER_LIMIT_EXCEEDED', true)
        return {runId: 'run'}
      },
    })
    expect(seen.map(entry => entry.attempt)).toEqual([0, 1, 2])
    expect(new Set(seen.map(entry => entry.operationId)).size).toBe(3)
    expect(onAttempt.mock.calls.map(call => call[1])).toEqual([0, 1, 2])
    expect(outcomes[0]).toMatchObject({
      status: 'dispatched',
      attempt: 2,
      operationId: await productionBatchOperationId(batchId, '0#1', 2),
    })
  })

  it('starts from the saved attempt', async () => {
    const dispatch = vi.fn(async () => ({}))
    await dispatchProductionBatch({
      batchOperationId: batchId,
      items: [{key: '0#1', attempt: 3}],
      dispatch,
    })
    expect(dispatch).toHaveBeenCalledWith({
      key: '0#1',
      attempt: 3,
      operationId: await productionBatchOperationId(batchId, '0#1', 3),
    })
  })

  it('defers an in-progress idempotency claim and finds the API error behind a wrapper', async () => {
    const outcomes = await dispatchProductionBatch({
      batchOperationId: batchId,
      items: [{key: '0#1'}],
      dispatch: async () => {
        throw new Error('wrapped', {
          cause: apiError(409, 'IDEMPOTENCY_IN_PROGRESS'),
        })
      },
    })
    expect(outcomes[0]).toMatchObject({
      status: 'deferred',
      reason: 'IDEMPOTENCY_IN_PROGRESS',
    })
  })

  it('reports any other error as failed and keeps dispatching the rest', async () => {
    const outcomes = await dispatchProductionBatch({
      batchOperationId: batchId,
      items,
      dispatch: async ({key}) => {
        if (key === '1#1') throw apiError(400, 'VALIDATION_ERROR')
        return {}
      },
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual([
      'dispatched',
      'failed',
      'dispatched',
    ])
    expect(outcomes[1]).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'VALIDATION_ERROR',
    })
  })

  it('stops walking an item that keeps replaying 429, and defers it rather than failing it', async () => {
    const dispatch = vi.fn(async () => {
      throw apiError(429, 'AGENT_OWNER_LIMIT_EXCEEDED', true)
    })
    const outcomes = await dispatchProductionBatch({
      batchOperationId: batchId,
      items: [{key: '0#1'}],
      maxAttempts: 4,
      dispatch,
    })
    expect(dispatch).toHaveBeenCalledTimes(4)
    expect(outcomes[0]).toMatchObject({status: 'deferred', attempt: 3})
  })
})

describe('AssetHubApiError.replayed', () => {
  it('is true when the server replays a stored response', async () => {
    const client = createAssetHubClient({
      apiKey: 'test-key',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: {code: 'AGENT_OWNER_LIMIT_EXCEEDED', message: 'limit'},
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'Idempotency-Replayed': 'true',
            },
          },
        ),
      ),
    })
    const error = await client.v1
      .analyzeProduction(
        {imageAssetId: 'image', agentVersion: 'ah_agent_graph_harpy_assembly_v2'},
        {idempotencyKey: batchId},
      )
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AssetHubApiError)
    expect(error).toMatchObject({
      status: 429,
      code: 'AGENT_OWNER_LIMIT_EXCEEDED',
      replayed: true,
    })
  })
})
