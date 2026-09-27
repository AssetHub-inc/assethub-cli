/**
 * Pure, independently-testable pieces of `production run --image ...`
 * (the image -> finished-asset one-shot command). Kept separate from
 * index.ts so the tricky bits — cost estimation, batch-status polling, the
 * V6 compose fallback's mesh<->image pairing, and error hints — can be unit
 * tested without spinning up an HTTP server or spawning the built CLI.
 *
 * This module intentionally does not import from `./index.js`: the CLI
 * command wiring (in index.ts) calls these functions and supplies whatever
 * they need (flags already parsed, client calls already made) rather than
 * this module reaching back into index.ts's private helpers, which would
 * create a circular import between the two files.
 */
import type {
  CanvasExecution,
  MeshComposerPart,
  ModelSummary,
  ProductionAutomationBatchStatusResult,
  ProductionOrderStatus,
} from '@assethub/api-client'

export type OneShotImageInput =
  | {kind: 'file'; path: string}
  | {kind: 'resourceId'; resourceId: string}

/**
 * `--image <file|assetId>` auto-detection: an existing local path is treated
 * as `--file`; anything else (an asset/resource id) is treated as
 * `--source-id`. `exists` is injectable so this stays a pure function in
 * tests instead of touching the real filesystem.
 */
export const detectOneShotImageInput = (
  value: string,
  exists: (path: string) => boolean,
): OneShotImageInput =>
  exists(value) ? {kind: 'file', path: value} : {kind: 'resourceId', resourceId: value}

export type ComposeMode = 'v6' | 'none'

/** Parses `--compose`. Absent stays absent (server default applies untouched). */
export const parseComposeFlag = (value: string | undefined): ComposeMode | undefined => {
  if (value == null) return undefined
  if (value === 'v6' || value === 'none') return value
  throw new Error('--compose must be "v6" or "none"')
}

/**
 * The confirmed field name (assethub-web PR #8179, `web-cli-ux`) for
 * requesting an explicit Composer V6 pass from `production automation`
 * itself. Not `composeModel` — that was this module's pre-#8179 best guess.
 */
export const PART_COMPOSER_V6_AGENT_VERSION = 'part_composer_v6_auto_assemble'

/**
 * Builds the `config` object for the `production automation` request.
 *
 * - `--compose` omitted: returns `undefined` so the request carries no
 *   `config.autoCompose` at all, leaving the server default in effect.
 * - `--compose none`: disables automation's own compose stage entirely.
 * - `--compose v6`: asks the server to run Composer V6 itself, in the same
 *   call, via `partComposerAgentVersion`. `autoCompose` is deliberately left
 *   unset (defaults to `true`) — the server 400s with
 *   `PART_COMPOSER_VERSION_REQUIRES_AUTO_COMPOSE` if both are sent together,
 *   so this function must never combine them. A server that predates #8179
 *   ignores the unrecognized field and runs its own default compose instead;
 *   `serverSupportsV6Compose` inspects the response afterward so the caller
 *   can still fall back to the client-side lineage-pairing compose
 *   (`buildComposerPartsFromMeshExecutions`) on that older server.
 */
export const buildAutomationConfig = (
  compose: ComposeMode | undefined,
): Record<string, unknown> | undefined => {
  if (compose == null) return undefined
  if (compose === 'none') return {autoCompose: false}
  return {partComposerAgentVersion: PART_COMPOSER_V6_AGENT_VERSION}
}

/**
 * `estimatedCostBreakdown` (added by #8179) only appears on a server new
 * enough to also honor `partComposerAgentVersion` — its presence in the
 * automation response is the signal that the server already did the V6
 * compose server-side in that same call, so no client-side fallback compose
 * is needed. Its absence means an older, currently-deployed server: it
 * silently ignored `partComposerAgentVersion` and ran its own default
 * compose (if any), so the caller must still run the explicit fallback.
 */
export const serverSupportsV6Compose = (
  automationResult: Record<string, unknown>,
): boolean => automationResult.estimatedCostBreakdown != null

export const DEFAULT_MAX_PARTS = 24

export type CostLineItem = {total: number | null; note?: string}

