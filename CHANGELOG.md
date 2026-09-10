# Changelog

## CLI 0.1.18 / API client 0.1.9

- Download owned canvas images, meshes, and available generation/edit history with `canvas download`, optionally scoped to a mesh.
- Preserve recorded generation inputs and distinguish missing evidence from current canvas connections.
- Write local HTML, Markdown, and a JSON manifest with file hashes; retain successful files and report individual download failures.
- Require the canvas handoff feature to be enabled for the authenticated account.

## CLI 0.1.17

- Synchronize the existing Internal V3.6.4 Fast Analysis API and CLI aliases.
- Cover graph splitting, recovery and classic-flag rejection for V3.6.1, V3.6.3 and V3.6.4.
- Preserve version aliases and defaults; use the API catalog to discover availability.

## CLI 0.1.16

- Accept the existing Internal V3.6.3 Fast Analysis graph split through `parts split` and `production analyze`.
- Retain V3.6.1, existing defaults, graph history, operation recovery and rejection of classic-only continuation flags.
- Clarify that completed native refinement still requires visual review.

## CLI 0.1.15 / API client 0.1.8

- Run native Composer Standard, Thorough, Placement, Workshop and Blender refinement through the CLI/API.
- Resume from actual mesh revisions, transforms and volume centroids; record each round in canvas history.
- Discover mode availability and enforce native round limits; preserve incomplete results as needing review.

## CLI 0.1.14 / API client 0.1.7

- Document public access to CLI, hosted MCP, canvas history, and team management.
- Retain workspace ownership, admin permissions, MFA, and feature-specific availability.

## CLI 0.1.13 / API client 0.1.6

- Invite, list, change roles, and remove team members using user authentication.
- Preserve existing roles on invitations; provide explicit email resend and MFA/IP enforcement.
- Configure and discover the account-authenticated MCP workspace server with `--account`.

## CLI 0.1.12 / API client 0.1.5

- Search historical UI meshes, including parts and revisions, and download owned mesh assets.
- List and export stored artifact graphs; inspect ancestors and descendants by graph ID.
- Preserve canvas execution history commands and workspace ownership boundaries.

## CLI 0.1.11

- Discover live MCP tools with `mcp tools` and inspect input schemas with `mcp tools <name>`.
- Reuse bounded, authenticated discovery without invoking tools or generating assets.

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
