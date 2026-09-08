# AssetHub CLI and TypeScript SDK

Use AssetHub from your terminal or TypeScript applications. Generate image and
3D assets, manage canvases, keep generation history, and reuse project context.

| Package | Purpose |
| --- | --- |
| [`@assethub/cli`](https://www.npmjs.com/package/@assethub/cli) | The `assethub` command |
| [`@assethub/api-client`](https://www.npmjs.com/package/@assethub/api-client) | Typed client for the public API |

## Install and connect

Use Node.js 22.14 or newer and npm.

```sh
npm install -g @assethub/cli
assethub auth login --api-key-stdin
assethub doctor --mcp
```

Create a workspace API key in [AssetHub](https://app.assethub.io), run the login
command, paste the key, and finish standard input with Ctrl+D on macOS/Linux or
Ctrl+Z then Enter on Windows. The key selects the workspace for API operations.
Do not put keys in issue reports, committed files, or command arguments.

`capabilities` reports the operations available to your account. Some features
are in Internal preview. Generation and analysis use workspace credits.

```sh
assethub models list
assethub canvas list
assethub --help
```

See the [CLI reference](packages/assethub-cli/README.md) for generation, source
imports, moodboards, versioned context, comparisons, retries, and evaluations.

## Diagnose connections and create MCP configuration

```sh
assethub --version
assethub doctor --profile my-workspace
assethub doctor --mcp --profile my-workspace
assethub mcp config --client cursor
assethub mcp config --client codex
```

`doctor` reports the authenticated workspace, API access, and optional MCP tool
discovery as JSON. It explains rejected keys, unavailable MCP access, rate limits,
and network timeouts. It does not run tools or spend generation credits. Exit 2
means a check failed; use `--timeout-ms 30000` for a slower connection.

MCP configuration prints Cursor JSON or a Codex TOML section. Merge it into your
existing user configuration; it does not modify any settings. Both clients read
`ASSETHUB_API_KEY` from their launch environment. No key is printed or embedded.
CLI saved profiles and the AI client's environment are separate; use the same
workspace key in both. `--base-url` supports custom HTTPS origins and localhost.

An explicit `--profile` selects that profile's key and API origin even when the
shell contains another workspace's environment variables. A missing explicit
profile fails instead of switching accounts. Without `--profile`, an environment
key still takes precedence over the default saved profile. `--api-key` and
`--base-url` remain explicit overrides.

## TypeScript SDK

```sh
npm install @assethub/api-client
```

```ts
import {createAssetHubClient} from '@assethub/api-client'

const client = createAssetHubClient({apiKey: process.env.ASSETHUB_API_KEY!})
const models = await client.v2.listModels()
console.log(models)
```

The API key belongs in a trusted server or local process. See the
[SDK reference](packages/assethub-api-client/README.md) and
[API documentation](https://app.assethub.io/docs/api).

## Connect an AI coding tool with MCP

AssetHub provides a hosted MCP endpoint at `https://app.assethub.io/api/mcp`.
There is no local MCP package to install. The
[CLI & MCP setup page](https://app.assethub.io/developer-tools) includes Cursor
and Codex configuration. That page and hosted MCP access are currently in
Internal preview; the API key creator must have MCP access.

## Development

```sh
npm ci
npm run check
node packages/assethub-cli/dist/index.js --help
```

`check` builds both packages, typechecks them, and runs their tests. Tests use
local fixtures and mocked API responses; they do not require an AssetHub key or
start paid generations. Python 3 is required for source-ingestion tests. Optional
PDF/video ingestion tools are documented in the CLI reference.

This repository contains the public distribution sources, beginning with the
CLI 0.1.7 and SDK 0.1.2 releases. It has no dependency on the private application
checkout. Legacy internal workspace commands and the experimental autopilot demo
are unavailable in the standalone distribution, as in CLI 0.1.7.

[Contributing and releases](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) ·
[Report an issue](https://github.com/AssetHub-inc/assethub-cli/issues) ·
[MIT license](LICENSE)
