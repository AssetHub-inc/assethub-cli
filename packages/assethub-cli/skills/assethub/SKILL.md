---
name: assethub
description: |
  Use the AssetHub CLI (`assethub`) and hosted MCP to make and process 3D assets: images, meshes, parts, rigs, animations, textures, full production runs, and the workspace's saved methods ("skills"). AssetHub handles the AI providers, credits, and job tracking.

  TRIGGER when:
  - Generating or editing an image, concept, or reference for a 3D asset
  - Turning an image or prompt into a 3D mesh, splitting it into parts, or composing parts
  - Rigging, animating, retopologizing, texturing, or converting a mesh
  - Any "I want …" request to make or change an asset, even when no skill is named ("I want a turnaround of hero.png", "bikin side view dong"): check the team's skills first, ask once, then run
  - Using, listing, or choosing a workspace skill / method ("use the clay skill on this", "スキルを使って", "which skills do we have?")
  - Making a new skill or saving a way of working ("make a skill from this", "save this as our method", "スキルにして", "bikin skill buat turnaround")
  - Sharing a skill with AssetHub staff, or running one staff shared ("share it with staff", "stop sharing it", "which shared skills can I use?")
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
> **The easy way: say what you want.** "I want a clean turnaround of `hero.png`." You never need a skill's name, a command or an id. The assistant looks through your team's skills, asks you **one** question (which skill and how many credits at most), runs it, and saves the result next to your file. More examples:
>
> - "What skills does our workspace have?"
> - "Make a side view of `~/Desktop/hero.png`." (the assistant checks whether your team has a skill for it)
> - 「このキャラ画像を3D用に前処理して。上限は500クレジットで。」
> - "That looks great. Make a skill from this so the team can use it." (it asks you a few questions first)
> - "Share that skill with staff." (AssetHub staff only; it asks first)
> - "Turn `crate.png` into a 3D model and download it to `./out`."
>
> Before anything that costs credits, the assistant asks you **one** question with the price when there is one up front (a skill run has none) and always the spending limit, and waits for your yes. Your original files are never overwritten; results are saved next to them as new files. If something stops halfway, the assistant continues the same job instead of paying for it twice.

## Words used here