export type OneShotCostBreakdown = {
  split: CostLineItem & {perImage: number | null}
  meshGeneration: CostLineItem & {perPart: number | null; maxParts: number}
  compose: CostLineItem & {perLane: number | null; lanesPerImage: number}
}

export type OneShotCostEstimate = {
  breakdown: OneShotCostBreakdown
  totalCredits: number
  notes: string[]
}

/**
 * Best-effort cost breakdown for `--estimate`, shaped like the server's own
 * `estimatedCostBreakdown` (#8179: `split`/`meshGeneration`/`compose`, each
 * with a per-unit price and a total). Nothing here calls `production
 * automation`/`analyze` (that would start real, billable work); every
 * number comes from a side-effect-free GET (`models` catalog, `mesh/compose`
 * capabilities). Today's API has no dry-run cost for part extraction/split,
 * so that line is reported as unknown rather than guessed. `maxParts`
 * mirrors the server's own conservative constant for this math (24, per
 * #8179) rather than a locally invented cap; `--max-parts` overrides it.
 */
export const estimateOneShotCost = (options: {
  meshModel: ModelSummary | undefined
  maxParts: number
  composeRequested: boolean
  composeCredits: number | null | undefined
}): OneShotCostEstimate => {
  const notes: string[] = []

  const split: OneShotCostBreakdown['split'] = {
    perImage: null,
    total: null,
    note:
      'part extraction/split cost has no dry-run price source today; the actual cost is reported after the run (see `production status` or `runs get --summary`)',
  }
  notes.push(split.note!)

  const perPart =
    options.meshModel?.creditCost ?? options.meshModel?.defaultCreditCost ?? null
  const meshTotal = perPart == null ? null : perPart * options.maxParts
  const meshGeneration: OneShotCostBreakdown['meshGeneration'] = {
    perPart,
    maxParts: options.maxParts,
    total: meshTotal,
    ...(perPart == null
      ? {
          note: options.meshModel
            ? `mesh generation cost not included: no credit price found for model "${options.meshModel.id}"`
            : 'mesh generation cost not included: mesh model was not found in the catalog',
        }
      : {
          note: `assumes up to ${options.maxParts} parts at ${perPart} credits each; the CLI has no way to know the actual part count before splitting runs`,
        }),
  }
  notes.push(meshGeneration.note!)

  const lanesPerImage = 1
  const compose: OneShotCostBreakdown['compose'] = options.composeRequested
    ? options.composeCredits == null
      ? {
          perLane: null,
          lanesPerImage,
          total: null,
          note: 'compose cost not included: no quote found for the requested compose model',
        }
      : {perLane: options.composeCredits, lanesPerImage, total: options.composeCredits * lanesPerImage}
    : {
        perLane: null,
        lanesPerImage,
        total: 0,
        note: 'compose disabled by --compose none',
      }
  if (compose.note) notes.push(compose.note)

  const totalCredits = (meshGeneration.total ?? 0) + (compose.total ?? 0)

  return {breakdown: {split, meshGeneration, compose}, totalCredits, notes}
}

/**
 * Reads the server's own `estimatedTotalCredits`/`estimatedCostBreakdown`
 * off a real (non-estimate) automation response, when present (#8179).
 * These fields are not yet in `ProductionAutomationResult`'s shipped type,
 * so this reads them optionally/untyped rather than guessing a schema;
 * absent on a server that has not deployed #8179 yet.
 */
export const readServerCostBreakdown = (
  automationResult: Record<string, unknown>,
): {estimatedTotalCredits: number; estimatedCostBreakdown: unknown} | undefined => {
  const total = automationResult.estimatedTotalCredits
  const breakdown = automationResult.estimatedCostBreakdown
  if (typeof total !== 'number' || breakdown == null) return undefined
  return {estimatedTotalCredits: total, estimatedCostBreakdown: breakdown}
}

/** Whether the estimated (or actual, server-reported) total would exceed `--max-cost`. */
export const exceedsMaxCost = (
  totalCredits: number,
  maxCostCredits: number | undefined,
): boolean => maxCostCredits != null && totalCredits > maxCostCredits

/**
 * Human stage label for one image's `ProductionOrderStatus`. The API has no
 * distinct "compose" status, so `ready`/`in_progress` are both reported as
 * `mesh` (parts are being generated or are ready to be); there is no way to
 * tell "meshing" apart from "composing" from this field alone.
 */
