# @assethub/cli

Command line interface for AssetHub.

## Personal API keys

Log in once with a personal key (`ah_pat_`), then select its workspace:

```sh
assethub auth login --api-key-stdin --profile personal
assethub workspace list --query Studio --limit 25
assethub workspace use <workspace-id>
assethub capabilities
assethub mesh list --workspace <other-workspace-id>
```

Login verifies account identity through workspace discovery, including when
`--skip-verify` is supplied. `workspace use` validates access and saves the workspace
in the same profile with the same key. It does not issue keys or change browser
sessions. Pass `--cursor <nextCursor>` for another workspace list page.

`--workspace` overrides the saved selection for one command, including diagnostics,
MCP discovery, history, and run recovery. Recovery still rejects an operation saved
in another workspace. Personal profiles take precedence over environment API
credentials and origins; explicit `--api-key` uses the supplied key and requires
`--workspace` for scoped API commands. Saved personal credentials cannot be sent
to another origin through `--base-url` alone.

Keys are limited by their workspace and read/write scopes and current account
permissions. Account, member, and API-key administration require user-session
authentication. Existing workspace keys and user-token login remain supported.

## Connection diagnostics and MCP

```sh
assethub --version
assethub doctor --mcp --profile my-workspace
assethub mcp config --client cursor
assethub mcp config --client codex
```

`doctor` checks API access and the authenticated workspace. `--mcp` also checks
MCP initialization and tool discovery, without invoking any tool or generating
assets. It returns JSON and exit 0 when checks pass, or exit 2 with a diagnostic
and next step when a check fails. The default total timeout is 15 seconds; change
it with `--timeout-ms`. Hosted MCP accepts workspace and personal API keys; personal keys also require
a selected workspace. Account operations use a separate user access token.

`mcp config` outputs a Cursor JSON object or Codex TOML section to merge into
existing user settings. It reads saved profile selection and does not write files
or include your saved API key in the output.
The generated settings read `ASSETHUB_API_KEY` from the AI client's environment.
Use the same key as your CLI profile. Personal profiles include the selected
`X-AssetHub-Workspace` header; `--workspace` overrides it in the generated settings.
For a different API origin, pass
`--base-url https://your-host/prefix` (HTTP is accepted only for localhost).

Explicit `--profile` uses that profile's key and origin, ahead of environment
variables, including user tokens and workspace MFA proofs. A missing profile fails.
Without an explicit profile, a personal profile or a workspace selected with
`workspace use` takes precedence over environment API credentials; otherwise the environment key
precedes the saved default. `--api-key` and `--base-url` remain
explicit overrides. `auth logout` removes the selected saved profile (or the
saved default); environment credentials remain under your shell’s control.
Diagnostics omit API keys and raw server error bodies.

## Historical meshes and artifact graphs

Lists are scoped to the selected workspace, including assets created in the UI. Mesh search
includes parts, revisions, and archived meshes, and excludes samples.

```sh
assethub mesh list --query "helmet" --limit 25
assethub mesh get mesh_123
assethub mesh download mesh_123 --out-dir ./meshes
assethub graph list --limit 25
assethub graph show --graph "$GRAPH_ID"
assethub graph export --graph "$GRAPH_ID" --out ./graph.json
assethub graph lineage --graph "$GRAPH_ID" --artifact "$NODE_ID" --direction ancestors
```

Pass each `nextCursor` as `--cursor` until it is null; a graph page can be empty
while its cursor advances past duplicates. Graph catalogs include generated and
uploaded graphs. Use `--source upload` to read uploaded snapshots. Graph exports
contain the full saved graph and blob references; they do not download blob bytes.
`--canvas` keeps the existing CLI/API execution history view and cannot be combined
with `--graph`. Mesh IDs returned by search can be passed to `composer run`.

## Agent generation with canvas history

