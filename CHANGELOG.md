# Changelog

## CLI 0.1.11 / API client 0.1.5

- Search historical UI meshes, including parts and revisions, and download owned mesh assets.
- List and export stored artifact graphs; inspect ancestors and descendants by graph ID.
- Preserve canvas execution history commands and workspace ownership boundaries.

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
