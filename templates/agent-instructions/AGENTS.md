# Agent Instructions (canonical — ALL assistants)

**This file is the single source of truth for AI-agent instructions in this repository.** `CLAUDE.md` and `GEMINI.md` import it and add only assistant-specific content; Codex and opencode read this file natively. **Edit shared conventions HERE and only here** — never duplicate them into the per-assistant files.

These files are local: they are listed in `.git/info/exclude`, so they never reach a commit, a diff, or a PR. Write them for the machine you are on, but keep personal paths, emails, and hostnames out of them anyway — a gitignored file is one `git add -f` away from being public.

## First action in every session

1. **`bd where`** — confirm it prints this project's `.beads` directory and the expected issue prefix.
   - If a `BEADS_DIR` environment variable is exported on this machine, it wins over repository discovery and will silently route every `bd` call into another project's store. Either unset it or pass `BEADS_DIR="$PWD/.beads"` explicitly on every `bd` invocation.
   - **Never run `bd init`** when `bd where` looks wrong — you are in the wrong directory or inheriting the wrong environment. Report it; a second store is worse than a failed command.
2. **`bd prime`** — load the persistent memories.
3. **Verify** the output contains a `## Persistent Memories` section. If it says none are stored, fall back to `bd memories --json`; plain `bd memories` prints truncated previews and is not a substitute.

`bd ready` lists available work, `bd show <id>` reads one issue, `bd update <id> --claim` claims it, `bd close <id>` finishes it.

## Read protocol (before non-trivial work)

Don't guess architectural patterns; look them up.

1. **Architecture source of truth**: `<fill in: docs/architecture/, ADRs, or the module map>`. Treat its rules as physical laws.
2. **Current state**: the live queue is `bd ready --json`; persistent knowledge loads through the first-action sequence above.
3. If a doc says "X never does Y", either follow it or change the doc with new reasoning — never silently violate it.

## Execution constraints (physical laws of this codebase)

`<fill in the invariants that a competent newcomer would violate: the guard that must be called before an encode, the boundary that fails at runtime rather than compile time, the thing that must never be hand-edited because it is generated.>`

- **No ghost code** — verify interfaces and files exist (grep or read) before referencing them.
- **Scope containment** — modify only files related to the current objective; never "clean up" unrelated files.

## Build and test

```bash
# <fill in the real gates, exactly as CI runs them>
```

Run the gates you claim to have run. Whoever orchestrates re-runs them independently, and a claimed-but-unrun gate is treated as a failure.

## Conventions

- Use `bd` for ALL task tracking and `bd remember` for persistent knowledge. No markdown TODO lists, no parallel tracking systems.
- Default to no code comments; add one only when the WHY is non-obvious.
- **No magic literals, DRY always.** Inline selectors, addresses, thresholds, or duplicated formulas are defects even when correct. One exported implementation; callers import it.
- No features, refactors, or abstractions beyond what the task requires.
- **No AI attribution anywhere**: no `Co-Authored-By:` trailers naming an assistant, no "Generated with …" footers in PR bodies. Authorship is the human committer.

### Git, commits, PRs

- `<fill in: which branches are protected, whether work lands via PR or directly, and who merges>`.
- Multi-paragraph commit messages via heredoc (`git commit -F -`), without attribution trailers.
- **Beads is local-only — never mention bd issue ids in PR titles, PR bodies, commit messages, or anything else team-facing.** Track the bd↔PR link on the bd issue instead (`bd update <id> --notes "PR #NNN"`).

## Orchestration and delegation protocol

Applies to whichever assistant is the main session.

1. **Orchestrate, don't code.** Route by weight, cheapest first: small exactly-speccable tasks to the cheapest coder tier, medium features to the mid tier, cross-system or design-heavy correctness to the strongest. Each toolchain has its own workers — Claude reads `.claude/agents/`, Codex `.codex/agents/`, agy `.agents/agents/`, opencode `.opencode/agent/`.
2. **Specs embed every decision and every gate.** A dispatched worker should never have to infer a decision you already made, and never runs git or a release step unless told to.
3. **Verify, don't trust.** Independently re-run every gate a worker claims to have passed, and check findings against the code before acting on them.
4. **Worktree discipline**: one isolated worktree per workstream. Shell working directories persist between calls, so `cd` with absolute paths, and after any worker run check `git status` in both the worktree and the main checkout.
5. **A worker that reports a blocked or contradictory spec is doing its job.** Fix the spec rather than pressing the same instruction again.

## Session completion

Before ending a session: run the gates, close finished issues with reasons, file new issues for follow-ups (never a TODO in code), and push committed work. Work is not complete until it is pushed.
