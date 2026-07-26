# Agent Relay

Agent Relay is a Claude-first plugin backed by a provider-neutral Node.js supervisor. It keeps Claude, Codex, and agy aligned on the same Bead, worktree, branch, specification, gate evidence, and review record so provider exhaustion does not strand work inside one conversation.

```text
Beads
  |
  v
Neutral supervisor
  |
  +--> provider routing --> isolated worktree --> gates --> multi-vendor review
  |
  +--> checkpoint ledger --> resume / status
  |
  +--> human-only merge handoff
```

## Installation

Claude:
- Load the plugin from `.claude-plugin/`, or from the repo-local marketplace entry that resolves to `plugins/agent-relay`.

Codex:
- Load the plugin from `.codex-plugin/`.
- The repo-local marketplace entry lives at `.codex-plugin/marketplace.json` and resolves to `plugins/agent-relay`.

agy:
- Import the Claude-compatible plugin metadata and sync the generated roles from `.agents/agents/`.

## Quick start

1. Clone the repository and run `node scripts/sync-roles.mjs` once to materialize provider role bundles.
2. From the target project root, run `relay setup --adapter example-app`.
3. Verify the install with `relay doctor --json`.
4. Plan the Bead with `relay plan <bead-id>`.
5. Execute or reattach with `relay run <bead-id>` and `relay resume <bead-id>`.
6. Run `relay review <bead-id>` to obtain vendor review and, when delivery is configured, create the PR.

Version `0.1.0` ships as a local CLI/plugin package only. A transient per-user relay service is optional future work and is intentionally omitted from the packaged flow.

## Command surface

- `relay setup --adapter example-app`
- `relay doctor`
- `relay plan <bead-id>`
- `relay run <bead-id>`
- `relay resume <bead-id>`
- `relay status [bead-id]`
- `relay review <bead-id>`
- `relay gates <bead-id> [gate-name]`
- `relay cleanup <bead-id>`
- `relay sync-adapters`
- `relay --json ...`

All commands return structured JSON and one of these stable exit classes:

- `success`
- `human-action-required`
- `provider-quorum-unavailable`
- `project-misconfigured`
- `unrecoverable-run-state`

## Example adapter

`adapters/example-app.json` is a worked example, not a real project. It shows the shape an adapter takes; a real one belongs in the repository it describes:

- The Beads store is the project-local `.beads/` directory created by `bd init`; no global store and no machine-specific path is involved.
- `scripts/dev/worktree-setup.sh` is the required worktree bootstrap command.
- `AGENTS.md`, architecture docs, and ADRs remain project law.
- Protected control-plane paths block worker writes unless the run is explicitly in plugin-maintenance mode.

`relay setup` writes only local state beneath `.agents/agent-relay/` plus the ignored `.resources/` cache, adds both to local Git exclude state when available, and synchronizes provider role bundles into existing provider directories. It never overwrites `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `STATE.md`, or architecture documents.

## Reference resources (`.resources/`)

`.resources/` is the standard, never-committed cache of external reference material for every repository Agent Relay touches, including this one. Agents keep upstream documentation there instead of refetching it, guessing at it, or committing it.

Rules:

- Location is the repository root: `.resources/`. Adapters may relocate it with `guidance.resourcesRoot`.
- It is ignored by Git. This repository ignores it through `.gitignore`; `relay setup` adds `<resourcesRoot>/` to the target project's local Git exclude state next to `.agents/agent-relay/`.
- One topic per directory, each with a `SOURCE.md` recording the origin URL and the fetch date. Example: `.resources/beads/` for the Beads issue tracker documentation at `https://beads.gascity.com/`.
- It is a cache, not law. `AGENTS.md`, architecture documents, ADRs, and the adapter always win. Entries may be stale, so re-fetch rather than editing them in place.
- It is never a deliverable. `.resources/` is excluded from worktree snapshots, scope-locked diff artifacts, review bundles, privacy scans, and link checks, so nothing cached there can reach a PR.
- Workers get it read-only. The supervisor bind-mounts the project's resources root into the isolated sandbox read-only and exports `AGENT_RELAY_RESOURCES_DIR`; writes belong to the human or the supervisor.

`relay setup` creates the directory and a `README.md` restating these rules, and `relay doctor` reports `resourcesRoot` plus whether it is actually ignored.

## Beads store

The Beads store is project-local. `adapter.beads.requiredDir` defaults to `.beads`, resolved against the project root, which is exactly where `bd init` creates the embedded Dolt database (`.beads/embeddeddolt/`). Nothing depends on a shared or per-user store.

