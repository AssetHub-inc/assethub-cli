# AssetHub CLI agent rules

Before designing, implementing, or reviewing a new or materially changed remote
product action, read [the feature parity skill](.claude/skills/assethub-feature-parity/SKILL.md)
and [the development guide](docs/feature-parity-development.md).

The application repository owns server/OpenAPI, MCP, and hosted chat contracts;
this repository owns the published CLI and SDK. Coordinate matching changes and
evidence across repositories. Keep the skill copy byte-for-byte synchronized
with `assethub-web` and `assethub-ml`; `.agents/skills` exposes that copy.

Preserve actor/workspace scope, gates, billing, operation IDs, and terminal
recovery. Do not treat a workspace key's minter as the current user or replay a
paid operation because its response was uncertain. Only the user makes a
creator approval decision.

Use isolated worktrees, target PRs at `main`, and run `npm run check` before
submission. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for versioning and publication.
