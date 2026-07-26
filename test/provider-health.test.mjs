import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import {
  evaluateProvider,
  loadProviderHealth,
  providerHealthPath,
  recordProviderSample
} from "../src/lib/provider-health.mjs";
import { writeJson } from "../src/lib/fs.mjs";

const NOW = "2026-01-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function isoAt(offsetMs) {
  return new Date(NOW_MS + offsetMs).toISOString();
}

async function createProjectRoot() {
  return mkdtemp(path.join(os.tmpdir(), "agent-relay-provider-health-"));
}

// Shared by the crossing-handoffAt and advancing-past-cooldown tests below: 3
// measured samples that together cross a 50%-of-40 threshold and require dropping
// two of them (oldest first) before the running sum falls back under threshold.
function buildCoolingFixture() {
  const windowMs = 5 * 60 * 60 * 1000;
  const budget = { windowMs, handoffAt: 0.5, limitUsd: 40 };
  const sampleA = { at: isoAt(-4 * 60 * 60 * 1000), beadId: "sample-a", costUsd: 20, measured: true };
  const sampleB = { at: isoAt(-3 * 60 * 60 * 1000), beadId: "sample-b", costUsd: 10, measured: true };
  const sampleC = { at: isoAt(-1 * 60 * 60 * 1000), beadId: "sample-c", costUsd: 10, measured: true };
  const health = { samples: [sampleC, sampleA, sampleB] };
  return { budget, health, sampleA, sampleB, sampleC };
}

test("providerHealthPath points at <projectRoot>/.agents/agent-relay/provider-health.json", () => {
  assert.equal(
    providerHealthPath("/tmp/example-project"),
    path.join("/tmp/example-project", ".agents", "agent-relay", "provider-health.json")
  );
});

test("evaluateProvider is eligible with no budget regardless of samples", () => {
  const result = evaluateProvider({
    health: { samples: [{ at: NOW, beadId: "x", costUsd: 999999, measured: true }] },
    budget: null,
    now: NOW
  });
  assert.deepEqual(result, { eligible: true, state: "eligible", reason: null, cooledUntil: null });
});

test("evaluateProvider treats an undefined health record as no samples", () => {
  const result = evaluateProvider({
    health: undefined,
    budget: { windowMs: 1000, handoffAt: 0.5, limitUsd: 10 },
    now: NOW
  });
  assert.deepEqual(result, { eligible: true, state: "eligible", reason: null, cooledUntil: null });
});

test("evaluateProvider excludes a sample exactly at now-windowMs and includes one a millisecond inside", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };

  const boundarySample = { at: isoAt(-1000), beadId: "b-boundary", costUsd: 10, measured: true };
  const boundaryResult = evaluateProvider({ health: { samples: [boundarySample] }, budget, now: NOW });
  assert.equal(boundaryResult.eligible, true);
  assert.equal(boundaryResult.state, "eligible");

  const insideSample = { at: isoAt(-999), beadId: "b-inside", costUsd: 10, measured: true };
  const insideResult = evaluateProvider({ health: { samples: [insideSample] }, budget, now: NOW });
  assert.equal(insideResult.eligible, false);
  assert.equal(insideResult.state, "cooling");
});

test("evaluateProvider flips to cooling when spend crosses handoffAt and computes the exact cooldown instant", () => {
  const { budget, health, sampleB } = buildCoolingFixture();
  const result = evaluateProvider({ health, budget, now: NOW });
  assert.equal(result.eligible, false);
  assert.equal(result.state, "cooling");
  assert.equal(result.reason, "40 of 40 USD in the last 5h");

  // Dropping sample-a alone leaves remaining spend (20) equal to threshold (20),
  // which must NOT count as under threshold; sample-b must also be dropped, so
  // cooledUntil is sample-b's exit instant, not sample-a's.
  const expectedCooledUntil = new Date(Date.parse(sampleB.at) + budget.windowMs).toISOString();
  assert.equal(result.cooledUntil, expectedCooledUntil);
});

test("advancing now to the computed cooledUntil makes evaluateProvider eligible again with no other input change", () => {
  const { budget, health } = buildCoolingFixture();
  const cooling = evaluateProvider({ health, budget, now: NOW });

  const justBefore = new Date(Date.parse(cooling.cooledUntil) - 1).toISOString();
  const stillCooling = evaluateProvider({ health, budget, now: justBefore });
  assert.equal(stillCooling.eligible, false);
  assert.equal(stillCooling.state, "cooling");

  const atCooldown = evaluateProvider({ health, budget, now: cooling.cooledUntil });
  assert.equal(atCooldown.eligible, true);
  assert.equal(atCooldown.state, "eligible");
  assert.equal(atCooldown.reason, null);
  assert.equal(atCooldown.cooledUntil, null);
});

