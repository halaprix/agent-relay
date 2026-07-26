# KISS and DRY audit — 2026-07-26

Bead: `agent-relay-6st.1`. All line references are at commit `457b525`.

## Method

Every module in `src/lib/` and `scripts/` was read in full by the auditor. Two mechanical
sweeps supplied the raw measurements: a function-level map of `supervisor.mjs` (name, line
range, exported, run-state coupling, internal callers) and a duplication diff across the
candidate pairs below. Every finding was then verified against the source before it was
recorded; two assumptions made when this bead was filed did not survive verification and are
recorded as corrections (F2 sizing, F7).

Repository shape at `457b525`: `src/lib` is 4,453 lines across 19 modules; `supervisor.mjs`
is 2,654 of them (59.6%). Provider names appear as literals 44 times in `src/` + `scripts/`
(claude 20, codex 15, agy 9), excluding plugin-directory path strings.

## Verdict key

- **fix-now** — landed under this bead; behavior-preserving.
- **defer** — real, but another filed bead owns the ground; fixing twice is the waste.
- **follow-up** — real, but out of this bead's no-behavior-change constraint; filed as a bead.
- **leave** — examined and deliberately not changed, with the reason.

## Findings

### F1 · supervisor.mjs is a god-module; worker containment is the alien concern — fix-now

`src/lib/supervisor.mjs` holds the run state machine *and* a complete OS-sandboxing
subsystem. The containment cluster — `resolveCommandPath` through `prepareIsolatedProviderRun`
(478–1054, 577 lines) plus module state (51–53) and five test hooks (2634–2654) — never
touches run state: the caller map shows every one of those functions is reached only from
`prepareIsolatedProviderRun`, which itself is called from three phase functions and one test
hook. That is a module boundary already, just not expressed as one.

Cost: the hardest-to-reason-about code in the repo (bwrap args, mount overlap rules, the
fallback isolation hook) can only be read embedded in a 2,654-line file, and every audit of
"what can a worker touch" starts with an excavation.

Fix: move the cluster verbatim to `src/lib/containment.mjs`. The provider-config helpers
sitting just above it — `SUPPORTED_PROVIDER_VENDORS` (50), `providerCommandFromConfig`,
`providerVendor`, `providerStrength`, `validateRuntimeProviderConfig` (425–476) — are provider
metadata, not sandbox construction, and are needed by both the supervisor
(`candidateReviewProviders`, coder/reviewer loops) and containment
(`prepareIsolatedProviderRun` validates config first): they move to `provider.mjs`, keeping
the import graph acyclic (`provider ← containment ← supervisor`). The supervisor re-exports
the five `__*ForTests` hooks so the test suite is untouched.

### F2 · gates.mjs is production-dead and has already drifted — fix-now (delete)

`src/lib/gates.mjs` (`runGateGroup`, 42 lines) is imported by exactly one file:
`test/gates.test.mjs`. Production gate running lives in `supervisor.mjs`
`runGateGroupsChecked` (1540–1577), which was evidently forked from it and has diverged:
the live version resolves `gate.cwd` against the worktree (1558) where the dead one resolves
against `projectRoot` (gates.mjs:27), and the live one wraps every gate in control-plane
snapshot assertions the dead one lacks. A future reader who finds `gates.mjs` first learns
the wrong semantics.

