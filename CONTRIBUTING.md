# Contributing

Open an issue with the command, CLI version, operating system, expected result,
and redacted output. Use pull requests against `main` for changes. Never include
API keys, project source files, or customer data in reports or fixtures.

Run `npm ci` and `npm run check` before submitting. The CLI and SDK are npm
workspaces; shared development dependencies live at the repository root.

For remote product actions, follow the shared [feature parity skill](.claude/skills/assethub-feature-parity/SKILL.md)
and [cross-repository development guide](docs/feature-parity-development.md).
The application repository owns the server, OpenAPI, MCP, and hosted chat;
this repository owns the packages users install from npm.

# Releasing

1. Review the package changes, update the affected `package.json` versions and
   `CHANGELOG.md`, then run `npm install --package-lock-only` and `npm run check`.
2. Keep shared package changes coordinated with the application repository.
   Only public CLI/SDK code and synthetic fixtures belong in this repository.
3. Merge the reviewed changes into `main` and wait for CI.
4. Run the **Publish packages** workflow from `main`, selecting `api-client` or
   `cli`. Publish the SDK first if the CLI requires its new version.
5. The workflow builds, tests, packs, publishes with npm OIDC provenance, and
   creates a GitHub Release containing the package tarball, then waits about ten
   minutes for an anonymous registry download matching that tarball. Verify the published
   package from a clean install before announcing it.

The publish workflow uses the GitHub environment `npm`. Each npm package must
trust organization `AssetHub-inc`, repository `assethub-cli`, workflow
`publish.yml`, environment `npm`, with direct publishing allowed. No stored npm
token is needed. The workflow only runs on `main`; rerunning an already published
version fails rather than replacing it. If npm publication succeeds but GitHub
Release creation fails, create the missing release for the same commit and
published tarball instead of changing the npm version just to retry the release.

If only the final registry check times out, verify the existing npm version and
GitHub Release again after registry processing finishes. Do not republish it.