- The supervisor derives `BEADS_DIR` from the project itself and exports it for every `bd` call. An inherited `BEADS_DIR` that points somewhere else is rejected instead of silently winning.
- `bd where` must resolve inside that store; the embedded database directory beneath it counts as a match.
- Tracking is an adapter choice, and `beads.tracked: true` matches what `bd init` actually does: it commits `.beads/config.yaml`, `metadata.json`, and `README.md`, and writes a nested `.beads/.gitignore` that keeps the Dolt database, sockets, and lock files out of Git. The issue data itself synchronizes over the Git remote through `refs/dolt/data`, not through the working tree. With `tracked: true`, Agent Relay leaves ignore state alone.
- Set `beads.tracked: false` for a store that should stay entirely local, and `relay setup` adds `<requiredDir>/` to local Git exclude state next to `.agents/agent-relay/`. Files Git already tracks stay tracked, so switching an existing project needs `git rm --cached` as well.
- Either way the store is protected control-plane state: workers never write it, and `.beads` sits in `controlPlane.protectedPaths`.
- Absolute `requiredDir` values still work for projects that genuinely need an external store.
- `relay doctor` reports `beadsDir`, `beadsTracked`, and `beadsStorePresent`, and fails with `project-misconfigured` when the store is missing so the human can run `bd init --quiet`.

## Bead taxonomy

Work is addressed hierarchically: `agent-relay-n95` is an epic, `agent-relay-n95.1` a task under it, `agent-relay-n95.1.2` a subtask under that. Three levels is the ceiling; anything deeper is a sign the epic wanted splitting.

- **`bd` mints the identifiers.** `bd create "…" -t epic` returns the hash id, and `bd create "…" --parent <id>` appends the next dotted segment. Never hand-write an id.
- **Only leaves are claimable.** An epic is a container for scope, not a unit of work. `bd ready` will happily list an epic — pick a leaf underneath it instead. Agent Relay enforces this: `relay plan`, `relay run`, `relay resume`, and `relay review` refuse an id that has children, and name the open leaves beneath it. Detection reads the dependency graph, not the dotted id, so a project with flat ids behaves exactly as before.
- **Discovered work becomes a child**, not a sibling. If a task turns up something it cannot absorb, the new bead hangs off the bead that found it, so the epic keeps showing the true remaining scope. Hang it on the epic rather than the finishing task when the follow-up is out of that task's scope — a parent must not close while a child is open, or the child drops out of the tree view.
- **The dotted id is display, the graph is truth.** `bd` does not renumber on re-parent, so an id can outlive the parent it names. Read `bd children` or the dependency graph, never the id string.
- **Standalone work keeps a flat id.** A lone task does not need a ceremonial epic above it. Promote it to one when it grows children.
- Epics close on their children through `--waits-for-gate` (`all-children` by default), so an epic left open is a real signal that something under it is unfinished.

## Beads ownership and recovery

- The neutral supervisor is the only Beads writer. In production Bubblewrap runs, workers receive the project store mounted read-only plus a read-only `bd` executable for `bd --readonly ...`; the test-only fallback withholds the Beads store because it lacks OS isolation.
- Every run resolves the project store, parses `bd where`, primes memories, falls back to `bd memories --json` when needed, checks the required live-store key, validates dependencies, and atomically claims the requested Bead once.
- Structured checkpoints are appended with `bd comments add`; resume can rebuild state from Bead comments if the local ledger is gone.
- `.agents/agent-relay/state/*.jsonl` is only a reconstructible operational ledger. If it disappears, a run is still recoverable from Beads plus Git and worktree state.
- Persisted run state tracks the live phase machine (`planning`, `awaiting-plan-approval`, `implementing`, `reviewing`, `delivering`, `awaiting-human`, `complete`) plus `planReview`, `pendingCorrection`, and review quorum metadata.

## Failure routing

- Quota, rate limit, and authentication failures hand off immediately to the next provider.
- Service and network failures retry once, then hand off.
- Timeouts, crashes, malformed reports, and missing reports checkpoint the worktree truth before handoff.
- Implementation, lint, type, and test failures return to the same coder with bounded corrective prompts.
- Human-only actions pause for the user.
- Dirty or partially committed worktrees are preserved and never deleted automatically.

## Safety model

- Workers run inside isolated worktrees, never the main checkout.
- Provider auth remains environment-driven. Pass API keys or session tokens through provider `env`; Agent Relay does not mint credentials or write them into artifacts.
- Provider-specific wrapper packages or support files must be declared in `runtime.readOnlyMounts`. Those mounts are read-only, `HOME` is a writable synthetic sandbox directory, and overlap with the project root, worktree, Beads store, or protected control-plane paths is rejected.
- The supervisor validates main-checkout stability around external runs, rejects blanket staging, force-push, remote mutation, protected-path drift, Beads writes, and attribution/privacy findings.
- Review uses at least two distinct vendors for non-documentation work when quorum is available.
- When delivery is configured, automation stops at a review-clean PR. Otherwise review pauses with `human-action-required` and an exact delivery-configuration reason. Human merge remains mandatory.

## Review and gates

- Gate groups are defined per adapter and rerun independently by the supervisor.
- Scope-locked diff artifacts and per-review prompt/output files are stored for each review round.
- Money-path and Solidity work can request stronger reviewer pools and adversarial questions through adapter risk classes.
- Configured high-risk classes pause for plan approval before implementation.
- The bundled example adapter runs package-level SDK and app tests during implementation, reruns formatting plus workspace lint/check-types before delivery, and adds `forge build` plus `forge test` for Solidity risk.

## Static site

The dependency-free site lives under `site/`. The Pages workflow reruns privacy and site validation before upload, but private-repository publishing still depends on repository visibility and account plan support.
