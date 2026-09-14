---
name: assethub
description: |
  Use the AssetHub CLI (`assethub`) and hosted MCP to generate and process 3D assets: images, meshes, parts, rigs, animations, textures, and full production runs. AssetHub handles the AI providers, credits, and job tracking.

  TRIGGER when:
  - Generating or editing an image, concept, or reference for a 3D asset
  - Turning an image or prompt into a 3D mesh, splitting it into parts, or composing parts
  - Rigging, animating, retopologizing, texturing, or converting a mesh
  - Running a 3D production pipeline, checking a job, or recovering a run
  - Asking what models or operations are available, or what something will cost
  - Recording whether a generated asset is acceptable

  DO NOT TRIGGER for:
  - Installing or configuring the CLI (use `assethub init`, `assethub auth login`)
  - Managing workspace members (use `assethub workspace ...`)
---

# AssetHub CLI

`assethub` is a client, not an agent. It calls the AssetHub API, prints one JSON object to stdout, and puts progress on stderr. You decide what to do; it does it and tells you what happened.

## Output contract

- stdout is exactly one JSON object. Parse it. Never scrape stderr.
- Exit codes: `0` accepted or completed · `1` terminal failure · `2` input, auth, capability, or budget error · `3` timeout, history pending, or needs review · `130` interrupted.
- **Exit 3 is not a failure.** The server-side job keeps running. The JSON still carries `runId` and `operationId`; use them to resume or watch instead of starting again.
- Errors arrive as `{"error": {"code", "message"}}` plus any known `runId` / `operationId`.

## The ritual

Always in this order. Skipping a step is how credits get wasted.

### 1. Check what this key can do

```bash
assethub capabilities
```

Tells you which operations, models, and history features this workspace key allows. If it fails with a missing-key error, the user needs `assethub auth login --api-key-stdin` (never pass a key as an argument) or `ASSETHUB_API_KEY` in the environment. A personal key also needs `assethub workspace use <workspace-id>`.

### 2. Find the operation

Prefer the dedicated commands (`image generate`, `mesh generate`, `parts split`, `rig create`, `animate retarget`, `production analyze` …). For anything else, search the live catalog:

```bash
assethub api search "compose parts"
assethub api describe "POST /mesh/compose"
```

`describe` returns the exact input schema and required fields. **Read it before you call.** Do not guess parameter names.

### 3. Pick the model deliberately

```bash
assethub models list --domain mesh
assethub models get <model-id>
```

The default model is not always the right one. A model's catalog entry carries its credit plan. If the user has already tried a model and it failed, choose a different one rather than retrying the same thing.

### 4. Run, with an operation ID for anything paid

```bash
assethub image generate --prompt "stylized wooden crate" --wait --download --out-dir ./out/crate
assethub mesh generate --source-id <image-asset-id> --canvas <canvas-id> --wait
assethub api call "POST /mesh/compose" --input-json @request.json --operation-id $(uuidgen)
```

- `--wait` blocks until the job finishes and returns the final result. Without it you get a job or run ID to watch.
- `--download --out-dir <dir>` fetches every output artifact and writes a `manifest.json`.
- `--operation-id <uuid>` makes a paid request idempotent. Reuse the **same** ID with the **same** input to retry; a new candidate needs a new ID.
- Generation returns `execution` with the canvas URL, run and job IDs, and the output asset IDs. Chain those IDs into the next step with `--source-id`.

### 5. Wait or recover — never resubmit blindly

```bash
assethub jobs watch <job-id> --download --out-dir ./out
assethub runs watch <run-id>
assethub runs resume <operation-id> --wait
```

After a timeout, an interrupted command, or any uncertain response, `runs resume <operation-id>` replays the identical request and returns the existing result. It never charges twice. Starting a fresh command does.

### 6. Record the verdict

```bash
assethub evaluations submit --canvas <canvas-id> --artifact <asset-id> \
  --report ./review.json --agent <your-name> --require-pass
```

`review.json` must have `schemaVersion: "assethub.evaluation-submission.v1"`, a `rubric`, a `verdict` of `pass` | `fail` | `needs_review`, `criteria`, `referenceAssetIds`, and `evidenceAssetIds`. Inspect the downloaded artifact before you write the verdict; a verdict you did not check is worse than none. `--require-pass` exits 1 on fail and 3 on needs_review, so a pipeline can stop on a bad result. An agent verdict is never creator approval.

## Cost safety

- `production run` defaults to `full_auto`, which never pauses for a human. **Always pass `--max-cost-credits <n>`.** The server caps `--max-iterations` at 5.
- Over MCP the same rule applies: always set `maxCostCredits` on `production_run`.
- `assethub account get` shows the balance. Check it before a batch.
- Prefer a dedicated, scoped API key for agent work rather than a full-access one.

## Rules learned the hard way

- Never put an API key in a command argument or a config file. Use `--api-key-stdin` or the environment.
- Part extractor names are the public product names: `V1.5`, `V2.0 alpha`, `V2.1 alpha`. Internal IDs are not accepted.
- `parts split` and `parts compare` with `--preprocess-prompt` create a second production order; use `--all-ready`, not `--task-id`.
- Every generation should land on a canvas. Pass `--canvas <id>` to keep a job's steps together; without it the CLI makes one canvas per working directory. `assethub canvas open <id>` shows the user what happened.
- A complaint like "the mesh has extra limbs" is usually an input problem: stray lines, shadows, or inconsistent views. Clean the image (`image edit`) before switching models.
- Input can come from a file, a URL, stdin bytes, base64, a data URI, an OpenAI- or Anthropic-style JSON attachment (`--stdin-json`), or the clipboard. You never need to write a temporary file first.
- Large or complex requests: `--input-json @request.json` with the schema from `api describe`.

## Reusable methods (workspace skills)

```bash
assethub skills list
assethub skills get <skill-id>
```

A workspace skill is a saved method that already worked in this workspace. Read them before inventing a new approach to a problem the team has solved. Skills set to `automatic` apply on matching runs without asking.

## MCP equivalents

The hosted MCP (`https://app.assethub.io/api/mcp`) exposes the same API. `capabilities_get` ↔ `capabilities`; `operation_search` / `operation_describe` / `operation_call` ↔ `api search` / `describe` / `call`; `job_poll` ↔ `jobs watch`; `evaluation_submit` ↔ `evaluations submit`. Whichever surface you use, follow the same ritual.

## Diagnose

```bash
assethub doctor --mcp
assethub --version
```

`doctor` checks the key, the workspace, and MCP tool discovery without spending credits. Exit 2 means a check failed and the JSON says which and what to do.
