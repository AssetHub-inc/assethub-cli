<!-- assethub-staff-guide: added by the CLI for AssetHub staff accounts; never edit by hand -->

## Skill rules (staff)

- **Check the team's skills before you work.** A request to make or change something starts with `skills list --runnable` (free; it lists every skill this account can run, staff-shared ones included, see "Before any work"). The team's method beats one you invent.
- **A new skill always starts with an interview.** However the request is worded, and however much it already says, ask the rounds in "Make a new skill" and read the answers back before anything is built.
- **Run a skill as written.** Start it with `skills run`. Never copy a skill's steps into your own prompt, reword them, or swap its model on your own (models the person names go in `--mesh-model` / `--image-model`): the skill's exact wording is what keeps its rules (agents that rewrote it broke them). The person's own wishes go in `--ask`.

## Workspace skills: the team's saved methods

A workspace skill is a method the team already agreed on. It is stored and runs on the AssetHub server; nothing is copied to this computer. Always read the live list.

```bash
assethub skills list --runnable      # free
assethub skills get <skill-id>       # free
```

- `list --runnable` returns every skill this account can run on an image, in one list: `skillId`, `summary` (title, then goal), `revision`, `mode`, and `source`: `workspace` (the workspace's own and installed skills, official V8 goal skills included), `staff-share` (shared to AssetHub staff, staff accounts only; `sharedFrom` names the workspace) or `showcase` (an official skill installed on its first run). `official` / `staffOnly` mark AssetHub official skills, `goal` a goal skill. Run any of them the same way, with `skills run <skillId>`. Plain `skills list` shows only the workspace's own skills, including older ones that only guide production runs and cannot run on an image.
- A row with `sameSummaryAs` has a look-alike with the same title. Name both, say how they differ (read both with `get`), and ask which one. Never guess.
- `items` empty: tell the person the `hint`, in plain words.
- `get` gives the full method: its goal, when to use it, steps, the checks the result is judged against, and the `revision` and `contentSha256` you will pin. For an official goal skill not installed yet, or a skill shared to staff, the full method cannot be read before it runs here: `get` then returns its list entry with `fullMethod: false`. Judge it from its `summary` (and `recommendedModels`), say so in one line, and run it without `--revision` / `--content-sha256`.

### 1. Before any work, check for a skill

When the person asks you to **make or change** something (an image, a view, parts, a cleanup), look for a team skill first, before planning the work yourself. Skip this only when they already named a skill or only asked a question.

1. **Always** read `assethub skills list --runnable` (free) before you decide anything fits or nothing does. It is the one list of candidates: the workspace's own skills, official ones and, for staff, the skills shared to staff.

   Then match their request and their image against each title and summary.
2. `skills get` the best one to three candidates. Check that the image fits the skill's "when to use" and that its goal is what they asked for (from the summary when `fullMethod` is `false`).
3. **One or more fit:** ask in one round. Add the spending-limit question only for a skill that takes one (see "Run it"); never for a goal skill (`goal: true`). For a goal skill, add one line with its models: Auto, then the names from its `recommendedModels` (names from `assethub models list`).

   > **Your team has a skill for this. Use it?**
   > - **Turnaround view (Recommended)**: makes one view from a front image, keeps face, clothes and proportions
   > - **Pose correction**: if you meant fixing the pose to an A-pose
   > - **Do it without a skill**
   >
   > Models: **Auto** (the skill picks from Meshy V7.1, Hunyuan3D 3.1, Hi3D v3.0 Quality). Name one if you want it.
   > Charged to **<selected workspace name>**. A skill run has no price up front; it stops and asks before spending past its limit.

4. **Nothing fits** (nothing in `skills list --runnable`): say it once ("Your team doesn't have a skill for this yet, so I'll do it directly.") and continue with the normal work below, still asking before anything paid.

A skill that is `off` cannot run. Say an editor of the workspace can turn it on, and offer the closest runnable one. Never switch a skill on yourself. If the person picks a skill you did not recommend, run it, but say: "Not the recommended skill for this image. Check the result carefully."

### 2. Run it

Running skills is not open to every account yet. If `skills run` answers `Running skills is not available on this account yet.`, tell the person exactly that and stop. Do not try other routes.

There is no up-front price for a skill run; never invent one. Spending limits:

- **Goal skills (`goal: true`, official ones included) take no limit.** Never pass `--budget` and never ask for one. The server stops the run each time it has used 5000 credits (`budget_exhausted`) and you ask whether to continue.
- **Step skills:** start without `--budget` too. On more and more accounts the limit is internal, like a goal skill's. Only if the start answers 422 `SKILL_RUN_BUDGET_REQUIRED` (nothing is charged), ask for a limit: **500 credits (Recommended)**, **750** or **1000** unless the person names one (a skill corrects itself and retries each part; 150 to 200 ran out halfway through real part-separation runs; it only spends what the run uses). Then run the identical command again with `--budget <n>`.

```bash
assethub skills run <skill-id> --file ./hero.png --revision <n> --content-sha256 <sha256>
```

- `--file` uploads a picture from this computer to the canvas first; `--image-asset <asset-id>` uses one already in AssetHub instead. Exactly one of the two. With `--image-asset` there is no original folder, so also pass `--out-dir <folder>` (it is created if missing); without it the results stay on the canvas only.
- Without `--wait` it returns as soon as the run starts; then follow it as in "Keep the person posted" below.
- `--revision` / `--content-sha256` come from `skills get`: the version the person approved. If the skill was edited since, the run is refused instead of charged; read it again and ask again.
- `--ask "<text>"` passes the person's own instructions ("keep the scarf"). `--canvas <id>` picks the canvas; without it, the CLI uses one canvas per folder.
- Models (goal skills only): Auto is the default; pass no flag for it. When the person names a model, in the ask or later, pass `--mesh-model <id>` / `--image-model <id>` (repeat for more; ids and names from `assethub models list --domain meshGen` or `--domain imageGen`; any listed model works, not only the recommended ones). Never offer models for a skill with fixed steps: it refuses the flags before anything is charged.
- The first stderr line shows the operation ID. **If the command is interrupted, run the identical command again with `--operation-id <that id>`.** It reconnects to the same run; it never starts a second one.
- While it runs, stderr gives one plain line per step and per AI check ("Try 1: Making the image - done.", "AI check (try 1): the fingers look fused. Correcting it automatically."). Pass them on in the person's language.
- **Keep the person posted.** `--wait` only hands you those lines when the run ends, which can be many minutes of silence. For anything that will take more than a minute or two (a skill run, a resume, a shared run), start it **without** `--wait`, then check every minute or so with `assethub skills run-status <skill-id> <run-id> --attempts --out-dir <folder of the original>` (free, never charges). Each time, say what is new in one line ("Hair: try 1 done, the AI check wants the fringe longer; trying again"), and show every new try image it saved. Stop checking when the status is no longer `running`. If your tool can run a command in the background and tell you when it ends, `--wait` in the background is fine too, as long as you still check and report in between.
- When it finishes, verified results are saved **next to the original** as new files (`hero.turnaround-view.png`, then `-2`, `-3`, …). stderr lists each `Saved:` path; the JSON has `saved` and `canvasId`. Nothing is ever overwritten. Open every saved image so it shows in the conversation, before you describe it, with its path as a link and the canvas link.
- Give the canvas link the moment the run starts ("Running on your canvas: https://app.assethub.io/workflow/60180"), from the JSON's `canvasId`, and again with the result.
- The JSON's `next` field says what to do next.

**Statuses:** `running` (still working: check again with `skills run-status <skill-id> <run-id> --wait`, never restart) · `budget_exhausted` (paused, below) · `completed` · `failed` (`outcome.reason` says why) · `cancelled`.

**Lost track of a run?** A new session, a closed window or a laptop that slept knows no run ID. Run `assethub skills run-list` (free): it lists the skill runs started from this folder, newest first, each with its status and the next command. `--file <image>` narrows it to one picture; `--all` shows every folder on this computer. Continue the one the person means with `assethub skills run-status <skill-id> <run-id> --wait` (results are saved next to the original) or `skills run-resume`. Never start a new run for work that may still be running.

**Paused at the limit** (`budget_exhausted`, exit 0). Nothing is lost. Say what it used so far (`budget.spentCredits`) and ask with exactly two options:

> - **Continue (Recommended)**: same run, up to another 5000 credits
> - **Keep what's done and stop**

On yes, continue the **same** run:

```bash
assethub skills run-resume <skill-id> <run-id> --out-dir <folder of the original>
```

Only a run started with `--budget` needs an amount to continue: offer **Raise the limit by 250 and continue** (based on what one step cost so far; never quote a number you cannot back) and pass `--add-credits 250`. If a resume answers that it needs `addCredits`, ask the same way.

**Failed:** say why in one sentence from `outcome.reason`, and how many credits were used. If the JSON has `rejected` (the run's AI check said no to its last try), go to **When the AI check says no** below. Otherwise ask: **Try again with an extra instruction** (a new run, with its own limit) / **Use another skill** / **Stop for now**. Never retry on your own.

#### Goal skills (V8): questions, stopping, your own

A row with `goal: true` in `skills list --runnable` is a goal skill: it plans its own steps toward a goal and judges the result against its checks. Official ones are goal skills. Start it like any other with `skills run <skillId>`; no `--goal` flag and no install step (an official one installs on its first run). While a `--wait` runs, stderr says `Now: <step>` and `Check "<name>" passed|failed (try n)`; when you check with `run-status` instead, the same is in the JSON's `goal.now` and `goal.checks` (`verdict`, `tries`, `note`). Pass them on in the person's language.

- **It asked a question.** The run pauses (`goal.result: "waiting"`, exit 0) and stderr prints `Needs your answer: <question> Answer with: assethub skills run-answer <skill-id> <run-id> --answer <option>`, with the other options after it. Ask the person exactly that question, with those options, one round. Never answer it yourself. Then continue the **same** run:

  ```bash
  assethub skills run-answer <skill-id> <run-id> --answer <their choice, as the CLI quoted it> --out-dir <folder of the original>
  ```

  The options come from the run, not from the person, so copy the chosen one exactly as the `Needs your answer` line quoted it (the CLI wraps each option in single quotes). Never put an option inside double quotes and never retype it: a `$(...)` or backtick inside one would run in the shell.

  Without `--wait` it returns once the answer is in; follow it with `skills run-status` as above.
- **Stop it** ("stop", "that's enough", "keep what you have"): `assethub skills run-stop <skill-id> <run-id> --out-dir <folder of the original>`. It stops after its current step, keeps everything made so far and ends `cancelled`. Ask first only when the person did not ask for it.
- **How it ended** (`goal.result`): `completed` (all checks passed) · `needs_review` (some checks were not judged; not checked is not passed, so look the result over with the person) · `failed` (checks failed; say which from the `Check` lines and `goal.reason`) · `budget_exhausted` (paused; `run-resume` as above) · `cancelled`. A goal run that ends without a verified result still saves its drafts to `--out-dir`, named as tries; show them and say they were not verified.
- **The person's own goal skill** (a folder with `skill.json` of `schemaVersion: "ag.memory-skill.v8"` and an optional `references/` folder): `assethub skills import-goal <folder>` stores it in the workspace (free). It then shows in `skills list --runnable`; run it with `skills run <skillId>`. Import only a folder the person gave you; never write or change a `skill.json` for them.

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
- **What kind of images is it for?** ("Mascot concepts with accessories, front view (Recommended)", "Any mascot with accessories").

**Round 4: read it all back, then price it.** First show everything you understood, in their words, including a short **From our conversation** list, and ask: **That's right (Recommended)** / **Change something**. "Change something" goes back to the round it belongs to. Only after "That's right", write `--instructions` and price it for free.

`--instructions` is read as a list of rules: **each line becomes one numbered finding** that a step or check of the skill must carry. Write one decision per line (4000 characters at most), saying where it came from, in English:

```text
Artist asked: one accessory per image, exactly as in the concept.
Artist corrected: keep the scarf's stripe pattern; the first try dropped it.
Rejected: try 1, the bag strap was cut off at the edge.
Kept: try 2, all three accessories on white with nothing added.
Must: white background; same shape and colour as the concept; nothing that is not in the concept.
Use on: Mascot concepts with accessories, front view.
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

**Staff running a skill someone shared.** Shared skills are in `skills list --runnable` with `source: "staff-share"`; the person never has to name one. On a canvas, staff pick them in the Use skill node. From the CLI, run one like any other skill, with the same one round: `assethub skills run <skillId> --file <image>` (a limit only if the start asks for one, as in "Run it"). The CLI starts it through its share, in this workspace, which pays. Follow it with `skills run-status` and record the verdict with `skills run-verdict` as usual. 409 `SHARE_STOPPED` means the owner stopped sharing it: say so, and offer the workspace's own skills instead.

### Skill runs: when something goes wrong

| What you see | What to do |
|---|---|
| A run failed or paused with `rejected` (its AI check said no) | `skills run-status <skill-id> <run-id> --attempts`, then fix the rejected try here: see "When the AI check says no". |
| "What happened to my run?" in a new session | `assethub skills run-list` (this folder) or `--all`, then `skills run-status <skill-id> <run-id> --wait`. |
| `Running skills is not available on this account yet.` | Tell the person exactly that. Stop. |
| A skill run refused because the version changed | `skills get` again, describe what changed, ask again before running. |
| `budget_exhausted` | Offer "Continue" (or "Raise the limit by x" for a run started with `--budget`) or "Keep this try and stop"; resume the same run. |
| Exit 3 on a skill run | `skills run-status <skill-id> <run-id>` or `skills run-resume`; never start a new run. |

- `skills run` takes no `--budget` for a goal skill; a step skill needs one only when the start answers 422 `SKILL_RUN_BUDGET_REQUIRED`. Either way a run stops to ask before going past its limit.
- Over MCP: `workspace_skill_list` / `workspace_skill_get` ↔ `skills list` / `get`; skill runs: `operation_call` with `POST /workspace-skills/{skillId}/runs`, then `GET …/runs/{runId}`, `POST …/resume`, `POST …/verdict`.