export const stageLabelForOrderStatus = (status: ProductionOrderStatus): string => {
  switch (status) {
    case 'draft':
      return 'queued'
    case 'analyzing':
      return 'split'
    case 'ready':
    case 'in_progress':
      return 'mesh'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return status
  }
}

/**
 * One line per per-image stage transition, plus a batch-level completion
 * line when the completed/failed counts change. "mesh k/N" here means
 * images processed out of the batch, not parts within one image — the batch
 * status endpoint does not expose per-part progress.
 */
export const batchProgressLines = (
  previous: ProductionAutomationBatchStatusResult | undefined,
  next: ProductionAutomationBatchStatusResult,
): string[] => {
  const lines: string[] = []
  const previousStatusByOrder = new Map(
    (previous?.images ?? []).map(image => [image.orderId, image.status]),
  )
  for (const image of next.images) {
    const before = previousStatusByOrder.get(image.orderId)
    if (before !== image.status) {
      lines.push(
        `[batch] order=${image.orderId} stage=${stageLabelForOrderStatus(image.status)} (${image.status})`,
      )
    }
  }
  const previousSummary = previous?.summary
  const done = next.summary.completed + next.summary.failed
  if (
    previousSummary == null ||
    previousSummary.completed !== next.summary.completed ||
    previousSummary.failed !== next.summary.failed
  ) {
    lines.push(`[batch] mesh ${done}/${next.summary.total} done`)
  }
  return lines
}

/**
 * Polls `getStatus` (expected to be `client.v1.getProductionAutomationStatus`,
 * which already retries 429s in its own request layer) until every image in
 * the batch reaches a terminal outcome, printing one line per stage
 * transition via `onProgress`. Mirrors the deadline/backoff shape of
 * `pollProductionStatus`/`watchProductionRun` in index.ts.
 */
export const pollAutomationBatch = async (options: {
  getStatus: () => Promise<ProductionAutomationBatchStatusResult>
  sleep: (ms: number) => Promise<void>
  intervalMs: number
  timeoutMs: number
  onProgress?: (lines: string[]) => void
}): Promise<ProductionAutomationBatchStatusResult> => {
  const deadline = Date.now() + options.timeoutMs
  let previous: ProductionAutomationBatchStatusResult | undefined
  for (;;) {
    const status = await options.getStatus()
    const lines = batchProgressLines(previous, status)
    if (lines.length && options.onProgress) options.onProgress(lines)
    previous = status
    if (status.summary.completed + status.summary.failed >= status.summary.total) {
      return status
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `production run --wait timed out after ${options.timeoutMs}ms for batch=${status.batchId}`,
      )
    }
    await options.sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())))
  }
}

/**
 * The V6 compose fallback's mesh<->image pairing. Reads the automation
 * batch's own `mesh.generate` executions (fetched via `listCanvasRuns` and
 * filtered to the target order) for each part's produced mesh asset
 * (`execution.outputs`, `mediaType === 'mesh'`) and the part image it was
 * generated from (`execution.inputAssets`, `mediaType === 'image'`) — the
 * same `{assetId, partImageAssetId}` shape `composer run --part
 * <mesh>:<image>` accepts, so no manual pairing is needed.
 */
export const buildComposerPartsFromMeshExecutions = (
  executions: CanvasExecution[],
  orderId: string,
): MeshComposerPart[] => {
  const parts: MeshComposerPart[] = []
  for (const execution of executions) {
    if (execution.operation !== 'mesh.generate') continue
    if (!execution.orderIds.includes(orderId)) continue
    const meshOutput = execution.outputs.find(output => output.mediaType === 'mesh')
    if (!meshOutput) continue
    const partImage = execution.inputAssets?.find(asset => asset.mediaType === 'image')
    parts.push({
      assetId: meshOutput.assetId,
      ...(partImage ? {partImageAssetId: partImage.assetId} : {}),
    })
  }
  return parts
}

/**
 * The V6 compose fallback's `fullBodyImageAssetId`. Automation's own result
 * does not return a durable asset id for the original image (only
 * `orderId`/`projectId`/`url`/`runId`), so this reads it back off the part
 * images' own `sourceAssetId` (each part image's own upstream source is the
 * original full-body photo it was cropped from) — the same field
 * `composerInputFromRun`'s mesh.generate part-field allowlist tracks.
 */