Canvas execution is available to authenticated users with access to the selected workspace. Run `assethub capabilities`
first. Image, mesh, parts split, and production analyze/execute/automation refuse to dispatch if canvas history is unavailable.
The current public API remains compatible with clients that omit `executionContext`.

```sh
assethub image generate --prompt "small stylized robot" --agent my-agent --wait > image.json
CANVAS_ID=$(jq -r '.execution.canvas.id' image.json)
IMAGE_ASSET_ID=$(jq -r '.execution.outputs[0].assetId' image.json)
IMAGE_RUN_ID=$(jq -r '.execution.runId' image.json)
assethub mesh generate --source-id "$IMAGE_ASSET_ID" --canvas "$CANVAS_ID" \
  --derived-from-run "$IMAGE_RUN_ID" --agent my-agent --wait > mesh.json
assethub graph show --canvas "$CANVAS_ID"
assethub runs list --canvas "$CANVAS_ID"
assethub canvas open "$CANVAS_ID"
```

Without `--canvas`, the first generation creates one canvas per real working
directory, API origin and organization. `canvas use <id>` changes the selection.
An inaccessible selected canvas is an error; the CLI does not silently make another.
`canvas open` prints JSON and opens a browser only in a terminal.

Each generation returns `execution` with the canvas URL, run/job IDs, stable output
asset IDs, history status, and credit usage when available. History persists while
all browsers are closed. Uploaded images are promoted to owned durable assets.
Use `--input-json @request.json` for a complete request, or the existing file/stdin/
source flags. A `source create` or `files import` JSON response can be passed to
`--source-json @source.json`; generated asset IDs can be passed to `--source-id`.

The CLI saves each request before dispatch under `~/.assethub/state/operations`
(or `ASSETHUB_CLI_STATE_DIR`). Those files contain inputs, never API keys. Keep the
state directory private. `--operation-id <uuid>` supplies an operation identity;
retries and `runs resume <operation-id>` reuse its identical body and key. A new
candidate needs a new operation ID. `runs watch <run-id>` only reads status.

Internal preview: continue mesh generation and composition on native canvas nodes without uploading
their source images or parts again:

```sh
assethub canvas nodes --canvas 42
assethub mesh generate --canvas 42 --node shape:production --wait
assethub composer run --canvas 42 --node shape:production --wait
```

Use the exact `nodeId` returned by discovery. `--node` resolves saved inputs and
settings on the server and writes results to that node's UI history. Mesh nodes
accept optional `--model-id` and `--params-json` overrides; composition accepts
`--model` and `--mode`. Explicit source/part/reference flags and `--input-json`
cannot accompany `--node`. The existing `--from-node` flag reads Artifact Graph
lineage and does not select a UI node.

For a Production3D node, mesh generation submits its eligible saved child nodes,
skipping parts already complete or generating. Each child has its own receipt.
The batch operation ID is printed before submission and its target list is saved
under `state/node-batches`. Resume a partial batch with `runs resume <operation-id>`
or repeat the command with the same `--operation-id`; this reuses the original
targets and request keys even if the canvas changes. Composer accepts either the
Production3D node or its Part Composer node and reuses the linked parts/reference.
CLI-created graph Productions are discoverable before a browser opens the canvas.
Composer uses its saved Quick, Quick + Agent, Agent only or Turntable setting.
Agent completion returns an editable scene as `needs_review`; it does not export
a new combined mesh until the user reviews and exports it.
Native node actions require the server's `api_canvas_native_nodes` feature gate.

stdout contains final JSON; stderr contains progress. Exceptions: `--version` prints the version, and `mcp config` prints the requested configuration. Exit codes are 0 for accepted/
completed, 1 for terminal failure/partial, 2 for input/auth/capability/budget errors,
3 for timeout/history pending/needs review, and 130 for Ctrl-C. Timeout and Ctrl-C
leave server execution running and return known identities.

External agents can evaluate downloaded artifacts with their own tools and store
an assessment without starting another model call:

