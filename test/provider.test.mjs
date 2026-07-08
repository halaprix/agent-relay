import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";
import { classifyProviderFailure, parseWorkerReport, runProviderCommand } from "../src/lib/provider.mjs";

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
    timeoutMs: 100
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  const firstStat = await stat(markerPath);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondStat = await stat(markerPath);
  assert.equal(secondStat.size, firstStat.size);
  const writes = (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
  assert.ok(writes.length >= 1);
});
