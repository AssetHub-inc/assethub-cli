import {basename, dirname, extname, join} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {
  dispatchProductionBatch,
  type CanvasExecution,
  type ExecutionContext,
  type ProductionAnalyzeRequest,
  type ProductionBatchOutcome,
} from '@assethub/api-client'
import {readState, writeState} from './canvas.js'
import {activeExecution, executeRecorded} from './execution.js'
import {runProgressLine} from './runProgress.js'

type Session = Parameters<typeof executeRecorded>[0]

export type ProductionBatchItem = {
  key: string
  /** Where the image came from (file name, asset ID or URL). */
  label: string
  imageIndex: number
  repeat: number
  /** A `production.analyze` body without its executionContext. */
  body: Record<string, unknown>
  /** The attempt key to send next; see `dispatchProductionBatch`. */
  attempt: number
}

/**
 * Pinned before the first paid request: the uploaded sources and every item's
 * body. Rerunning with the operation ID resumes these items instead of
 * uploading and starting again.
 */
type ProductionBatchState = {
  version: 1
  operationId: string
  baseUrl: string
  ownerId: string
  canvasId: number
  /** The command's inputs as typed; a rerun must match them. */
  request: unknown
  items: ProductionBatchItem[]
}

export type ProductionBatchItemResult = {
  key: string
  label: string
  imageIndex: number
  repeat: number
  /** Absent while `pending`. */
  operationId?: string
  attempt: number
  /** `pending`: the wait ended before this item was started. */
  status: 'pending' | 'dispatched' | 'deferred' | 'failed' | CanvasExecution['status']
  runId?: string
  execution?: CanvasExecution
  reason?: string
  code?: string
  message?: string
}

export type ProductionBatchSource = {
  flag: 'file' | 'source-id' | 'source-url'
  value: string
}

const stem = (path: string) => basename(path, extname(path))
const safeLabel = (label: string) => label.replace(/[^\w.-]+/g, '_')

/**
 * One distinct label per image: it names the order and the download folder, so
 * two images must never share one. Files that share a name get their folder.
 */
export const productionBatchLabels = (
  sources: readonly ProductionBatchSource[],
): string[] => {
  const base = sources.map(({flag, value}) =>
    flag === 'file'
      ? stem(value)
      : flag === 'source-url'
        ? stem(new URL(value).pathname) || value
        : value,
  )
  const count = (labels: string[], label: string) =>
    labels.filter(entry => entry === label).length
  const withFolder = base.map((label, index) => {
    const {flag, value} = sources[index]!
    return count(base, label) > 1 && flag === 'file'
      ? `${basename(dirname(value))}-${label}`
      : label
  })
  return withFolder
    .map((label, index) =>
      count(withFolder, label) > 1
        ? `${label}-${withFolder.slice(0, index + 1).filter(entry => entry === label).length}`
        : label,
    )
    .map(safeLabel)
}

/** The image as the user named it, for progress lines: `image (28).png`. */
export const productionBatchImageName = ({flag, value}: ProductionBatchSource): string =>
  flag === 'file'
    ? basename(value)
    : flag === 'source-url'
      ? basename(new URL(value).pathname) || value
      : value

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const statePath = (stateDir: string, operationId: string) => {
  if (!uuid.test(operationId)) throw new Error('Operation ID must be a UUID')
  return join(stateDir, 'production-batches', `${operationId}.json`)
}

export const readProductionBatch = async (
  stateDir: string,
  operationId: string,
): Promise<ProductionBatchState | undefined> => {
  const state = (await readState(statePath(stateDir, operationId))) as
    | ProductionBatchState
    | undefined
  if (state === undefined) return undefined
  if (
    !state ||
    state.version !== 1 ||
    state.operationId !== operationId ||
    typeof state.baseUrl !== 'string' ||
    typeof state.ownerId !== 'string' ||
    !Number.isSafeInteger(state.canvasId) ||
    !Array.isArray(state.items) ||
    !state.items.every(
      item =>
        item &&
        typeof item.key === 'string' &&
        Number.isSafeInteger(item.attempt) &&
        item.body &&
        typeof item.body === 'object',
    )
  )
    throw new Error('Invalid saved production batch')
  return state
}

const isTerminal = (execution: CanvasExecution) =>
  execution.status === 'needs_review' ||
  (!['queued', 'running'].includes(execution.status) &&
    execution.history.status === 'recorded')