```sh
assethub evaluations submit --canvas "$CANVAS_ID" --artifact "$IMAGE_ASSET_ID" \
  --report ./evaluation.json --agent my-agent --require-pass
assethub evaluations list --canvas "$CANVAS_ID"
assethub graph lineage --canvas "$CANVAS_ID" --artifact "$IMAGE_ASSET_ID"
assethub graph export --canvas "$CANVAS_ID" --out ./graph.json
```

`evaluation.json` requires the strict report fields `schemaVersion`,
`rubric`, `verdict: pass|fail|needs_review`, `criteria`, `referenceAssetIds`, and
`evidenceAssetIds` for comparable reports. The server records `agent_submission`
and authenticated actor provenance. This never counts as human approval.
`--require-pass` returns 1 for fail and 3 for missing/needs-review verdicts.

For example, an agent that has not inspected the output yet can submit:

```json
{
  "schemaVersion": "assethub.evaluation-submission.v1",
  "rubric": {"id": "asset-quality", "version": "1"},
  "verdict": "needs_review",
  "criteria": [
    {
      "id": "visual-quality",
      "verdict": "needs_review",
      "reason": "Artifact inspection is pending."
    }
  ],
  "referenceAssetIds": [],
  "evidenceAssetIds": []
}
```

Replace the verdict and reason with the actual assessment after inspecting the
artifact; reference and evidence IDs must belong to the authenticated organization.

Existing parts commands use the same canvas and durable operation storage:

```sh
assethub parts split --source-id "$IMAGE_ASSET_ID" --canvas "$CANVAS_ID" --part-extractor V1.5 --wait
# Select only the parts to execute; --all-ready selects all ready tasks.
assethub parts split --source-id "$IMAGE_ASSET_ID" --canvas "$CANVAS_ID" --part-extractor V1.5 --all-ready --wait
# Internal graph versions run the complete split through one analyze receipt.
assethub production agents
assethub parts split --source-id "$IMAGE_ASSET_ID" --canvas "$CANVAS_ID" --part-extractor V3.6.1 --all-ready --wait
# CLI 0.1.20+: existing Internal V3.6.5 and Pluffy models; check server availability first.
assethub parts split --source-id "$IMAGE_ASSET_ID" --canvas "$CANVAS_ID" --part-extractor V3.6.5 --all-ready --wait
assethub production analyze --source-id "$IMAGE_ASSET_ID" --canvas "$CANVAS_ID" --part-extractor pluffy --wait
assethub production automation --canvas "$CANVAS_ID" --input-json @batch.json --wait
```

`parts split` keeps separate analysis and selected-part execution phases. Each phase
has its own saved operation ID, with the execution linked to the analysis run.
For Internal `V3.6.1` (`V3.6.1 Primary Images First`), `V3.6.3`
(`V3.6.3 Fast Analysis`, CLI 0.1.16+), `V3.6.4`
(`V3.6.4 Fast Analysis`, CLI 0.1.17+), `V3.6.5 Primary Images` and
`Chibi Character (Pluffy) v3.1` (both CLI 0.1.20+), analysis runs the complete
Artifact Graph split. `--all-ready` waits for that one receipt and does not start a
second production execution. Resume an interrupted graph split with
`runs resume <operation-id>`; `--task-id`, `--mission-id`,
`--part-extraction-mode`, and classic `--order-id` continuation are unsupported.
Automation runs the existing complete batch pipeline, including mesh generation;
its `images[]` share the selected canvas. `batch.json` uses the existing automation
request shape, including `agentVersion`, `images` (owned `imageAssetId`, `uploadId`,
or an `imageUrl` to import), `config`, and optional `maxCostCredits`.
An uncertain Trigger acknowledgement remains recoverable as `needs_review` with
pending history; retrying the same operation never silently launches another run.

