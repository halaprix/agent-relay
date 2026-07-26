# Usage-aware provider rotation

Status: accepted, not implemented
Date: 2026-07-26

## Problem

Provider handoff is reactive. `classifyProviderFailure` matches the child process's stderr for
`quota|rate limit|429|authentication|...` and only then rotates to the next provider. The relay
therefore learns a provider is exhausted by burning a call and failing it, and once it has fallen
through to the next provider nothing ever returns to the first one: the loop in
`executeCoder` walks `orchestratorOrder` forward only, and resume pins `coderIndex`
to `lastCoder`.

There is no usage accounting anywhere in the codebase. The worker report schema carries
`status, summary, ownedPaths, commandsAttempted, changedPaths, gatesClaimed, artifacts` and
nothing about tokens or cost.

## What the providers actually expose

Verified against the installed CLIs on 2026-07-26; captures are cached in `.resources/`.

| Provider | Version | Usage telemetry | Context window | Native budget cap |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.220 | `-p --output-format json` → `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `modelUsage[model]{costUSD, contextWindow}`, `total_cost_usd` | self-reported | `--max-budget-usd`, `--max-turns` |
| Codex | 0.145.0 | `exec --json` → final `turn.completed` event with `usage{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` | not reported | none |
| agy | 1.1.7 | none — plain text only | not reported | none |

### Quota probes

Claude Code does expose remaining account quota to a non-interactive caller, and it is free:

```
$ claude -p "/usage" --output-format json     # total_cost_usd: 0, num_turns: 0, ~1s
Current session: 25% used · resets Jul 26, 1:40pm (Europe/Warsaw)
Current week (all models): 30% used · resets Jul 31, 1:59pm (Europe/Warsaw)
Current week (Fable): 43% used · resets Jul 31, 2pm (Europe/Warsaw)
```

The CLI answers locally — no API call, no tokens, no rate-limit consumption — so it can be polled
as often as we like. This is the vendor's own number, and it sees what a local ledger cannot:
usage from other machines, other sessions, and claude.ai, plus the weekly limit that no per-call
accumulation can infer.

Two consequences for the design:

1. **A probe, where one exists, outranks the estimate.** The rolling-window meter becomes the
   fallback for providers that can't be probed, not the primary mechanism.
2. **"When do we come back" needs no timestamp parsing.** Because probing is free, re-probe and
   read the percentage. Reset strings carry no year and a named timezone
   (`Jul 31, 2pm (Europe/Warsaw)`); keep them as a human-readable hint in the reason, not as the
   thing eligibility is computed from.

Codex has no non-interactive equivalent (`/status` and `/usage` are TUI-only; `codex doctor`
reports nothing about limits) and agy has none at all. Those two keep the rolling estimate.

## Approach

Three independent switches, all off by default:

1. **`quotaProbe`** on a provider reads the vendor's own remaining quota. Authoritative where it
   exists; today that means Claude.
2. **`usageParser`** on a provider records what each call consumed. Observability, and the input
   to the fallback meter.
3. **`budget`** on a provider turns those records into a rolling-window meter that can take the
   provider out of rotation.

A provider with a `quotaProbe` uses it and ignores the estimate. A provider without one falls back
to `usageParser` + `budget`. A provider with neither is never cooled.

A project that sets neither behaves exactly as it does today: no parsing, no new files, no new
exit paths.

The meter is a rolling window, not a counter. Spend inside `windowMs` is summed per provider; at
`handoffAt` of the limit the provider goes `cooling`, and the return time is computed rather than
guessed — it is the moment enough old samples age out of the window for the sum to fall back
under the line.

### Config

```jsonc
// .agents/agent-relay/config.json → providers.claude
{
  "command": "…",
  "args": ["…"],
  "vendor": "anthropic",
  "quotaProbe": {                    // absent = no probe, fall back to the estimate
    "parser": "claude-usage",
    "command": "claude",
    "args": ["-p", "/usage", "--output-format", "json"],
    "meters": ["session", "week"],   // cool if any listed meter is over handoffAt
    "handoffAt": 0.9,
    "minIntervalMs": 60000,          // floor between probes
    "timeoutMs": 30000
  },
  "usageParser": "claude-json",      // claude-json | codex-jsonl | absent
  "budget": {                        // absent = tracking only, no rotation
    "windowMs": 18000000,            // 5h
    "limitUsd": 40,                  // or limitTokens, exactly one
    "handoffAt": 0.9
  }
}
```

The probe is a declared command, not a hardcoded endpoint. Agent Relay stays provider-neutral: an
operator whose environment can read quota some other way — a vendor API, a script that reads what
their IDE panel reads — supplies that command instead, and only the parser name changes.

Budgets live in project config, not in the adapter. They describe an account and a plan, which
are properties of the operator, not of the repository being worked on.

### Failure posture

- **Invalid config fails closed.** An unknown `usageParser`, a `handoffAt` outside `(0, 1]`, a
  `windowMs` under a minute, or both/neither of `limitUsd` and `limitTokens` is
  `project-misconfigured` (exit 12) at `doctor` and `setup` time. A typo must not silently
  disable the guard.
- **Unreadable output fails open.** If a configured parser cannot find usage in a call's output,
  the sample is recorded as `unmeasured`, the provider stays eligible, and the run continues. An
  optional feature must never make a run worse than not having it.
- **A provider with no parser is never cooled.** agy has no meter; silence is not evidence of
  either exhaustion or health.

## Components

### `src/lib/usage.mjs` (new)

```js
parseUsage(parserName, { stdout, stderr }) →
  null | { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens,
           reasoningTokens, costUsd | null, contextWindow | null, model | null }
```

Pure over captured output. `claude-json` parses the result envelope; `codex-jsonl` scans for the
`turn.completed` event. Anything unrecognized returns `null`. Fixtures come from the real captures
in `.resources/claude-code/` and `.resources/codex-cli/`, copied into `test/fixtures/usage/`
because `.resources/` is never committed.

### `src/lib/provider-health.mjs` (new)

Owns `.agents/agent-relay/provider-health.json`, already covered by the existing
`.agents/agent-relay/` exclude entry.

```json
{
  "version": 1,
  "providers": {
    "claude": {
      "samples": [{ "at": "…", "beadId": "…", "costUsd": 0.28, "tokens": 28861, "measured": true }],
      "state": "cooling",
      "reason": "36.4 of 40 USD in the last 5h",
      "cooledUntil": "2026-07-26T14:05:00Z",
      "observedAt": "…"
    }
  }
}
```

Samples outside the window are pruned on write, which bounds the file. Reads treat a missing or
corrupt file as empty: like the run ledger, this is reconstructible operational state, not a
source of truth. Writes take a dedicated lock through the existing `acquireLock`, because two
relays can run different beads in one project at the same time.

### `evaluateProvider({ health, budget, now })` → `{ eligible, state, reason, cooledUntil }`

Pure, with an injected clock so the window boundary is testable.

### Supervisor integration

Four touch points, each a no-op when no budget is configured:

1. **Pre-flight filter** in the `executeCoder` provider loop and in
   `candidateReviewProviders` — skip providers that are cooling. Review calls spend the same
   quota as implementation calls.
2. **Post-call record** after `runProviderCommand` in both the coder and reviewer paths:
   parse, append a sample, re-evaluate, and on a transition into `cooling` write a
   `provider-budget-cooling` checkpoint to the ledger and the Bead.
3. **Empty pool** → `provider-quorum-unavailable` (exit 11) with the earliest reset in the reason.
4. **`relay doctor --json`** reports each provider's budget, rolling spend, state, and reset time.

## Deliberately out of scope

- **Mid-call preemption.** The supervisor spawns an opaque CLI; it cannot interrupt a turn at 90%.
  The guarantee is "never start another turn on a provider that is nearly out", which lands every
  handover on a checkpoint boundary anyway.
- **Reimplementing `--max-budget-usd`.** Claude already caps spend per invocation. Document it as
  the per-call complement to the rolling meter rather than duplicating it.
- **Token-to-dollar pricing for Codex.** `limitTokens` covers it. A pricing table would need
  per-model upkeep for little gain.
- **Cross-project health.** One file per project.
- **Per-call context-fraction rotation.** The data is there for Claude (`contextWindow` is
  self-reported) and it is worth revisiting, but it answers a different question — whether a
  single turn ran out of room — and it is not what strands a run.

## Testing

| Area | Cases |
| --- | --- |
| Parsers | Real Claude envelope; real Codex JSONL; plain text; truncated JSON; missing `turn.completed`; multi-model `modelUsage` |
| Window math | Injected clock; sample exactly on the boundary; pruning; `cooledUntil` computed from the oldest in-window sample |
| Eligibility | Under threshold, crossing it, returning after the window rolls, unmeasured samples ignored |
| Config validation | Each invalid field yields exit 12 at doctor |
| Supervisor | No budget configured → behavior identical to today; budget exceeded → next provider used and checkpoint written; all cooling → exit 11 with the earliest reset; unparseable usage → provider stays eligible |
| Concurrency | Two writers, no lost samples |

## Rollout

Ship the parsers and the ledger before the rotation. With `usageParser` set and `budget` absent,
the relay records real numbers without changing any decision, so the limits can be chosen from
observed data instead of guessed.
