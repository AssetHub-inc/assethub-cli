// What `--wait` prints while runs work: one line per real change (a new step,
// another mesh ready, a part kept with an issue, the end of the run), with the
// local time, and for a batch the image's letter and file name. Part states
// that flicker (drawing, checking, redoing) never print a line on their own.

import type {CanvasExecution} from '@assethub/api-client'

import type {ProductionBatchItemResult} from './productionBatch.js'

type Clock = () => Date
type Write = (text: string) => void

// A stopped run reports phase `done` and step 4 whatever stopped it, so where
// it stopped is the last step seen while it worked.
const stepNames: Record<number, string> = {
  1: 'Planning the parts',
  2: 'Making the base body',
  3: 'Making the parts',
  4: 'Assembling in Blender',
}
const pad2 = (value: number) => String(value).padStart(2, '0')
const clockTime = (date: Date) =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
const shortId = (id: string) => id.slice(0, 8)
const duration = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${pad2(minutes % 60)} min`
}

/** Where the run is: the summary with `Step 3 of 4` shortened to `3/4`. */
export const stepText = (execution: CanvasExecution): string =>
  execution.progress
    ? execution.progress.summary.replace(/^Step (\d+) of (\d+) · /, '$1/$2 ')
    : execution.status

/**
 * Why a run stopped, in plain words. The backend sends V4 findings as a
 * Python-style list (`[{'code': ..., 'message': ...}]`); each becomes
 * `message (code)`.
 */
export const failureText = (execution: CanvasExecution): string =>
  plainError(
    execution.error?.message ??
      execution.progress?.outcome?.detail ??
      execution.history.error ??
      execution.status,
  )
const plainError = (message: string, code?: string): string => {
  const findings = [...message.matchAll(/\{([^{}]*)\}/g)].flatMap(
    ([, body]) => {
      const field = (name: string) =>
        new RegExp(`['"]${name}['"]:\\s*['"]([^'"]*)['"]`).exec(body!)?.[1]
      const text = field('message')
      return text
        ? [`${text}${field('code') ? ` (${field('code')})` : ''}`]
        : []
    },
  )
  if (message.trim().startsWith('[') && findings.length)
    return findings.join('; ')
  return code ? `${message} (${code})` : message
}

const isFailure = (status: string) =>
  status === 'failed' || status === 'cancelled'
const stoppedAt = (lastStep: number | undefined) =>
  lastStep && stepNames[lastStep]
    ? `at ${lastStep}/4 ${stepNames[lastStep]} · `
    : ''
const terminalText = (
  execution: CanvasExecution,
  status: string,
  lastStep?: number,
): string => {
  if (isFailure(status)) {
    return `✗ FAILED · ${stoppedAt(lastStep)}${failureText(execution)}`
  }
  if (status === 'completed') return `✓ done · ${stepText(execution)}`
  if (status === 'needs_review')
    return `⚠ needs review · ${stepText(execution)}`
  return `⚠ ${status} · ${stepText(execution)}`
}
const isTerminal = (status: string) =>
  !['queued', 'running', 'dispatched'].includes(status)
/** The step a still-working run is on, to say later where it stopped. */
const workingStep = (execution: CanvasExecution, status: string) =>
  !isTerminal(status) ? execution.progress?.step : undefined

/** Parts that became kept-with-an-issue or failed since the last report. */
const newIssues = (
  previous: CanvasExecution | undefined,
  next: CanvasExecution,
) => {
  const before = new Map(
    previous?.progress?.parts.map(part => [part.label, part.state]),
  )
  return (next.progress?.parts ?? [])
    .filter(
      part =>
        (part.state === 'kept' || part.state === 'failed') &&
        before.get(part.label) !== part.state,
    )
    .map(
      part =>
        `${part.state === 'kept' ? '⚠ kept with an issue' : '✗ part needs a person'}: ${part.label}${part.note ? ` · ${part.note}` : ''}`,
    )
}

/**
 * The lines one run's new receipt adds: its step or its end when either
 * changed, then any part that newly needs attention. `status` is the batch
 * item's status when it differs from the receipt's; `lastStep` the last step
 * seen while the run worked.
 */
const changeLines = (
  previous: CanvasExecution | undefined,
  next: CanvasExecution,
  status: string = next.status,
  previousStatus: string | undefined = previous?.status,
  lastStep?: number,
): string[] => {
  const text = isTerminal(status)
    ? terminalText(next, status, lastStep)
    : stepText(next)
  const before =
    previous && previousStatus
      ? isTerminal(previousStatus)
        ? terminalText(previous, previousStatus)
        : stepText(previous)
      : undefined
  return [...(text !== before ? [text] : []), ...newIssues(previous, next)]
}

/** `runs watch`, `production analyze --wait` and friends: one run. */
export const runReporter = ({
  write,
  now = () => new Date(),
}: {
  write: Write
  now?: Clock
}) => {
  let last: CanvasExecution | undefined
  let lastStep: number | undefined
  return (execution: CanvasExecution) => {
    const lines = changeLines(
      last,
      execution,
      execution.status,
      last?.status,
      lastStep,
    )
    last = execution
    lastStep = workingStep(execution, execution.status) ?? lastStep
    for (const line of lines)
      write(`${clockTime(now())}  run ${shortId(execution.runId)}  ${line}\n`)
  }
}

