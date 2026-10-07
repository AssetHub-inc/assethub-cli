# Changelog

## CLI 0.1.49

- The bundled skill asks **Keep** / **Not right** after a result, the same words the AssetHub canvas now shows on the Use skill node (it used to say Looks right / Needs changes). The recorded values are unchanged: `run-verdict --verdict keep|not-right`.

## CLI 0.1.48

- The bundled skill always reads the staff-shared skills (`GET /workspace-skills/shares`) alongside `skills list --runnable` before saying no skill fits. It used to read them only after `api search staff` found the share operations, so agents skipped them and told staff there was no skill. A refused call (a key that is not staff) is passed over silently.

## CLI 0.1.47

- `skills run-status --out-dir` / `--attempts` saves the result of a skill shared to staff. It used to fail with 403 `WORKSPACE_SKILL_FORBIDDEN`, because naming the files read the skill from the runner's own workspace; it now takes the title from the shares list.
- `skills run-status --attempts` labels each part's tries in a multi-part run (one image per part per try) as `passed` or `rejected`, instead of `unchecked`: a part's final passed, and a try that part was retried after was rejected. It uses a verdict's `part` when the server sends one.
- The bundled skill shows every saved result and try in the conversation, never just a "done" (golden rule 12), and keeps the person posted on long runs: it starts them without `--wait` and checks `run-status --attempts` about every minute, reporting each step and showing each new try.
- The bundled skill suggests 500 credits (Recommended), 750 or 1000 as a skill run's spending limit, up from 50 / 100 / 30, and raises a paused run by 250. Real part-separation runs ran out at 150 and 200 credits.
- The bundled skill always gives the canvas link (`https://app.assethub.io/workflow/<canvasId>`) when a run starts and again with its result (golden rule 11).
- The bundled skill starts a staff-shared run with `executionContext`, so the run shows in the canvas history, and says how to make a canvas when there is none.
- The bundled skill asks which workspace to use before the first paid call when the key can use more than one, or when none is selected (`No workspace selected` / `WORKSPACE_REQUIRED`). It lists them with `workspace list`, asks with the question tool, selects the answer with `workspace use`, and names that workspace in every later price question. It never switches workspace on its own.

## CLI 0.1.46

- The bundled skill offers sharing with AssetHub staff itself: right after a skill is saved ("What next?": try it on another image, share it with staff, or that's all), and again after its first kept result. Staff accounts only. Nobody has to know to type "share it with staff".

## CLI 0.1.45

- The bundled skill leads with "say what you want": an "I want …" request that names no skill still checks the team's skills, asks once, then runs.
- The bundled skill shares a skill revision with AssetHub staff (staff accounts only), checks and stops a share, and lets staff find and run skills other staff shared. Share and stop pass an `--operation-id`, as every `api call` mutation must.

## CLI 0.1.44

- The bundled skill offers to fix a result in the person's own session when they say **Needs changes**, not only when the skill's AI check rejected it: one image edit of only what they named, with the skill's model and preserve rules, checked against the skill's acceptance criteria, at most two fixes. Regenerating from the original stays an option, and is recommended when most of the image is wrong.
- The bundled skill makes every image through AssetHub: the assistant never draws or edits the person's pictures with its own image tool or code.
- The bundled skill runs a skill as written with `skills run` and never copies, rewords or swaps the model of its steps; the person's wishes go in `--ask`. (In a team eval, agents that rewrote a skill's steps broke its rules.)

## CLI 0.1.43

- `assethub skills run-list` finds a skill run again from a new session: a closed window or a laptop that slept no longer needs the operation id the old window printed. It lists the runs started from this folder (or `--file <image>`, or `--all`), newest first, with each run's live status and the next command. Free; it only reads.
- `skills run` records each run in the CLI's state folder (`skill-runs/<run-id>.json`: skill, revision, run and operation ids, canvas, source file, output folder) as soon as the server accepts it, before waiting.
- `skills run-status` and `skills run-resume` save results next to the original picture when the run was started from this computer and no `--out-dir` is given.
- The bundled skill tells the assistant to use `skills run-list` when it has lost track of a run.
- The bundled skill carries on without recording when `skills run-verdict` is refused (recording is not open to every account yet), and notes that each person records one answer per result.
- `skills run-status --attempts` also saves every image try of a run, verified or not, as `<original>.<skill>.try<n>-rejected.png` (or `-passed`, `-unchecked`), with the AI check's reason in the JSON. When the run's own AI check rejected its last try, the JSON carries `rejected: {attempt, reason}` and `next` points at fixing it.
- The bundled skill continues a run whose AI check said no in the person's own session: it saves the rejected try, agrees or disagrees with the check, asks once with the price, edits only what was rejected using the skill's own image model and preserve rules, checks the result against the skill's acceptance criteria, and stops after two local fixes.

