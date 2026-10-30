---
name: assethub
description: |
  Use the AssetHub CLI (`assethub`) and hosted MCP to make and process 3D assets: images, meshes, parts, rigs, animations, textures, full production runs. AssetHub handles the AI providers, credits, and job tracking.

  TRIGGER when:
  - Generating or editing an image, concept, or reference for a 3D asset
  - Turning an image or prompt into a 3D mesh, splitting it into parts, or composing parts
  - Rigging, animating, retopologizing, texturing, or converting a mesh
  - Running a 3D production pipeline, checking a job, or recovering a run
  - Asking what models or operations are available, or what something will cost
  - Recording whether a generated asset is acceptable

  DO NOT TRIGGER for:
  - Installing or configuring the CLI (use `assethub setup`, `assethub doctor --setup`)
  - Managing workspace members (use `assethub workspace ...`)
---

# AssetHub

> **New to this? Read this box, then skip to whatever you need.**
>
> This file teaches an AI coding assistant (Claude Code, Codex, Cursor) how to use AssetHub for you. You don't run anything in it yourself; you just talk to the assistant in your own words and language.
>
> **The easy way: say what you want.** "I want a clean turnaround of `hero.png`." You never need a command or an id. The assistant picks the right AssetHub operation, asks you **one** question before anything that costs credits, runs it, and saves the result next to your file. More examples:
>
> - "Make a side view of `~/Desktop/hero.png`."
> - 「このキャラ画像を3D用に前処理して。上限は500クレジットで。」
> - "Turn `crate.png` into a 3D model and download it to `./out`."
>
> Before anything that costs credits, the assistant asks you **one** question with the price when there is one up front and the spending limit when the job takes one, and waits for your yes. Your original files are never overwritten; results are saved next to them as new files. If something stops halfway, the assistant continues the same job instead of paying for it twice.

## Words used here