`evaluate list` discovers server evaluators. Server evaluation dispatch is currently
unavailable. Graph exports are bounded to 100 runs/evaluations and 1,000 nodes;
truncated exports require `--allow-truncated`. Other commands, including production run/intervene, rig and retopology,
retain their existing API behavior and do not yet create these receipts.
`autopilot --demo` is an experimental demo requiring the AssetHub monorepo and its unpublished development dependency `@assethub/autopilot-core`. Standalone project workflow commands do not require or install it. Autonomous budgeted improvement is a later stage.

## Storyboard project workflow

These API-key commands work from the standalone CLI. Canvas/context commands use
`api_canvas_execution`; native moodboards additionally require an internal actor
with `moodboard_style_reference_enabled`. Select a key belonging to the intended
workspace before uploading source material. API keys are never part of context.

```sh
# No API key is needed for local extraction. Optional dependencies are reported.
assethub project ingest ./client-sources --out-dir ./extracted --exclude-dir generated
assethub canvas create --name "Storyboard scene study" > canvas.json
CANVAS_ID=$(jq -r .id canvas.json)
assethub canvas import --canvas "$CANVAS_ID" --file ./extracted/storyboard.png > storyboard.json
assethub canvas import --canvas "$CANVAS_ID" --file ./character-face.png > character.json
assethub canvas import --canvas "$CANVAS_ID" --file ./primary-style.png > style.json

# Supply prompt + source text + imageAssetIds in analysis-request.json.
# Keep facts, uncertain identities and proposed backgrounds separate.
assethub language vision --input-json @analysis-request.json \
  --operation-id 61e3a99c-30b7-4f41-8d57-2789ccdc7c92 --out analysis.json

# Prepare context.json from the inspected source facts and analysis.
assethub canvas context put --canvas "$CANVAS_ID" --file ./context.json --if-version 0
assethub canvas context get --canvas "$CANVAS_ID" --out ./recovered-context.json
assethub moodboard create --input-json @moodboard.json > board.json
BOARD_ID=$(jq -r .id board.json)
assethub moodboard analyze "$BOARD_ID" --wait > revision.json
REVISION_ID=$(jq -r .id revision.json)
assethub image generate --canvas "$CANVAS_ID" --context "$CANVAS_ID" \
  --moodboard-revision "$REVISION_ID" --prompt "Reconstruct this storyboard as a 3D scene" \
  --wait --download --out-dir ./generated > generated.json
SOURCE_ID=$(jq -r .assetId storyboard.json)
OUTPUT_ID=$(jq -r '.execution.outputs[0].assetId' generated.json)
assethub canvas compare --canvas "$CANVAS_ID" --source-id "$SOURCE_ID" \
  --asset-id "$OUTPUT_ID" --out ./comparison.html
assethub evaluations submit --canvas "$CANVAS_ID" --artifact "$OUTPUT_ID" \
  --report ./review.json --agent my-agent
```

`project ingest` extracts PDF text/pages, workbook cells and embedded images,
representative video frames, and image/text sources. It writes `summary.json`,
`text.md` and `images.json` with source paths, hashes and extraction metadata.
Dependencies (Poppler, ffmpeg and Python 3) are detected, never installed. Partial
extraction exits 3 and reports missing dependencies; filenames do not establish
whether a picture is a storyboard or a 3D reference. Original files stay unchanged.

A context document is an extensible JSON object:

```json
{
  "schemaVersion": 1,
  "title": "EP013 s150",
  "instructions": {
    "must": ["Preserve the original character face and pose"],
    "avoid": ["Generic replacement characters"]
  },
  "sources": [
    {
      "key": "storyboard",
      "remoteAssetId": "<owned-image-uuid>",
      "generationUse": "required"
    }
  ],
  "generationPlan": {"requiredSourceKeys": ["storyboard"]},
  "sourceFacts": [
    "Facts established by the original storyboard and story text"
  ],
  "inferences": [
    {"proposal": "Background inferred from story", "status": "proposed"}
  ],
  "reviewState": {"status": "awaiting_creator_review"}
}
```