test("evaluateProvider excludes unmeasured samples from the spend sum", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
  const measured = { at: isoAt(-500), beadId: "b-measured", costUsd: 5, measured: true };
  const unmeasured = { at: isoAt(-400), beadId: "b-unmeasured", costUsd: 100, measured: false };
  const result = evaluateProvider({ health: { samples: [measured, unmeasured] }, budget, now: NOW });
  assert.equal(result.eligible, true);
  assert.equal(result.state, "eligible");
});

test("recordProviderSample keeps unmeasured samples in the ledger", async () => {
  const projectRoot = await createProjectRoot();
  const sample = { at: NOW, beadId: "b-unmeasured", costUsd: 999, measured: false };
  const record = await recordProviderSample({ projectRoot, providerName: "anthropic", sample, now: NOW });
  assert.equal(record.samples.length, 1);
  assert.equal(record.samples[0].measured, false);

  const reloaded = await loadProviderHealth(projectRoot);
  assert.equal(reloaded.providers.anthropic.samples[0].beadId, "b-unmeasured");
});

test("evaluateProvider sums tokens and ignores costUsd for token budgets", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitTokens: 1000 };
  const sampleWithTokens = { at: isoAt(-500), beadId: "b1", tokens: 900, costUsd: 0.01, measured: true };
  const sampleMissingTokens = { at: isoAt(-400), beadId: "b2", costUsd: 500, measured: true };
  const underLimit = evaluateProvider({
    health: { samples: [sampleWithTokens, sampleMissingTokens] },
    budget,
    now: NOW
  });
  assert.equal(underLimit.eligible, true);
  assert.equal(underLimit.state, "eligible");

  const pushedOver = { at: isoAt(-300), beadId: "b3", tokens: 200, measured: true };
  const overLimit = evaluateProvider({
    health: { samples: [sampleWithTokens, sampleMissingTokens, pushedOver] },
    budget,
    now: NOW
  });
  assert.equal(overLimit.eligible, false);
  assert.equal(overLimit.state, "cooling");
  assert.equal(overLimit.reason, "1100 of 1000 tokens in the last 1s");
});

test("recordProviderSample prunes samples that have aged out of the budget window", async () => {
  const projectRoot = await createProjectRoot();
  const windowMs = 1000;
  const staleSample = { at: isoAt(-5000), beadId: "stale", costUsd: 1, measured: true };
  const survivingSample = { at: isoAt(-500), beadId: "surviving", costUsd: 1, measured: true };
  await writeJson(providerHealthPath(projectRoot), {
    version: 1,
    providers: {
      anthropic: {
        samples: [staleSample, survivingSample],
        state: "eligible",
        reason: null,
        cooledUntil: null,
        observedAt: isoAt(-500)
      }
    }
  });

  const newSample = { at: NOW, beadId: "new", costUsd: 1, measured: true };
  const record = await recordProviderSample({
    projectRoot,
    providerName: "anthropic",
    sample: newSample,
    budget: { windowMs, handoffAt: 1, limitUsd: 100 },
    now: NOW
  });

  assert.deepEqual(record.samples.map((entry) => entry.beadId), ["surviving", "new"]);
});

test("recordProviderSample caps unbounded samples at 200 by dropping the oldest", async () => {
  const projectRoot = await createProjectRoot();
  const seeded = Array.from({ length: 200 }, (_, index) => ({
    at: isoAt(index * 1000),
    beadId: `seed-${index}`,
    costUsd: 1,
    measured: true
  }));
  await writeJson(providerHealthPath(projectRoot), {
    version: 1,
    providers: {
      anthropic: {
        samples: seeded,
        state: "eligible",
        reason: null,
        cooledUntil: null,
        observedAt: NOW
      }
    }
  });

  const newSample = { at: isoAt(200 * 1000), beadId: "seed-200", costUsd: 1, measured: true };
  const record = await recordProviderSample({
    projectRoot,
    providerName: "anthropic",
    sample: newSample,
    now: isoAt(200 * 1000)
  });

  assert.equal(record.samples.length, 200);
  assert.equal(record.samples[0].beadId, "seed-1");
  assert.equal(record.samples[199].beadId, "seed-200");
});

