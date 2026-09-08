/*
 * GENERATED FILE — DO NOT EDIT.
 *
 * Emitted from the zod contract in @assethub/production-contracts by
 * scripts/gen-api-client-types.ts. Regenerate with:
 *
 *   aube --filter @assethub/production-contracts run gen:api-client-types
 *
 * An edit here is a lie the published client tells about what the server
 * accepts: the route validates with the same zod schema this file was
 * generated from. A drift test in the contract package fails CI when the two
 * disagree.
 */

/** One human (or upstream-agent) decision about a production run's inputs. */
export type Intervention =
  | PartAddIntervention
  | PartRenameIntervention
  | PartExcludeIntervention
  | PartIncludeIntervention
  | PartRejectIntervention
  | PartRegenerateIntervention
  | ParamsSetIntervention

export type InterventionOp = Intervention['op']

/** Every op the contract accepts, in the order they are documented. */
export const INTERVENTION_OPS = [
  'part.add',
  'part.rename',
  'part.exclude',
  'part.include',
  'part.reject',
  'part.regenerate',
  'params.set',
] as const satisfies readonly InterventionOp[]

export type PartAddIntervention = {
  op: 'part.add'
  name: string
}

export type PartRenameIntervention = {
  op: 'part.rename'
  targetId: string
  name: string
}

export type PartExcludeIntervention = {
  op: 'part.exclude'
  targetId: string
}

export type PartIncludeIntervention = {
  op: 'part.include'
  targetId: string
}

export type PartRejectIntervention = {
  op: 'part.reject'
  targetId: string
  reason?: string
}

export type PartRegenerateIntervention = {
  op: 'part.regenerate'
  targetId: string
  mode: string
}

export type ParamsSetIntervention = {
  op: 'params.set'
  patch: {
    imageModel?: string
    views?: 'single' | 'multiview'
    styleTarget?: string
  }
}
