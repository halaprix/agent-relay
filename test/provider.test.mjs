import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";
import { classifyProviderFailure, parseWorkerReport, providerVendor, runProviderCommand, validateRuntimeProviderConfig } from "../src/lib/provider.mjs";
import { PROVIDERS } from "../src/lib/providers/index.mjs";
import { __candidateReviewProvidersForTests } from "../src/lib/supervisor.mjs";

async function waitForMarkerLines(markerPath, minimumLines, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const contents = await readFile(markerPath, "utf8").catch(() => "");
    const lines = contents.trim().split("\n").filter(Boolean);
    if (lines.length >= minimumLines) {
      return lines;
    }
    if (Date.now() >= deadline) {
      throw new Error(`marker did not reach ${minimumLines} lines within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("parseWorkerReport accepts pure json", () => {
  const report = parseWorkerReport('{"status":"success","summary":"ok","ownedPaths":[],"commandsAttempted":[],"changedPaths":[]}');
  assert.equal(report.status, "success");
});

test("parseWorkerReport falls back to final json line", () => {
  const report = parseWorkerReport('debug line\n{"status":"success","summary":"ok","ownedPaths":[],"commandsAttempted":[],"changedPaths":[]}');
  assert.equal(report.summary, "ok");
});

test("classifyProviderFailure detects quota and timeout failures", () => {
  assert.equal(classifyProviderFailure({ stdout: "", stderr: "quota exceeded" }), "handoff-immediate");
  assert.equal(classifyProviderFailure({ stdout: "", stderr: "network timeout" }), "handoff-after-retry");
});

// A model-agnostic manifest that resolves vendor from a "-m vendor/model" style argument,
// standing in for a future opencode-style provider. Registered/unregistered around each
// test so it never leaks into unrelated PROVIDERS lookups (it is not a real manifest — the
// bead explicitly defers adding one).
function withModelAgnosticManifest(fn) {
  const manifest = {
    name: "test-model-agnostic",
    resolveVendor: (providerConfig) => {
      const args = providerConfig?.args || [];
      const flagIndex = args.indexOf("-m");
      if (flagIndex === -1 || !args[flagIndex + 1]) {
        return null;
      }
      const prefix = args[flagIndex + 1].split("/")[0];
      return prefix || null;
    }
  };
  PROVIDERS.push(manifest);
  try {
    return fn(manifest);
  } finally {
    const index = PROVIDERS.indexOf(manifest);
    if (index !== -1) {
      PROVIDERS.splice(index, 1);
    }
  }
}

test("providerVendor: declared and resolved agree (claude) returns that vendor", () => {
  assert.equal(providerVendor("claude", { command: "claude", vendor: "anthropic" }), "anthropic");
});

test("providerVendor: declared and resolved disagree throws naming both values", () => {
  withModelAgnosticManifest((manifest) => {
    assert.throws(
      () =>
        providerVendor(manifest.name, {
          command: "opencode",
          args: ["-m", "anthropic/claude-sonnet"],
          vendor: "openai"
        }),
      new Error(`provider ${manifest.name} declares vendor openai but its configured model resolves to anthropic`)
    );
  });
});

test("providerVendor: only resolved present returns resolved vendor", () => {
  withModelAgnosticManifest((manifest) => {
    assert.equal(
      providerVendor(manifest.name, { command: "opencode", args: ["-m", "google/gemini"] }),
      "google"
    );
  });
});

test("providerVendor: neither declared nor resolved returns null, and validateRuntimeProviderConfig fail-closes", () => {
  withModelAgnosticManifest((manifest) => {
    assert.equal(providerVendor(manifest.name, { command: "opencode", args: [] }), null);
    assert.throws(
      () => validateRuntimeProviderConfig(manifest.name, { command: "opencode", args: [] }),
      new Error(`provider ${manifest.name}.vendor must be configured explicitly to one of anthropic, openai, google`)
    );
  });
});

test("candidateReviewProviders refuses to let a misdeclared model-agnostic provider inflate quorum", () => {
  withModelAgnosticManifest((manifest) => {
    const config = {
      providers: {
        claude: { command: "claude", vendor: "anthropic", strength: "strong" },
        [manifest.name]: {
          command: "opencode",
          args: ["-m", "anthropic/claude-sonnet"],
          // Misdeclared: operator says openai, but the configured model resolves to anthropic.
          // Before resolveVendor existed this would have silently counted as a second,
          // distinct vendor and satisfied a two-vendor review quorum alongside claude.
          vendor: "openai",
          strength: "strong"
        }
      }
    };
    assert.throws(
      () =>
        __candidateReviewProvidersForTests({
          config,
          providerNames: ["claude", manifest.name],
          requiredVendors: 2
        }),
      new RegExp(`provider ${manifest.name} declares vendor openai but its configured model resolves to anthropic`)
    );
  });
});

test("candidateReviewProviders collapses a correctly-resolved model-agnostic provider onto the same vendor as claude", () => {
  withModelAgnosticManifest((manifest) => {
    const config = {
      providers: {
        claude: { command: "claude", vendor: "anthropic", strength: "strong" },
        [manifest.name]: {
          command: "opencode",
          args: ["-m", "anthropic/claude-sonnet"],
          strength: "strong"
        }
      }
    };
    const { candidates, hasQuorum } = __candidateReviewProvidersForTests({
      config,
      providerNames: ["claude", manifest.name],
      requiredVendors: 2
    });
    assert.equal(candidates.length, 1);
    assert.equal(hasQuorum, false);
  });
});

// Real opencode-manifest coverage of the same hazard the model-agnostic fixture above
// exercises abstractly: opencode's model is genuinely operator-configurable via `-m`, so
// its resolveVendor must both collapse quorum when the resolved vendor matches another
// provider's declared vendor, and refuse a contradiction rather than silently trusting
// the declared one.
test("opencode resolving to anthropic does not inflate quorum alongside claude", () => {
  const config = {
    providers: {
      claude: { command: "claude", vendor: "anthropic", strength: "strong" },
      opencode: {
        command: "opencode",
        args: ["-m", "anthropic/claude-sonnet"],
        vendor: "anthropic",
        strength: "strong"
      }
    }
  };
  const { candidates, hasQuorum } = __candidateReviewProvidersForTests({
    config,
    providerNames: ["claude", "opencode"],
    requiredVendors: 2
  });
  assert.equal(candidates.length, 1);
  assert.equal(hasQuorum, false);
});

test("opencode declaring openai while its model resolves to anthropic throws the contradiction error", () => {
  assert.throws(
    () =>
      providerVendor("opencode", {
        command: "opencode",
        args: ["-m", "anthropic/claude-sonnet"],
        vendor: "openai"
      }),
    new Error("provider opencode declares vendor openai but its configured model resolves to anthropic")
  );
});

test("runProviderCommand times out by killing the process group and stops child writes", { timeout: 10000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-provider-timeout-"));
  const markerPath = path.join(tempDir, "marker.log");
  const result = await runProviderCommand({
    providerName: "timeout-fixture",
    command: process.execPath,
    args: [repoPath("test", "fixtures", "provider-timeout-process-group.mjs")],
    cwd: tempDir,
    env: {
      PROVIDER_TIMEOUT_MARKER: markerPath
    },
    timeoutMs: 500
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  const writes = await waitForMarkerLines(markerPath, 2);
  const firstStat = await stat(markerPath);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondStat = await stat(markerPath);
  assert.equal(secondStat.size, firstStat.size);
  assert.ok(writes.length >= 2);
});
