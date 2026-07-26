import path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireLock } from "./lock.mjs";
import { projectStateRoot, providerHealthPath } from "./paths.mjs";

export { providerHealthPath };

const MAX_UNBOUNDED_SAMPLES = 200;
const LOCK_ACQUIRE_ATTEMPTS = 100;
const LOCK_RETRY_DELAY_MS = 10;

// Every timestamp this module reasons about (`now`, sample `at` fields) is supplied
// by the caller as an ISO-8601 string or an epoch-ms number; `new Date(value)` treats
// both unambiguously. Nothing in here reads the system clock.
function toEpochMs(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`provider-health: invalid time value ${JSON.stringify(value)}`);
  }
  return ms;
}

function toIso(value) {
  return new Date(toEpochMs(value)).toISOString();
}

function emptyLedger() {
  return { version: 1, providers: {} };
}

export async function loadProviderHealth(projectRoot) {
  try {
    const parsed = await readJson(providerHealthPath(projectRoot));
    const providers =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      parsed.providers && typeof parsed.providers === "object"
        ? parsed.providers
        : {};
    return { version: 1, providers };
  } catch {
    return emptyLedger();
  }
}

function lockPathFor(projectRoot) {
  return path.join(projectStateRoot(projectRoot), "locks", "provider-health.lock.json");
}

// acquireLock is fail-fast (returns acquired:false on contention rather than
// blocking), so writers poll it until the current holder releases.
async function acquireLockRetrying({ lockPath, owner }) {
  let lastReason = "locked";
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    const lock = await acquireLock({ lockPath, owner });
    if (lock.acquired) {
      return lock;
    }
    lastReason = lock.reason;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
  throw new Error(`provider-health: timed out acquiring ${lockPath} (${lastReason})`);
}

function formatQuantity(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatWindow(windowMs) {
  if (windowMs % 3_600_000 === 0) {
    return `${windowMs / 3_600_000}h`;
  }
  if (windowMs % 60_000 === 0) {
    return `${windowMs / 60_000}m`;
  }
  if (windowMs % 1000 === 0) {
    return `${windowMs / 1000}s`;
  }
  return `${windowMs}ms`;
}

function budgetField(budget) {
  return budget.limitUsd !== undefined
    ? { field: "costUsd", limit: budget.limitUsd, unit: "USD" }
    : { field: "tokens", limit: budget.limitTokens, unit: "tokens" };
}

function sampleValue(sample, field) {
  // Field ABSENT (undefined) is intentional: a USD-budget evaluation over a
  // token-only sample (or vice versa) contributes 0 rather than throwing.
  const raw = sample[field];
  if (raw === undefined) {
    return 0;
  }
  // Only an actual JS number is acceptable. `Number(raw)` used to coerce
  // strings ("", " ", "42"), booleans, and arrays into finite numbers, which
  // let corrupt/attacker-controlled data pass as if it were real spend — the
  // unsafe direction for a guardrail. NaN/Infinity are still rejected.
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new TypeError(
      `provider-health: non-numeric ${field} ${JSON.stringify(raw)} on measured sample`
    );
  }
  // A negative quantity is either corrupt data or a credit; either way, letting
  // it cancel out real spend from other samples in the same window would bias
  // toward "eligible". Zero remains valid (a genuinely free sample).
  if (raw < 0) {
    throw new TypeError(
      `provider-health: negative ${field} ${JSON.stringify(raw)} on measured sample`
    );
  }
  return raw;
}

// Tolerant numeric sum used only for carry bookkeeping over samples that were
// dropped by the 200-sample cap before they ever reached sampleValue's
// validation. Non-numeric/negative fields contribute 0 here rather than
// throwing — recordProviderSample must never fail because of historical data
// it is merely relocating into the carry bucket.
function sumMeasuredField(entries, field) {
  return entries.reduce((sum, entry) => {
    const raw = entry[field];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? sum + raw : sum;
  }, 0);
}

// Window is half-open: (now - windowMs, now]. A sample at exactly now - windowMs
// has already aged out.
function contributingSamples({ samples, field, windowStartMs, nowMs }) {
  return samples
    .filter((sample) => sample.measured === true)
    .map((sample) => ({ atMs: toEpochMs(sample.at), value: sampleValue(sample, field) }))
    .filter((sample) => sample.atMs > windowStartMs && sample.atMs <= nowMs)
    .sort((a, b) => a.atMs - b.atMs);
}