`context get --out` writes the document for editing and reuse; stdout contains its
version/hash envelope. Updating changed content requires `--if-version N` from the
last read. Image generation pins the current version by default; `--context-version`
and repeated `--context-source` explicitly select a version and source keys. Required
references, labelled instructions and source facts are added by the server, and their
IDs/version/hash are recorded on the run. Retry an uncertain generation with
`runs resume <operation-id>` to preserve the original pinned inputs.

`moodboard.json` contains `name`, `assetIds` (maximum 12),
`representativeAssetIds` (maximum 3, all included in assetIds), and optional
`userNote`. `update <board-id> --input-json @file` creates a new immutable revision;
`get`, `list`, and `archive` manage existing boards. Analysis uses the existing
8-credit vision plan for a new attempt, resumes an active job, and reuses a ready
revision. The combined generation limit is **6 content and style images**: five identity/storyboard references leave room
for one style representative.

Image import persists upload identity before registration and recovers the same
asset after an uncertain response; `--upload-id` resumes a known completed upload.
Identical moodboard creation input uses the same operation identity; supply a fresh
`--operation-id` when intentionally creating another identical board. Language
commands require a UUID operation ID: reuse it with the same input after a timeout.

Comparisons are portable HTML with embedded image bytes and a SHA-256 provenance
sidecar. They remain `awaiting_creator_review`; an agent evaluation is not creator
approval. Native project assets and generation history are saved in AssetHub.
`canvas layout` appends native image nodes and source/output edges through the
authoritative canvas room (Internal rollout). It preserves matching existing nodes
and rejects identity collisions. `canvas import` alone preserves an asset without
changing layout. Use the owned asset IDs returned by import or generation, including `image_...` IDs.
For example, create `layout.json` with those IDs:

```json
{
  "images": [
    {
      "assetId": "<storyboard-asset-id>",
      "role": "source",
      "x": 0,
      "y": 0,
      "name": "Original storyboard"
    },
    {
      "assetId": "<generated-asset-id>",
      "role": "output",
      "x": 600,
      "y": 0,
      "name": "Generated candidate — review pending"
    }
  ],
  "connections": [
    {
      "sourceAssetId": "<storyboard-asset-id>",
      "targetAssetId": "<generated-asset-id>"
    }
  ]
}
```

```sh
assethub canvas layout --canvas "$CANVAS_ID" --input-json @layout.json
```

Legacy `workspace --internal` commands and the experimental autopilot demo are
not available in the standalone distribution. Use the authenticated public
`canvas`, `moodboard`, and `canvas context` commands described above.

```sh
export ASSETHUB_API_KEY=ah_live_xxx

assethub models list
assethub files import https://example.com/input.png --media-type image
assethub source create --file ./input.png --media-type image
assethub image generate --prompt "stylized prop concept" --wait
assethub mesh generate --file ./input.png --wait
assethub jobs watch job_123 --download --out-dir ./out/job
assethub parts split --file ./input.png --part-extractor "V1.5" --wait --all-ready --download --out-dir ./out/parts
assethub parts compare --file ./input.png --preprocess-prompt "clean white background, centered product photo" --part-extractor "V1.5" --wait --all-ready
assethub runs upload ./out/pluffy-run-2026-07-30 --dry-run
```

Uploading a local artifact-graph run:

```sh
# Validate the run folder without sending anything.
assethub runs upload ./out/pluffy-run-2026-07-30 --dry-run

# Upload it. Blobs go first, one at a time, then the snapshot.
assethub runs upload ./out/pluffy-run-2026-07-30 --tag pluffy --description "V3 humanoid"
```

`<path>` is an `ag.graph-folder.v1` folder — the directory holding
`manifest.json`, `nodes.jsonl`, `edges.jsonl` and `blobs/`. The wire format is
`ag.registry.v1`, the same document the artifact-graph registry accepts, so one
folder can be published to either destination without conversion.

