import {AssetHubApiError, type AssetHubClient} from '@assethub/api-client'
import {CliExecutionError} from './execution.js'

type RoutingWorkbench = {
  state: {
    revision: string
    models: Record<string, string>
    previousModels: Record<string, string> | null
  }
  presets: Record<string, Record<string, string>>
  roles: Record<string, unknown>
  creditPlans: {text: number; vision: number}
}

const comparisonId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error(
      'Persist a comparison UUID as "id" in --input-json; reuse that same input to resume',
    )
  return value
}

/** Uses the native Internal API: no paid retries, polling, or automatic adoption. */
export async function runModelRoutingCommand({
  client,
  command,
  input,
  id,
  preset,
  role,
  model,
  dryRun = false,
  beforeSubmit,
}: {
  client: Pick<AssetHubClient, 'request'>
  command: string
  input?: Record<string, unknown>
  id?: string
  preset?: string
  role?: string
  model?: string
  dryRun?: boolean
  beforeSubmit?: (receipt: {id: string; credits: number}) => void
}): Promise<unknown> {
  const request = async (path: string, body?: unknown) =>
    (
      await client.request<unknown>(
        'v2',
        path,
        body === undefined
          ? {signal: AbortSignal.timeout(30_000)}
          : {
              method: 'POST',
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(
                path === '/models/comparisons' ? 300_000 : 120_000,
              ),
            },
      )
    ).data
  if (dryRun && !['apply', 'set', 'rollback'].includes(command))
    throw new Error('--dry-run is only supported for apply, set and rollback')
  if (command === 'routing') return request('/models/routing')
  if (command === 'apply') {
    if (Boolean(input) === Boolean(preset))
      throw new Error(
        'models apply requires exactly one of --input-json or --preset',
      )
    if (input) return dryRun ? input : request('/models/routing', input)
  }
  if (['apply', 'set', 'rollback'].includes(command)) {
    const {state, presets, roles} = (await request(
      '/models/routing',
    )) as RoutingWorkbench
    let models: Record<string, string>
    if (command === 'rollback') {
      if (state.previousModels === null)
        throw new Error('No previous routing profile to restore')
      models = state.previousModels
    } else if (command === 'set') {
      if (!role || !model || !Object.hasOwn(roles, role))
        throw new Error(
          `Use models set <role> <model-id|default>; roles: ${Object.keys(roles).join(', ')}`,
        )
      models = {...state.models}
      if (model === 'default') delete models[role]
      else models[role] = model
    } else {
      if (!preset || (preset !== 'legacy' && !Object.hasOwn(presets, preset)))
        throw new Error(
          `Unknown preset; available: legacy, ${Object.keys(presets).join(', ')}`,
        )
      models =
        preset === 'legacy'
          ? {}
          : {
              ...presets[preset]!,
              ...(state.models.image_default
                ? {image_default: state.models.image_default}
                : {}),
            }
    }
    const update = {
      expectedRevision: state.revision,
      models,
    }
    if (dryRun) return update
    // Reapplying an identical selection must preserve the previous profile for rollback.
    if (
      Object.keys(models).length === Object.keys(state.models).length &&
      Object.entries(models).every(
        ([key, value]) => state.models[key] === value,
      )
    )
      return state
    return request('/models/routing', update)
  }
  if (command === 'comparison')
    return request(`/models/comparisons/${comparisonId(id)}`)
  if (command === 'compare') {
    const savedId = comparisonId(input?.id)
    const {creditPlans} = (await request('/models/routing')) as RoutingWorkbench
    const credits =
      Array.isArray(input?.imageAssetIds) && input.imageAssetIds.length > 0
        ? creditPlans.vision
        : creditPlans.text
    if (!Number.isFinite(credits) || credits < 0)
      throw new Error('Native comparison credit total is unavailable')
    beforeSubmit?.({id: savedId, credits})
    try {
      return await request('/models/comparisons', input)
    } catch (error) {
      if (
        error instanceof AssetHubApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        throw error
      throw new CliExecutionError(
        `Comparison ${savedId}: submission outcome is uncertain; run models comparison ${savedId} before reusing the identical saved input.`,
        3,
        undefined,
        undefined,
        undefined,
        {cause: error},
      )
    }
  }
  throw new Error('Use models routing|apply|set|rollback|compare|comparison')
}

/** Pending or uncertain work must never look like a passing development check. */
export function routingComparisonExitCode(receipt: unknown): 0 | 1 | 3 {
  const arms =
    receipt && typeof receipt === 'object' && 'arms' in receipt
      ? receipt.arms
      : undefined
  if (!Array.isArray(arms) || arms.length !== 2)
    throw new Error('Invalid comparison receipt: expected two arms')
  const statuses = arms.map((arm: unknown) =>
    arm && typeof arm === 'object' && 'status' in arm ? arm.status : undefined,
  )
  if (statuses.some(status => status !== 'succeeded' && status !== 'failed'))
    return 3
  return statuses.includes('failed') ? 1 : 0
}
