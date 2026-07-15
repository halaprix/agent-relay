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

## Example setup

`adapters/example-app.json` encodes the first project adapter:

- `BEADS_DIR` must resolve to `/home/example-user/.example-beads`.
- `scripts/dev/worktree-setup.sh` is the required worktree bootstrap command.
- `AGENTS.md`, architecture docs, and ADRs remain project law.
- Protected control-plane paths block worker writes unless the run is explicitly in plugin-maintenance mode.

`relay setup` writes only local state beneath `.agents/agent-relay/`, adds that directory to local Git exclude state when available, and synchronizes provider role bundles into existing provider directories. It never overwrites `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `STATE.md`, or architecture documents.

## Beads ownership and recovery

- The neutral supervisor is the only Beads writer. In production Bubblewrap runs, workers receive `BEADS_DIR` mounted read-only plus a read-only `bd` executable for `bd --readonly ...`; the test-only fallback withholds the host Beads store because it lacks OS isolation.
- Every run verifies `BEADS_DIR`, parses `bd where`, primes memories, falls back to `bd memories --json` when needed, checks the required live-store key, validates dependencies, and atomically claims the requested Bead once.
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
- The Example adapter runs package-level SDK and app tests during implementation, reruns formatting plus workspace lint/check-types before delivery, and adds `forge build` plus `forge test` for Solidity risk.

## Static site

The dependency-free site lives under `site/`. The Pages workflow reruns privacy and site validation before upload, but private-repository publishing still depends on repository visibility and account plan support.
