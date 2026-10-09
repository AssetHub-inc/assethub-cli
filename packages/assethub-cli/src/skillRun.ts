// `assethub skills run` and its follow-ups: run a workspace skill (stored on
// the server, never copied locally) on one image, watch it in plain words,
// and save what it made next to the original without overwriting anything.
import {createWriteStream} from 'node:fs'
import {mkdir, open} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'
import {basename, extname, join} from 'node:path'
import {
  TERMINAL_WORKSPACE_SKILL_RUN_STATUSES,
  type WorkspaceSkillRun,
  type WorkspaceSkillRunStartInput,
  type WorkspaceSkillRunStarted,
} from '@assethub/api-client'

export type SkillRunClient = {
  v2: {
    getWorkspaceSkill: (
      skillId: string,
      options?: {revision?: number},
    ) => Promise<{
      skill: {skillId: string; revision: number; contentSha256: string; title: string}
    }>
    startWorkspaceSkillRun: (
      skillId: string,
      body: WorkspaceSkillRunStartInput,
    ) => Promise<WorkspaceSkillRunStarted>
    getWorkspaceSkillRun: (
      skillId: string,
      runId: string,
    ) => Promise<WorkspaceSkillRun>
    getAsset: (assetId: string) => Promise<{url: string}>
  }
}

/**
 * The exact revision a run will use. When the caller names one (the version
 * the person approved), it is checked against the server; otherwise the
 * current revision is pinned. Either way the start carries the pin, so a skill
 * edited in between is refused instead of charged.
 */
export const pinSkill = async (
  client: SkillRunClient,
  skillId: string,
  expected: {revision?: number; contentSha256?: string},
) => {
  const {skill} = await client.v2.getWorkspaceSkill(
    skillId,
    expected.revision ? {revision: expected.revision} : {},
  )
  if (
    expected.contentSha256 &&
    expected.contentSha256 !== skill.contentSha256
  )
    throw new Error(
      `Skill ${skillId} revision ${skill.revision} is not the version you approved (content hash differs). Read it again with \`assethub skills get ${skillId}\` and ask before running.`,
    )
  return {
    skillId: skill.skillId,
    title: skill.title,
    revision: skill.revision,
    contentSha256: skill.contentSha256,
  }
}

const STAGE_WORDS: Record<string, string> = {
  author: 'Reading the skill',
  plan: 'Planning',
  spawn: 'Splitting the work',
  point: 'Finding the parts',
  crop: 'Cropping',
  image: 'Making the image',
  operation: 'Running a step',
  review: 'AI check',
}

const stepKey = (step: {stepId: string; attempt: number; part?: string}) =>
  `${step.stepId}#${step.attempt}#${step.part ?? ''}`

/**
 * One plain line per change since the last poll: a step that finished or
 * failed, and every AI check verdict. No ids, no JSON — the lines are meant to
 * be passed to the person as they are.
 */
export const describeSkillRunProgress = (
  previous: WorkspaceSkillRun | undefined,
  next: WorkspaceSkillRun,
): string[] => {
  const lines: string[] = []
  const before = new Map(
    (previous?.steps ?? []).map(step => [stepKey(step), step.status]),
  )
  for (const step of next.steps) {
    if (step.stage === 'review') continue
    const was = before.get(stepKey(step))
    if (was === step.status) continue
    if (step.status !== 'completed' && step.status !== 'failed') continue
    const what = STAGE_WORDS[step.stage] ?? step.stage
    const part = step.part ? ` (${step.part})` : ''
    lines.push(
      // ASCII only: Windows PowerShell 5.1 garbles an em dash read from a pipe.
      `Try ${step.attempt}: ${what}${part} - ${step.status === 'completed' ? 'done' : 'failed'}.`,
    )
  }
  const seen = new Set(
    (previous?.verdicts ?? []).map(v => `${v.stepId}#${v.attempt}`),
  )
  for (const verdict of next.verdicts) {
    if (seen.has(`${verdict.stepId}#${verdict.attempt}`)) continue
    if (verdict.pass === null) continue
    lines.push(
      verdict.pass
        ? `AI check (try ${verdict.attempt}): looks right.`
        : `AI check (try ${verdict.attempt}): ${verdict.reason ?? 'not right'}. Correcting it automatically.`,
    )
  }
  if (previous?.status !== next.status) {
    if (next.status === 'awaiting_confirmation' && next.quote)
      lines.push(describeSkillRunQuote(next.quote))
    if (next.status === 'budget_exhausted')
      lines.push(
        `Paused: the spending limit is reached (${next.budget.spentCredits} of ${next.budget.credits} credits used).`,
      )
    if (next.status === 'completed') lines.push('Finished.')
    if (next.status === 'failed')
      lines.push(
        `Stopped: ${next.outcome?.reason ?? 'the skill could not finish this image'}.`,
      )
    if (next.status === 'cancelled') lines.push('Stopped: the run was cancelled.')
  }
  return lines
}

