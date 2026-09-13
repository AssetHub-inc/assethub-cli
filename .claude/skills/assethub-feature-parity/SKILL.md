---
name: assethub-feature-parity
description: Use when designing, implementing, reviewing, or releasing a new user-facing AssetHub capability, public API operation, CLI or MCP command, chat action, or an ML component contract consumed by Web. Keeps server, OpenAPI, CLI, MCP, and chat execution behavior aligned without a second capability registry.
version: 1.0.0
---

# AssetHub feature parity

Treat a new remote product action as one capability delivered through every programmable surface.
Keep this skill synchronized byte-for-byte between `assethub-web` and `assethub-ml`; each repository's `.agents/skills` entry points to its own canonical `.claude` copy.

## Classify the change

Apply this workflow to a new or materially changed user-facing server action and to an ML public contract consumed by Web. UI-only presentation, copy, local host transports, and refactors that preserve behavior and published contracts do not need invented CLI commands.

State the classification in the PR: `advertised operation`, `special non-OpenAPI capability`, `ML contract change`, or `excluded`, with one sentence of evidence.

## Build from the server contract

1. Implement one authoritative server operation with the same actor, workspace, membership, gate, validation, billing, idempotency, execution-context, and terminal-result rules for every caller.
2. Advertise remote operations in the appropriate versioned OpenAPI document. Keep the operation schema complete enough for generic discovery and execution.
3. Use the shared API-client operation discovery/request contract. Keep CLI `api`, MCP `operation_*`, and chat operation tools wired to it. Do not add a second operation manifest.
4. If a capability cannot be represented in OpenAPI, explain why and add explicit CLI, MCP, and chat adapters. Keep local file selection/download or browser handoff at the transport boundary.
5. Preserve durable operation/run IDs and recoverable terminal output. A model or automation may surface `failed` or `needs_review`; only a human makes a creator decision.

## Prove parity

Add meaningful tests at the changed contract and each affected adapter. Exercise discovery, description, request construction, authorization/gates, billing or credit behavior, idempotent replay, and final run/result projection where those apply. Reuse the same behavior fixture across surfaces when practical.

Run the structural guard described in [the development guide](../../../docs/feature-parity-development.md). It verifies shared gateway wiring and changed-file evidence for special adapters. It does not prove semantic equivalence.

Before release, exercise the real capability through CLI, MCP, and chat against the same environment and actor. Record commands/tool calls, operation or run IDs, terminal states, outputs, gate state, and any untested provider variants. CI and HTTP success alone are not completion evidence.

For an ML contract change, publish and test the component-owned contract, keep compatibility/versioning explicit, and link the Web consumer change plus its CLI/MCP/chat evidence. An ML implementation change with an unchanged published contract is excluded.

Use the PR evidence table in the development guide. Stop if a required surface is missing; do not describe planned follow-up as parity.