export const runProductionBatch = async (
  session: Session,
  options: {
    operationId: string
    request: unknown
    /** Resolves sources (uploads) and builds the items; skipped on resume. */
    buildItems: () => Promise<ProductionBatchItem[]>
    agent?: ExecutionContext['agent']
    parentRunId?: string
    /** With `wait`, at most `concurrency` of this batch's runs are unfinished at once. */
    wait?: {
      concurrency: number
      intervalMs: number
      timeoutMs: number
      onProgress?: (item: ProductionBatchItemResult) => void
    }
  },
): Promise<{
  batchOperationId: string
  canvasId: number
  items: ProductionBatchItemResult[]
  timedOut: boolean
}> => {
  const path = statePath(session.stateDir, options.operationId)
  let state = await readProductionBatch(session.stateDir, options.operationId)
  if (state) {
    if (state.baseUrl !== session.baseUrl)
      throw new Error('Saved batch belongs to a different API origin')
    if (state.ownerId !== session.ownerId)
      throw new Error('Saved batch belongs to a different organization')
    if (state.canvasId !== session.canvas.id)
      throw new Error('Saved batch belongs to a different canvas')
    if (!isDeepStrictEqual(state.request, JSON.parse(JSON.stringify(options.request))))
      throw new Error(
        'Operation ID already belongs to a batch with different inputs; rerun it with the same inputs or use a new operation ID',
      )
  } else {
    state = JSON.parse(
      JSON.stringify({
        version: 1,
        operationId: options.operationId,
        baseUrl: session.baseUrl,
        ownerId: session.ownerId,
        canvasId: session.canvas.id,
        request: options.request,
        items: await options.buildItems(),
      }),
    ) as ProductionBatchState
    await writeState(path, state, {exclusive: true})
  }
  const saved = state
  activeExecution.batchOperationId = saved.operationId

  // Workers persist attempts concurrently; write the whole state in order.
  let writes = Promise.resolve()
  const persistAttempt = (key: string, attempt: number) => {
    const item = saved.items.find(entry => entry.key === key)!
    if (item.attempt === attempt) return writes
    item.attempt = attempt
    writes = writes.then(() => writeState(path, saved))
    return writes
  }
  const dispatch = (items: ProductionBatchItem[], concurrency: number) =>
    dispatchProductionBatch({
      batchOperationId: saved.operationId,
      items,
      concurrency,
      // Attempts are saved, so a rerun never has to walk past spent keys.
      maxAttempts: 1_000,
      onAttempt: persistAttempt,
      dispatch: ({key, operationId}) =>
        executeRecorded(
          session,
          'production.analyze',
          saved.items.find(item => item.key === key)!.body as unknown as ProductionAnalyzeRequest,
          {operationId, agent: options.agent, parentRunId: options.parentRunId},
        ),
    })

  const results = new Map<string, ProductionBatchItemResult>()
  const record = (
    item: ProductionBatchItem,
    outcome: ProductionBatchOutcome<{execution: CanvasExecution}>,
  ) => {
    const {key, label, imageIndex, repeat} = item
    const base = {key, label, imageIndex, repeat, operationId: outcome.operationId, attempt: outcome.attempt}
    const result: ProductionBatchItemResult =
      outcome.status === 'dispatched'
        ? {
            ...base,
            status: 'dispatched',
            runId: outcome.result.execution.runId,
            execution: outcome.result.execution,
          }
        : outcome.status === 'deferred'
          ? {...base, status: 'deferred', reason: outcome.reason, message: outcome.message}
          : {...base, status: 'failed', ...(outcome.code ? {code: outcome.code} : {}), message: outcome.message}
    results.set(key, result)
    options.wait?.onProgress?.(result)
    return result
  }

  let timedOut = false
  if (!options.wait) {
    const outcomes = await dispatch(saved.items, 4)
    outcomes.forEach((outcome, index) => record(saved.items[index]!, outcome))
  } else {
    const {concurrency, intervalMs, timeoutMs} = options.wait
    const deadline = Date.now() + timeoutMs
    const queue = [...saved.items]
    const running = new Map<string, {runId: string; readErrors: number}>()
    let blockedUntil = 0
    while (queue.length > 0 || running.size > 0) {
      while (running.size < concurrency && queue.length > 0 && Date.now() >= blockedUntil) {
        const item = queue.shift()!
        const [outcome] = await dispatch([item], 1)
        const result = record(item, outcome!)
        if (result.status === 'dispatched') {
          if (isTerminal(result.execution!)) {
            results.set(item.key, {...result, status: result.execution!.status})
          } else running.set(item.key, {runId: result.runId!, readErrors: 0})
        } else if (result.status === 'deferred') {
          queue.unshift(item)
          // Retry once one of our runs finishes, or after a pause if none runs.
          blockedUntil = running.size > 0 ? Infinity : Date.now() + intervalMs * 6
        }
      }
      if (queue.length === 0 && running.size === 0) break
      if (Date.now() >= deadline) {
        timedOut = true
        break
      }
      await delay(intervalMs)
      for (const [key, entry] of running) {
        // A transient read error must not abort the batch; give up after 5 in a row.
        let execution: CanvasExecution
        try {
          execution = await session.client.v2.getRun(entry.runId)
          entry.readErrors = 0
        } catch (error) {
          if (++entry.readErrors >= 5) throw error
          continue
        }
        const previous = results.get(key)!
        const next = {...previous, execution, status: isTerminal(execution) ? execution.status : ('dispatched' as const)}
        // Report status changes and, while it runs, each new progress step.
        if (
          previous.execution?.status !== execution.status ||
          (previous.execution && runProgressLine(previous.execution) !== runProgressLine(execution))
        )
          options.wait.onProgress?.(next)
        results.set(key, next)
        if (isTerminal(execution)) {
          running.delete(key)
          if (blockedUntil === Infinity) blockedUntil = 0
        }
      }
      if (blockedUntil === Infinity && running.size === 0) blockedUntil = 0
    }
  }
  await writes
  return {
    batchOperationId: saved.operationId,
    canvasId: saved.canvasId,
    items: saved.items.map(
      item =>
        results.get(item.key) ?? {
          key: item.key,
          label: item.label,
          imageIndex: item.imageIndex,
          repeat: item.repeat,
          attempt: item.attempt,
          status: 'pending',
        },
    ),
    timedOut,
  }
}