test("recordProviderSample caps at 200 samples under a budget and marks the record truncated", async () => {
  const projectRoot = await createProjectRoot();
  const windowMs = 1000 * 60 * 60 * 24 * 365; // huge window so nothing ages out
  const seeded = Array.from({ length: 200 }, (_, index) => ({
    at: isoAt(index * 1000),
    beadId: `seed-${index}`,
    costUsd: 1,
    measured: true
  }));
  await writeJson(providerHealthPath(projectRoot), {
    version: 1,
    providers: {
      anthropic: {
        samples: seeded,
        state: "eligible",
        reason: null,
        cooledUntil: null,
        observedAt: NOW
      }
    }
  });

  const newSample = { at: isoAt(200 * 1000), beadId: "seed-200", costUsd: 1, measured: true };
  const record = await recordProviderSample({
    projectRoot,
    providerName: "anthropic",
    sample: newSample,
    budget: { windowMs, handoffAt: 1, limitUsd: 100000 },
    now: isoAt(200 * 1000)
  });

  assert.equal(record.samples.length, 200);
  assert.equal(record.samples[0].beadId, "seed-1");
  assert.equal(record.samples[199].beadId, "seed-200");
  assert.equal(record.truncated, true);
});

test("recordProviderSample under a budget that does not exceed the cap leaves the truncation marker off", async () => {
  const projectRoot = await createProjectRoot();
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 100 };
  const sample = { at: NOW, beadId: "b1", costUsd: 1, measured: true };
  const record = await recordProviderSample({ projectRoot, providerName: "anthropic", sample, budget, now: NOW });
  assert.equal(record.samples.length, 1);
  assert.notEqual(record.truncated, true);
});

test("evaluateProvider treats a measured sample missing the budget's field as contributing 0 without throwing", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
  const missingField = { at: isoAt(-500), beadId: "b-missing", measured: true };
  assert.doesNotThrow(() => {
    const result = evaluateProvider({ health: { samples: [missingField] }, budget, now: NOW });
    assert.equal(result.eligible, true);
    assert.equal(result.state, "eligible");
  });
});

test("evaluateProvider keeps excluding unmeasured samples from the spend sum (unchanged behavior)", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
  const unmeasured = { at: isoAt(-500), beadId: "b-unmeasured", costUsd: "abc", measured: false };
  const result = evaluateProvider({ health: { samples: [unmeasured] }, budget, now: NOW });
  assert.equal(result.eligible, true);
  assert.equal(result.state, "eligible");
});

for (const [label, badValue] of [
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["the string \"abc\"", "abc"],
  ["null", null]
]) {
  test(`evaluateProvider throws a TypeError when a measured sample's budget field is ${label}`, () => {
    const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
    const badSample = { at: isoAt(-500), beadId: "b-bad", costUsd: badValue, measured: true };
    assert.throws(
      () => evaluateProvider({ health: { samples: [badSample] }, budget, now: NOW }),
      TypeError
    );
  });
}

for (const [label, badValue] of [
  ["the empty string", ""],
  ["a whitespace-only string", " "],
  ["true", true],
  ["an array", []],
  ["a numeric string", "42"]
]) {
  test(`evaluateProvider throws a TypeError when a measured sample's budget field is ${label}`, () => {
    const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
    const badSample = { at: isoAt(-500), beadId: "b-bad-type", costUsd: badValue, measured: true };
    assert.throws(
      () => evaluateProvider({ health: { samples: [badSample] }, budget, now: NOW }),
      TypeError
    );
  });
}

test("evaluateProvider throws a TypeError when a measured sample's budget field is negative", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
  const badSample = { at: isoAt(-500), beadId: "b-negative", costUsd: -100, measured: true };
  assert.throws(
    () => evaluateProvider({ health: { samples: [badSample] }, budget, now: NOW }),
    TypeError
  );
});

test("evaluateProvider rejects a negative sample even when it would otherwise cancel out real spend", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
  const positive = { at: isoAt(-500), beadId: "b-positive", costUsd: 100, measured: true };
  const negative = { at: isoAt(-400), beadId: "b-negative", costUsd: -100, measured: true };
  assert.throws(
    () => evaluateProvider({ health: { samples: [positive, negative] }, budget, now: NOW }),
    TypeError
  );
});

test("evaluateProvider still accepts zero as a valid sample value", () => {
  const budget = { windowMs: 1000, handoffAt: 1, limitUsd: 10 };
  const zero = { at: isoAt(-500), beadId: "b-zero", costUsd: 0, measured: true };
  const result = evaluateProvider({ health: { samples: [zero] }, budget, now: NOW });
  assert.equal(result.eligible, true);
  assert.equal(result.state, "eligible");
});