Correction to the bead as filed: the bead assumed the duplication ran the other way (that the
supervisor's copy was the redundant one). The dependency direction is the opposite.

Fix: delete `src/lib/gates.mjs` and `test/gates.test.mjs`. The test tested only the dead
copy; live gate behavior is covered through the supervisor suite (manual gates, gate-failure
correction, delivery gates). This is the one place the diff removes a test, and it removes it
because the code under test is removed.

### F3 · Privacy scanners duplicate their entire matching core — fix-now

`scanPrivacy` (guardrails.mjs 29–54) and `scanPrivacyInPaths` (56–77) carry byte-identical
attribution and email loops (32–52 vs 61–74, ~95% identical); they differ only in how they
enumerate files. The email allowlist (`git@github.com`, `@example.com`) exists twice, so a
policy change has two edit sites and one of them will be missed.

Fix: extract a single `scanText(relativePath, text)` core; both walkers keep their exact
public signatures and outputs.

### F4 · git.mjs repeats one wrapper five times — fix-now

`getGitStatus`, `getGitRemotes`, `getGitHead`, `getGitBranch`, `resolveBaseSha` (242–280) are
the same nine-line run-throw-trim wrapper ~90% verbatim. Fix: one internal helper taking the
args and the exact existing error prefix; the five exports and their error strings stay
byte-identical.

### F5 · runGitText is git plumbing stranded in the supervisor — fix-now

`supervisor.mjs` 358–371 reimplements `git.mjs`'s spawn wrapper with swallow-errors
semantics, used by `captureControlPlaneSnapshot` (373–388). Fix: move it to `git.mjs` as an
export beside `runGit`, unchanged.

### F6 · Five entrypoints share a verbatim preamble — fix-now

`planUnlocked`, `runUnlocked`, `reviewUnlocked`, `resumeUnlocked` open with the same three
lines (loadAdapter → ensureProjectState → withProjectBeadsDir; 2390–2392, 2440–2442,
2458–2460, 2565–2567) plus the same container-refusal check; `gates` shares the three-line
prefix (2545–2547). Fix: one `openBeadAction` helper for the four bead-scoped entrypoints.
`gates` (optional beadId) and `cleanupUnlocked` (different shape, see F12) stay as they are.

### F7 · Plugin validators — correction: they are NOT near-duplicates — leave

Measured: `validate-claude-plugin.mjs` (21 lines) vs `validate-codex-plugin.mjs` (32 lines)
are ~15% identical. They validate different manifest schemas; the codex one carries
`requireString` checks the claude one has no use for. The "near-identical validators" claim
in bead `6st.2` was wrong and a correcting comment has been left on that bead. Forcing one
implementation over two schemas would be abstraction for its own sake.

### F8 · roles.mjs renderer/parser/target triplication — defer to 6st.2

`renderClaudeRole` vs `renderAgyRole` ~70% identical (32–71); `syncRoleBundles` check/write
branches ~85% identical with three hardwired targets each (166–181); `defaultRoleTargets`
(140–146) is the fixed three-provider shape. All of it is exactly the per-provider knowledge
`6st.2` moves into manifests. Fixing it here means restructuring the same 90 lines twice in
one week; the audit records it and 6st.2 owns it.

### F9 · Worker/review report validators overlap ~40% — leave

`validate.mjs` 11–35 vs 37–66 share the requireKeys/rejectUnknownKeys/status-enum ceremony,
but the shapes genuinely differ (worker: path arrays; review: nested findings with their own
key rules). A table-driven validator would be shorter and harder to read. KISS cuts against
DRY here.

### F10 · Two spawn wrappers: runGitBuffer vs runProviderCommand — leave

`git.mjs` 107–163 and `provider.mjs` 43–155 both do the spawn/capture-file dance.
`runGitBuffer` exists because `cat-file` output is binary and must not pass through string
decoding; it also deliberately lacks the SIGTERM→SIGKILL ladder and detached process group of
the provider runner. Unifying them means threading a binary mode and two kill policies
through one function — more complexity than the ~40 shared lines cost. Revisit only if a
third spawn wrapper appears.

### F11 · Adapter validation exists twice: code and JSON Schema — leave (accepted, documented)

`adapter.mjs` `validateAdapter` and `schemas/project-adapter.schema.json` describe the same
shape and both had to be edited for `resourcesRoot` and `beads.tracked` this week. In a
zero-dependency repo, enforcing the schema at runtime would mean writing a JSON-Schema
validator — far worse than the drift risk. The schema stays the wire-format documentation and
CI artifact; the code stays the runtime authority; this entry is the recorded linkage.

### F12 · relay cleanup silently drops the adapter — follow-up: `agent-relay-6st.1.1`

`scripts/relay.mjs:29` calls `cleanup({ projectRoot, beadId })`; `cleanupUnlocked` (2584)
defaults `adapterName = "example-app"`. With a second adapter this cleans up under the wrong
one. Fixing it changes behavior (new CLI flag, no default), so it is out of this bead's
constraint and filed as the audit's first subtask.

### F13 · Long phase functions with repeated checkpoint boilerplate — defer to n95.5

`executeCoder` 1782–2042 (261 lines, with the `providerCursor` spread pattern verbatim
at 1846, 1888, 1914), `deliverReviewedWork` 2152–2324 (173), `runPlanReview` 1579–1718 (140).
Long but linear, and each is one phase — length here is narrative, not entanglement. More
decisive: bead `n95.5` rewrites the coder loop (pre-flight provider filter, post-call
usage recording), so carving it up now guarantees churn. Re-audit these three after the n95
epic lands.

### F14 · beadsEnv vs withProjectBeadsDir — leave

Two two-line functions with the same spread-and-set body (beads.mjs, supervisor.mjs 259–262)
but different argument shapes. Below the abstraction floor.

## Fixes landed under this bead

| Findings | Change | Constraint check |
| --- | --- | --- |
| F1 | `containment.mjs` extracted; provider-config helpers to `provider.mjs`; test hooks re-exported | pure move, suite unchanged |
| F2 | `gates.mjs` + its test deleted | dead code; live behavior covered by supervisor suite |
| F3–F6 | scanText core; gitText helper; runGitText relocated; openBeadAction preamble | byte-identical outputs and error strings |

Everything else above is recorded as defer / follow-up / leave with its reason. Nothing in
this audit was dropped silently.
