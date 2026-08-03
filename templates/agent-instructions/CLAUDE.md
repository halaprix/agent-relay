# Project Instructions for Claude Code

**Canonical shared instructions live in `AGENTS.md`** (imported below) — read by ALL assistants. Edit shared conventions (execution constraints, build and test, git and PR rules, the bd workflow, the delegation protocol) ONLY in `AGENTS.md`. This file carries ONLY Claude-specific content.

@AGENTS.md

# Claude-specific notes

- Run the `AGENTS.md` first-action sequence manually unless a `SessionStart` hook does it for you. `relay setup` writes that hook into `.claude/settings.json` as `BEADS_DIR="$CLAUDE_PROJECT_DIR/.beads" bd prime --hook-json`, and upgrades a bare `bd prime` hook that `bd init` left behind.
- **Scope `BEADS_DIR` per invocation; never export it globally.** These are opposite things and only one is safe. A prefix assignment on a single command (as in that hook, or `BEADS_DIR="$PWD/.beads" bd where`) pins that one call to this repository and makes an inherited global export harmless. A global export in a shell profile routes every other project on the machine into whichever store it names — which is the exact failure the hook exists to prevent, since a hook fires before any instruction file can be read. Use `$CLAUDE_PROJECT_DIR`, not `$PWD`, inside a hook: a `SessionStart` hook's working directory is wherever the session was invoked, not necessarily the repository root.
- Keep persistent knowledge in `bd remember`, not in the harness's own memory files, so every assistant shares it.

# Orchestration and delegation

The tool-neutral protocol lives in **`AGENTS.md` §"Orchestration and delegation protocol"**. Claude-specific mechanics only:

- Dispatch workers with the Agent tool; personas live in `.claude/agents/`. Agent Relay generates `orchestrator`, `coder`, and `reviewer` there — run `relay setup` after changing a role source, never hand-edit the generated bundle.
- Route to an external CLI when it is cheaper or when a second vendor's opinion is the point: `codex` and `agy` both read this repository's instruction files. Each provider manifest declares its own default model per role, so ask for the role and let the manifest pick the model.
- Reviews get opinions from a different vendor than the one that wrote the code; a same-vendor review does not satisfy a two-vendor quorum.
