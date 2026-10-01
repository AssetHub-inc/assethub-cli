# Changelog

## Unreleased

- `assethub hooks install --client claude` now installs the session-saving hooks for the current folder only, in `.claude/settings.local.json`, instead of `~/.claude/settings.json`, which saved every Claude Code session on the machine. `--global` keeps the old behaviour. A folder install is refused in the home folder, where it would apply to every project. `hooks uninstall` follows the same scope.
- `setup --save-sessions` installs for the folder setup runs in, and the disclosure names that folder. In the home folder setup refuses up front, in the dry run as in the real run, and does not offer session saving.
- Hooks installed globally by 0.1.31 or earlier stay until removed with `assethub hooks uninstall --client claude --global`.
- `assethub hooks install --client codex` installs the session-saving hooks for Codex, in the current folder's `.codex/hooks.json` (`--global`: `$CODEX_HOME/hooks.json`). The file is added to the repository's `info/exclude`, and a tracked one is refused. Install says when Codex still needs the folder trusted, and that a new hook must be approved in `/hooks`. `setup --save-sessions` installs for Codex too. Needs Codex 0.145 or newer, the first release that runs `SessionEnd` hooks; on older Codex a session is uploaded only when a later session picks it up as abandoned (after 2 quiet hours).
- Codex sessions are saved as `codex` and trimmed to the conversation, like Claude Code ones: base instructions, `AGENTS.md` and other context messages, developer messages, reasoning, turn settings, the event stream and exec bookkeeping are dropped.
- Fix a hang when saving a session with long lines without spaces: the image-path search now runs in linear time.

## CLI 0.1.31 / API client 0.1.17

- Add `assethub setup`: signs in (reusing a saved key), selects a workspace, registers the hosted MCP server in Claude Code and Codex, and checks the connection. On macOS it also makes `ASSETHUB_API_KEY` available to desktop apps, re-applied at login by `assethub env load`. `--dry-run` lists every change without making it. The API key is never written to a configuration file.
- Add `assethub update [--check] [--dry-run] [--yes]`: upgrades a global install with the package manager that installed it and keeps the saved login.
- Add `production batch`: one `production analyze` per image (`--file`, `--files-dir`, `--source-id`, `--source-url`) times `--repeat`, on one canvas. More than one paid run requires `--yes`. Rerunning with the printed `--operation-id` resumes without starting any run twice, and `--wait` reports each run's progress.
- Add `--base-body`, `--skill-planner-model` and `--auto-repair` to analysis, and `--pipeline-depth`, `--assembly-policy` and `--mesh-generation-json` for production graph runs. `runs watch` shows step-by-step progress for character assembly runs.
- Add Composer V6 and V5.1 to `composer run --model`, `composer refine --skill-assembly [--reasoning]`, `--agent-model` and `--optimize off|light|medium|heavy`. `--part` accepts `<mesh-id>=<part-image-id>` as well as the existing `<mesh-id>:<part-image-id>`.
- Add `canvas graph-id`, `graph snapshot|node|image`, `runs get|watch --download`, and `skills memory|validate|schema|build|official`.
- Uploads send `X-AssetHub-Workspace`, so personal API keys can upload runs.
- `setup` never overwrites an earlier configuration backup, leaves unrelated MCP servers untouched, and only uses executable files from `PATH`. `update` verifies the upgrade with the same login options it was given. Canvas export downloads only follow redirects that stay on HTTPS and don't lead into a private network.
- `Humanoid Assembly` is listed under that name; its previous name is still accepted. Part extractor names no longer carry availability labels: the server decides which ones an account can run.
- Rate-limit handling is unchanged from 0.1.27, except that a plan's active-run limit is returned right away instead of being retried.
- API client: add graph reads (`getGraphSnapshot`, `getGraphNode`, `getGraphNodeImage`), production batch helpers, skill build, review and official-skill methods, binary artifact reads, `AssetHubApiError.replayed`, and progress fields on executions.

## CLI 0.1.30 / API client 0.1.16