## CLI 0.1.42

Skills commands work as written on Windows (PowerShell and cmd.exe).

- `skills build --instructions`, `skills run --ask` and `skills build-enhance --current` take `@file` (or `@-` for stdin). The bundled skill writes multi-line instructions and JSON to a file instead of putting line breaks or quotes inside one argument, which PowerShell and cmd.exe break.
- The bundled skill writes every command on one line: no trailing `\` (PowerShell ran the first half alone, so `skills run` started without its `--revision`/`--content-sha256` pin), no `$(uuidgen)`, no single-quoted JSON. A test keeps it that way.
- `skills run` progress lines are plain ASCII (`Try 1: Making the image - done.`); Windows PowerShell 5.1 showed the em dash as `ΓÇö`.
- The bundled skill quotes every `@file` argument (`--instructions "@instructions.txt"`): PowerShell reads an unquoted `@name` as splatting, so the file never reached the CLI. A test keeps them quoted.
- On Windows, `setup --print-env` prints `$env:ASSETHUB_API_KEY = "…"` and setup's hints say `setx ASSETHUB_API_KEY "<your key>"` instead of a bash `export`.
- CI also builds, typechecks and runs the skills tests on `windows-latest`.

## CLI 0.1.41 / API client 0.1.19

Artists can find, run and create workspace skills from Claude Code, Codex or Cursor without writing API calls. Publish `@assethub/api-client` 0.1.19 first: the CLI needs its new skill-run methods.

- `assethub skills run <skill-id> --file <image> --budget <credits> --wait` runs a workspace skill on a picture from this computer. It uploads the picture to the canvas, pins the skill revision you approved (an edited skill is refused instead of charged), prints one plain line per try and per AI check on stderr, and saves the verified results next to the original as new files (`hero.turnaround-view.png`, then `-2`, …); nothing is ever overwritten. The JSON says what to do next in `next`. Running again with the same `--operation-id` continues the same run. Running skills is not open to every account yet; such an account gets `Running skills is not available on this account yet.`
- `skills run-status`, `skills run-resume --add-credits <n>` (a run paused at its spending limit continues; never a second run) and `skills run-verdict --verdict keep|not-right [--note]`.
- `skills list --runnable` lists only the skills a run accepts (the same ones the canvas "Use skill" node offers), across every page, and marks two skills with the same title (`sameSummaryAs`).
- `skills build --task-kind <kind>` builds a skill for any end result (`concept_art`, `part_composition`, `mesh_generation`, `mesh_processing`, `rigging_animation`, `character_production`), not only `part_separation`. The other kinds need the v7 Skill Builder on your account; otherwise the server answers `TASK_KIND_NOT_SUPPORTED`.
- `skills build-status`, `build-enhance`, `build-accept` and `build-discard` are listed in `--help`. They worked before but were not shown.
- The bundled `assethub` skill is rewritten for artists: the assistant checks the team's skills before any work, asks every choice through its question tool (AskUserQuestion in Claude Code, numbered options elsewhere), runs a skill with one command, and starts every new skill with an interview (kind, canvas, goal, what must stay the same, criteria, a full read-back) steered by what was decided in the conversation. A test keeps every command and flag the skill names in `--help`.
- API client: `startWorkspaceSkillRun`, `getWorkspaceSkillRun`, `resumeWorkspaceSkillRun`, `recordWorkspaceSkillRunVerdict`, their types, `TERMINAL_WORKSPACE_SKILL_RUN_STATUSES`, and `WORKSPACE_SKILL_BUILD_TASK_KINDS` (a build's `taskKind` takes all seven kinds).
- `assethub setup` ends by saying what to type: `type /assethub, or just say what you want, e.g. "what skills does our workspace have?"`.

## CLI 0.1.40 · SDK 0.1.18

- `production analyze` and `production batch` take `--mesh-quality low|high` and a repeatable `--mesh-model <id>` for V4 Character Assembly (`--part-extractor v4`). They set the run's mesh quality and the only models it may use, the same as the canvas start card: `--mesh-quality low --mesh-model meshGen.tripo_p2_preview` makes every part Tripo P2, and the AI's fallback never leaves that list. Defaults: low uses Tripo P2, high uses Tripo 3.1. The `meshGen.` prefix is optional. Needs the mesh-quality rollout (internal and named V4 testers); the server refuses the request before any credit hold otherwise.
- The SDK's `ProductionAnalyzeRequest.meshGeneration` has `preferences` (new `ProductionMeshPreferences` type).

## CLI 0.1.39

Fixes for setting up the CLI on Windows.

- Pasting the API key into setup's hidden prompt works on Windows. The terminal added invisible bytes around the pasted key (bracketed-paste markers, or a literal Ctrl+V), so every request failed with `fetch failed`. The prompt now removes control characters and terminal escape sequences before using the key.
- The CLI trusts the operating system's certificate store as well as Node's own. Antivirus HTTPS scanning and company proxies re-sign traffic with a root only the OS trusts, which made every request fail with `fetch failed` unless `NODE_OPTIONS=--use-system-ca` was set. Needs Node 22.19 or 24.5; older versions behave as before.
- A network error shows its cause, for example `fetch failed: invalid Authorization header (UND_ERR_INVALID_ARG)` or `fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE`, instead of only `fetch failed`.
- `assethub setup --api-key-stdin` (or any run that cannot ask) uses the only workspace the key can reach rather than failing with `No workspace selected`. With more than one, `--workspace <id>` is still required.
- On Windows, setup links the skill into each agent with a directory junction instead of a symlink, so the `skills` step no longer fails with `EPERM` when Developer Mode is off. An existing link is kept.

## CLI 0.1.38

- A session upload no longer gets stuck when the server already holds revisions this machine has no record of, for example after `~/.assethub` was deleted and set up again. Before, the upload failed with `already holds a different snapshot at this revision` and waited an hour to retry; now it skips past the revisions the server holds and uploads right away.
- When the server already held a newer revision, the session was marked uploaded although the new snapshot was not stored. It is now sent as a higher revision.
- The setup notice says sessions upload every 8 minutes while you work, not only when they end.

## CLI 0.1.37

- A running session is uploaded while you work every 8 minutes instead of every 20, so work shows up in AssetHub sooner.
- `ASSETHUB_SESSION_UPLOAD_INTERVAL_MIN` sets that interval in minutes (at least 1). Set it where the hooks run, for example in your shell profile or the `env` block of Claude Code settings: `ASSETHUB_SESSION_UPLOAD_INTERVAL_MIN=2`. Each upload sends a new snapshot of the whole transcript; images the server already holds are skipped. A value that is not a positive number keeps the default.

## CLI 0.1.36

- The CLI keeps itself current. Auto-update is on by default: at most once a day a detached background process checks the registry and installs a newer release with the package manager that installed the CLI, as `assethub update --yes` would, keeping the saved login. No command waits for it. The next command prints one stderr line, `@assethub/cli updated itself from <old> to <new>`; a failed install prints `could not update itself …` and the `is available` notice continues. stdout JSON is unchanged. Two commands started together never install twice (lock file).
- Auto-update applies only to a global install, never to `npx`, a project dependency or a source checkout. It is off in CI, with `ASSETHUB_NO_AUTO_UPDATE=1` (notice only) or `ASSETHUB_NO_UPDATE_CHECK=1` (nothing). `assethub setup` shows it as a new `auto-update` step; `--no-auto-update` / `--auto-update` save the choice in `~/.assethub/settings.json`.
- An older CLI never replaces a newer installed skill: the skill copy is refreshed only by an upgrade, and setup reports such a copy as `kept … newer than this CLI`.
- `assethub update` and `update --check` refresh that daily check, so the notice stops as soon as you upgrade.
- The bundled agent skill starts every session with `assethub update --check` (auto-update may be off, may have failed, or may not have run yet): when an update is available the agent runs `assethub update --yes`, tells you the versions, and re-reads the refreshed skill; when the update cannot run it continues on the current version and says so once.

## CLI 0.1.35

- `assethub setup` is now the one command that connects coding agents. It runs the steps `login`, `workspace`, `mcp`, `skills`, `app-env` and `doctor`, finds Claude Code, Codex and Cursor on the machine, registers the MCP server in each and installs the bundled `assethub` skill. Each step checks the current state first and reports it as unchanged, updated, or what a `--dry-run` would change, so running setup again is safe.
- New setup options: `--agent claude-code|codex|cursor` (repeatable or comma separated, `claude` accepted), `--project` (MCP config and skill in the current folder, with relative skill links), `--only <step,...>`, `--skip <step,...>` and `--no-skills`. `--client claude|codex|both` still works.
- Each agent has one MCP writer. Claude Code is changed through `claude mcp add-json` (it owns `~/.claude.json`); only when `claude` is not on PATH, for example with only an IDE extension, does setup write the same entry into that file (or `.mcp.json` with `--project`) itself, after a backup. An identical entry is left alone. A config file setup writes itself is backed up first (never over another backup, even from a concurrent run) and replaced in one rename, so an interrupted run cannot leave it truncated. If `claude mcp add` fails while replacing an outdated entry, the previous entry is put back; if `claude mcp remove` fails, the existing entry is left as it is and the step fails.
- Setup refuses a remote HTTP or credentialed `--base-url` before writing any agent config, and its JSON result keeps what `init` reported: `version`, `detected` agents, the `skill` copy and links, and each step's config `path`.
- `setup --only skills` installs the skill copy even when no coding agent is found (for example `--project` in a repository on a CI machine); only the `mcp` step needs an agent.
- `assethub doctor --setup` reports agents whose MCP entry or skill is missing or out of date, without changing anything.
- `assethub init` is deprecated. It runs `setup --only mcp,skills`, prints the result as JSON with setup's fields (`agents`, `steps`), and will be removed in a later version.

## CLI 0.1.34

- Saved sessions upload while you work: on `Stop` and `PreCompact` the hooks start a background upload of the running session, at most every 20 minutes. Claude Code app sessions stay open for days and rarely reach `SessionEnd`, so until now they were uploaded only after 2 quiet hours, when a later session started. `SessionEnd` and the `SessionStart` retry sweep are unchanged, and `ASSETHUB_SESSION_UPLOAD=off` still turns uploading off.
- A running upload keeps its per-session lock fresh, so an upload that takes longer than 15 minutes is no longer mistaken for a crashed one and joined by a second upload of the same session.

## CLI 0.1.33

- `production batch --wait` progress is readable: a header names each image by letter and file name, a line (with the local time) prints only when a run really moves on (started, a new step, another mesh ready, a part kept with an issue, a Blender round, the end), and a status table prints every 5 minutes and at the end. Failures read `✗ FAILED · at 1/4 Planning the parts · Planner run failed. (planner_failed)` instead of a Python-style list. `runs watch` and `production analyze --wait` use the same run lines. The stdout JSON is unchanged.
- A `--source-url` with no file name is named by its host in progress lines and download folders, never by the whole URL, so a signed URL's query string (its credentials) is not printed or written to disk.

## CLI 0.1.32

- `assethub hooks install --client claude` now installs the session-saving hooks for the current folder only, in `.claude/settings.local.json`, instead of `~/.claude/settings.json`, which saved every Claude Code session on the machine. `--global` keeps the old behaviour. A folder install is refused in the home folder, where it would apply to every project. `hooks uninstall` follows the same scope.
- `setup --save-sessions` installs for the folder setup runs in, and the disclosure names that folder. In the home folder setup refuses up front, in the dry run as in the real run, and does not offer session saving.
- Hooks installed globally by 0.1.31 or earlier stay until removed with `assethub hooks uninstall --client claude --global`.
- `assethub hooks install --client codex` installs the session-saving hooks for Codex, in the current folder's `.codex/hooks.json` (`--global`: `$CODEX_HOME/hooks.json`). The file is added to the repository's `info/exclude`, and a tracked one is refused. Install says when Codex still needs the folder trusted, and that a new hook must be approved in `/hooks`. `setup --save-sessions` installs for Codex too. Needs Codex 0.145 or newer, the first release that runs `SessionEnd` hooks; on older Codex a session is uploaded only when a later session picks it up as abandoned (after 2 quiet hours).
- Codex sessions are saved as `codex` and trimmed to the conversation, like Claude Code ones: base instructions, `AGENTS.md` and other context messages, developer messages, reasoning, turn settings, the event stream and exec bookkeeping are dropped.
- Fix a hang when saving a session with long lines without spaces: the image-path search now runs in linear time, and still finds paths up to 4096 characters.
- `hooks save` refuses an unknown `--client` instead of saving the session as Claude Code, and an uploaded session is tagged with its own client (`agent:codex` for Codex).

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
