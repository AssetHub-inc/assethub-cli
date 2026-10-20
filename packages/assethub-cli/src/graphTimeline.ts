/**
 * Per-stage wall-clock summary of an artifact graph, read from each node's
 * `metadata.timing` ({createdAt, startedAt, completedAt, durationMs}) and
 * grouped by `stage:*` tag. Pure: no I/O, no clock.
 */

export type GraphTimelineNode = {
  tags?: unknown
  metadata?: unknown
}

export type StageTimeline = {
  stage: string
  nodes: number
  timedNodes: number
  firstStartedAt: string | null
  lastCompletedAt: string | null
  wallMs: number | null
  sumDurationMs: number
  maxDurationMs: number | null
}

export type GraphTimeline = {
  stages: StageTimeline[]
  untimedNodes: number
  unstagedNodes: number
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const parse = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

type Edge = {at: number; iso: string}
type Group = {
  nodes: number
  timed: number
  first: Edge | null
  last: Edge | null
  sum: number
  max: number | null
}

export const buildGraphTimeline = (
  nodes: readonly GraphTimelineNode[],
): GraphTimeline => {
  const groups = new Map<string, Group>()
  let untimedNodes = 0
  let unstagedNodes = 0

  for (const node of nodes) {
    const timing = asRecord(asRecord(node.metadata).timing)
    const startIso =
      parse(timing.startedAt) !== null ? timing.startedAt : timing.createdAt
    const start = parse(startIso)
    const end = parse(timing.completedAt)
    const duration =
      typeof timing.durationMs === 'number' && Number.isFinite(timing.durationMs)
        ? timing.durationMs
        : null
    const isTimed = start !== null || end !== null || duration !== null
    if (!isTimed) untimedNodes += 1

    const stages = (Array.isArray(node.tags) ? node.tags : []).filter(
      (tag): tag is string => typeof tag === 'string' && tag.startsWith('stage:'),
    )
    if (stages.length === 0) {
      unstagedNodes += 1
      continue
    }
    for (const stage of new Set(stages)) {
      const group = groups.get(stage) ?? {
        nodes: 0,
        timed: 0,
        first: null,
        last: null,
        sum: 0,
        max: null,
      }
      group.nodes += 1
      if (isTimed) group.timed += 1
      if (start !== null && (!group.first || start < group.first.at))
        group.first = {at: start, iso: startIso as string}
      if (end !== null && (!group.last || end > group.last.at))
        group.last = {at: end, iso: timing.completedAt as string}
      if (duration !== null) {
        group.sum += duration
        group.max = group.max === null ? duration : Math.max(group.max, duration)
      }
      groups.set(stage, group)
    }
  }

  const stages = [...groups.entries()]
    .map(([stage, g]) => ({
      stage,
      nodes: g.nodes,
      timedNodes: g.timed,
      firstStartedAt: g.first?.iso ?? null,
      lastCompletedAt: g.last?.iso ?? null,
      wallMs: g.first && g.last ? Math.max(0, g.last.at - g.first.at) : null,
      sumDurationMs: g.sum,
      maxDurationMs: g.max,
    }))
    .sort((a, b) => {
      if (a.firstStartedAt === b.firstStartedAt)
        return a.stage.localeCompare(b.stage)
      if (a.firstStartedAt === null) return 1
      if (b.firstStartedAt === null) return -1
      return a.firstStartedAt < b.firstStartedAt ? -1 : 1
    })
  return {stages, untimedNodes, unstagedNodes}
}
