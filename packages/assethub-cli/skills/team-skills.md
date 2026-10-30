<!-- assethub-team-skills: added by the CLI for accounts with team skills; never edit by hand -->

## Team skills: your team's agent skills, versioned in AssetHub

A team skill is an ordinary skill folder (`SKILL.md` plus `scripts/` and `references/`) kept in the AssetHub workspace with numbered revisions. It runs here, on the person's computer, in Claude Code, Codex or Cursor. It is not the workspace skill learned from a canvas (`skills build`, `skills run`): if they say "save skill" about a SKILL.md folder or plugin, it is this; if they mean a method learned from a canvas result, it is that. Unsure: ask that one question.

**Check the team's skills on every new request (free).** When the person asks for something new (a new ask, a new image or file to work on, a new task; not a follow-up, retry or answer inside the current one), first run `assethub skills pull --quiet`, then look through the installed team skills for one that fits the request and use it if one does. It installs the newest team skills into this computer's agents and prints one line per change; tell the person those lines once. Skip the check when they are continuing the current task. Nothing it downloads is run. A copy they changed is kept: offer **Keep mine and share it** / **Use the team's** (`skills pull --replace-local <id>`).

**Save a skill: it is shared with everyone in the workspace, so always ask.** When they say "save skill", "simpan skill", "push my skill", "share my plugin" or 「スキルを保存」:

1. Put everything in the folder: scripts in `scripts/`, notes in `references/`, and paths that differ per computer in `local.json` beside SKILL.md (never sent).
2. `assethub skills push <folder>` without `--yes`. It sends nothing, lists the files, and blocks keys, private links and paths on one computer. Fix the blockers.
3. Show the person the files (the full text of any new or changed script) and ask: **Share this with everyone in the workspace (they get it on their next pull)** / **Only keep it here**.
4. Only after they say yes to this push: `assethub skills push <folder> --note "<what changed, in their words>" --yes`. Never pass `--yes` without that answer; a yes for an earlier push does not count. Never offer to save a skill on your own.
5. Say the result in one line. If a teammate saved a newer revision first, say who and what, and ask: **Get theirs first** (`skills pull`) / **Save mine on top** (rerun with `--on-top`).

A Claude Code plugin folder saves each of its skills with the plugin's name and version; its hooks and commands are not sent. Go back to an older revision with `assethub skills use <id>@<n>`; follow the newest again with `<id>@latest`.