export const resolveFullBodyImageAssetId = (
  executions: CanvasExecution[],
  orderId: string,
): string | undefined => {
  for (const execution of executions) {
    if (execution.operation !== 'mesh.generate') continue
    if (!execution.orderIds.includes(orderId)) continue
    const partImage = execution.inputAssets?.find(asset => asset.mediaType === 'image')
    if (partImage?.sourceAssetId) return partImage.sourceAssetId
  }
  return undefined
}

export type KnownErrorLike = {
  status?: number
  code?: string
  message: string
  details?: {
    meshAssetId?: string
    assetId?: string
    actualType?: string
    expectedType?: string
  }
}

/**
 * Actionable next steps appended to (never replacing) a known
 * `AssetHubApiError`'s own message. Matches on `error.code`/`error.details`
 * first — `PART_IMAGE_REQUIRED` and `ASSET_WRONG_MEDIA_TYPE` are confirmed
 * `/mesh/compose` error codes (assethub-web PR #8179) with a structured
 * `details` payload. Falls back to matching on message content for a server
 * that has not shipped those codes yet (e.g. today's deployed API, where
 * the same failures still surface as a plain `404 ASSET_NOT_FOUND` or a
 * generic validation message — "Asset not found" is quoted directly from
 * the originally reported failure). `ASSET_NOT_FOUND` itself (asset does
 * not exist / isn't yours) is left alone; it is not one of these cases.
 */
export const errorHintFor = (error: KnownErrorLike): string | undefined => {
  if (error.code === 'PART_IMAGE_REQUIRED') {
    const meshAssetId = error.details?.meshAssetId ?? '<mesh-asset-id>'
    return `pass --part ${meshAssetId}:<part-image-asset-id>, or regenerate with mesh generate --derived-from-run <split-run-id>`
  }
  if (error.code === 'ASSET_WRONG_MEDIA_TYPE') {
    const {assetId, actualType, expectedType} = error.details ?? {}
    if (expectedType === 'mesh' && actualType === 'image') {
      return `asset ${assetId ?? '<asset-id>'} is an image; run mesh generate (or production run --image) first`
    }
    return `asset ${assetId ?? '<asset-id>'} has the wrong type: expected ${expectedType ?? 'unknown'}, got ${actualType ?? 'unknown'}`
  }

  const message = error.message.toLowerCase()
  if (message.includes('asset not found') || message.includes('not found')) {
    return 'compose expects a mesh part asset id, not an image asset — run `mesh generate` (or `production run --image <file|assetId>`) first, then compose the resulting mesh asset ids'
  }
  if (
    message.includes('part image') ||
    message.includes('partimageassetid') ||
    message.includes('full body image') ||
    message.includes('fullbodyimageassetid')
  ) {
    return "pass `--part <mesh-asset-id>:<part-image-asset-id>` on `composer run`/`composer refine` to attach each part's source image (or use `production run --image ... --compose v6`, which pairs them automatically)"
  }
  return undefined
}

/** Appends an error hint to `error.message` in place, if one applies. */
export const withErrorHint = <T extends Error & {message: string}>(error: T): T => {
  const hint = errorHintFor(error)
  if (hint) error.message = `${error.message} (${hint})`
  return error
}

/** Condensed, human-readable lines for `runs get --summary`. */
export const formatExecutionSummaryLines = (execution: CanvasExecution): string[] => {
  const lines = [
    `runId: ${execution.runId}`,
    `operation: ${execution.operation}`,
    `status: ${execution.status}`,
    `canvas: ${execution.canvas.id}`,
  ]
  if (execution.orderIds.length) lines.push(`orders: ${execution.orderIds.join(', ')}`)
  lines.push(
    `credits: reserved=${execution.usage.reservedCredits ?? '-'} charged=${execution.usage.chargedCredits ?? '-'}`,
  )
  const output = execution.outputs[0]
  lines.push(`output: ${output ? output.assetId : '-'}`)
  if (execution.error) lines.push(`error: ${execution.error.code}: ${execution.error.message}`)
  return lines
}
