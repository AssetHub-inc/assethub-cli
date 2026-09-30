// A run's `progress` (V4 Character Assembly runs) as one line for `runs watch`
// and `--wait`: the step, where it is, and how many parts are busy. PURE.

import type {CanvasExecution} from '@assethub/api-client'

/** The run's status, or for a run with progress its one-line summary. */
export const runProgressLine = (execution: CanvasExecution): string => {
  const progress = execution.progress
  if (!progress) return execution.status
  const counts = new Map<string, number>()
  for (const part of progress.parts)
    if (part.state !== 'ready' && part.state !== 'waiting')
      counts.set(part.stateText, (counts.get(part.stateText) ?? 0) + 1)
  const busy = [...counts].map(
    ([text, count]) => `${count} ${text.toLowerCase()}`,
  )
  return busy.length
    ? `${progress.summary} · ${busy.join(', ')}`
    : progress.summary
}
