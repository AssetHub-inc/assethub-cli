# @assethub/api-client

Typed client for the public AssetHub API.

## Personal API keys

Use `createAssetHubClient({apiKey, workspaceId})` with an `ah_pat_` personal key.
The client sends `X-AssetHub-Workspace` on JSON and streaming requests, including
canvas and historical asset operations. The server enforces current membership,
workspace scope, and read/write permissions; the key does not grant account,
member, or key administration.

Discover accessible workspaces with `createWorkspaceClient({accessToken: apiKey})`
and `.list({query, limit, cursor})` (limit 1–100). Personal responses include
`authentication: 'personal'` and an optional `nextCursor`. `.select(workspaceId)`
validates access and returns the selected `workspace`; it does not alter a browser
session. Workspace keys and user access tokens retain their existing behavior.

## Historical assets

Scoped to the API key workspace:
`client.v2.listMeshes({query, cursor, limit})`, `listGraphs({cursor, limit})`,
and `getGraph(graphId, {source, artifactId, direction, depth})` read existing UI
assets and graphs. Use `getAsset(assetId)` for a signed mesh download URL.
Continue pagination until `nextCursor` is null, even after an empty graph page.
Generated graphs read the current authoritative head; uploaded graphs use
`source: 'upload'`. A graph export retains blob references, not downloaded bytes.

## Recorded canvas executions

Discover availability with `client.v2.getCapabilities()`. Create a canvas with
`createCanvas({name}, {idempotencyKey: operationUuid})`, then pass
`executionContext: {canvasId, clientOperationId, source: 'api'}` to `generateImage`
or `generateMesh`, with the same `clientOperationId` as `idempotencyKey`.
Responses retain existing fields and add `execution`. Poll `getRun(runId)` for
durable outputs; `listCanvasRuns`, `getCanvasGraph`, and the evaluation submission/
list/get methods use the same owner-scoped records. `getRun` accepts an AbortSignal.

Existing generation requests without context keep their previous behavior.
Canvas execution is available to authenticated users with access to the selected workspace; unavailable evaluators
are explicitly reported by capability discovery. External evaluation reports are agent submissions,
not human approval or server-verified judgments.

Native Composer refinement uses `client.v2.getMeshRefinementModes()` for the
available mode policies and `client.v2.refineMesh({...}, {idempotencyKey})` for
durable execution. Supply every part's ten-number transform and an instruction;
the returned `execution.operation` is `mesh.refine`, and incomplete native results
use `status: 'needs_review'`. A refinement receipt can carry the final
`composition.parts`, `composition.transforms`, `composition.referenceTransform`,
and a `refinement` report.

```ts
import {createAssetHubClient} from '@assethub/api-client'

const client = createAssetHubClient({
  apiKey: process.env.ASSETHUB_API_KEY!,
})

const models = await client.v2.listModels()

const segmented = await client.v2.segment({
  source: {resourceId: '<mesh-resource-id>'},
  granularity: 'balanced',
})
const result = await client.v2.pollJob(segmented.jobId)

for await (const event of client.v2.editImage({
  source: {resourceId: '<image-resource-id>'},
  goalId: 'Clean Up',
})) {
  console.log(event)
}
```

Texture generation defaults to Tripo when `modelId` is omitted. Select Meshy
Retexture with exactly one style input: `style_prompt` or `referenceSource`.
Meshy `texture_quality: 'extreme'` produces 8K and bills its higher-quality plan;
`detailed` is the 4K default. Discover current prices through the model catalog.

```ts
const textured = await client.v2.texture({
  source: {resourceId: '<mesh-resource-id>'},
  modelId: 'meshProcess.meshy_retexture',
  style_prompt: 'Weathered bronze with subtle patina',
  texture_quality: 'extreme',
  pbr: true,
})
const textureResult = await client.v2.pollJob(textured.jobId)

// Alternatively, use a completed image upload as the style reference.
const referenced = await client.v2.texture({
  source: {resourceId: '<mesh-resource-id>'},
  modelId: 'meshProcess.meshy_retexture',
  referenceSource: {uploadId: '<completed-image-upload-id>'},
})
const referencedResult = await client.v2.pollJob(referenced.jobId)
```

`textureQuality` remains an alias of `texture_quality`; if both are supplied,
they must match. `source` and `referenceSource` accept `uploadId`, `resourceId`,
`fileRef`, or `url`.

NDJSON workflow methods throw `AssetHubWorkflowError` when a failure arrives
inside an HTTP 200 stream, so callers do not have to mistake stream acceptance
for completed generation.

The client only talks to the public `/api/v1` and `/api/v2` surfaces. It must
not import AssetHub server internals, database clients, or private app modules.

Production automation accepts `writeToCanvas: true`, `config.meshCompare.models`
(up to six model IDs), and `config.cleanup.prompt` when `cleanBackground` is
enabled. Prefer `config.autoCompose: false` to disable composition; the legacy
`config.meshCompare.autoCompose: false` remains supported when the top-level
switch is omitted. Neither client inserts a composition default.

## Reusable project context and moodboards

`v2.importCanvasAsset`, `getCanvasContext` and `putCanvasContext` manage owned
references and versioned context. `generateImage` accepts `projectContext` and
`moodboardRevisionId` with a matching executionContext; saved run inputs retain
the context hash and reference IDs. Native moodboard CRUD/analysis methods remain
internal actor gated. `languageText` and `languageVision` use the existing public
text/vision routes and accept an idempotency key for safe response recovery.


Account-authenticated team membership is available through `createWorkspaceClient`:
`listMembers(workspaceId)`, `inviteMember(workspaceId, {email, role, resend?})`,
`setMemberRole(workspaceId, {userId, role})`, and `removeMember(workspaceId, userId)`.
These calls use a user access token, preserve workspace MFA proofs, and never
retry mutations automatically. See the CLI README for permissions and email recovery.

### Canvas handoff export (staged)

```ts
const handoff = await client.v2.exportCanvas(42, {mesh: 'mesh_123'})
```

Omit `mesh` to include the owned canvas's visible assets and recorded ancestors.
`CanvasExport` supplies signed file URLs, safe generation steps, missing-evidence
warnings and an explicit `truncated` indicator. This reads UI and API history;
canvas wiring does not establish actual mesh inputs. URLs expire after one hour.
The `workflow_canvas_handoff_enabled` gate controls the additive route.