test("evaluateProvider treats a spend within floating-point noise of the threshold as cooling", () => {
  // 0.1 + 0.7 sums to 0.7999999999999999 in IEEE-754 doubles, strictly less
  // than 0.8 threshold — the true (decimal) sum is exactly at the threshold,
  // so this must read as cooling, not eligible.
  const budget = { windowMs: 1000, handoffAt: 0.8, limitUsd: 1 };
  const sampleA = { at: isoAt(-500), beadId: "b-float-a", costUsd: 0.1, measured: true };
  const sampleB = { at: isoAt(-400), beadId: "b-float-b", costUsd: 0.7, measured: true };
  assert.equal(sampleA.costUsd + sampleB.costUsd < 0.8, true);
  const result = evaluateProvider({ health: { samples: [sampleA, sampleB] }, budget, now: NOW });
  assert.equal(result.eligible, false);
  assert.equal(result.state, "cooling");
});

test("recordProviderSample carries dropped-by-cap spend forward so 201 x $1 measured samples against a $201 limit reads as cooling, not eligible", async () => {
  const projectRoot = await createProjectRoot();
  const windowMs = 1000 * 60 * 60 * 24 * 365; // huge window so nothing ages out
  const seeded = Array.from({ length: 200 }, (_, index) => ({
    at: isoAt(index * 1000),
    beadId: `seed-${index}`,
    costUsd: 1,
    measured: true
  }));
  await writeJson(providerHealthPath(projectRoot), {
    version: 1,
    providers: {
      anthropic: {
        samples: seeded,
        state: "eligible",
        reason: null,
        cooledUntil: null,
        observedAt: NOW
      }
    }
  });

  const newSample = { at: isoAt(200 * 1000), beadId: "seed-200", costUsd: 1, measured: true };
  const record = await recordProviderSample({
    projectRoot,
    providerName: "anthropic",
    sample: newSample,
    budget: { windowMs, handoffAt: 1, limitUsd: 201 },
    now: isoAt(200 * 1000)
  });

  assert.equal(record.samples.length, 200);
  assert.equal(record.truncated, true);
  assert.equal(record.state, "cooling");
  assert.ok(record.carried);
  assert.equal(record.carried.costUsd, 1);
  assert.equal(record.carried.count, 1);
  assert.equal(record.carried.oldestAt, seeded[0].at);
});

test("recordProviderSample's carried spend ages out of the window exactly like an ordinary sample", async () => {
  const projectRoot = await createProjectRoot();
  const windowMs = 1000;
  await writeJson(providerHealthPath(projectRoot), {
    version: 1,
    providers: {
      anthropic: {
        samples: [{ at: isoAt(-500), beadId: "surviving", costUsd: 1, measured: true }],
        state: "eligible",
        reason: null,
        cooledUntil: null,
        observedAt: isoAt(-500),
        carried: { costUsd: 100, tokens: 0, oldestAt: isoAt(-5000), count: 5 }
      }
    }
  });

  const newSample = { at: NOW, beadId: "new", costUsd: 1, measured: true };
  const record = await recordProviderSample({
    projectRoot,
    providerName: "anthropic",
    sample: newSample,
    budget: { windowMs, handoffAt: 1, limitUsd: 1000 },
    now: NOW
  });

  // The stale carry (oldestAt = -5000ms, far outside the 1000ms window) must
  // no longer count toward spend or persist on the record.
  assert.equal(record.carried, undefined);
  assert.equal(record.state, "eligible");
});

test("loadProviderHealth returns the empty shape for a missing or corrupt file, and recording afterwards succeeds", async () => {
  const projectRoot = await createProjectRoot();
  const missing = await loadProviderHealth(projectRoot);
  assert.deepEqual(missing, { version: 1, providers: {} });

  const ledgerPath = providerHealthPath(projectRoot);
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, "{ this is not json ]]]", "utf8");

  const corrupt = await loadProviderHealth(projectRoot);
  assert.deepEqual(corrupt, { version: 1, providers: {} });

  const record = await recordProviderSample({
    projectRoot,
    providerName: "anthropic",
    sample: { at: NOW, beadId: "recovered", costUsd: 1, measured: true },
    now: NOW
  });
  assert.equal(record.samples.length, 1);

  const reloaded = await loadProviderHealth(projectRoot);
  assert.equal(reloaded.providers.anthropic.samples[0].beadId, "recovered");
});

test("two concurrent recordProviderSample calls for the same provider both land", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectRoot();
  await Promise.all([
    recordProviderSample({
      projectRoot,
      providerName: "anthropic",
      sample: { at: isoAt(-10), beadId: "concurrent-a", costUsd: 1, measured: true },
      now: NOW
    }),
    recordProviderSample({
      projectRoot,
      providerName: "anthropic",
      sample: { at: isoAt(-5), beadId: "concurrent-b", costUsd: 1, measured: true },
      now: NOW
    })
  ]);

  const final = await loadProviderHealth(projectRoot);
  const beadIds = final.providers.anthropic.samples.map((entry) => entry.beadId).sort();
  assert.deepEqual(beadIds, ["concurrent-a", "concurrent-b"]);
});