export type BatchImage = {
  key: string
  imageIndex: number
  repeat: number
  name: string
}

/**
 * `production batch`: a header naming each image by letter (A, B, …; `A#2`
 * for the second repeat), a line per real change, and a status table.
 */
export const batchReporter = (options: {
  write: Write
  now?: Clock
  operationId: string
  agent: string
  canvasId: number
  concurrency?: number
  images: BatchImage[]
}) => {
  const {write, images} = options
  const now = options.now ?? (() => new Date())
  const repeats = images.some(image => image.repeat > 1)
  const letter = (image: Pick<BatchImage, 'imageIndex' | 'repeat'>) =>
    `${image.imageIndex < 26 ? String.fromCharCode(65 + image.imageIndex) : image.imageIndex + 1}${repeats ? `#${image.repeat}` : ''}`
  const letterWidth = Math.max(...images.map(image => letter(image).length))
  const nameWidth = Math.max(...images.map(image => image.name.length))
  const who = (key: string) => {
    const image = images.find(entry => entry.key === key)!
    return `${letter(image).padEnd(letterWidth)}  ${image.name.padEnd(nameWidth)}`
  }
  const state = new Map<
    string,
    {
      result: ProductionBatchItemResult
      startedAt?: Date
      endedAt?: Date
      lastLine?: string
      lastStep?: number
    }
  >()
  const say = (key: string, line: string) =>
    write(`${clockTime(now())}  ${who(key)}  ${line}\n`)

  const header = () => {
    const runs = `${images.length} run${images.length === 1 ? '' : 's'}${options.concurrency ? `, ${options.concurrency} at a time` : ''}`
    write(
      [
        `Batch ${shortId(options.operationId)} · ${options.agent} · ${runs} · canvas ${options.canvasId}`,
        ...images
          .filter(image => !repeats || image.repeat === 1)
          .map(
            image =>
              `  ${String.fromCharCode(65 + image.imageIndex).padEnd(1)}  ${image.name}`,
          ),
        `  Resume with: --operation-id ${options.operationId}`,
        '',
        '',
      ].join('\n'),
    )
  }

  const item = (result: ProductionBatchItemResult) => {
    const entry = state.get(result.key)
    const previous = entry?.result
    const lines: string[] = []
    if (result.execution) {
      if (!previous?.execution)
        lines.push(
          isTerminal(result.status)
            ? terminalText(result.execution, result.status)
            : `started run ${shortId(result.execution.runId)} · ${stepText(result.execution)}`,
          ...newIssues(undefined, result.execution),
        )
      else
        lines.push(
          ...changeLines(
            previous.execution,
            result.execution,
            result.status,
            previous.status,
            entry?.lastStep,
          ),
        )
    } else if (result.status === 'deferred') {
      lines.push(
        `waiting for a free run slot · ${result.message ?? result.reason ?? ''}`,
      )
    } else if (result.status === 'failed') {
      lines.push(
        `✗ could not start · ${plainError(result.message ?? 'failed', result.code)}`,
      )
    }
    const next = {
      result,
      startedAt:
        entry?.startedAt ??
        (result.execution ? new Date(result.execution.createdAt) : undefined),
      endedAt:
        entry?.endedAt ??
        (result.execution && isTerminal(result.status) ? now() : undefined),
      lastLine: entry?.lastLine,
      lastStep:
        (result.execution && workingStep(result.execution, result.status)) ??
        entry?.lastStep,
    }
    for (const line of lines) {
      if (line === next.lastLine) continue
      next.lastLine = line
      say(result.key, line)
    }
    state.set(result.key, next)
  }

  /** Every image's state now: printed every few minutes and at the end. */
  const table = (title: string) => {
    const rows = images.map(image => {
      const entry = state.get(image.key)
      const result = entry?.result
      const execution = result?.execution
      const [mark, detail] = !result
        ? ['○ not started', '']
        : execution
          ? isFailure(result.status)
            ? [
                '✗ failed',
                `${entry?.lastStep ? `at ${entry.lastStep}/4 · ` : ''}${failureText(execution)}`,
              ]
            : result.status === 'completed'
              ? ['✓ done', stepText(execution)]
              : isTerminal(result.status)
                ? [`⚠ ${result.status.replace('_', ' ')}`, stepText(execution)]
                : ['● running', stepText(execution)]
          : result.status === 'deferred'
            ? ['… waiting', result.message ?? result.reason ?? '']
            : result.status === 'failed'
              ? [
                  '✗ failed',
                  plainError(result.message ?? 'failed', result.code),
                ]
              : ['○ not started', '']
      const took =
        entry?.startedAt && !Number.isNaN(entry.startedAt.getTime())
          ? `  ${duration((entry.endedAt ?? now()).getTime() - entry.startedAt.getTime())}`
          : ''
      return `  ${who(image.key)}  ${mark.padEnd(12)}${detail}${took}`
    })
    write(
      ['', `── ${clockTime(now())} · ${title} ──`, ...rows, '', ''].join('\n'),
    )
  }

  return {header, item, table}
}
