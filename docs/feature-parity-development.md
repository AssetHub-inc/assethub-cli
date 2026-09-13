# Feature parity development

Use the [shared feature parity skill](../.claude/skills/assethub-feature-parity/SKILL.md)
for new or materially changed remote product actions. Classify the change as an
advertised operation, a special non-OpenAPI capability, an ML contract change,
or an excluded UI/local-only change.

## Repository responsibilities

`assethub-web` owns the server operations, versioned OpenAPI, MCP, and hosted
chat. `assethub-cli` owns the npm CLI and SDK distributed to users. `assethub-ml`
owns ML component contracts. Coordinate matching changes in each affected
repository; changing an embedded Web package does not update the installed CLI.
Keep the feature parity skill identical in all three repositories.

The SDK operation gateway reads the authenticated server catalog. CLI `api`
commands, hosted MCP `operation_*`, and chat use that same contract. Do not add
a second permission policy or operation manifest. The server enforces current
membership, gates, billing, input validation, and idempotency.

Preserve exact operation/run IDs and terminal receipts, including partial and
uncertain outcomes. A generic call executes one advertised JSON operation;
queued work still needs its documented status API. Local file transfer and
browser interaction require their existing explicit adapters. AI evaluation
does not supply a human creator decision.

## Verification and release

Run `npm ci` and `npm run check` here. In the coordinated Web checkout, run its
structural guard with that PR's changed-file list:

```sh
node scripts/ci/check-feature-parity.mjs --files-json /tmp/pr-files.json
node --test scripts/ci/__tests__/check-feature-parity.test.mjs
```

Use `--special <name>` for special non-OpenAPI capabilities. That guard checks
Web wiring and changed-file evidence; it does not validate a standalone npm
release or prove product behavior.

Record the same actor, workspace, environment, gates, and existing operation
IDs when exercising CLI, MCP, and chat. For mutations, keep the caller-supplied
UUID and exact inputs across uncertain responses; inspect the original run
before any retry. Report untested variants rather than claiming parity from CI.

| Surface | Contract or invocation | Test evidence | Live operation/run and result |
| --- | --- | --- | --- |
| Server/OpenAPI | Web PR and method/path | route/contract tests | environment and response |
| CLI/SDK | standalone PR and exact command | build and adapter tests | operation/run and terminal result |
| MCP | exact hosted tool call | Web adapter tests | operation/run and terminal result |
| Chat | prompt and tool receipt | Web chat tests | operation/run and rendered result |

Coordinate the server deployment before advertising new capabilities. Follow
[the release procedure](../CONTRIBUTING.md#releasing): bump affected versions
and the lockfile, publish the SDK first, publish the CLI, then verify both from
a clean registry install. Do not publish from a feature branch.
