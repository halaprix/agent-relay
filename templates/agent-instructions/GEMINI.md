# Project Instructions for Gemini

**Canonical shared instructions live in `AGENTS.md`** (imported below) — read by ALL assistants. Edit shared conventions ONLY in `AGENTS.md`; this file carries ONLY Gemini-specific content.

@./AGENTS.md

# Gemini-specific notes

- **Run the `AGENTS.md` first-action sequence as your FIRST action.** Nothing injects it for you.
- **If an orchestrator dispatched you**: your brief embeds every decision and every gate. Follow it exactly, do not run git or any release step, and report gate results honestly — they are independently re-run. Pin ACTUAL observed behaviour over the brief's predictions and flag mismatches loudly.
- If the brief contradicts itself or the code, stop and report instead of guessing. A blocked worker is cheaper than a wrong merge.
- Verify you are writing into the intended worktree rather than the main checkout; use absolute paths.

# Eager context

Gemini loads a large context well, so import the documents you would otherwise have to be told to read:

```
@./<architecture doc>
@./<module map>
```