| Word | Meaning |
|---|---|
| **Credits** | What AssetHub work costs. Charged to the selected **workspace** (your personal one or a team's). |
| **Canvas** | A board in the AssetHub web app where every step of a job appears. Each job here lands on one; `assethub canvas open <id>` shows it. |
| **Asset** | A stored image or mesh, named by an id like `img_…` or `mesh_…`. |
| **Run** | One use of a production pipeline on one image. |
| **Operation ID** | A UUID you attach to anything paid. Sending the same request with the same ID again returns the same job and never charges twice. |

## Golden rules

1. **Ask once before spending, then do exactly what was agreed.** State what will run, on which image, the price when the catalog or an estimate gives one (never invent one), the spending limit when the job takes one, and which workspace pays. Wait for a yes. Never start paid work the person did not approve.
2. **Never pay twice for one job.** After a timeout, an interruption, or an unclear answer, continue the same job (same operation ID, `runs resume`). Starting the command fresh is a second charge.
3. **Never overwrite the person's files.** Save results as new files next to the originals.
4. **Read before you call.** Use `api describe` for the exact input. Never guess parameter names or invent ids, prices, or commands.
5. **Talk like the person talks.** Answer in their language. For artists, no commands, ids, revision numbers, or JSON in the reply; one plain sentence per step.
6. **Ask, don't assume.** Every choice goes through your question tool (see "Asking the person"), with your recommendation first.
7. **Make every image through AssetHub.** Never draw, generate or edit the person's pictures with your own image tool, a built-in generator, or code, even when that looks faster. Work done in AssetHub is checked, repeatable by the rest of the team, and kept on the canvas. If AssetHub cannot do what was asked, say so and ask what to do.
8. **Always give the canvas link.** Anything that runs on a canvas (an image, a mesh, a production) gets its link in your reply as soon as it starts, and again with the result: `https://app.assethub.io/workflow/<canvasId>` (or `canvas.url` / `execution.canvas.url` when the JSON has it). The person can watch it and find the result there later.
9. **Show it, never just say it.** Every image a run, a try, a fix or a job saves: show it in the conversation: in Claude Code, open it with the Read tool (the Claude app shows it as a thumbnail in the chat) and give it as a markdown link, `[hero.turnaround-view.png](./hero.turnaround-view.png)`, so one click opens it. In Codex or Cursor, use your own image viewer the same way. Put the canvas link next to it. Never say "done" or "it passed" without showing the picture. On a long job, report each step and each AI check as it happens (see "Keep the person posted"), instead of going quiet until the end.

## How the CLI answers

`assethub` is a client, not an agent. It calls the AssetHub API, prints **one JSON object to stdout**, and writes progress lines to stderr.

- Parse stdout. Progress on stderr is written for people and may be passed on as is; do not parse it.
- **Every command here works as written in bash, zsh, PowerShell and cmd.exe** (Windows included). Keep it that way: one line per command, never a trailing `\` to continue a line (PowerShell would run the first half alone, without the flags after it), no `$(…)`, and multi-line text or JSON goes in a file passed as `@file` (`--instructions`, `--ask`, `--current`, `--input-json`).
- Exit codes: `0` accepted or completed · `1` terminal failure · `2` input, auth, capability, or budget error · `3` timeout, history pending, or needs review · `130` interrupted.
- **Exit 3 is not a failure.** The job keeps running on the server. The JSON still carries `runId` / `operationId`; use them to continue or watch.
- Errors arrive as `{"error": {"code", "message"}}` plus any known `runId` / `operationId`.

## Start of every session

### 1. Make sure the CLI is current (free)

```bash
assethub update --check
```

- `"status": "up_to_date"`: carry on.
- `"status": "update_available"`: run `assethub update --yes`, tell the person which version you moved from and to (`from`, `to`), then **re-read this file after your next `assethub` command**: that command refreshes it, and its rules may have changed.
- `update` refuses (an `npx` or project-local install, or a source checkout) or fails (no network): continue on the current version, say so once, do not retry in a loop.
- Do not update while another `assethub` command is still running. Server jobs are unaffected by an update; continue them afterwards with their ids.

Auto-update is on by default, so this usually says `up_to_date`. A stderr line `updated itself from … to …` means the same as an update: re-read this file after that command. Never turn auto-update off for the person.

### 2. Pick the workspace with the person (free)

Every credit is charged to the selected workspace, so the person chooses it, not you. Do this before `capabilities`: with no workspace selected, every workspace call (`capabilities` included) fails with `WORKSPACE_REQUIRED`.

```bash
assethub workspace get                  # the selected one, if any
assethub workspace list --limit 100     # every workspace this key can use
```

`workspace list` is paged: while its JSON has a `nextCursor`, run it again with `--cursor <nextCursor>`, so the person never chooses from a cut-off list. A missing-key error here means the person needs `assethub auth login --api-key-stdin` (never put a key in a command argument) or `ASSETHUB_API_KEY` in the environment.

- **Only one workspace exists**: select it if needed and name it once ("Using your Personal workspace."). No question, whether or not one was selected.
- **Several exist, none selected** (`No workspace selected`, or a `WORKSPACE_REQUIRED` error later): ask before anything else.
- **Several exist, one selected**: ask once per session, before the first paid call. Never switch on your own, and never assume a team workspace is fine because it is selected.

Ask with the question tool, by name and kind. The tool takes at most 4 options, so offer the selected one, the personal one, and the most likely team ones, and put the selected or personal one first. With more than 4, name the rest in the question ("Also: Studio Y, Studio Z. Type a name to pick one."); the tool's free answer takes it, and `assethub workspace list --query <name>` finds its id.

> **Which workspace should I use? It pays for everything in this session.**
> - **Personal (Recommended)**: your own credits
> - **Studio X team**: shared team credits

Then select it and name it in every later price question ("charged to Studio X team"):

```bash
assethub workspace use <workspace-id>
```

`workspace use` is the default for this key on this computer until it is changed again. Say so if you switch away from what was selected before.

### 3. Check what this key can do (free)

```bash
assethub capabilities
```

Lists the operations, models, and history features this key allows in the selected workspace.

## Asking the person

Every choice the person makes goes through your question tool: **AskUserQuestion** in Claude Code. Codex and Cursor have none; there, write the same question with numbered options and stop until they answer.

- Up to 4 questions per round, 2 to 4 options each. Put the option you recommend first and end its label with "(Recommended)". Never add an "Other" option: the tool adds a free answer by itself.
- Labels and descriptions in the person's language. No ids, revision numbers, commands, or JSON in them.
- Draft the options from what you already know (the image, the job that just happened) so the person mostly picks instead of typing.
- Use `multiSelect` only when several answers can be true at once ("What needs to change?").
- One round at a time. Wait for the answer before the next round or any paid call.

## Other work: images, meshes, parts, production

### 1. Find the operation

Prefer the dedicated commands (`image generate`, `mesh generate`, `parts split`, `rig create`, `animate retarget`, `production analyze` …). For anything else, search the live catalog and **read the schema before calling**:

```bash
assethub api search "compose parts"
assethub api describe "POST /mesh/compose"
```

### 2. Pick the model deliberately

```bash
assethub models list --domain mesh
assethub models get <model-id>
```

The default is not always right. A model's catalog entry carries its credit plan. If a model already failed for this person, choose a different one rather than retrying the same thing.

### 3. Run, with an operation ID for anything paid

```bash
assethub image generate --prompt "stylized wooden crate" --wait --download --out-dir ./out/crate
assethub mesh generate --source-id <image-asset-id> --canvas <canvas-id> --wait
assethub api call "POST /mesh/compose" --input-json "@request.json" --operation-id <uuid>
```

- `--wait` blocks until the job finishes. Without it you get an id to watch.
- `--download --out-dir <dir>` fetches every output and writes a `manifest.json`.
- `--operation-id <uuid>`: reuse the **same** id with the **same** input to retry; a new attempt needs a new id. Make the UUID yourself and paste the value (any random v4 UUID); don't rely on `uuidgen`, which Windows lacks.
- Results include `execution` with the canvas URL, run and job ids, and output asset ids. Chain them into the next step with `--source-id`.

### Fast path: one image to a finished, composed asset

You do not need `parts split` → `mesh generate` per part → `composer run` by hand:

```bash
assethub production run --image ./character.png --estimate
assethub production run --image ./character.png --max-cost 500 --wait --download --out-dir ./out/asset
```

`--image` takes a file path or an asset id. `--estimate` is free and shows the cost; show it and ask before the real run. `--max-cost <credits>` refuses to start once the estimate exceeds it. `--compose v6` asks for a Composer V6 pass; `--compose none` stops after the meshes. `runs get <run-id> --summary` is the readable way to check a long run. If `--image` is not in `assethub --help`, the CLI is out of date: update it.

### Waiting and recovering

```bash
assethub jobs watch <job-id> --download --out-dir ./out
assethub runs watch <run-id>
assethub runs resume <operation-id> --wait
```

After a timeout, an interruption, or any unclear answer, `runs resume <operation-id>` replays the identical request and returns the existing result. It never charges twice. Starting a fresh command does.

### Recording a verdict on an asset

```bash
assethub evaluations submit --canvas <canvas-id> --artifact <asset-id> --report ./review.json --agent <your-name> --require-pass
```

`review.json` needs `schemaVersion: "assethub.evaluation-submission.v1"`, a `rubric`, a `verdict` of `pass` | `fail` | `needs_review`, `criteria`, `referenceAssetIds`, and `evidenceAssetIds`. Look at the downloaded result before you write it; a verdict you did not check is worse than none. `--require-pass` exits 1 on fail and 3 on needs_review. An agent verdict is never the creator's approval.

## Cost safety

- `production run --order-id … --mission-id …` defaults to `full_auto`, which never pauses for a person. **Always pass `--max-cost-credits <n>`** (the `--image` form uses `--max-cost <n>`). The server caps `--max-iterations` at 5. Over MCP, always set `maxCostCredits` on `production_run`.
- There is no balance command; find the credit routes with `assethub api search credit`.
- Prefer a dedicated, scoped API key for agent work over a full-access one.

## When something goes wrong

| What you see | What to do |
|---|---|
| Exit 3, or the command was interrupted | Continue the same job: `runs resume <operation-id>`, or rerun with the same `--operation-id`. Never start fresh. |
| Missing key / 401 | `assethub auth login --api-key-stdin`, or set `ASSETHUB_API_KEY`. Personal key: `assethub workspace use <id>`. |
| `WORKSPACE_REQUIRED` / `No workspace selected` | Ask which workspace ("Pick the workspace with the person"), then `assethub workspace use <id>`, then run the same command again. |
| "The mesh has extra limbs" and similar | Usually the input: stray lines, shadows, inconsistent views. Clean the image first (`image generate --file <image> --prompt "remove stray lines and shadows, plain background"`, or `parts compare --preprocess-prompt <text>`) before switching models. |
| Anything else unclear | `assethub doctor --mcp` (free) checks the key, workspace, and MCP; exit 2 names the failed check and the fix. |

## Rules learned the hard way

- Never put an API key in a command argument or a config file. Use `--api-key-stdin` or the environment.
- Part extractor names are the public product names (`V1.5`, `V2.0 alpha`, `V2.1 alpha`). Internal ids are not accepted.
- `parts split` and `parts compare` with `--preprocess-prompt` create a second production order; use `--all-ready`, not `--task-id`.
- Every generation should land on a canvas. Pass `--canvas <id>` to keep a job's steps together; without it the CLI makes one canvas per working folder.
- Input can come from a file, a URL, stdin bytes, base64, a data URI, an OpenAI- or Anthropic-style JSON attachment (`--stdin-json`), or the clipboard. No temporary file needed.
- Large or complex requests: `--input-json "@request.json"` with the schema from `api describe`.

## MCP equivalents

The hosted MCP (`https://app.assethub.io/api/mcp`) exposes the same API. `capabilities_get` ↔ `capabilities`; `operation_search` / `operation_describe` / `operation_call` ↔ `api search` / `describe` / `call`; `job_poll` ↔ `jobs watch`; `evaluation_submit` ↔ `evaluations submit`. Whichever you use, the golden rules are the same.

## Diagnose

```bash
assethub doctor --mcp
assethub --version
```

`doctor` checks the key, the workspace, and MCP tool discovery without spending credits.

## Internal model evaluation and production routing (CLI 0.1.56+)

Use `assethub models routing` to discover roles, current revision, provider IDs,
server presets and native A/B prices. Admission is Internal-only; the saved
configuration is global across eligible actors. Select the intended API origin
with `--base-url`; the default is production. Keep the gate's audience separate
from routing changes.

For a model change, save immutable comparison input with a UUID `id`, role,
baselineModel, candidateModel, prompt and optional original owned imageAssetIds.
Run `models compare --input-json @comparison.json` and retain the full JSON receipt.
Exit 0 means both providers completed, 1 means terminal failure, 3 means pending
or uncertain. Recover with `models comparison <id>`; explicit resume uses the
identical saved input and ID. Never mint a replacement ID for uncertain work.
No command polls, automatically retries paid work or adopts a model.

Review quality separately, including native full-product outputs when needed.
A/B here tests provider text/vision, not complete tool execution or final 3D.
After authorized adoption, use `models apply --preset deepseek` or
`models set <role> <provider/model-id>`; `--dry-run` previews either change.
Text presets preserve the independent `image_default` role. Omitted image and
preprocessing model flags use the server default; explicit flags or JSON model
selections stay pinned. Server capability checks and revision CAS remain
authoritative. `models set <role> default` removes one override,
`models apply --preset legacy` clears all,
and `models rollback` restores the immediately previous profile. Save the initial
`models routing` JSON before multiple edits. Unchanged convenience selections
preserve rollback history; conflicts and uncertain writes require a read, not
an automatic retry. Existing operations retain their pins; new workers can take
up to five seconds to observe a change. See the package README for exact saved
profile restoration and the development workflow.
