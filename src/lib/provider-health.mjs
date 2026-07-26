import path from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { ensureDir, readJson } from "./fs.mjs";
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

async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
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

// Window is half-open: (now - windowMs, now]. A sample at exactly now - windowMs
// has already aged out.
function contributingSamples({ samples, field, windowStartMs, nowMs }) {
  return samples
    .filter((sample) => sample.measured === true)
    .map((sample) => ({ atMs: toEpochMs(sample.at), value: Number(sample[field]) || 0 }))
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
  const threshold = budget.handoffAt * limit;
  const spend = contributing.reduce((sum, sample) => sum + sample.value, 0);

  if (spend < threshold) {
    return { eligible: true, state: "eligible", reason: null, cooledUntil: null };
  }

  // cooledUntil is the instant the oldest contributing sample rolls out of the
  // window and drags the sum back under threshold: drop oldest-first and stop.
  let remaining = spend;
  let cooledUntilMs = nowMs;
  for (const sample of contributing) {
    remaining -= sample.value;
    cooledUntilMs = sample.atMs + budget.windowMs;
    if (remaining < threshold) {
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
    const prunedSamples =
      typeof pruneWindowMs === "number"
        ? appended.filter((entry) => toEpochMs(entry.at) > nowMs - pruneWindowMs)
        : appended.slice(-MAX_UNBOUNDED_SAMPLES);

    const evaluation = budget
      ? evaluateProvider({ health: { samples: prunedSamples }, budget, now })
      : { state: "eligible", reason: null, cooledUntil: null };

    const record = {
      samples: prunedSamples,
      state: evaluation.state,
      reason: evaluation.reason,
      cooledUntil: evaluation.cooledUntil,
      observedAt: toIso(now)
    };
    ledger.providers[providerName] = record;
    await writeJsonAtomic(providerHealthPath(projectRoot), ledger);
    return record;
  } finally {
    await lock.release();
  }
}
