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

Make the `relay` command itself available first — `package.json` declares the `bin`, but nothing puts it on `PATH` until you link it once:

```bash
cd agent-relay && npm link
```

`relay` then resolves from any directory. Without this step the shell has no way to know `relay` means this tool rather than something else already installed under that name.

Claude:
- Load the plugin from `.claude-plugin/`, or from the repo-local marketplace entry that resolves to `plugins/agent-relay`.

Codex:
- Load the plugin from `.codex-plugin/`.
- The repo-local marketplace entry lives at `.codex-plugin/marketplace.json` and resolves to `plugins/agent-relay`.

agy:
- Import the Claude-compatible plugin metadata and sync the generated roles from `.agents/agents/`.

## Quick start

1. Clone the repository, run `node scripts/sync-roles.mjs` once to materialize provider role bundles, then `npm link` so the `relay` command itself resolves from any directory.
2. In the target project, run `bd init --quiet` if it has no Beads store yet, then `relay init [--providers claude,codex,agy]` to write `.agents/agent-relay/adapter.json` from what it can detect (see [Adapters](#adapters) below). Review the summary it prints before continuing.
3. From the project root, run `relay setup`. With a project adapter in place this needs no flag; `relay setup --adapter example-app` still works for trying the bundled example itself.
4. Verify the install with `relay doctor --json`.
5. Plan the Bead with `relay plan <bead-id>`.
6. Execute or reattach with `relay run <bead-id>` and `relay resume <bead-id>`.
7. Run `relay review <bead-id>` to obtain vendor review and, when delivery is configured, create the PR.

Version `0.1.0` ships as a local CLI/plugin package only. A transient per-user relay service is optional future work and is intentionally omitted from the packaged flow.

## Command surface

- `relay init [--name <slug>] [--base-branch <branch>] [--providers claude,codex,agy] [--force]`
- `relay setup [--adapter <bundled-name> | --adapter-file <path>]`
- `relay doctor`
- `relay plan <bead-id>`
- `relay run <bead-id>`
- `relay resume <bead-id>`
- `relay status [bead-id]`
- `relay graph [bead-id] [--out path.html]`
- `relay view [bead-id] [--port n] [--no-open]`
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

## Adapters

An adapter is project-specific configuration — worktree bootstrap, gate commands, control-plane paths, risk classes — and a project's own configuration belongs in that project's own repository, not committed into Agent Relay. Every command resolves which adapter governs the run with the same precedence, and never falls back to a bundled example silently:

1. **`--adapter-file <path>`** — an explicit path. Missing is a clear `project-misconfigured` error naming the path, never a fallback.
2. **`--adapter <name>`** — an explicit bundled adapter by name (`adapters/<name>.json` inside this repository). An unknown name is an error naming what was looked for; it does not fall through to a project adapter, because naming a bundled adapter is explicit intent.
3. **`<projectRoot>/.agents/agent-relay/adapter.json`** — used when neither flag is given. This is where a real project's adapter lives.
4. Otherwise: `project-misconfigured`, naming the exact path that was checked. Defaulting silently here would run a real project under a stranger's gates and control-plane paths without anyone choosing that.

`relay doctor` and `relay setup` both report `adapterSource` (`project`, `bundled`, or `explicit-file`) and `adapterPath`, so it is never ambiguous which adapter actually governed a run.

### `relay init` — write a project's first adapter by detection, not by copying one

`relay init [--name <slug>] [--base-branch <branch>] [--providers claude,codex,agy] [--force]` writes `<projectRoot>/.agents/agent-relay/adapter.json` for the project it runs in, built from what it can actually detect, and stops — it never runs `relay setup` itself, on the same principle the precedence rules above are built on: an adapter's gates and control-plane paths take effect on a real project, and that should never happen without a human (or an explicit second command) choosing it.

What it detects, with no dependency beyond what's already on `PATH`:

- **Package manager and per-package test commands** from the lockfile present (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `package-lock.json`) and each package's `package.json` `scripts`. A `workspaces` field is expanded for simple `"dir/*"` globs; anything more exotic is named in the summary as skipped, not silently mishandled.
- **Foundry/Solidity** — a `foundry.toml` anywhere adds a `solidity-core` risk class and a gate group running `forge build`/`forge test` in the right directory.
- **Providers already in use** — via `--providers`, or detected from existing config directories. `.claude`/`.codex`/`.opencode` are checked by their top-level directory, matching the `mkdir` step below; `agy`'s is checked more specifically (`.agents/agents`), because its top segment (`.agents`) is also where Agent Relay's own local state lives regardless of whether agy is in use.
- **A Beads store**, and if one already exists, `relay init` seeds the one `bd remember` memory the adapter's `beads.memoryKey` requires — without it, the very first `relay plan`/`run`/`review` fails with "required memory key missing." If no store exists yet, the summary names the exact `bd init`/`bd remember` commands to run first.
- Existing `docs/architecture`, `docs/adr`, `AGENTS.md`, and `STATE.md`, feeding `guidance.architectureRoots` and `guidance.requiredFiles` — never claiming a file is required when it does not exist yet, since `relay doctor` checks that literally.

- **The worktree bootstrap script.** When a package manager was detected, `relay init` generates an executable `scripts/dev/worktree-setup.sh` running that manager's lockfile-respecting install (`pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`, `npm ci`) and points `repository.worktreeSetupCommand` at it. A worktree is a throwaway checkout of a known commit, so resolving fresh versions there would let a gate pass or fail for reasons unrelated to the change. An existing script is never overwritten, only referenced. When no package manager was detected there is no honest install step, so `worktreeSetupCommand` is `[]` — an explicit "this project has no setup step", which `relay run` skips. It is never a placeholder path to a file that does not exist; that shape failed every first run.

What it refuses to guess, on purpose: risk classes beyond `documentation` and `normal-code` (plus `solidity-core` when Foundry is found) — nothing in a repository's file layout implies a `money-path` or `shared-infrastructure` concept, so those are left for a human to add. The generated worktree script installs dependencies and nothing else; a project needing a build or codegen step before a worker can work has to add it, and the summary says so. Never overwrites an existing adapter without `--force`.

A project with nothing detectable at all still gets a **valid** adapter — every gate list defaults to `[]` rather than failing to construct, and `providerOrder` defaults to all four providers. Detection never blocks writing something reviewable.

`adapters/example-app.json` remains the reference for what a fully filled-in adapter looks like:

- The Beads store is the project-local `.beads/` directory created by `bd init`; no global store and no machine-specific path is involved.
- `scripts/dev/worktree-setup.sh` is the required worktree bootstrap command.
- `AGENTS.md`, architecture docs, and ADRs remain project law.
- Protected control-plane paths block worker writes unless the run is explicitly in plugin-maintenance mode.

`relay setup` writes only local state beneath `.agents/agent-relay/` plus the ignored `.resources/` cache, adds both to local Git exclude state when available, and synchronizes provider role bundles into existing provider directories (a provider's own directory — `.claude/`, `.codex/`, `.agents/`, `.opencode/` — must already exist for its role bundles to sync there). It never overwrites `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `STATE.md`, or architecture documents, and it never overwrites an adapter that is already there.

### Session-start hooks

`relay setup` also guarantees the one piece of wiring that project law cannot cover. A session-start hook runs before the assistant has read a single instruction file, so a misconfigured one cannot be corrected by guidance. `bd init` writes a bare `bd prime --hook-json`, and on a machine that exports a global `BEADS_DIR` pointing at another project, that bare command primes the **wrong** store on every session start — silently.

For each provider whose manifest declares a `sessionHook` (today, Claude: `.claude/settings.json`, event `SessionStart`), `relay setup` ensures the command is scoped to this project's own store:

```
BEADS_DIR="$CLAUDE_PROJECT_DIR/.beads" bd prime --hook-json
```

- A bare `bd prime` hook is **upgraded in place**, never duplicated alongside a second conflicting one.
- A hook that already sets `BEADS_DIR` is left exactly as written — it may be a deliberate local variant.
- Unrelated keys, other events, and sibling hooks in the file are preserved; the run is idempotent.
- A `settings.json` that cannot be parsed is **reported, never overwritten**.
- Nothing is written for a provider whose own directory does not exist, so a project that does not use it never gains its configuration file.
- `$CLAUDE_PROJECT_DIR`, not `$PWD`: a `SessionStart` hook's working directory is wherever the session was invoked, which is not guaranteed to be the repository root. `--adapter`-configured stores are honoured too — an absolute `beads.requiredDir` is used as-is rather than being prefixed.

Scoping `BEADS_DIR` on a single command and exporting it globally are opposite things: the prefix pins one call to this repository and makes an inherited global export harmless, while a profile-level export routes every other project on the machine into whichever store it names.

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

## Agent instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)

Every assistant reads project law from a file in the repository root, and each one looks for a different name. Agent Relay ships one layered set so the law is written once:

- `AGENTS.md` is canonical and holds every shared convention. Codex and opencode read it natively.
- `CLAUDE.md` and `GEMINI.md` import it (`@AGENTS.md`) and carry only assistant-specific mechanics.
- Shared conventions are edited in `AGENTS.md` and nowhere else. Duplicating them into the per-assistant files is how they drift.

`relay setup` writes any of the three that are missing from the templates in `templates/agent-instructions/`, and adds all three to the project's local Git exclude state. An existing file is never touched — by then it is the project's own law, and a template is only a starting point. `relay doctor` reports which are present.

They stay local and uncommitted on purpose: they name per-machine tooling and model choices, and a project's rules are not Agent Relay's to version. That also means `git clean -xfd` deletes them, so treat the templates as the recovery path.

Adopting a project means filling in the placeholders: the architecture documents worth reading, the real gate commands, the invariants a newcomer would violate, and who merges. The template ships the parts that are true everywhere — the inherited-`BEADS_DIR` trap, verify-don't-trust delegation, no AI attribution, and Beads as the only durable task system.

## Bead graph (`relay graph`)

`relay graph` renders the dependency graph as one self-contained HTML file: no scripts, no CDN, no network requests. It opens offline, survives in an archive, and can be published as an Artifact as-is.

The page is computed, not drawn by a model. Identical input produces identical bytes, which is what makes it reviewable and testable — the layout coordinates come from the script, so there is nothing to trust and nothing to drift.

- Nodes are laid out left to right by longest path over ordering edges, so **layer 0 is startable work**. Containment never pushes a child rightward: an epic does not block its own children.
- Solid arrows are `blocks`; dashed arrows are `parent-child`. `relates-to` is an annotation and draws nothing.
- A bead id restricts the page to that bead and its descendants; without one the whole store is drawn.
- A dependency cycle is reported in the page and the beads pinned to layer 0, rather than throwing — `bd` permits a cycle, so refusing to draw would make the store unviewable. `bd dep cycles` names them.

The data comes from `bd export --readonly` read on **stdout and never written to disk**. That is deliberate: an exported `.beads/issues.jsonl` carries `created_by` account names plus every title, description, and comment, it is not covered by `.beads/.gitignore`, and the privacy scanner skips `.beads` — two blind guards on a public repository.

Compared to `bd graph --html`, which loads D3 from `d3js.org` and so needs network access and cannot be archived, this trades interactivity for a file that always works.

## Interactive viewer (`relay view`)

`relay graph` and `relay view` are the two halves of looking at a queue:

- **`relay graph`** writes a self-contained page. Offline, diffable, attachable to a PR, and identical bytes for identical input.
- **`relay view`** opens [`@halaprix/beads-viewer`](https://www.npmjs.com/package/@halaprix/beads-viewer) on the same store, where the graph is editable — create beads, drag to connect dependencies, change status, and see a terminal `bd` land within about a second.

The viewer is an **optional external tool, never a dependency**. Agent Relay ships zero runtime dependencies and the viewer ships a browser bundle, so `relay view` fetches it through `npx` on demand. Point `AGENT_RELAY_VIEWER_BIN` at a local checkout to use one, or `AGENT_RELAY_VIEWER_PACKAGE` at a fork.

`relay view` resolves the store from the adapter and passes `BEADS_DIR` explicitly rather than letting the viewer discover it. An exported `BEADS_DIR` aimed at another project silently beats repository discovery, and editing the wrong issue database is not a mistake worth risking. A missing store is reported before the viewer launches; a viewer that cannot be run is `project-misconfigured`; a viewer exiting non-zero is `human-action-required`.

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