/** One plain line for a flat run's price, to pass to the person as it is. */
export const describeSkillRunQuote = (quote: NonNullable<WorkspaceSkillRun['quote']>) =>
  `Found ${quote.items.length} ${quote.items.length === 1 ? 'part' : 'parts'}: ${quote.items
    .map(item => item.key)
    .join(', ')}. ${quote.total} credits (${quote.base} + ${quote.perPart} per part), retries included, failed parts are refunded.`

/** A run stops moving at a terminal status, when paused at its limit, and when it waits for its price to be confirmed. */
export const isSkillRunSettled = (run: WorkspaceSkillRun) =>
  run.status === 'budget_exhausted' ||
  run.status === 'awaiting_confirmation' ||
  TERMINAL_WORKSPACE_SKILL_RUN_STATUSES.includes(run.status)

/** The read's answer, or undefined when it took longer than `ms`. */
const readWithin = async <T>(read: () => Promise<T>, ms: number) => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>(done => {
        timer = setTimeout(() => done(undefined), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export const waitForSkillRun = async (input: {
  client: SkillRunClient
  skillId: string
  runId: string
  onProgress: (line: string) => void
  pollMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** One read that takes longer is abandoned and retried, so a stalled
   *  request cannot hold `--wait` past its deadline. */
  requestTimeoutMs?: number
}): Promise<{run: WorkspaceSkillRun; timedOut: boolean}> => {
  const sleep =
    input.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)))
  const now = input.now ?? Date.now
  const deadline = now() + (input.timeoutMs ?? 45 * 60_000)
  const requestTimeoutMs = input.requestTimeoutMs ?? 60_000
  let previous: WorkspaceSkillRun | undefined
  for (;;) {
    const run = await readWithin(
      () => input.client.v2.getWorkspaceSkillRun(input.skillId, input.runId),
      requestTimeoutMs,
    )
    if (!run) {
      if (now() >= deadline) {
        if (previous) return {run: previous, timedOut: true}
        throw new Error(`Could not read skill run ${input.runId}: the server did not answer.`)
      }
      await sleep(input.pollMs ?? 5_000)
      continue
    }
    for (const line of describeSkillRunProgress(previous, run))
      input.onProgress(line)
    previous = run
    if (isSkillRunSettled(run)) return {run, timedOut: false}
    if (now() >= deadline) return {run, timedOut: true}
    await sleep(input.pollMs ?? 5_000)
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'model/gltf-binary': '.glb',
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'skill'

/**
 * Download the run's verified outputs into `outDir`, named after the original
 * (`cat.figure-to-clay.png`, then `-2`, `-3`, ...). Files are created with
 * `wx`, so an existing file — the original above all — is never overwritten.
 */
/** Stream one asset into `outDir` as `<base>.<ext>` (then `-2`, `-3`, …),
 *  opened with `wx` so an existing file is never overwritten. */
const downloadAsset = async (input: {
  client: SkillRunClient
  assetId: string
  outDir: string
  base: string
  fetchImpl: typeof fetch
}): Promise<string> => {
  const {url} = await input.client.v2.getAsset(input.assetId)
  const response = await input.fetchImpl(url, {signal: AbortSignal.timeout(120_000)})
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const mime = response.headers.get('content-type')?.split(';')[0] ?? ''
  const extension = EXTENSIONS[mime] ?? (extname(new URL(url).pathname) || '.bin')
  if (!response.body) throw new Error('empty response')
  await mkdir(input.outDir, {recursive: true})
  for (let n = 1; ; n++) {
    const path = join(input.outDir, `${input.base}${n === 1 ? '' : `-${n}`}${extension}`)
    let handle
    try {
      handle = await open(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    // Streamed to disk: a mesh output can be far larger than an image.
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      createWriteStream('', {fd: handle.fd, autoClose: false}),
    ).finally(() => handle.close())
    return path
  }
}

const stemOf = (sourceFileName?: string) =>
  sourceFileName ? basename(sourceFileName, extname(sourceFileName)) : 'result'

/**
 * Download the run's verified outputs into `outDir`, named after the original
 * (`cat.figure-to-clay.png`, then `-2`, `-3`, ...). Files are created with
 * `wx`, so an existing file — the original above all — is never overwritten.
 */
export const saveSkillRunOutputs = async (input: {
  client: SkillRunClient
  run: WorkspaceSkillRun
  skillTitle: string
  outDir: string
  /** The original file's name, used as the stem; defaults to the skill. */
  sourceFileName?: string
  fetchImpl?: typeof fetch
}): Promise<{saved: {assetId: string; path: string}[]; failed: {assetId: string; error: string}[]}> => {
  const base = `${stemOf(input.sourceFileName)}.${slug(input.skillTitle)}`
  const saved: {assetId: string; path: string}[] = []
  const failed: {assetId: string; error: string}[] = []
  const assetIds = [
    ...new Set(
      input.run.outputs
        .filter(output => output.verified && output.assetId)
        .map(output => output.assetId!),
    ),
  ]
  for (const assetId of assetIds) {
    try {
      saved.push({
        assetId,
        path: await downloadAsset({...input, assetId, base, fetchImpl: input.fetchImpl ?? fetch}),
      })
    } catch (error) {
      failed.push({assetId, error: error instanceof Error ? error.message : String(error)})
    }
  }
  return {saved, failed}
}

export type SavedAttempt = {
  assetId: string
  attempt: number
  /** What the run's AI check said about this try. */
  check: 'passed' | 'rejected' | 'unchecked'
  reason?: string
  part?: string
  path: string
}

/**
 * Download every image try of a run, verified or not, as
 * `<original>.<skill>.try<n>[-<part>]-<passed|rejected|unchecked>.<ext>`, so
 * the person's own assistant can look at a rejected try and fix it locally.
 */
export const saveSkillRunAttempts = async (input: {
  client: SkillRunClient
  run: WorkspaceSkillRun
  skillTitle: string
  outDir: string
  sourceFileName?: string
  fetchImpl?: typeof fetch
}): Promise<{saved: SavedAttempt[]; failed: {assetId: string; error: string}[]}> => {
  const prefix = `${stemOf(input.sourceFileName)}.${slug(input.skillTitle)}`
  const saved: SavedAttempt[] = []
  const failed: {assetId: string; error: string}[] = []
  const seen = new Set<string>()
  const images = input.run.steps.filter(step => step.stage === 'image')
  // A verdict may name its part; older servers send none.
  const checked = (input.run.verdicts as (WorkspaceSkillRun['verdicts'][number] & {part?: string})[])
    .filter(v => v.pass !== null)
  // A verdict names its review step ("review"), not the image it judged
  // ("isolate"), so the try is matched by attempt. Only when that is
  // unambiguous: with several images per try (one per part) the checks cannot
  // be told apart, and a wrong "rejected" would send the person after the
  // wrong image, so those are settled by the run's own record below instead.
  const verdictFor = (step: (typeof images)[number]) =>
    checked.find(v => v.stepId === step.stepId && v.attempt === step.attempt && (v.part ?? step.part) === step.part) ??
    (step.part ? checked.find(v => v.part === step.part && v.attempt === step.attempt) : undefined) ??
    (images.filter(other => other.attempt === step.attempt).length === 1 &&
    checked.filter(v => v.attempt === step.attempt).length === 1
      ? checked.find(v => v.attempt === step.attempt)
      : undefined)
  // Without a verdict that names the part: a part's final passed its check,
  // and a try the same part was retried after was rejected (a part is only
  // retried after its check says no). The reason stays unknown then.
  const finals = new Set(input.run.parts.flatMap(part => part.finals))
  const checkOf = (step: (typeof images)[number]) => {
    const verdict = verdictFor(step)
    if (verdict) return {check: verdict.pass ? 'passed' : 'rejected', reason: verdict.reason} as const
    if (!step.part) return {check: 'unchecked'} as const
    if (finals.has(step.artifactId)) return {check: 'passed'} as const
    if (images.some(other => other.part === step.part && other.attempt > step.attempt))
      return {check: 'rejected'} as const
    return {check: 'unchecked'} as const
  }
  for (const step of images) {
    if (!step.assetId || seen.has(step.assetId)) continue
    seen.add(step.assetId)
    const {check, reason} = checkOf(step)
    const part = step.part ? `-${slug(step.part)}` : ''
    try {
      const path = await downloadAsset({
        ...input,
        assetId: step.assetId,
        base: `${prefix}.try${step.attempt}${part}-${check}`,
        fetchImpl: input.fetchImpl ?? fetch,
      })
      saved.push({
        assetId: step.assetId,
        attempt: step.attempt,
        check,
        ...(check === 'rejected' && reason ? {reason} : {}),
        ...(step.part ? {part: step.part} : {}),
        path,
      })
    } catch (error) {
      failed.push({assetId: step.assetId, error: error instanceof Error ? error.message : String(error)})
    }
  }
  return {saved, failed}
}

/** What to do next, as a command the agent can run after asking. */
export const nextSkillRunAction = (
  run: WorkspaceSkillRun,
): string | undefined => {
  if (run.status === 'budget_exhausted')
    return `Ask before spending more, then: assethub skills run-resume ${run.skillId} ${run.runId} --add-credits <n> --wait`
  if (run.status === 'awaiting_confirmation')
    return `Show the parts and the price and ask once, then: assethub skills run-confirm ${run.skillId} ${run.runId} --total ${run.quote?.total ?? '<total>'} [--parts <id,id>] --wait (with --parts, --total is ${run.quote ? `${run.quote.base} + ${run.quote.perPart} per part` : 'the base plus the per-part price for each'})`
  if (run.status === 'running')
    return `Still running on the server. Check again with: assethub skills run-status ${run.skillId} ${run.runId} --wait`
  if (run.status === 'completed')
    return `Show the result, then record the answer: assethub skills run-verdict ${run.skillId} ${run.runId} --verdict keep|not-right [--note <text>]`
  return undefined
}


const RUNNABLE_SCHEMA_VERSION = 'ag.memory-skill.v7'

export type SkillListRow = {
  skillId: string
  summary: string
  schemaVersion?: string | null
  mode: string
  revision: number
  taskKind: string | null
}

export type RunnableSkill = {
  skillId: string
  summary: string
  revision: number
  mode: string
  taskKind: string | null
  /** Other runnable skills with the same summary: ask which one before running. */
  sameSummaryAs?: string[]
}

/**
 * The skills `skills run` accepts — v7 and not switched off, the same rule as
 * the canvas "Use skill" node — across every page of the list. Look-alikes
 * are flagged so an agent asks instead of guessing by name.
 */
export const listRunnableSkills = async (
  listPage: (
    cursor: string | undefined,
  ) => Promise<{items: SkillListRow[]; nextCursor: string | null}>,
) => {
  const rows: SkillListRow[] = []
  let cursor: string | undefined
  do {
    const page = await listPage(cursor)
    rows.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  const runnable = rows.filter(
    row => row.schemaVersion === RUNNABLE_SCHEMA_VERSION && row.mode !== 'off',
  )
  const bySummary = new Map<string, string[]>()
  for (const row of runnable)
    bySummary.set(row.summary, [...(bySummary.get(row.summary) ?? []), row.skillId])
  const items: RunnableSkill[] = runnable.map(row => {
    const twins = bySummary.get(row.summary)!.filter(id => id !== row.skillId)
    return {
      skillId: row.skillId,
      summary: row.summary,
      revision: row.revision,
      mode: row.mode,
      taskKind: row.taskKind,
      ...(twins.length > 0 ? {sameSummaryAs: twins} : {}),
    }
  })
  const off = rows.filter(
    row => row.schemaVersion === RUNNABLE_SCHEMA_VERSION && row.mode === 'off',
  ).length
  return {
    items,
    notRunnable: {
      total: rows.length - runnable.length,
      off,
      otherVersion: rows.length - runnable.length - off,
    },
    ...(items.length === 0
      ? {
          hint:
            off > 0
              ? 'No skill in this workspace can run on an image yet. Some are switched off: an editor can turn one on with `assethub skills controls`.'
              : 'No skill in this workspace can run on an image yet. Build one with the Skill Builder, or install one from AssetHub (`assethub skills official list`).',
        }
      : {}),
  }
}
