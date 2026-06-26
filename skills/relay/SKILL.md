---
name: relay
description: Use Agent Relay when a project needs Beads-governed planning, provider failover, isolated worktrees, gates, and multi-vendor review.
---

# Agent Relay

Use `relay` when the project wants Claude, Codex, and agy to share the same Bead, worktree, branch, specification, gate evidence, and review record.

## Workflow

1. Run `relay setup --adapter example-app` from the project root.
2. Confirm `relay doctor --json` reports valid manifests, roles, adapters, and local state.
3. Plan the target Bead with `relay plan <bead-id>`.
4. Execute with `relay run <bead-id>` or reattach with `relay resume <bead-id>`.
5. Inspect checkpoints with `relay status [bead-id]`, `relay review <bead-id>`, and `relay gates <bead-id> [gate-name]`.
6. Use `relay cleanup <bead-id>` only after the human has reviewed the retained worktree state.

## Guardrails

- Beads is the only durable task system; workers use `bd --readonly`.
- Workers stay inside assigned worktrees and owned paths.
- The supervisor blocks blanket staging, force-push, remote mutation, protected control-plane edits, and AI attribution.
- Automation stops at a review-clean PR for human merge.