export function evaluateProvider({ health, budget, now }) {
  if (!budget) {
    return { eligible: true, state: "eligible", reason: null, cooledUntil: null };
  }
  const nowMs = toEpochMs(now);
  const windowStartMs = nowMs - budget.windowMs;
  const { field, limit, unit } = budgetField(budget);
  const samples = Array.isArray(health?.samples) ? health.samples : [];
  const contributing = contributingSamples({ samples, field, windowStartMs, nowMs });

  // The carry bucket represents spend that earlier writes dropped off the
  // 200-sample cap. It is treated as a single pseudo-sample sitting at the
  // earliest dropped timestamp — i.e. before all retained samples — so it
  // both counts toward spend and rolls off the window like a real sample.
  // Aging: prune the whole carry once its oldestAt exits the window. This
  // lumps several distinct dropped timestamps under one (the oldest), which
  // over-counts slightly once part of the carried batch would otherwise have
  // aged out on its own — over-counting is the safe direction for a
  // guardrail, so it is preferred to under-counting.
  const carried = health?.carried;
  let contributingWithCarry = contributing;
  if (carried && typeof carried.oldestAt !== "undefined") {
    const carryAtMs = toEpochMs(carried.oldestAt);
    if (carryAtMs > windowStartMs && carryAtMs <= nowMs) {
      const carryValue = field === "tokens" ? carried.tokens || 0 : carried.costUsd || 0;
      contributingWithCarry = [{ atMs: carryAtMs, value: carryValue }, ...contributing].sort(
        (a, b) => a.atMs - b.atMs
      );
    }
  }

  const threshold = budget.handoffAt * limit;
  // Floating-point noise (e.g. 0.1 + 0.7 summing to 0.7999999999999999
  // against an 0.8 threshold) must not read as "under" — a spend that is
  // within FP noise of the threshold is, in truth, AT the threshold, which
  // this guardrail treats as over. epsilon scales with the threshold's
  // magnitude and a small multiple of Number.EPSILON to absorb summation
  // error without changing outcomes for values clearly under or over.
  const epsilon = Math.abs(threshold) * Number.EPSILON * 8;
  const spend = contributingWithCarry.reduce((sum, sample) => sum + sample.value, 0);

  if (spend < threshold - epsilon) {
    return { eligible: true, state: "eligible", reason: null, cooledUntil: null };
  }

  // cooledUntil is the instant the oldest contributing sample rolls out of the
  // window and drags the sum back under threshold: drop oldest-first and stop.
  let remaining = spend;
  let cooledUntilMs = nowMs;
  for (const sample of contributingWithCarry) {
    remaining -= sample.value;
    cooledUntilMs = sample.atMs + budget.windowMs;
    if (remaining < threshold - epsilon) {
      break;
    }
  }

  const reason = `${formatQuantity(spend)} of ${formatQuantity(limit)} ${unit} in the last ${formatWindow(budget.windowMs)}`;
  return {
    eligible: false,
    state: "cooling",
    reason,
    cooledUntil: new Date(cooledUntilMs).toISOString()
  };
}

export async function recordProviderSample({ projectRoot, providerName, sample, budget = null, now }) {
  const lock = await acquireLockRetrying({
    lockPath: lockPathFor(projectRoot),
    owner: `provider-health:${providerName}:${process.pid}`
  });
  try {
    const ledger = await loadProviderHealth(projectRoot);
    const existing = ledger.providers[providerName];
    const priorSamples = existing && Array.isArray(existing.samples) ? existing.samples : [];
    const appended = [...priorSamples, { ...sample }];

    const pruneWindowMs = budget?.windowMs;
    const nowMs = toEpochMs(now);
    const windowPruned =
      typeof pruneWindowMs === "number"
        ? appended.filter((entry) => toEpochMs(entry.at) > nowMs - pruneWindowMs)
        : appended;
    // Always cap to the most recent MAX_UNBOUNDED_SAMPLES entries, even when a
    // budget window already pruned by age: a high-frequency sampler with a long
    // windowMs can otherwise grow the ledger unboundedly within the window.
    const prunedSamples = windowPruned.slice(-MAX_UNBOUNDED_SAMPLES);
    const truncated = windowPruned.length > prunedSamples.length;
    // `truncated` remains a boolean visibility marker, but visibility alone is
    // not correctness: dropping in-window samples used to silently undercount
    // spend, biasing toward "eligible" — the unsafe direction for a
    // guardrail. Instead, fold whatever the cap drops into a carry bucket
    // that evaluateProvider adds back in as a pseudo-sample.
    const droppedByCap = windowPruned.slice(0, windowPruned.length - prunedSamples.length);

    let carried = existing?.carried;
    if (carried && typeof pruneWindowMs === "number") {
      const carryAtMs = toEpochMs(carried.oldestAt);
      if (carryAtMs <= nowMs - pruneWindowMs) {
        // Carry aged out of the window exactly like an ordinary sample would.
        carried = undefined;
      }
    }
    if (droppedByCap.length > 0) {
      const droppedMeasured = droppedByCap.filter((entry) => entry.measured === true);
      const droppedCostUsd = sumMeasuredField(droppedMeasured, "costUsd");
      const droppedTokens = sumMeasuredField(droppedMeasured, "tokens");
      const droppedOldestMs = Math.min(...droppedByCap.map((entry) => toEpochMs(entry.at)));
      const droppedOldestAt = toIso(droppedOldestMs);
      if (carried) {
        const carriedOldestMs = toEpochMs(carried.oldestAt);
        carried = {
          costUsd: (carried.costUsd || 0) + droppedCostUsd,
          tokens: (carried.tokens || 0) + droppedTokens,
          oldestAt: droppedOldestMs < carriedOldestMs ? droppedOldestAt : carried.oldestAt,
          count: (carried.count || 0) + droppedMeasured.length
        };
      } else {
        carried = {
          costUsd: droppedCostUsd,
          tokens: droppedTokens,
          oldestAt: droppedOldestAt,
          count: droppedMeasured.length
        };
      }
    }

    const evaluation = budget
      ? evaluateProvider({ health: { samples: prunedSamples, carried }, budget, now })
      : { state: "eligible", reason: null, cooledUntil: null };

    const record = {
      samples: prunedSamples,
      state: evaluation.state,
      reason: evaluation.reason,
      cooledUntil: evaluation.cooledUntil,
      observedAt: toIso(now),
      ...(truncated ? { truncated: true } : {}),
      ...(carried ? { carried } : {})
    };
    ledger.providers[providerName] = record;
    await writeJsonAtomic(providerHealthPath(projectRoot), ledger);
    return record;
  } finally {
    await lock.release();
  }
}