- `--dry-run` runs every local check and prints what _would_ be sent. A folder
  whose manifest no longer matches its own `nodes.jsonl`, whose blob table
  disagrees with the graph, or which exceeds the per-request size ceilings is
  rejected here rather than halfway through an upload.
- Uploads are resumable. Each blob is checked against the server before it is
  sent, and blob storage is content-addressed, so re-running the identical
  command after a failure sends only what is still missing.
- `--graph-id` / `--stream-id` / `--rev` override the identity derived from the
  folder name and `manifest.source`. Re-uploading the same revision with
  different content is refused; bump `--rev` to publish a new revision.
- `--skip-register` skips the graph-registration call for a graph that already
  exists.
- Requires an internal account whose org has the Production Control
  entitlement; other keys get "cannot upload runs to Production Control".

Configuration:

- `ASSETHUB_API_KEY`: optional when a profile was saved with `auth login`.
- `ASSETHUB_API_BASE_URL`: optional, defaults to `https://app.assethub.io`.
- `ASSETHUB_CLI_CONFIG`: optional auth config path.

Agent-friendly login:

```sh
printf '%s' "$ASSETHUB_API_KEY" | assethub auth login --api-key-stdin
assethub image generate --prompt "small stylized game asset chest" --wait --download --out-dir ./out/image
assethub mesh generate --source-url https://example.com/input.png --wait --download --out-dir ./out/mesh
cat ./character.png | assethub parts split --stdin --file-name character.png --part-extractor "V1.5" --wait --all-ready --download --out-dir ./out/parts
base64 -i ./character.png | assethub parts split --stdin-base64 --file-name character.png --content-type image/png --part-extractor "V1.5" --wait --all-ready
printf '{"image_url":{"url":"data:image/png;base64,..."}}' | assethub parts split --stdin-json --part-extractor "V1.5" --wait --all-ready
assethub parts split --clipboard --file-name character.png --part-extractor "V1.5" --wait --all-ready
cat ./character.png | assethub parts compare --stdin --file-name character.png --preprocess-prompt "clean white background" --part-extractor "V1.5" --wait --all-ready
```

Agent-oriented input:

- `--file <path>` uploads a local image or mesh through the public file API.
- `--stdin --file-name <name>` accepts raw piped bytes. Give a file name with
  an extension when possible.
- `--stdin-base64 --file-name <name> --content-type <type>` accepts raw base64
  from stdin. It also accepts a full `data:*;base64,...` value.
- `--stdin-data-uri` accepts a data URI from stdin.
- `--stdin-json` accepts common agent payload shapes from stdin, including
  OpenAI-style `{"image_url":{"url":"..."}}`, Anthropic-style
  `{"source":{"type":"base64","media_type":"image/png","data":"..."}}`,
  `resourceId`, `fileRef`, `dataUri`, `base64`, `url`, and local `path`.
- `--source-json <json|@file|@->` parses the same JSON shapes from an argument,
  a file, or stdin.
- `--data-uri <uri>` accepts `data:image/png;base64,...` style inputs and uploads
  them before running the target command.
- `--clipboard` reads an image from the macOS clipboard for image inputs. It
  uses `pngpaste` when available and falls back to the system clipboard bridge.
- `--source-url`, `--source-id`/`--source-resource-id`, and `--file-ref-json`
  can be reused across image, mesh, and part extraction commands where the API
  supports them.

For Codex or other AI agents, the important contract is: if the runtime can
expose the attachment as bytes, base64, a data URI, a local path, an
OpenAI/Anthropic-style JSON object, or a URL, the CLI can consume it directly.
It does not require writing a temporary file first.

Agent-oriented output:

- stdout is one final JSON object.
- polling progress goes to stderr.
- `--download --out-dir <dir>` recursively downloads public artifact URLs from
  job or production status payloads and writes a `manifest.json`.

