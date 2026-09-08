/**
 * THE ONE PLACE the Production Control run-upload wire contract lives.
 *
 * The backend for these routes is being built in parallel. Everything the CLI
 * knows about *where* to send bytes and *how big* they may be is in this file,
 * so a late change on the server side is a one-line edit here rather than a
 * sweep through the transport.
 *
 * Route shape mirrors the Cloudflare ag-registry Worker
 * (assethub-ml research/artifact-graph/cloud/registry-worker/src/worker.js)
 * because the payloads are the same `ag.registry.v1` documents. Only the prefix
 * and the transport envelope differ: these live on AssetHub's public v2 API
 * surface, behind `withExposedApi()` + API-key auth, so they speak AssetHub's
 * `{success, data}` / `{success, error}` envelope rather than
 * `ag.registry-error.v1`.
 */

/** Change this one line if the backend lands on a different prefix. */
export const CONTROL_RUN_UPLOAD_API_PREFIX = '/api/v2/production/run-uploads'

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

export type ControlRunUploadUrls = {
  /** POST — register the graph. Required before any blob or snapshot lands. */
  graphs: string
  /** PUT — the `ag.registry-push.v1` envelope. */
  snapshot: (graphId: string) => string
  /** HEAD (does the pool already hold these bytes?) / PUT (send them). */
  blob: (graphId: string, blobKey: string) => string
}

export const controlRunUploadUrls = (baseUrl: string): ControlRunUploadUrls => {
  // Matches @assethub/api-client's own URL construction: trim the trailing
  // slash and append, so a base URL carrying a path prefix keeps it.
  const prefix = `${trimTrailingSlash(baseUrl)}${CONTROL_RUN_UPLOAD_API_PREFIX}`
  return {
    graphs: `${prefix}/graphs`,
    snapshot: graphId => `${prefix}/graphs/${encodeURIComponent(graphId)}/snapshot`,
    blob: (graphId, blobKey) =>
      `${prefix}/blobs/${encodeURIComponent(graphId)}/${encodeURIComponent(blobKey)}`,
  }
}

/**
 * Server-enforced ceilings, checked locally so a doomed run is rejected before
 * the first byte leaves rather than after N blobs have already landed.
 *
 * The `ag.registry.v1` format allows far more (64 MiB graph arrays, 2 MiB
 * manifest). These smaller numbers are the real ceiling: the routes run on
 * Vercel Serverless, whose request-body limit bites first.
 */
export const CONTROL_MAX_BLOB_BYTES = 4 * 1024 * 1024
export const CONTROL_MAX_PUSH_BYTES = 4 * 1024 * 1024

/** Format-level ceilings from the registry contract, checked for completeness. */
export const REGISTRY_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
export const REGISTRY_MAX_GRAPH_ARRAY_BYTES = 64 * 1024 * 1024
export const REGISTRY_MAX_METADATA_BYTES = 256 * 1024

/**
 * Error codes the routes answer with. Values follow AssetHub's public-API
 * SCREAMING_SNAKE convention; the semantics follow the registry's.
 */
export const CONTROL_ERROR_CODES = {
  /** 409 — the snapshot references bytes the pool does not hold yet. */
  missingBlobs: 'MISSING_BLOBS',
  /** 409 — same rev, different graphHash. A genuine divergence. */
  snapshotConflict: 'SNAPSHOT_CONFLICT',
  /** 409 — the server already holds a newer rev. Desired end state, not a failure. */
  staleSnapshot: 'STALE_SNAPSHOT',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  /** 404 — the graph was never registered by this org. Distinct from "no access". */
  notRegistered: 'NOT_REGISTERED',
} as const

/**
 * These routes are internal-only. An API key whose owner is not an internal
 * user, or whose org lacks the Production Control entitlement, gets 404 rather
 * than 403 — the path's existence is itself not disclosed.
 */
export const CONTROL_NOT_ENTITLED_STATUS = 404
