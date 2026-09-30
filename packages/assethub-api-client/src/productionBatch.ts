import {childOperationId} from './nativeCanvasNodes.js'

/**
 * Batch dispatch of Production runs, shared by the CLI (`production batch`) and
 * MCP (`production_analyze_batch`). Each item is an ordinary `production.analyze`
 * call under its own child operation ID, so the server's idempotency receipts
 * make a repeated batch return the runs it already started instead of paying
 * for them again.
 *
 * A rejected request is stored as a failure receipt and replayed for the same
 * key, so a 429 (agent-run limit) would come back forever. A 429 therefore moves
 * the item to a new attempt key the next time it is tried: a fresh 429 defers the
 * item on its current key, and a replayed 429 means that key was spent, so the
 * next attempt is sent at once.
 */

export const MAX_PRODUCTION_BATCH_ITEMS = 20
export const MAX_PRODUCTION_BATCH_ATTEMPTS = 25

export type ProductionBatchEntry<I> = {
  key: string
  index: number
  repeat: number
  input: I
}

export type ProductionBatchDeferReason =
  | 'AGENT_OWNER_LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_IN_PROGRESS'

type OutcomeBase = {key: string; operationId: string; attempt: number}
export type ProductionBatchOutcome<T> =
  | (OutcomeBase & {status: 'dispatched'; result: T})
  | (OutcomeBase & {
      status: 'deferred'
      reason: ProductionBatchDeferReason
      message: string
    })
  | (OutcomeBase & {status: 'failed'; code?: string; message: string})

/** One item per image and repeat, one repeat round at a time. */
export const expandProductionBatch = <I>(
  inputs: readonly I[],
  repeat = 1,
): ProductionBatchEntry<I>[] => {
  if (inputs.length === 0)
    throw new Error('A production batch needs at least one image')
  if (!Number.isSafeInteger(repeat) || repeat < 1)
    throw new Error('repeat must be a positive integer')
  if (inputs.length * repeat > MAX_PRODUCTION_BATCH_ITEMS)
    throw new Error(
      `A production batch runs at most ${MAX_PRODUCTION_BATCH_ITEMS} items (images × repeat)`,
    )
  return Array.from({length: repeat}, (_, round) =>
    inputs.map((input, index) => ({
      key: `${index}#${round + 1}`,
      index,
      repeat: round + 1,
      input,
    })),
  ).flat()
}

export const productionBatchOperationId = (
  batchOperationId: string,
  key: string,
  attempt: number,
): Promise<string> =>
  childOperationId(batchOperationId, attempt === 0 ? key : `${key}~${attempt}`)

type ApiErrorLike = {
  status?: unknown
  code?: unknown
  message?: unknown
  replayed?: unknown
}

/** The API error behind any wrappers (e.g. the CLI's execution error). */
const apiErrorOf = (error: unknown): ApiErrorLike | undefined => {
  for (
    let current = error, depth = 0;
    current != null && typeof current === 'object' && depth < 5;
    current = (current as {cause?: unknown}).cause, depth++
  ) {
    const candidate = current as ApiErrorLike
    if (typeof candidate.code === 'string' && typeof candidate.status === 'number')
      return candidate
  }
  return undefined
}

const deferReason = (
  error: ApiErrorLike,
): ProductionBatchDeferReason | undefined => {
  if (error.code === 'IDEMPOTENCY_IN_PROGRESS') return error.code
  if (error.status !== 429) return undefined
  return error.code === 'AGENT_OWNER_LIMIT_EXCEEDED'
    ? error.code
    : 'RATE_LIMITED'
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const dispatchProductionBatch = async <T>({
  batchOperationId,
  items,
  dispatch,
  onAttempt,
  concurrency = 4,
  maxAttempts = MAX_PRODUCTION_BATCH_ATTEMPTS,
}: {
  batchOperationId: string
  /** `attempt` is the saved attempt to resume from (0 when absent). */
  items: ReadonlyArray<{key: string; attempt?: number}>
  dispatch: (item: {
    key: string
    operationId: string
    attempt: number
  }) => Promise<T>
  /** Called before each send, so a caller can persist the attempt first. */
  onAttempt?: (key: string, attempt: number, operationId: string) => Promise<void>
  concurrency?: number
  maxAttempts?: number
}): Promise<ProductionBatchOutcome<T>[]> => {
  const dispatchOne = async (item: {
    key: string
    attempt?: number
  }): Promise<ProductionBatchOutcome<T>> => {
    for (let attempt = item.attempt ?? 0; ; attempt++) {
      const operationId = await productionBatchOperationId(
        batchOperationId,
        item.key,
        attempt,
      )
      const base = {key: item.key, operationId, attempt}
      await onAttempt?.(item.key, attempt, operationId)
      try {
        return {...base, status: 'dispatched', result: await dispatch(base)}
      } catch (error) {
        const apiError = apiErrorOf(error)
        const reason = apiError && deferReason(apiError)
        if (reason == null)
          return {
            ...base,
            status: 'failed',
            ...(typeof apiError?.code === 'string' ? {code: apiError.code} : {}),
            message: messageOf(error),
          }
        if (apiError?.replayed !== true || reason === 'IDEMPOTENCY_IN_PROGRESS')
          return {...base, status: 'deferred', reason, message: messageOf(error)}
        // Never report `failed` here: a later key may already hold a run, and
        // "start again" would pay twice. Deferred keeps the caller retrying.
        if (attempt + 1 >= (item.attempt ?? 0) + maxAttempts)
          return {
            ...base,
            status: 'deferred',
            reason,
            message: `Still refused after ${maxAttempts} attempts; call again later with the same input`,
          }
      }
    }
  }

  const outcomes: ProductionBatchOutcome<T>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      outcomes[index] = await dispatchOne(items[index]!)
    }
  }
  await Promise.all(
    Array.from(
      {length: Math.max(1, Math.min(concurrency, items.length))},
      worker,
    ),
  )
  return outcomes
}
