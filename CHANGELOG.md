# Changelog

## CLI 0.1.9

- Add `doctor` to check API access and the workspace, plus optional MCP tool discovery.
- Add `mcp config --client cursor|codex` with environment-based credentials.
- Add `--version` for support and installation checks.
- Honor an explicit auth profile ahead of stale environment credentials and origin; reject missing profiles.
- Use the saved default profile when no environment key or explicit profile is supplied; log out of that same saved profile.
- Verify actual npm tarball availability and integrity during publishing.

## CLI 0.1.8 / API client 0.1.3

- Publish the CLI and TypeScript SDK sources in their own GitHub repository.
- Add repository, homepage, and issue links to npm package metadata.
- Build and test without private workspace dependencies.
- Keep the standalone CLI's experimental-demo error explicit.
- Generalize example fixtures and document the public installation workflow.
- Add GitHub Actions CI and npm trusted publishing with provenance.

The public API operations are based on CLI 0.1.7 and API client 0.1.2.