`assethub parts compare` runs the normal part split first. When
`--preprocess-prompt <text>` is provided, it then uses the Nano Banana image
model to generate a preprocessed image, waits for that image job to finish, and
runs a second split on the generated image. The final JSON contains `direct`
and `preprocessed` sections so agents can compare both outputs. If
preprocessing fails, the direct result is still printed with
`preprocessed.ok: false`; pass `--fail-on-preprocess-error` when a non-zero exit
is preferred. Use `--all-ready` rather than explicit `--task-id` values when
preprocessing is enabled, because the generated-image split creates a separate
production order.

Image generation uses the `v2` endpoint with mandatory canvas history.
`--api-version v1` is rejected; run `assethub capabilities` to check availability.

Part extraction uses the same names shown in the AssetHub product: `V1.5`,
`V2.0 alpha`, `V2.1 alpha`, and the Internal-only aliases `V3.6.1`
(`V3.6.1 Primary Images First`), `V3.6.3` (`V3.6.3 Fast Analysis`),
`V3.6.4` (`V3.6.4 Fast Analysis`), `V3.6.5` (`V3.6.5 Primary Images`),
and `pluffy` (`Chibi Character (Pluffy) v3.1`). CLI 0.1.20 adds the latter two;
`3.6.5`, `pluffy v3.1`, and `pluffy 3.1` are also accepted aliases.
Run `production agents` to check availability and `supportedOnGraphEndpoint`
before selecting a graph version. These aliases do not change the V1.5 default
or grant access to Internal models; the server still authorizes the account.
Retired names are no longer accepted by the CLI.
Internal agent IDs are intentionally not part of the CLI interface.

The CLI only uses AssetHub's public API surface and is designed so this package
can be published independently from the private application monorepo.

## Workspaces and existing parts

Workspace management uses a user access token, separately from workspace API keys.
Pass the token through standard input; never include it in command arguments.

```sh
assethub auth login --access-token-stdin
assethub workspace list
assethub workspace create --name "Character concepts"
assethub workspace use <workspace-id>
assethub canvas list
assethub canvas use <canvas-id>
assethub composer models
assethub composer run --part <mesh-id> --part <mesh-id> --reference <image-id> --wait
assethub composer run --from-run <run-id> --transforms-json @transforms.json --wait
assethub composer refine --list-modes
assethub composer refine --from-run <run-id> --instruction "align the feet" \
  --mode placement --max-rounds 2 --wait --download --out-dir ./refined
```

Selection reuses a valid API key for that workspace or creates one when permitted.
Membership, API key creation permissions, and workspace MFA still apply. Complete
required MFA in AssetHub and provide its signed proof through
`ASSETHUB_WORKSPACE_MFA` during user login to save it with the profile. Renew an
expired proof by logging in again. Explicit `--profile` uses its saved proof and
ignores environment credentials; an explicit `--api-key` can supply the workspace
key. Generation uses normal workspace credits.

`composer refine --from-run` accepts a `mesh.compose` or prior `mesh.refine` run
and uses that receipt's final `composition.transforms` and any replacement
`composition.parts` on the same canvas, preserving `parentRunId` lineage. If the
receipt has no actual transforms, provide `--transforms-json`; the CLI refuses to
silently restart from the original requested input. New requests can use
`--input-json` or `--part`/`--reference` with `--transforms-json`. Mode availability
and each mode's `--max-rounds` policy come from `composer refine --list-modes`.
Incomplete native results remain `needs_review` and return exit code 3, so inspect
the execution and its new geometry asset IDs before continuing.

Native refinement `completed` or `reviewed` means execution finished; it is not
creator approval. Read `execution.refinement.report` and inspect the actual
`execution.composition` and downloaded meshes. Structured unresolved issues or
incomplete refinement can return `needs_review` (exit 3). Review narrative issues
even on completed runs, using overlays and oblique/side views before claiming
visual improvement.

Existing Production outputs can be inspected and downloaded without regenerating:

