---
name: relay
description: Use Agent Relay when a project needs Beads-governed planning, provider failover, isolated worktrees, gates, and multi-vendor review.
---

# Agent Relay

Use `relay` when the project wants Claude, Codex, and agy to share the same Bead, worktree, branch, specification, gate evidence, and review record.

## Workflow

1. Ensure the project has a local Beads store (`bd init --quiet` creates `.beads/`), then run `relay setup --adapter example-app` from the project root.
2. Confirm `relay doctor --json` reports valid manifests, roles, adapters, and local state.
3. Plan the target Bead with `relay plan <bead-id>`.
4. Execute with `relay run <bead-id>` or reattach with `relay resume <bead-id>`.
5. Inspect checkpoints with `relay status [bead-id]`, `relay review <bead-id>`, and `relay gates <bead-id> [gate-name]`.
6. Render the queue with `relay graph [bead-id] [--out path.html]` — a self-contained page, computed by the script rather than drawn by a model, where layer 0 is startable work.
7. Use `relay cleanup <bead-id>` only after the human has reviewed the retained worktree state.

## Agent instruction files

- Project law lives in `AGENTS.md` at the repository root; `CLAUDE.md` and `GEMINI.md` import it and add only assistant-specific mechanics. Codex and opencode read `AGENTS.md` natively.
- `relay setup` scaffolds any that are missing from `templates/agent-instructions/` and keeps all three out of Git. It never overwrites an existing file.
- Edit shared conventions in `AGENTS.md` only. A convention copied into a per-assistant file will drift from the canonical one.
- Fill in the template placeholders before relying on them: architecture documents, gate commands, the invariants specific to the project, and the branch and merge rules.

## Reference resources

- Cache external documentation under the repository-root `.resources/` directory, one topic per subdirectory with a `SOURCE.md` naming the origin URL and fetch date.
- `.resources/` is always git-ignored, never reviewed, and never part of a diff or PR. Workers see it read-only through `AGENT_RELAY_RESOURCES_DIR`.
- Project law (`AGENTS.md`, architecture docs, ADRs, the adapter) outranks anything cached there; re-fetch stale entries instead of editing them.

## Bead taxonomy

- Epics are containers: `agent-relay-n95` → `agent-relay-n95.1` → `agent-relay-n95.1.2`, three levels at most.
- Create children with `bd create "…" --parent <id>`; it mints the dotted id. Never hand-write one.
- Claim leaves, never an epic — `bd ready` lists epics too, and `relay plan`, `run`, `resume`, and `review` reject an id with children and name the open leaves beneath it.
- Work discovered mid-task becomes a child of the bead that found it, so the epic still reflects the real remaining scope. Put it on the epic instead when it falls outside the finishing task's scope: closing a parent while a child is open hides the child.
- Ids are display only. `bd` keeps a dotted id after re-parenting, so trust `bd children` and the graph, not the string.

## Guardrails

- Beads is the only durable task system; the store is the project-local `.beads/` directory and workers use `bd --readonly`.
- Workers stay inside assigned worktrees and owned paths.
- The supervisor blocks blanket staging, force-push, remote mutation, protected control-plane edits, and AI attribution.
- Automation stops at a review-clean PR for human merge.
