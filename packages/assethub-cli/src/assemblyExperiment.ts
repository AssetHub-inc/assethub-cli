/**
 * Client-side validation for the internal-only `assemblyExperiment` body field
 * of `production analyze` (V4 Character Assembly). Mirrors the server schema in
 * `apps/frontend/src/feature/artifactGraph/util/assemblyExperiment.ts`; the
 * server remains the authority, this only fails fast before a paid request.
 */
export const GARMENT_FIT_FLAGS = [
  'wearGraph',
  'proportionLock',
  'measuredGates',
  'penetrationRepair',
  'protectDetail',
  'depthGate',
  'armatureFit',
  'disableRingFit',
] as const

export const MODEL_ROLES = ['planner', 'review', 'qaEscalation'] as const

export const PART_COUNT_VALUES = ['few', 'default', 'detailed'] as const

export const V5_START_VALUES = ['placement', 'fit'] as const

export type AssemblyExperimentInput = {
  partCount?: (typeof PART_COUNT_VALUES)[number]
  v5Assembler?: boolean
  v5Start?: (typeof V5_START_VALUES)[number]
  garmentFit?: Partial<Record<(typeof GARMENT_FIT_FLAGS)[number], boolean>>
  models?: Partial<Record<(typeof MODEL_ROLES)[number], string>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
) => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0)
    throw new Error(
      `--assembly-experiment: unknown key(s) in ${where}: ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`,
    )
}

const validate = (json: unknown): AssemblyExperimentInput => {
  if (!isRecord(json))
    throw new Error('--assembly-experiment must be a JSON object')
  assertKeys(
    json,
    ['garmentFit', 'models', 'v5Assembler', 'v5Start', 'partCount'],
    'the root object',
  )
  const out: AssemblyExperimentInput = {}
  if (json.garmentFit !== undefined) {
    if (!isRecord(json.garmentFit))
      throw new Error('--assembly-experiment: garmentFit must be an object')
    assertKeys(json.garmentFit, GARMENT_FIT_FLAGS, 'garmentFit')
    for (const [flag, value] of Object.entries(json.garmentFit))
      if (typeof value !== 'boolean')
        throw new Error(
          `--assembly-experiment: garmentFit.${flag} must be true or false`,
        )
    out.garmentFit = {...(json.garmentFit as Record<string, boolean>)}
  }
  if (json.models !== undefined) {
    if (!isRecord(json.models))
      throw new Error('--assembly-experiment: models must be an object')
    assertKeys(json.models, MODEL_ROLES, 'models')
    for (const [role, value] of Object.entries(json.models))
      if (typeof value !== 'string' || value.length === 0)
        throw new Error(
          `--assembly-experiment: models.${role} must be a non-empty model id`,
        )
    out.models = {...(json.models as Record<string, string>)}
  }
  if (json.v5Assembler !== undefined) {
    if (typeof json.v5Assembler !== 'boolean')
      throw new Error(
        '--assembly-experiment: v5Assembler must be true or false',
      )
    out.v5Assembler = json.v5Assembler
  }
  if (json.v5Start !== undefined) {
    if (
      typeof json.v5Start !== 'string' ||
      !(V5_START_VALUES as readonly string[]).includes(json.v5Start)
    )
      throw new Error(
        `--assembly-experiment: v5Start must be one of ${V5_START_VALUES.join(', ')}`,
      )
    out.v5Start = json.v5Start as (typeof V5_START_VALUES)[number]
  }
  if (json.partCount !== undefined) {
    if (
      typeof json.partCount !== 'string' ||
      !(PART_COUNT_VALUES as readonly string[]).includes(json.partCount)
    )
      throw new Error(
        `--assembly-experiment: partCount must be one of ${PART_COUNT_VALUES.join(', ')}`,
      )
    out.partCount = json.partCount as (typeof PART_COUNT_VALUES)[number]
  }
  return out
}

/**
 * Combine `--assembly-experiment <json>` and `--garment-fit a,b` (sugar for
 * `{garmentFit: {a: true, b: true}}`). The sugar wins on a per-flag conflict.
 * `--part-count` must agree with any explicit JSON partCount.
 * Returns undefined when no input is given so the request stays byte-identical.
 */
export const buildAssemblyExperiment = ({
  json,
  garmentFit,
  partCount,
}: {
  json?: unknown
  garmentFit?: string
  partCount?: string
}): AssemblyExperimentInput | undefined => {
  if (json === undefined && garmentFit === undefined && partCount === undefined)
    return undefined
  const base = json === undefined ? {} : validate(json)
  if (partCount !== undefined) {
    if (!(PART_COUNT_VALUES as readonly string[]).includes(partCount))
      throw new Error(
        `--part-count must be one of ${PART_COUNT_VALUES.join(', ')}`,
      )
    if (base.partCount !== undefined && base.partCount !== partCount)
      throw new Error(
        '--part-count conflicts with --assembly-experiment partCount',
      )
    base.partCount = partCount as (typeof PART_COUNT_VALUES)[number]
  }
  if (garmentFit === undefined) return base
  const names = garmentFit
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0)
  if (names.length === 0)
    throw new Error('--garment-fit needs at least one flag name')
  const unknown = names.filter(
    name => !(GARMENT_FIT_FLAGS as readonly string[]).includes(name),
  )
  if (unknown.length > 0)
    throw new Error(
      `--garment-fit: unknown flag(s) ${unknown.join(', ')} (allowed: ${GARMENT_FIT_FLAGS.join(', ')})`,
    )
  return {
    ...base,
    garmentFit: {
      ...base.garmentFit,
      ...Object.fromEntries(names.map(name => [name, true])),
    },
  }
}