- Add the Composer Alpha `effort` option to the mesh refinement client request. The CLI accepts `--effort light|standard|thorough`, forwards it from JSON input, and preserves it across `--from-run` continuation.
- Check the selected effort's round limit before dispatch.

## CLI 0.1.29 / API client 0.1.15

- Send `--compose v6` as the top-level `partComposerAgentVersion` field that the production automation API reads. CLI 0.1.28 sent it inside `config`, so the server silently used its default Composer model.
- Add the field to the API client request type and verify the serialized request body.

## CLI 0.1.28 / API client 0.1.14

- Add `production run --image <file|asset-id>`, a one-shot "image to finished asset" command: a thin wrapper around `production automation` (which already does split, mesh generation, and server-side compose) plus waiting, downloads, and cost estimation. `--image` auto-detects an existing local path (uploaded like `--file`) versus an asset id (used like `--source-id`). This is a different command from the existing `production run --order-id --mission-id` mission-execution flow, which is unchanged; the two are disambiguated by whether `--image` is present.
- Add `--compose v6|none` to the one-shot command. `--compose none` disables automation's compose stage (`config.autoCompose: false`). The V6 field was initially nested inside `config` and is corrected in CLI 0.1.29. Against an older server (detected by the automation response lacking `estimatedCostBreakdown`), the CLI falls back to reading the batch's own `mesh.generate` executions, pairing each produced mesh with its source part image, and running an explicit `composer run`.
- Add `--estimate` to the one-shot command: prints a cost breakdown, shaped like the server's own `split`/`meshGeneration`/`compose` breakdown, from side-effect-free catalog reads only, without submitting anything. `--max-parts` (default 24, matching the server's own conservative constant for this math) overrides the assumed worst-case part count used only for this math. Part-extraction/split cost has no dry-run price source today and is reported as unknown rather than guessed. Add `--max-cost <credits>`, which refuses to run (non-zero exit, nothing submitted) once the estimate exceeds it, and is also sent to the server as `maxCostCredits` on the real run. A real run against a server that has shipped #8179 additionally surfaces the server's own `estimatedTotalCredits`/`estimatedCostBreakdown`.
- Wire up `getProductionAutomationStatus` (already present in the API client but unused until now): the one-shot command's `--wait` polls it and prints one line per per-image stage transition and per batch-completion change.
- Add `runs get --summary`, a condensed plain-text view (status, credits, output asset, error) instead of the full JSON execution dump. Add `runs wait <run-id>` as a named alias for `runs watch`.
- Expose `AssetHubApiError.details` (the error envelope's own `error.details`), and use it in the one-shot command's compose-error hints: `PART_IMAGE_REQUIRED` (with `details.meshAssetId`) and `ASSET_WRONG_MEDIA_TYPE` (with `details.assetId`/`actualType`/`expectedType`), both confirmed by #8179, appended to (never replacing) the original message/code. Falls back to matching on message content for a server that has not shipped those codes yet.

## CLI 0.1.27 / API client 0.1.13

- Retry 429 responses in the shared client request path instead of failing the command: wait the server's `Retry-After` header (or the parsed "Try again in N seconds" message), add jitter, and bound both the per-wait delay and the attempt count while replaying the exact same request (including any `Idempotency-Key`).
- Stop treating a 429 as a `--wait` failure: `waitForExecution` keeps polling until the `--wait` deadline instead of exiting with a failure status when the run is still rate-limited.
- Add a floor and jitter to the `--wait` poll cadence so parallel invocations stop polling in lockstep against the same rate-limit window.
- Accept `<mesh-asset-id>:<part-image-asset-id>` as a `composer run --part` and `composer refine --part` value, forwarding the reference image as `partImageAssetId` on that part so Composer V6 (`part_composer_v6_auto_assemble`) runs no longer fail with a missing-part-image error; plain mesh-only `--part` values keep working unchanged.

## CLI 0.1.26

- Accept `V3.0.9 Garment Boundaries` and its short aliases for graph splitting.
- Accept `Humanoid Assembly (internal)` and its aliases, including the exact
  publicName printed by `production agents`, for graph splitting.
- Align `V3.7 Artist Skills` and `V3.7.1 Building Modules` aliases with the
  `V3.0.7`/`V3.0.8` names used by the web picker and `production agents`.
- Derive the artifact-graph routing set from the part extractor option list
  instead of a separately maintained set, so a newly listed graph agent
  cannot miss the graph endpoint.
- Recognize internal part extractor IDs by the `ah_` prefix instead of by
  the presence of an underscore, so public aliases that happen to contain
  underscores (e.g. `humanoid_assembly_auto`) are no longer rejected.
- Add `assethub init`, which detects Claude Code, Codex, and Cursor, writes the hosted MCP entry into each agent's configuration without storing a key, and installs the bundled `assethub` agent skill. `--agent`, `--project`, and `--dry-run` control scope; existing settings and user-owned directories are preserved.
- Ship the `assethub` agent skill in the npm package. It teaches coding agents the command sequence, cost rules, recovery via `runs resume`, and verdict submission, and refreshes itself on the next command after a CLI upgrade.
- Honor `ASSETHUB_CLI_HOME` for every agent-configuration write so tests and sandboxes never touch the real home directory.

## CLI 0.1.25 / API client 0.1.12

- Preserve the requested body-first assembly policy and bounded regeneration options in Composer refinement JSON input, saved operation replay, and `--from-run` requests.
- Respect the server-advertised body-first round limit while preserving the legacy limit, and include Responses API runtime types.
- Add the existing server contract fields to the public API client request type; server authorization, rollout gates and budgets remain authoritative.

## CLI 0.1.24

- Accept V3.7.1 Building Modules and its short aliases for graph splitting and workspace skill selection. Preserve server authorization and saved operation recovery.
- Forward Skills from new `parts split` analyses and reject retroactive selection on existing orders.
- Keep API client 0.1.11 and the CLI default unchanged.

## CLI 0.1.23 / API client 0.1.11

- Discover, describe, and call the authenticated v1/v2 OpenAPI catalog with `api search`, `api describe`, and `api call`; mutations require an explicit stable operation UUID.
- Add typed Workspace Skill methods and `skills` commands for learning, review, controls, and proposal publication through the existing server gates and actor permissions.
- Forward bounded skill selection for V3.7 Artist Skills through `production analyze --skill-mode auto|manual|off [--skill-id <id>...]`, preserving server-owned skill resolution.
- Pin saved Production guidance with `--context <canvas-id> --context-version <n>`; supported graph models apply the verified Must/Avoid instructions without silently reading a newer revision.
- Preserve the newer personal-key selection and terminal execution receipt recovery behavior.
- Expose live Composer layout credit quotes in the SDK, including an explicit unavailable price while preserving compatibility with older servers.
- Add a shared parser for bounded owned-image responses so MCP and chat can consume actual image pixels while retaining metadata without image bytes, including rejected candidates selected by owned generated graph and artifact IDs.
- Preserve exact native Production part task IDs on discovered Canvas nodes so graph retries can target the saved part identity.

## CLI 0.1.22

- Preserve returned execution run IDs when a dispatch reports a typed terminal server error, including when the first receipt read is unavailable.
- Resume a known failed receipt with a GET instead of repeating its POST; keep confirmed failures at exit 1 and recovery-required responses at exit 3.
- Keep API client 0.1.10 unchanged.

## CLI 0.1.21

- Discover server-registered personal access for existing `sk_` keys during login, workspace discovery, and authentication status.
- Preserve the same key and profile across workspace selection, including saved keys without a user-token login.
- Fail closed on personal-key policy errors; permit legacy fallback only for the exact unregistered-key response.
- Keep API client 0.1.10 unchanged.

## CLI 0.1.20

- Accept the existing Internal V3.6.5 Primary Images and Chibi Character (Pluffy) v3.1 models by product name or short alias.
- Keep graph split and replay on one analysis receipt, including `--all-ready`; reject classic continuation flags and raw internal IDs.
- Preserve the V1.5 default, server authorization and API client 0.1.10.

## CLI 0.1.19 / API client 0.1.10

- Use one personal API key across its permitted workspaces; switching keeps the same credential and profile.
- Send the selected workspace on API, streaming, workspace discovery, MCP and upload requests.
- Support bounded workspace search and preserve workspace scope during recovery.
- Personal key issuance requires the corresponding server rollout; existing workspace credentials remain supported.

## CLI 0.1.18 / API client 0.1.9

- Download owned canvas images, meshes, and available generation/edit history with `canvas download`, optionally scoped to a mesh.
- Preserve recorded generation inputs and distinguish missing evidence from current canvas connections.
- Write local HTML, Markdown, and a JSON manifest with file hashes; retain successful files and report individual download failures.
- Require the canvas handoff feature to be enabled for the authenticated account.

## CLI 0.1.17

- Synchronize the existing Internal V3.6.4 Fast Analysis API and CLI aliases.
- Cover graph splitting, recovery and classic-flag rejection for V3.6.1, V3.6.3 and V3.6.4.
- Preserve version aliases and defaults; use the API catalog to discover availability.

## CLI 0.1.16

- Accept the existing Internal V3.6.3 Fast Analysis graph split through `parts split` and `production analyze`.
- Retain V3.6.1, existing defaults, graph history, operation recovery and rejection of classic-only continuation flags.
- Clarify that completed native refinement still requires visual review.

## CLI 0.1.15 / API client 0.1.8

- Run native Composer Standard, Thorough, Placement, Workshop and Blender refinement through the CLI/API.
- Resume from actual mesh revisions, transforms and volume centroids; record each round in canvas history.
- Discover mode availability and enforce native round limits; preserve incomplete results as needing review.

## CLI 0.1.14 / API client 0.1.7

- Document public access to CLI, hosted MCP, canvas history, and team management.
- Retain workspace ownership, admin permissions, MFA, and feature-specific availability.

## CLI 0.1.13 / API client 0.1.6

- Invite, list, change roles, and remove team members using user authentication.
- Preserve existing roles on invitations; provide explicit email resend and MFA/IP enforcement.
- Configure and discover the account-authenticated MCP workspace server with `--account`.

## CLI 0.1.12 / API client 0.1.5

- Search historical UI meshes, including parts and revisions, and download owned mesh assets.
- List and export stored artifact graphs; inspect ancestors and descendants by graph ID.
- Preserve canvas execution history commands and workspace ownership boundaries.

## CLI 0.1.11

- Discover live MCP tools with `mcp tools` and inspect input schemas with `mcp tools <name>`.
- Reuse bounded, authenticated discovery without invoking tools or generating assets.

## CLI 0.1.10

- Add `doctor` to check API access and the workspace, plus optional MCP tool discovery.
- Add `mcp config --client cursor|codex` with environment-based credentials.
- Add `--version` for support and installation checks.
- Honor an explicit auth profile ahead of stale environment credentials and origin; reject missing profiles.
- Use the saved default profile when no environment key or explicit profile is supplied; log out of that same saved profile.
- Update the test runner to Vitest 4.1.11, resolving its reported development dependency vulnerabilities.
- Verify actual npm tarball availability and integrity during publishing.

## CLI 0.1.9 / API client 0.1.4

- Add user login and workspace listing, creation, and selection.
- Compose existing meshes, recompose saved transforms, and retain canvas history and lineage.
- Keep workspace credentials scoped to their API origin and selected organization.
- Replay an unacknowledged Composer dispatch with the original operation identity.

These operations match the application release v1.2.1354.

## CLI 0.1.8 / API client 0.1.3

- Publish the CLI and TypeScript SDK sources in their own GitHub repository.
- Add repository, homepage, and issue links to npm package metadata.
- Build and test without private workspace dependencies.
- Keep the standalone CLI's experimental-demo error explicit.
- Generalize example fixtures and document the public installation workflow.
- Add GitHub Actions CI and npm trusted publishing with provenance.

The public API operations are based on CLI 0.1.7 and API client 0.1.2.