```sh
assethub production status <order-id> --download --out-dir ./existing-assets
assethub graph export --canvas <canvas-id> --out ./graph.json
assethub graph lineage --canvas <canvas-id> --artifact <asset-id> --direction ancestors
```

Graph commands with `--canvas` cover recorded CLI/API executions and evaluations.
A canvas with only older UI activity can return an empty graph. Use `graph list`
and `graph show --graph <id>` for historical graphs, or `mesh list` to search
the workspace mesh library.

## Inspect available MCP operations

```sh
assethub mcp tools --profile my-workspace
assethub mcp tools image_generate --profile my-workspace
```

The first command returns a compact list of tools and their action annotations.
The second returns the live description and input schema for one tool, including
required fields. Both use the selected profile and the same bounded checks as
`doctor --mcp`; they do not invoke tools or spend credits. Discover names first
because server capabilities can change.


### Team members

Use a **user access token** with `auth login --access-token-stdin`. A workspace
API key cannot invite people or change membership. Commands use the selected
workspace; `--workspace <id>` explicitly selects a target without changing your
saved selection. Membership reads require team membership; changes require admin
permission. The target workspace's MFA and IP restrictions apply.

```sh
assethub workspace members --workspace <workspace-id>
assethub workspace invite --workspace <workspace-id> --email colleague@example.com
assethub workspace set-role <user-id> --role admin --workspace <workspace-id>
assethub workspace remove-member <user-id> --workspace <workspace-id>
```

Invite defaults to `user`; use `--role admin` deliberately. Invitations grant
membership and send email. An existing member returns `already_member`, preserving
their role and avoiding another email. Use `workspace invite --email ... --resend`
only to explicitly resend or recover failed delivery. If a request is interrupted,
check `workspace members` first. Removal revokes workspace membership, not the
user's account. The final admin cannot be demoted or removed.

For MCP account operations, add a separate server using:

```sh
assethub mcp config --client codex --account
assethub mcp config --client cursor --account
assethub mcp tools --account --profile <user-profile>
```

The generated configuration references `ASSETHUB_ACCESS_TOKEN` and
`ASSETHUB_WORKSPACE_MFA_COOKIE` without printing credentials. Set the latter to
`ah_workspace_mfa=<signed-cookie-value>` from the same verified browser session
(or an empty string if workspace MFA is not required). Pass these environment
variables to your MCP client and reconnect. This server uses
`https://app.assethub.io/api/workspaces/mcp` and exposes `workspace_list`,
`workspace_members_list`, `workspace_member_invite`, `workspace_member_set_role`,
and `workspace_member_remove`. Keep the existing API-key MCP server for generation.

## Download a canvas handoff

```sh
assethub canvas download --canvas 42 --out-dir ./client-handoff
assethub canvas download --canvas 42 --mesh mesh_123 --out-dir ./mesh-handoff
```

This staged feature uses the selected workspace API key. A canvas invitation does
not grant API-key or workspace access. Use an empty output directory. The bundle
contains image files, final mesh files, `manifest.json`, `index.html`, and
`history.md`. Open `index.html` locally to review images and recorded steps.

The export follows the actual recorded mesh inputs and image-edit ancestors,
including intermediate assets removed from the canvas. Current canvas connections
are not generation evidence. UI `mesh_generation` / `projected_image_gen`, API
execution receipts, and associated Production / Artifact Graph records are read
without dispatching new work. Prompts and models appear when recorded. Missing
or ambiguous history is reported explicitly; this is the available recorded
history, not a reconstruction of unrecorded editing gestures.

Downloads stream to temporary files and are renamed only after completion. The
manifest records local paths, byte counts and SHA-256 hashes; signed URL tokens
and API credentials are not saved. Download failures retain the successful files
and manifest and exit 1. Truncated exports exit 3. Individual files are limited to
1 GiB, and bounded server traversal reports any omitted history. History warnings
can remain even when all available files download successfully.