| Word | Meaning |
|---|---|
| **Credits** | What AssetHub work costs. Charged to the selected **workspace** (your personal one or a team's). |
| **Canvas** | A board in the AssetHub web app where every step of a job appears. Each job here lands on one; `assethub canvas open <id>` shows it. |
| **Asset** | A stored image or mesh, named by an id like `img_…` or `mesh_…`. |
| **Workspace skill** | A saved, approved method for this workspace ("de-shadow a figure, then make it clay"). It lives on the AssetHub server, not on this computer, and runs there. Not the same thing as this file, which is a skill for the *assistant*. |
| **Run** | One use of a workspace skill (or a production pipeline) on one image. |
| **Operation ID** | A UUID you attach to anything paid. Sending the same request with the same ID again returns the same job and never charges twice. |

## Golden rules

1. **Ask once before spending, then do exactly what was agreed.** State what will run, on which image, the price when the catalog or an estimate gives one (never invent one; a skill run has none), the spending limit, and which workspace pays. Wait for a yes. Never start paid work the person did not approve.
2. **Never pay twice for one job.** After a timeout, an interruption, or an unclear answer, continue the same job (same operation ID, `runs resume`, `skills run-status`, `skills run-resume`). Starting the command fresh is a second charge.
3. **Never overwrite the person's files.** Save results as new files next to the originals.
4. **Read before you call.** Use `api describe` for the exact input. Never guess parameter names or invent ids, prices, or commands.
5. **Talk like the person talks.** Answer in their language. For artists, no commands, ids, revision numbers, or JSON in the reply; one plain sentence per step.
6. **Check the team's skills before you work.** A request to make or change something starts with `skills list --runnable` and always the staff-shared skills (`GET /workspace-skills/shares`; both free, see "Before any work"). The team's method beats one you invent.
7. **Ask, don't assume.** Every choice goes through your question tool (see "Asking the person"), with your recommendation first.
8. **A new skill always starts with an interview.** However the request is worded, and however much it already says, ask the rounds in "Make a new skill" and read the answers back before anything is built.
9. **Make every image through AssetHub.** Never draw, generate or edit the person's pictures with your own image tool, a built-in generator, or code, even when that looks faster. Work done in AssetHub is checked, repeatable by the rest of the team, and kept on the canvas. If AssetHub cannot do what was asked, say so and ask what to do.
10. **Run a skill as written.** Start it with `skills run`. Never copy a skill's steps into your own prompt, reword them, or swap its model: the skill's exact wording is what keeps its rules (agents that rewrote it broke them). The person's own wishes go in `--ask`.
11. **Always give the canvas link.** Anything that runs on a canvas (a skill run, a shared run, an image, a mesh, a production) gets its link in your reply as soon as it starts, and again with the result: `https://app.assethub.io/workflow/<canvasId>` (or `canvas.url` / `execution.canvas.url` when the JSON has it). The person can watch it and find the result there later.
12. **Show it, never just say it.** Every image a run, a try, a fix or a job saves: show it in the conversation: in Claude Code, open it with the Read tool (the Claude app shows it as a thumbnail in the chat) and give it as a markdown link, `[hero.turnaround-view.png](./hero.turnaround-view.png)`, so one click opens it. In Codex or Cursor, use your own image viewer the same way. Put the canvas link next to it. Never say "done" or "it passed" without showing the picture. On a long job, report each step and each AI check as it happens (see "Keep the person posted"), instead of going quiet until the end.

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
- Draft the options from what you already know (the image, the run that just happened, the skill's checks) so the person mostly picks instead of typing.
- Use `multiSelect` only when several answers can be true at once ("What needs to change?").
- One round at a time. Wait for the answer before the next round or any paid call.

## Workspace skills: the team's saved methods

A workspace skill is a method the team already agreed on. It is stored and runs on the AssetHub server; nothing is copied to this computer. Always read the live list.

```bash
assethub skills list --runnable      # free
assethub skills get <skill-id>       # free
```

- `list --runnable` returns only the skills that can run on an image (the same ones the canvas "Use skill" node offers): `skillId`, `summary` (title, then goal), `revision`, `mode`. Plain `skills list` shows everything, including older skills that only guide production runs and cannot run on an image.
- A row with `sameSummaryAs` has a look-alike with the same title. Name both, say how they differ (read both with `get`), and ask which one. Never guess.
- `items` empty: check the staff-shared skills first (step 1 below) before saying there is none; then tell the person the `hint`, in plain words.
- `get` gives the full method: its goal, when to use it, steps, the checks the result is judged against, and the `revision` and `contentSha256` you will pin.

### 1. Before any work, check for a skill

When the person asks you to **make or change** something (an image, a view, parts, a cleanup), look for a team skill first, before planning the work yourself. Skip this only when they already named a skill or only asked a question.

1. **Always** read both lists of candidates, every time, before you decide anything fits or nothing does. Both are free:
   - `assethub skills list --runnable`: the workspace's own skills.
   - `assethub api call "GET /workspace-skills/shares"`: skills AssetHub staff shared (run them as in step 5). Shared skills are **never** in `skills list`, so an empty `skills list --runnable` does not mean there is no skill. Never skip this call. If it is refused (the key is not a staff account), carry on with the workspace's own skills and don't mention the error.

   Then match their request and their image against each title and summary, from both lists.
2. `skills get` the best one to three candidates. Check that the image fits the skill's "when to use" and that its goal is what they asked for.
3. **One or more fit:** ask (the skill and the limit can share one round):

   > **Your team has a skill for this. Use it?**
   > - **Turnaround view (Recommended)**: makes one view from a front image, keeps face, clothes and proportions
   > - **Drecom pose correction**: if you meant fixing the pose to an A-pose
   > - **Do it without a skill**
   >
   > **Spending limit?** Charged to **Personal**. Automatic corrections count toward it.
   > - **170 credits (Recommended)** · **250 credits** · **330 credits**

4. **Nothing fits** (in the workspace's skills or the staff-shared ones): say it once ("Your team doesn't have a skill for this yet, so I'll do it directly.") and continue with the normal work below, still asking before anything paid.

A skill that is `off` cannot run. Say an editor of the workspace can turn it on, and offer the closest runnable one. Never switch a skill on yourself. If the person picks a skill you did not recommend, run it, but say: "Not the recommended skill for this image. Check the result carefully."

### 2. Run it

Running skills is not open to every account yet. If `skills run` answers `Running skills is not available on this account yet.`, tell the person exactly that and stop. Do not try other routes.

There is no up-front price for a skill run; never invent one. Offer **170 credits (Recommended)**, **250** or **330** unless the person names a limit: a skill corrects itself and retries each part, and a 7-part part-separation run uses about 110. These match the canvas "Use skill" default. It only spends what the run uses. The run always needs one, and it is their decision.

```bash
assethub skills run <skill-id> --file ./hero.png --budget 170 --revision <n> --content-sha256 <sha256>
```

- `--file` uploads a picture from this computer to the canvas first; `--image-asset <asset-id>` uses one already in AssetHub instead. Exactly one of the two. With `--image-asset` there is no original folder, so also pass `--out-dir <folder>` (it is created if missing); without it the results stay on the canvas only.
- Without `--wait` it returns as soon as the run starts; then follow it as in "Keep the person posted" below.
- `--revision` / `--content-sha256` come from `skills get`: the version the person approved. If the skill was edited since, the run is refused instead of charged; read it again and ask again.
- `--ask "<text>"` passes the person's own instructions ("keep the scarf"). `--canvas <id>` picks the canvas; without it, the CLI uses one canvas per folder.
- The first stderr line shows the operation ID. **If the command is interrupted, run the identical command again with `--operation-id <that id>`.** It reconnects to the same run; it never starts a second one.
- While it runs, stderr gives one plain line per step and per AI check ("Try 1: Making the image - done.", "AI check (try 1): the fingers look fused. Correcting it automatically."). Pass them on in the person's language.
- **Keep the person posted.** `--wait` only hands you those lines when the run ends, which can be many minutes of silence. For anything that will take more than a minute or two (a skill run, a resume, a shared run), start it **without** `--wait`, then check every minute or so with `assethub skills run-status <skill-id> <run-id> --attempts --out-dir <folder of the original>` (free, never charges). Each time, say what is new in one line ("Hair: try 1 done, the AI check wants the fringe longer; trying again"), and show every new try image it saved. Stop checking when the status is no longer `running`. If your tool can run a command in the background and tell you when it ends, `--wait` in the background is fine too, as long as you still check and report in between.
- When it finishes, verified results are saved **next to the original** as new files (`hero.turnaround-view.png`, then `-2`, `-3`, …). stderr lists each `Saved:` path; the JSON has `saved` and `canvasId`. Nothing is ever overwritten. Open every saved image so it shows in the conversation, before you describe it, with its path as a link and the canvas link.
- Give the canvas link the moment the run starts ("Running on your canvas: https://app.assethub.io/workflow/60180"), from the JSON's `canvasId`, and again with the result.
- The JSON's `next` field says what to do next.

**Statuses:** `running` (still working: check again with `skills run-status <skill-id> <run-id> --wait`, never restart) · `budget_exhausted` (paused, below) · `completed` · `failed` (`outcome.reason` says why) · `cancelled`.

**Lost track of a run?** A new session, a closed window or a laptop that slept knows no run ID. Run `assethub skills run-list` (free): it lists the skill runs started from this folder, newest first, each with its status and the next command. `--file <image>` narrows it to one picture; `--all` shows every folder on this computer. Continue the one the person means with `assethub skills run-status <skill-id> <run-id> --wait` (results are saved next to the original) or `skills run-resume`. Never start a new run for work that may still be running.

**Flat price** (`awaiting_confirmation`, exit 3). Some skills have one fixed price instead of a spending limit: the run first finds the parts for free, then stops and prints them with the price (`quote`). Nothing has been charged yet. Show the parts and the price and ask once:

> **Found 7 parts: wheel, door, … · 86 credits.** Retries are included and failed parts are refunded.
> - **Start (Recommended)** · **Choose parts** · **Cancel**

On Start, confirm with the total you showed: `assethub skills run-confirm <skill-id> <run-id> --total 86 --wait --out-dir <folder of the original>`. With Choose parts, pass `--parts <id,id>` and `--total` = `quote.base` + `quote.perPart` × the number of parts. A `QUOTE_CHANGED` error means the price moved: show the new total and ask again. Use `--yes-up-to <credits>` on `skills run` only when the person named a price they accept in advance. The `--budget` you pass still caps a single-image flat skill: one priced above it is refused with its price, never charged.

**Paused at the limit** (`budget_exhausted`, exit 0). Nothing is lost. Ask with exactly two options:

> - **Raise the limit by 80 and continue (Recommended)**: new limit 250, same run
> - **Keep what's done and stop**

Base the amount on what one step cost so far (`budget.spentCredits`, `budget.remainingCredits`); never quote a number you cannot back. On yes, continue the **same** run:

```bash
assethub skills run-resume <skill-id> <run-id> --add-credits 80 --out-dir <folder of the original>
```

**Failed:** say why in one sentence from `outcome.reason`, and how many credits were used. If the JSON has `rejected` (the run's AI check said no to its last try), go to **When the AI check says no** below. Otherwise ask: **Try again with an extra instruction** (a new run, with its own limit) / **Use another skill** / **Stop for now**. Never retry on your own.

#### When the AI check says no: fix it here

A run can end `failed`, or pause at its limit (`budget_exhausted`), right after its own AI check rejected a try. The JSON then has `rejected: {attempt, reason}`. Don't stop there and don't start a blind new run. Continue the work yourself, in this session:

1. **Save the tries (free):** `assethub skills run-status <skill-id> <run-id> --attempts`. Each image try is saved next to the original as `<name>.<skill>.try<n>-rejected.png` (or `-passed`, `-unchecked`). The JSON's `attempts` lists each path with the check's `reason`.
2. **Look before you judge.** Read the original, the rejected try, and the skill's checks (`acceptanceCriteria` and each step's `checks` from `skills get`). Say in one plain sentence what the check rejected and whether you agree ("The check says the hands are fused with the sleeve; I see the same.").
3. **Ask once** (the price comes from `assethub models get <model-id>`):
   > **The skill's AI check rejected the last try. Fix it here?**
   > - **Fix the rejected try (Recommended)**: one image edit that changes only what the check named, about N credits, charged to <workspace>
   > - **Run the skill again**: a new run with its own limit
   > - **Stop for now**
   For a run paused at its limit, also offer **Raise the limit and let the skill try again** (`run-resume`).
4. **Fix only what was rejected.** Edit the rejected try with the model the skill's image step names (`skills get` → `steps[].run.model`, matched in `assethub models list`), on the run's canvas, saving next to the original:
   `assethub image generate --file <the -rejected.png> --prompt "<what to fix, from the check's reason>; keep everything else exactly as it is: <the skill's preserve rules>" --model-id <model id> --canvas <canvasId> --operation-id <a new UUID you write out> --wait --download --out-dir <folder of the original>`
   If the try is so far off that editing it makes no sense (the wrong subject, everything merged into one image), edit the **original** with the skill's own instruction plus the check's reason instead, and say so.
5. **Check it like the skill would.** Read the new image and go through the skill's `acceptanceCriteria` one by one, `must` first. Tell the person plainly which pass and which don't. Never call it fixed when a `must` still fails.
6. **Show it and ask Looks right / Needs changes**, as in "After the result". At most **two** local fixes per run: if the second still fails a `must`, stop and say what keeps failing. That is a problem with the skill, not something more credits will solve, so suggest telling whoever maintains it.

This does not change the skill or the run. The fixed image is a new file next to the original, never over a try or the original.

### 3. After the result

Show the result, then ask **Looks right** / **Needs changes**. Say that neither changes the skill or spends credits. Record the answer:

```bash
assethub skills run-verdict <skill-id> <run-id> --verdict keep
assethub skills run-verdict <skill-id> <run-id> --verdict not-right --note "jacket colour changed; hair shorter than the concept"
```

Recording is not open to every account yet, and each person records one answer per result (a second answer returns the first and writes nothing). If `run-verdict` is refused, don't mention the error: carry on with the next step below; the answer still steers what you do next.

- **Needs changes:** ask what is off, as a `multiSelect` drafted from the skill's checks and what you see in the image ("Proportions changed", "Colours or clothes changed", "Pose changed"). Record it with `--note`. Say "The skill itself has not changed." Then ask once:

  > **How should I fix it?**
  > - **Fix it here (Recommended)**: one image edit that changes only what you named, about N credits, charged to <workspace>
  > - **Generate again from the original image**: a new run of the skill with its own limit
  > - **Stop for now**

  Offer **Fix it here** only for an image result: it is an image edit, so for a mesh or any other file leave it out and offer the other two. Recommend **Generate again** instead when most of the image is wrong (the wrong subject, pose or outfit overall), since an edit cannot rescue that.
  - **Fix it here:** follow steps 4 and 5 of "When the AI check says no", starting from the saved result instead of a rejected try, with the person's note as the reason. Then show the fix and ask whether it looks right, but don't record it with `run-verdict`: this result already has its answer, and a second one is ignored. The same limit applies: at most two local fixes, each a new file next to the original.
  - **Generate again:** say "The next generation will use: “…”" with the new instructions (they replace the old ones), then start a new paid run with its own limit, passing them as `--ask`.
- **Looks right:** ask what next: the same skill on another image (or the next view), or done. If the result did **not** come from a skill, you may add **Make this a skill** once (it starts the Q&A in "Make a new skill"). Do not offer it again in the same conversation.

### 4. Make a new skill: always a Q&A first

Any request to create a skill starts this interview: "make a skill from this", "save this as our method", "bikin skill buat turnaround", 「スキルにして」, or a skill the person describes from scratch. **Never call `assethub skills build` (not even `--dry-run`) until rounds 1 to 3 are answered and the person has said yes to the summary in round 4.** Do not skip a round because the request already sounds complete. Put what they said into the options as the Recommended answer and let them confirm it.

A skill is learned from real results on a canvas, never from free text alone. Draft every option yourself from what happened (the operations on the canvas, the result they liked, what they corrected), so they mostly pick. Four rounds, one at a time. After each round, say back in one line what you understood ("So: an image skill that makes one side view from a front image, learned from the canvas we just used.") before asking the next.

**No result to learn from yet?** If they describe a skill but no canvas shows it working, say so plainly ("A skill learns from a result you were happy with. Let's make one first."). Then ask: **Do it on one image now (Recommended)** / **Use a canvas where we already did it** (they name it) / **Not now**. With the first choice, do the work normally (asking before anything paid), get their "Looks right", then come back to round 1 with that canvas as the source.

**Use the conversation to steer it.** Before round 1, go back through this conversation and collect what the person decided along the way:
- what they asked for, in their own words;
- every correction they gave ("make the hair longer", "keep the scarf") and every **Needs changes** answer;
- the AI check reasons that made a try go again, and the tries they rejected, with why;
- the result they kept, and what they said about it.

Use these to fill the **Recommended** option in every round, so the interview confirms what they already told you instead of asking it again. In round 3, ask **From our conversation, the skill should also…** as a `multiSelect` of those decisions in plain words (all checked by default), so they can drop anything that was a one-off.

Make sure the decisions on skill runs also exist on the canvas: a **Needs changes** or **Looks right** on a skill run from this conversation that was never recorded gets recorded now with `skills run-verdict <skill-id> <run-id> … --note "<their words>"` (free). The builder reads verdict notes on the canvas as the artist's own judgement, its strongest evidence. `run-verdict` needs a skill run; decisions about other work (an image edit, a generation) travel only in `--instructions`.

If they point to an earlier session ("like we did yesterday"), ask which canvas it was: the canvas keeps every step and verdict. Use what they say or show you about it. Don't go looking through old chat logs.

**Round 1: what kind of skill, and from where.**

- **What kind of skill is this?** Offer the two or three kinds that match what was done (Recommended first). The kind decides the `--task-kind` and the questions in round 2:

  | Say to the person | `--task-kind` |
  |---|---|
  | Image work: clean up a concept, a new view, a style or material | `concept_art` |
  | Splitting a character or object into parts | `part_separation` |
  | Putting parts together into one asset | `part_composition` |
  | Making a 3D model from images | `mesh_generation` |
  | Fixing or preparing a 3D model: retopology, UVs, textures | `mesh_processing` |
  | Rigging or animation | `rigging_animation` |
  | A whole character, start to finish | `character_production` |

- **Which canvas should it learn from?** The one just used (the run's `canvasId`; Recommended), a different canvas (they name it or paste its link), or several (2 to 5).

**Round 2: the goal, and what matters for this kind.** Always ask **What is this skill for?** with two or three one-sentence goals you drafted, each specific about what must stay the same. Then ask the questions for the kind they picked:

| Kind | Ask |
|---|---|
| Image work | **What must stay exactly the same?** (`multiSelect`: face and identity, pose, colours, clothes and accessories, proportions) · **What should the result look like?** (view or framing, background, style) |
| Splitting into parts | **Which parts?** (`multiSelect`, drafted from the parts you saw) · **How should each part come out?** (one part per image on white; fill in hidden areas, or leave them) |
| Putting parts together | **What makes a good join?** (`multiSelect`: no gaps, nothing poking through, original pose kept, sizes kept) |
| Making a 3D model | **How detailed?** (game-ready low poly, high detail, a stylised figure) · **What matters most?** (`multiSelect`: matches the front view, clean silhouette, symmetric) |
| Fixing a 3D model | **What should change?** (`multiSelect`: fewer polygons, clean UVs, textures, fix holes) and the target, such as a polygon budget or texture size |
| Rigging or animation | **What kind of rig?** (humanoid, four-legged, a prop) · **Which animations?** (`multiSelect`, drafted from the canvas) |
| A whole character | **What should come out at the end?** (textured mesh, rigged character, animated character) · **Which stages must the person approve?** |

**Round 3: how to judge it, and when to use it.**
- **A good result must…** (`multiSelect`): concrete, checkable criteria drafted from what they liked and the round 2 answers ("One accessory per image, white background", "Face identical to the concept"). These become the bar the skill's AI check judges against.
- **What kind of images is it for?** ("Pluffy concepts with accessories, front view (Recommended)", "Any mascot with accessories").

**Round 4: read it all back, then price it.** First show everything you understood, in their words, including a short **From our conversation** list, and ask: **That's right (Recommended)** / **Change something**. "Change something" goes back to the round it belongs to. Only after "That's right", write `--instructions` and price it for free.

`--instructions` is read as a list of rules: **each line becomes one numbered finding** that a step or check of the skill must carry. Write one decision per line (4000 characters at most), saying where it came from, in English:

```text
Artist asked: one accessory per image, exactly as in the concept.
Artist corrected: keep the scarf's stripe pattern; the first try dropped it.
Rejected: try 1, the bag strap was cut off at the edge.
Kept: try 2, all three accessories on white with nothing added.
Must: white background; same shape and colour as the concept; nothing that is not in the concept.
Use on: Pluffy concepts with accessories, front view.
```

Write these lines to a file (for example `instructions.txt` next to the image) and pass `--instructions "@instructions.txt"`. Never put line breaks inside a command-line argument: PowerShell and cmd.exe break them. Put every `@file` argument in double quotes (`"@instructions.txt"`): unquoted, PowerShell reads `@name` as splatting and the CLI never sees the file. Decisions only: never paste the conversation itself, file paths, ids, or anything private.

```bash
assethub skills build --goal "<goal>" --canvas <id> --task-kind <kind> --instructions "@instructions.txt" --dry-run
```

Ask with a summary card: the skill's name, the kind (in the person's words), what it learns from, the goal, the criteria, what it is for, `estimatedCredits`, and the time budget the dry run gives. Options: **Build it now (Recommended)** / **Change something** / **Cancel**.

**Build**, only after a yes, with a new operation ID; reuse that ID after any interruption:

```bash
assethub skills build --goal "<goal>" --canvas <id> --task-kind <kind> --instructions "@instructions.txt" --operation-id <uuid> --wait
```

`--wait` returns when the draft is `ready` for review, or the build failed (say why from `error`; the reserved credits go back). Explain the draft in plain words: what it does step by step, and what it checks. If the builder chose a different kind than the person picked, its `uncertainties` say why; tell them. Then ask **Save it (Recommended)** / **Change one part first** / **Discard**.

- Save: `assethub skills build-accept <build-id> --draft-sha256 <the draft's contentSha256>`. The hash is the draft you showed; if it changed, the save is refused instead of publishing something nobody read.
- Change one part: `assethub skills build-enhance <build-id> --section <section> --current "@current.json" --note "<what to change>"` (write the section's current JSON to `current.json` first) returns a suggestion only; the CLI cannot apply it to the draft. Show it, then ask: **Save now and edit that part on the skill's page in AssetHub** / **Build again with the change in the instructions** (a new paid build).
- Discard: `assethub skills build-discard <build-id>`.

After it is saved, ask in one round what to do next: **Try it on another image (Recommended)** (back to "Run it"), **Share it with AssetHub staff** (only for a staff account, and only once a result has been marked keep; see step 5), or **That's all**. The person should never have to know that sharing exists or type it themselves.

- `TASK_KIND_NOT_SUPPORTED`: this account can only build part-separation skills for now. Say so plainly. Never rebuild the same idea as part separation to get around it.
- 403: an editor of the workspace has to build it.

### 5. Share a skill with AssetHub staff (staff accounts only)

This is only for AssetHub staff accounts. If `assethub api search staff` finds nothing, this key cannot share; say so and stop. Sharing lets every staff member run one tested revision in their own workspace, and each run is charged to the workspace it runs in. Only an editor of the skill's workspace can share it (for a personal skill, its artist). Official skills and customized copies of them cannot be shared (422 `SKILL_NOT_SHAREABLE`).

Offer this yourself: after a skill is saved, and again after its first result is marked keep ("Your team can use this now. Share it with all AssetHub staff too?"). Also do it when the person asks ("share it with staff", "publish it to the team"):

1. `assethub skills get <skill-id>` gives the `revision` and `contentSha256`. Share a revision that already has a result marked keep, not a draft nobody has tried. If it has none, offer to try it on an image first.
2. Ask once: **Share revision N with AssetHub staff (Recommended)** / **Try it on an image first** / **Not now**. Name the skill and the revision, and say that staff run it at their own cost.
3. Share it. It is free. Sharing a newer revision later moves the share to that revision. Write `skill.json` as `{"skillId": "<skill-id>"}` and `share.json` as `{"revision": <n>, "contentSha256": "<sha256>"}`, then:

```bash
assethub api call "PUT /workspace-skills/{skillId}/staff-share" --path-json "@skill.json" --input-json "@share.json" --operation-id <a new UUID you write out>
```

Every change here (share, stop) needs its own `--operation-id`; after an unclear answer, repeat the same command with the same ID. 409 `WORKSPACE_SKILL_CONFLICT` means the skill changed since you read it: read it again and ask again. Never retry with a new hash on your own.

- Check what is shared: `assethub api call "GET /workspace-skills/{skillId}/staff-share" --path-json "@skill.json"` (`revision` is `null` when it is not shared).
- Stop sharing ("stop sharing it", "unshare"): `assethub api call "POST /workspace-skills/{skillId}/staff-share/stop" --path-json "@skill.json" --operation-id <a new UUID you write out>`. Staff can then no longer start or resume runs of it. Results they already have stay.

**Staff running a skill someone shared.** Shared skills are not in `skills list`, so step 1 of "Before any work" always reads `assethub api call "GET /workspace-skills/shares"` too; the person never has to name one. On a canvas, staff pick them in the Use skill node. From the CLI, ask the same one round (skill and limit), put the image on a canvas of this workspace (`assethub canvas import --canvas <id> --file <image>` returns its `assetId`; with no canvas yet, make one with `assethub api call "POST /canvases" --input-json "@canvas.json" --operation-id <uuid>`, where `canvas.json` is `{"name": "<name>", "clientOperationId": "<that uuid>"}`), then start the run with a new operation ID. Write `share-id.json` as `{"shareId": "<share-id>"}` and `run.json` as `{"clientOperationId": "<uuid>", "canvasId": <id>, "sourceImageAssetId": "<asset-id>", "budgetCredits": <n>, "executionContext": {"canvasId": <id>, "clientOperationId": "<the same uuid>", "source": "cli"}}`. Always send `executionContext`: without it the run never appears in the canvas's history, and the person sees an empty canvas. Give the person the canvas link (`https://app.assethub.io/workflow/<canvasId>`) as soon as it starts. Then:

```bash
assethub api call "POST /workspace-skills/shares/{shareId}/runs" --path-json "@share-id.json" --input-json "@run.json" --operation-id <the same uuid>
```

Follow it with `assethub skills run-status <the returned skillId> <runId> --wait --out-dir .`, and record the verdict with `skills run-verdict` as usual. 409 `SHARE_STOPPED` means the owner stopped sharing it: say so, and offer the workspace's own skills instead.

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
- `skills run` always needs `--budget`; there is no default.
- There is no balance command; find the credit routes with `assethub api search credit`.
- Prefer a dedicated, scoped API key for agent work over a full-access one.

## When something goes wrong

| What you see | What to do |
|---|---|
| Exit 3, or the command was interrupted | Continue the same job: `runs resume <operation-id>`, `skills run-status`, or rerun with the same `--operation-id`. Never start fresh. |
| A run failed or paused with `rejected` (its AI check said no) | `skills run-status <skill-id> <run-id> --attempts`, then fix the rejected try here: see "When the AI check says no". |
| "What happened to my run?" in a new session | `assethub skills run-list` (this folder) or `--all`, then `skills run-status <skill-id> <run-id> --wait`. |
| `Running skills is not available on this account yet.` | Tell the person exactly that. Stop. |
| A skill run refused because the version changed | `skills get` again, describe what changed, ask again before running. |
| `budget_exhausted` | Offer "Raise the limit by x and continue" or "Keep this try and stop"; resume the same run. |
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

The hosted MCP (`https://app.assethub.io/api/mcp`) exposes the same API. `capabilities_get` ↔ `capabilities`; `workspace_skill_list` / `workspace_skill_get` ↔ `skills list` / `get`; `operation_search` / `operation_describe` / `operation_call` ↔ `api search` / `describe` / `call` (skill runs: `operation_call` with `POST /workspace-skills/{skillId}/runs`, then `GET …/runs/{runId}`, `POST …/resume`, `POST …/verdict`); `job_poll` ↔ `jobs watch`; `evaluation_submit` ↔ `evaluations submit`. Whichever you use, the golden rules are the same.

## Diagnose

```bash
assethub doctor --mcp
assethub --version
```

`doctor` checks the key, the workspace, and MCP tool discovery without spending credits.
